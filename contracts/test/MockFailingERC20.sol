// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

// A deliberately badly-behaved ERC20 for tests: `transfer` reports failure by
// returning false rather than reverting, which is legal ERC20 and exactly the
// case an unchecked `transfer()` return value would silently swallow. Used to
// prove PoEGreenNode.distributeBlockReward actually checks the return value.
contract MockFailingERC20 {
    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }
}
