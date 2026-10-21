"""
Known-answer tests for node_client/energy.py.

Each test builds a fake /sys/class/powercap tree whose counter values are
chosen in advance, so the expected millijoules are exact. Run with:

    python -m unittest discover -s tests/python -v
"""

from __future__ import annotations

import math
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "node_client"))

from energy import (  # noqa: E402
    AssumedPowerMeter,
    EnergyUnavailable,
    RaplMeter,
    describe_sources,
    resolve_meter,
)


def make_zone(root: Path, zone: str, name: str, energy_uj: int, max_range_uj: int = 262_143_328_850) -> Path:
    path = root / zone
    path.mkdir(parents=True)
    (path / "name").write_text(f"{name}\n")
    (path / "energy_uj").write_text(f"{energy_uj}\n")
    (path / "max_energy_range_uj").write_text(f"{max_range_uj}\n")
    return path


def set_energy(zone: Path, energy_uj: int) -> None:
    (zone / "energy_uj").write_text(f"{energy_uj}\n")


def fake_clock(*times: float):
    return iter(times).__next__


class RaplMeterTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_sums_packages_and_ignores_subzones_and_psys(self) -> None:
        pkg0 = make_zone(self.root, "intel-rapl:0", "package-0", 1_000_000)
        core = make_zone(self.root, "intel-rapl:0:0", "core", 0)  # inside package-0 already
        psys = make_zone(self.root, "intel-rapl:1", "psys", 0)  # whole platform, includes packages
        pkg1 = make_zone(self.root, "intel-rapl:2", "package-1", 500)

        meter = RaplMeter(self.root, clock=fake_clock(10.0, 12.0))
        self.assertEqual(meter.source, "rapl:package-0+package-1")

        with meter.measure() as measurement:
            set_energy(pkg0, 3_500_000)  # +2.5 J
            set_energy(pkg1, 1_000_500)  # +1.0 J
            set_energy(core, 99_999_999)  # must not be counted
            set_energy(psys, 99_999_999)  # must not be counted

        reading = measurement.reading
        self.assertEqual(reading.milli_joules, 3_500)
        self.assertEqual(reading.seconds, 2.0)
        self.assertAlmostEqual(reading.watts, 1.75)
        self.assertFalse(reading.estimated)
        self.assertIn("measured", reading.describe())

    def test_recovers_one_counter_wrap(self) -> None:
        pkg = make_zone(self.root, "intel-rapl:0", "package-0", 999_999_000, max_range_uj=1_000_000_000)
        meter = RaplMeter(self.root, clock=fake_clock(0.0, 1.0))

        with meter.measure() as measurement:
            set_energy(pkg, 1_000)  # wrapped: 1,000 uJ to the top, 1,000 uJ after

        self.assertEqual(measurement.reading.milli_joules, 2)

    def test_rounds_partial_millijoules_up(self) -> None:
        pkg = make_zone(self.root, "intel-rapl:0", "package-0", 0)
        meter = RaplMeter(self.root, clock=fake_clock(0.0, 1.0))

        with meter.measure() as measurement:
            set_energy(pkg, 1_001)  # 1.001 mJ

        self.assertEqual(measurement.reading.milli_joules, 2)

    def test_refuses_a_counter_that_did_not_advance(self) -> None:
        make_zone(self.root, "intel-rapl:0", "package-0", 42)
        meter = RaplMeter(self.root, clock=fake_clock(0.0, 0.0005))

        with self.assertRaises(EnergyUnavailable) as caught:
            with meter.measure():
                pass
        self.assertIn("did not advance", str(caught.exception))

    def test_unavailable_without_a_powercap_tree(self) -> None:
        with self.assertRaises(EnergyUnavailable):
            RaplMeter(self.root / "missing")

    def test_unavailable_with_only_non_package_domains(self) -> None:
        make_zone(self.root, "intel-rapl:0", "psys", 0)
        make_zone(self.root, "intel-rapl:0:0", "core", 0)
        with self.assertRaises(EnergyUnavailable):
            RaplMeter(self.root)

    def test_explains_root_only_counters(self) -> None:
        make_zone(self.root, "intel-rapl:0", "package-0", 0)
        original = Path.read_text

        def deny_energy(path: Path, *args, **kwargs):
            if path.name == "energy_uj":
                raise PermissionError(13, "Permission denied", str(path))
            return original(path, *args, **kwargs)

        with mock.patch.object(Path, "read_text", deny_energy):
            with self.assertRaises(EnergyUnavailable) as caught:
                RaplMeter(self.root)
        self.assertIn("root-only", str(caught.exception))


class AssumedPowerMeterTests(unittest.TestCase):
    def test_watts_times_seconds(self) -> None:
        meter = AssumedPowerMeter(15.0, clock=fake_clock(100.0, 102.0))

        with meter.measure() as measurement:
            pass

        reading = measurement.reading
        self.assertEqual(reading.milli_joules, 30_000)  # 15 W x 2 s = 30 J
        self.assertTrue(reading.estimated)
        self.assertEqual(reading.source, "assumed:15W")
        self.assertIn("ESTIMATED", reading.describe())

    def test_never_reports_zero(self) -> None:
        meter = AssumedPowerMeter(1.0, clock=fake_clock(0.0, 0.0))
        with meter.measure() as measurement:
            pass
        self.assertEqual(measurement.reading.milli_joules, 1)

    def test_rejects_nonsense_wattage(self) -> None:
        for watts in (0, -5, math.nan, math.inf):
            with self.subTest(watts=watts):
                with self.assertRaises(ValueError):
                    AssumedPowerMeter(watts)


class ResolveMeterTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_refuses_to_guess_without_rapl_or_a_declared_wattage(self) -> None:
        with self.assertRaises(EnergyUnavailable) as caught:
            resolve_meter(None, root=self.root)
        self.assertIn("--assume-watts", str(caught.exception))

    def test_uses_the_declared_wattage_only_when_rapl_is_absent(self) -> None:
        meter = resolve_meter(20.0, root=self.root)
        self.assertIsInstance(meter, AssumedPowerMeter)

        make_zone(self.root, "intel-rapl:0", "package-0", 0)
        meter = resolve_meter(20.0, root=self.root)
        self.assertIsInstance(meter, RaplMeter)  # a real measurement beats an assumption

    def test_describe_sources(self) -> None:
        available, detail = describe_sources(self.root)
        self.assertFalse(available)
        make_zone(self.root, "intel-rapl:0", "package-0", 0)
        self.assertEqual(describe_sources(self.root), (True, "rapl:package-0"))


if __name__ == "__main__":
    unittest.main()
