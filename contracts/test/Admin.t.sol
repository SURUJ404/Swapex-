// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {PoolManager} from "../src/v4/PoolManager.sol";
import {SwapexFactory} from "../src/v3/SwapexFactory.sol";
import {currency} from "../src/v4/types/Currency.sol";
import {PoolKey} from "../src/v4/types/PoolKey.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

uint160 constant Q96 = uint160(1 << 96);

/// F.1 — two-step ownership and timelock-gated admin (docs/DECISIONS.md D29):
///  1. ownership transfers are two-step, so a mistyped transfer can never strand a contract;
///  2. every privileged admin call (`setProtocolFee`, `enableFeeAmount`) reverts unless the
///     caller *is* the timelock — and the timelock only acts through `schedule` + delay +
///     `execute`, with a queued operation killable by `cancel` at any point before execution.
contract AdminTest is Test {
    uint256 internal constant DELAY = 2 days;
    address internal constant ALICE = address(0xA11CE);

    TimelockController internal timelock;
    PoolManager internal pm;
    SwapexFactory internal factory;

    function setUp() public {
        address[] memory members = new address[](1);
        members[0] = address(this); // proposer + executor + admin, as in script/Deploy.s.sol
        timelock = new TimelockController(DELAY, members, members, address(this));
        // owner is the timelock from construction — never a pending-owner state
        pm = new PoolManager(address(timelock));
        factory = new SwapexFactory(address(timelock));
    }

    // ------------------------------------------------------- two-step ownership
    function test_ownership_pmTransferNeedsAcceptance() public {
        // mechanism test on a manager this contract actually owns (the suite's main manager is
        // timelock-owned, as in a real deployment)
        PoolManager mine = new PoolManager(address(this));
        mine.transferOwnership(ALICE);
        assertEq(mine.owner(), address(this), "owner unchanged until acceptance");
        assertEq(mine.pendingOwner(), ALICE, "pending owner recorded");
        vm.prank(ALICE);
        mine.acceptOwnership();
        assertEq(mine.owner(), ALICE);
        assertEq(mine.pendingOwner(), address(0), "pending cleared on acceptance");
    }

    function test_ownership_zeroAddressCannotBecomeOwner() public {
        // OZ v5 two-step: transferOwnership(0) merely cancels a pending transfer (documented
        // behaviour), and address(0) can never accept — so a zero-address owner is impossible.
        PoolManager mine = new PoolManager(address(this));
        mine.transferOwnership(ALICE);
        mine.transferOwnership(address(0));
        assertEq(mine.owner(), address(this), "owner unchanged by the zero transfer");
        assertEq(mine.pendingOwner(), address(0), "pending cleared");

        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, ALICE));
        mine.acceptOwnership(); // the previously named owner is stale now
        assertEq(mine.owner(), address(this), "still owned after the cancelled transfer");
    }

    function test_ownership_pmNonOwnerCannotTransfer() public {
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, ALICE));
        pm.transferOwnership(ALICE);
    }

    // --------------------------------------------------- direct admin rejected
    function test_admin_directProtocolFeeCallsRejected() public {
        PoolKey memory key = _initializedPool();
        // nobody but the timelock address itself may call — not a random address,
        // not even this (proposer/admin/executor) contract: governance only via `execute`.
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, ALICE));
        pm.setProtocolFee(key, 100000);

        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this))
        );
        pm.setProtocolFee(key, 100000);
        assertEq(pm.getProtocolFee(key), 0, "protocol fee untouched");
    }

    function test_admin_directEnableFeeAmountRejected() public {
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, ALICE));
        factory.enableFeeAmount(100, 1);
        assertEq(factory.feeAmountTickSpacing(100), 0, "fee tier untouched");
    }

    // ------------------------------------------------------ timelock: delay
    function test_timelock_earlyExecuteReverts() public {
        (address target, bytes memory data) = _enableFeeOp(100);
        bytes32 id = _opId(target, data);
        timelock.schedule(target, 0, data, bytes32(0), bytes32(0), DELAY);
        assertTrue(timelock.isOperationPending(id), "queued");

        // one second before the delay elapses the operation must not execute
        vm.warp(block.timestamp + DELAY - 1);
        vm.expectPartialRevert(TimelockController.TimelockUnexpectedOperationState.selector);
        timelock.execute(target, 0, data, bytes32(0), bytes32(0));
        assertEq(factory.feeAmountTickSpacing(100), 0, "still not applied");
    }

    function test_timelock_afterDelayExecutes() public {
        (address target, bytes memory data) = _enableFeeOp(100);
        timelock.schedule(target, 0, data, bytes32(0), bytes32(0), DELAY);

        vm.warp(block.timestamp + DELAY);
        timelock.execute(target, 0, data, bytes32(0), bytes32(0));
        assertEq(factory.feeAmountTickSpacing(100), 1, "fee tier applied post-delay");
    }

    function test_timelock_shorterDelayRejected() public {
        (address target, bytes memory data) = _enableFeeOp(100);
        vm.expectPartialRevert(TimelockController.TimelockInsufficientDelay.selector);
        timelock.schedule(target, 0, data, bytes32(0), bytes32(0), DELAY - 1);
    }

    function test_timelock_protocolFeeThroughTimelock() public {
        PoolKey memory key = _initializedPool();
        bytes memory data = abi.encodeCall(PoolManager.setProtocolFee, (key, 100000));
        timelock.schedule(address(pm), 0, data, bytes32(0), bytes32(0), DELAY);
        vm.warp(block.timestamp + DELAY);
        timelock.execute(address(pm), 0, data, bytes32(0), bytes32(0));
        assertEq(pm.getProtocolFee(key), 100000, "protocol fee set via governance");
    }

    // -------------------------------------------------- timelock: cancellation
    function test_timelock_cancelKillsQueuedOperation() public {
        (address target, bytes memory data) = _enableFeeOp(100);
        bytes32 id = _opId(target, data);
        timelock.schedule(target, 0, data, bytes32(0), bytes32(0), DELAY);

        // the proposal is pulled before the delay elapses (any CANCELLER_ROLE, here proposer)
        timelock.cancel(id);
        assertFalse(timelock.isOperation(id), "cancelled back to unset");

        vm.warp(block.timestamp + DELAY);
        vm.expectPartialRevert(TimelockController.TimelockUnexpectedOperationState.selector);
        timelock.execute(target, 0, data, bytes32(0), bytes32(0));
        assertEq(factory.feeAmountTickSpacing(100), 0, "cancelled op never applies");
    }

    // ------------------------------------------------------------- helpers
    function _enableFeeOp(uint24 fee) internal view returns (address, bytes memory) {
        return (address(factory), abi.encodeCall(SwapexFactory.enableFeeAmount, (fee, int24(1))));
    }

    function _opId(address target, bytes memory data) internal pure returns (bytes32) {
        return keccak256(abi.encode(target, uint256(0), data, bytes32(0), bytes32(0)));
    }

    /// @dev permissionless initialize so `setProtocolFee` has a pool to act on
    function _initializedPool() internal returns (PoolKey memory key) {
        MockERC20 a = new MockERC20("Token A", "TKA", 18);
        MockERC20 b = new MockERC20("Token B", "TKB", 18);
        (address lo, address hi) = address(a) < address(b) ? (address(a), address(b)) : (address(b), address(a));
        key = PoolKey({
            currency0: currency.wrap(lo),
            currency1: currency.wrap(hi),
            fee: 3000,
            tickSpacing: 60,
            hooks: address(0)
        });
        pm.initialize(key, Q96);
    }
}
