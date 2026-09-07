// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "../PoEConsensus.sol";

// Test-only subclass that exposes PoEConsensus's internal retargeting
// arithmetic. The difficulty floor and ceiling cannot be reached through a
// real commitBlock - at the floor no proof is findable in a sane search - so
// the bounds and the overflow-safety of the scaling are checked directly here.
// Not part of the deployable DAM contracts.
contract PoEConsensusHarness is PoEConsensus {
    constructor(
        address _energyMarket,
        address _greenNode,
        uint256 _difficultyTarget,
        uint256 _normTarget,
        uint256 _hashDifficulty,
        uint256 _maxOE,
        uint256 _referenceTime
    )
        PoEConsensus(
            _energyMarket,
            _greenNode,
            _difficultyTarget,
            _normTarget,
            _hashDifficulty,
            _maxOE,
            _referenceTime
        )
    {}

    function scaleTarget(uint256 target, uint256 numerator, uint256 denominator)
        external
        pure
        returns (uint256)
    {
        return _scaleTarget(target, numerator, denominator);
    }
}
