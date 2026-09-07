// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title Ownable2Step
 * @notice Shared, transferable ownership for DAM's administered contracts.
 *
 *  Every DAM contract with privileged setters used to declare its own `owner`
 *  and `onlyOwner` and offer no way to change either. On a real network that
 *  makes the deploying key the *permanent* administrator: no handover to a
 *  multisig, no rotation if the key leaks, no way to pass the project on.
 *  Contracts are immutable, so it is only fixable before deployment - the same
 *  gap `PoEGreenNode` had, found the same way, by trying to deploy.
 *
 *  The transfer is deliberately two-step. A single-step transfer to a mistyped
 *  or unreachable address hands administration to nobody, irreversibly, and
 *  that is exactly the transaction people get wrong when moving control to a
 *  freshly created multisig. Here the owner only nominates; ownership moves
 *  when the nominee proves it can transact by calling `acceptOwnership`.
 *
 *  There is deliberately no `renounceOwnership`. Every DAM contract needs a
 *  live owner - difficulty retargeting bounds, reporter rotation, fraud
 *  thresholds - so an owner-less contract is bricked, not decentralized.
 *
 *  `PoEGreenNode` intentionally does *not* inherit this. Its ownership is
 *  handed to `PoEConsensus`, a contract that cannot call `acceptOwnership`,
 *  so it keeps a single-step transfer for that machine-to-machine handover.
 */
abstract contract Ownable2Step {
    /// @notice Current administrator.
    address public owner;
    /// @notice Nominee that may take over by calling `acceptOwnership`.
    address public pendingOwner;

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not authorized");
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    /**
     * @notice Nominate a new owner. Ownership does not move until the nominee
     *         calls `acceptOwnership`, so a wrong address here is recoverable.
     */
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "New owner is the zero address");
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /**
     * @notice Complete a transfer previously nominated by the owner.
     */
    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "Not the pending owner");
        address previousOwner = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(previousOwner, owner);
    }

    /**
     * @notice Withdraw a pending nomination before it is accepted.
     */
    function cancelOwnershipTransfer() external onlyOwner {
        pendingOwner = address(0);
    }
}
