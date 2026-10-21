"""
Energy measurement for DAM nodes.

PoEEnergyMarket scores a block as verified work divided by the energy spent
producing it. The work is checked on chain; the energy has to be measured
here, at the machine. This module does that measuring, and it refuses to make
a number up.

Sources, in order of preference:

1. **RAPL** (Linux powercap, `/sys/class/powercap/intel-rapl:N`): hardware
   energy counters for each CPU package, on Intel and on recent AMD kernels.
   Only top-level `package-*` domains are summed. Sub-domains (`core`,
   `uncore`, `dram`) are already inside their package, and `psys` covers the
   whole platform including the packages, so adding either would count the
   same joules twice.
2. **An assumed wattage**, only when the caller passes one explicitly
   (`--assume-watts`). Energy is then `watts x wall-clock seconds`, and every
   reading says it is an estimate.

With neither available, `resolve_meter` raises `EnergyUnavailable` instead of
falling back to a proxy. The proxy this replaced, CPU utilisation, is how the
old metric came to reward idle machines.

Readings are whole-package energy over the measured window, so anything else
running on the machine inflates them. That error only ever makes a node look
less efficient, never more, and so do the other two choices here: millijoules
are rounded up, and a counter that did not advance is an error rather than a
zero. GPU energy (NVML) is not read, because nothing in this repository mines
on a GPU.
"""

from __future__ import annotations

import math
import re
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterator, List, Optional, Tuple

__all__ = [
    "POWERCAP_ROOT",
    "EnergyUnavailable",
    "EnergyReading",
    "Measurement",
    "RaplMeter",
    "AssumedPowerMeter",
    "resolve_meter",
    "describe_sources",
]

POWERCAP_ROOT = Path("/sys/class/powercap")

# Top-level package zones are `intel-rapl:<n>`; sub-zones add a second index.
_PACKAGE_ZONE = re.compile(r"^intel-rapl:\d+$")


class EnergyUnavailable(RuntimeError):
    """No energy source this module is willing to trust is available."""


@dataclass(frozen=True)
class EnergyReading:
    """Energy spent over one measured window."""

    milli_joules: int
    seconds: float
    source: str
    estimated: bool

    @property
    def joules(self) -> float:
        return self.milli_joules / 1000

    @property
    def watts(self) -> float:
        return self.joules / self.seconds if self.seconds > 0 else float("nan")

    def describe(self) -> str:
        kind = "ESTIMATED" if self.estimated else "measured"
        return (
            f"{self.joules:.3f} J over {self.seconds:.3f} s "
            f"(~{self.watts:.1f} W, {kind}, source={self.source})"
        )


class Measurement:
    """Handle yielded by a meter's `measure()`; `.reading` is set on exit."""

    def __init__(self) -> None:
        self.reading: Optional[EnergyReading] = None


def _ceil_div(numerator: int, divisor: int) -> int:
    """Integer division rounded up, so rounding can never flatter a node's efficiency."""

    return -(-numerator // divisor)


@dataclass(frozen=True)
class _RaplDomain:
    name: str
    energy_path: Path
    max_range_uj: int


def _discover_packages(root: Path) -> List[_RaplDomain]:
    if not root.is_dir():
        raise EnergyUnavailable(f"No powercap interface at {root} (not Linux, or RAPL not exposed).")

    domains: List[_RaplDomain] = []
    for zone in sorted(root.iterdir()):
        if not _PACKAGE_ZONE.match(zone.name):
            continue
        try:
            name = (zone / "name").read_text().strip()
        except OSError:
            continue
        if not name.startswith("package"):
            continue  # e.g. psys, which already contains the packages
        energy_path = zone / "energy_uj"
        try:
            max_range = int((zone / "max_energy_range_uj").read_text().strip())
            int(energy_path.read_text().strip())
        except PermissionError as error:
            raise EnergyUnavailable(
                f"RAPL counters exist but {energy_path} is not readable. Since Linux 5.10 "
                "they are root-only; run as root, or grant read access to energy_uj."
            ) from error
        except (OSError, ValueError):
            continue
        domains.append(_RaplDomain(name=name, energy_path=energy_path, max_range_uj=max_range))

    if not domains:
        raise EnergyUnavailable(f"No readable RAPL package domains under {root}.")
    return domains


class RaplMeter:
    """Sums package-level RAPL energy counters across a measured window."""

    estimated = False

    def __init__(self, root: Path = POWERCAP_ROOT, clock: Callable[[], float] = time.perf_counter) -> None:
        self.root = Path(root)
        self.clock = clock
        self.domains = _discover_packages(self.root)
        self.source = "rapl:" + "+".join(d.name for d in self.domains)

    def _read(self) -> List[int]:
        return [int(d.energy_path.read_text().strip()) for d in self.domains]

    @staticmethod
    def _delta(start: int, end: int, max_range: int) -> int:
        # The counter wraps at max_energy_range_uj. One wrap is recoverable;
        # several are not detectable, which bounds a window to well under one
        # wrap period (tens of minutes at typical package power).
        delta = end - start
        if delta < 0:
            delta += max_range
        return delta

    @contextmanager
    def measure(self) -> Iterator[Measurement]:
        handle = Measurement()
        start_counts = self._read()
        start_time = self.clock()
        yield handle
        elapsed = self.clock() - start_time
        end_counts = self._read()

        micro_joules = sum(
            self._delta(s, e, d.max_range_uj) for s, e, d in zip(start_counts, end_counts, self.domains)
        )
        if micro_joules <= 0:
            raise EnergyUnavailable(
                f"RAPL counters did not advance over {elapsed:.4f} s - the window was shorter than "
                "the counter resolution, or the counters are frozen. Refusing to report zero energy."
            )
        handle.reading = EnergyReading(
            milli_joules=_ceil_div(micro_joules, 1000),
            seconds=elapsed,
            source=self.source,
            estimated=False,
        )


class AssumedPowerMeter:
    """Energy as a declared constant wattage times wall-clock time. An estimate."""

    estimated = True

    def __init__(self, watts: float, clock: Callable[[], float] = time.perf_counter) -> None:
        if not math.isfinite(watts) or watts <= 0:
            raise ValueError(f"Assumed wattage must be a positive number, got {watts!r}.")
        self.watts = float(watts)
        self.clock = clock
        self.source = f"assumed:{self.watts:g}W"

    @contextmanager
    def measure(self) -> Iterator[Measurement]:
        handle = Measurement()
        start_time = self.clock()
        yield handle
        elapsed = self.clock() - start_time
        # watts * seconds = joules; x1000 for millijoules. At least 1 mJ, since
        # the chain rejects a zero reading and any real window cost something.
        milli_joules = max(1, math.ceil(self.watts * elapsed * 1000))
        handle.reading = EnergyReading(
            milli_joules=milli_joules,
            seconds=elapsed,
            source=self.source,
            estimated=True,
        )


def resolve_meter(assume_watts: Optional[float] = None, *, root: Path = POWERCAP_ROOT):
    """
    Return the best available meter.

    RAPL when this machine exposes it. Otherwise an AssumedPowerMeter, but
    only if `assume_watts` was given - the estimate has to be asked for, never
    defaulted into. Otherwise EnergyUnavailable, explaining both options.
    """

    try:
        return RaplMeter(root)
    except EnergyUnavailable as rapl_error:
        if assume_watts is None:
            raise EnergyUnavailable(
                f"Cannot measure energy on this machine: {rapl_error} "
                "Pass --assume-watts W to use a declared wattage instead; readings will then "
                "be labelled as estimates."
            ) from rapl_error
        return AssumedPowerMeter(assume_watts)


def describe_sources(root: Path = POWERCAP_ROOT) -> Tuple[bool, str]:
    """(available, explanation) for RAPL on this machine, for diagnostics."""

    try:
        meter = RaplMeter(root)
    except EnergyUnavailable as error:
        return False, str(error)
    return True, meter.source
