// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
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

    // ------------------------------------- ownership rehearsal (item 3: runbook, not design)
    // These are the literal calls a real deployment has to walk — deployer owns it, hands it to
    // the timelock, renounces the shortcut admin, and thereafter every privileged change waits
    // out the delay. If one of them stops working, the runbook in docs/SECURITY.md is wrong.

    function test_rehearsal_deployerHandsManagerToTheTimelock() public {
        PoolManager fresh = new PoolManager(address(this));
        assertEq(fresh.owner(), address(this), "deployer-owned, as Deploy.s.sol leaves it");

        // two-step handoff: the timelock has to accept, and only it can
        fresh.transferOwnership(address(timelock));
        assertEq(fresh.owner(), address(this), "deployer keeps control until acceptance");
        assertEq(fresh.pendingOwner(), address(timelock), "timelock is the pending owner");

        // accepting is itself a governed action — no shortcut around the delay
        bytes memory accept = abi.encodeCall(Ownable2Step.acceptOwnership, ());
        timelock.schedule(address(fresh), 0, accept, bytes32(0), bytes32(0), DELAY);
        vm.expectPartialRevert(TimelockController.TimelockUnexpectedOperationState.selector);
        timelock.execute(address(fresh), 0, accept, bytes32(0), bytes32(0));

        vm.warp(block.timestamp + DELAY);
        timelock.execute(address(fresh), 0, accept, bytes32(0), bytes32(0));
        assertEq(fresh.owner(), address(timelock), "handed over");
        assertEq(fresh.pendingOwner(), address(0), "pending cleared by acceptance");

        // the deployer is locked out for good
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        fresh.transferOwnership(ALICE);
    }

    function test_rehearsal_renounceAdminGovernanceSurvivesIt() public {
        assertTrue(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), address(this)));
        // TimelockController's own NatSpec: renounce the optional admin in favour of governance
        timelock.renounceRole(timelock.DEFAULT_ADMIN_ROLE(), address(this));
        assertFalse(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), address(this)), "shortcut admin gone");

        // a direct grant is impossible for anybody now...
        address outsider = makeAddr("outsider");
        bytes32 proposerRole = timelock.PROPOSER_ROLE(); // hoisted: expectRevert must see grantRole as the next call
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, address(this), timelock.DEFAULT_ADMIN_ROLE()
            )
        );
        timelock.grantRole(proposerRole, outsider);

        // ...but the lever still moves: the timelock itself is its own admin, and it only acts
        // through a queued operation. Governance is slower, not dead.
        bytes memory grant = abi.encodeCall(AccessControl.grantRole, (proposerRole, outsider));
        timelock.schedule(address(timelock), 0, grant, bytes32(0), bytes32(0), DELAY);
        vm.warp(block.timestamp + DELAY);
        timelock.execute(address(timelock), 0, grant, bytes32(0), bytes32(0));
        assertTrue(timelock.hasRole(timelock.PROPOSER_ROLE(), outsider), "role granted through governance");
    }

    function test_rehearsal_roleSeparation_proposerCannotExecute() public {
        // a timelock whose proposer and executor are deliberately *not* the same address
        address[] memory none = new address[](0);
        TimelockController split = new TimelockController(DELAY, none, none, address(this));
        address proposer = makeAddr("proposer");
        address executor = makeAddr("executor");
        address outsider = makeAddr("outsider");
        split.grantRole(split.PROPOSER_ROLE(), proposer);
        split.grantRole(split.CANCELLER_ROLE(), proposer);
        split.grantRole(split.EXECUTOR_ROLE(), executor);

        SwapexFactory f2 = new SwapexFactory(address(split));
        (address target, bytes memory data) = (address(f2), abi.encodeCall(SwapexFactory.enableFeeAmount, (100, int24(1))));
        bytes32 proposerRole = split.PROPOSER_ROLE();
        bytes32 executorRole = split.EXECUTOR_ROLE();

        // an outsider holds none of the three roles. (every cheatcode argument is hoisted: an
        // external call made while building expectRevert's or prank's arguments would itself
        // consume the pending prank and silently target the wrong sender)
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, outsider, proposerRole)
        );
        vm.prank(outsider);
        split.schedule(target, 0, data, bytes32(0), bytes32(0), DELAY);

        // the proposer queues it, but queueing is not applying
        vm.prank(proposer);
        split.schedule(target, 0, data, bytes32(0), bytes32(0), DELAY);
        assertTrue(split.isOperationPending(_opId(target, data)), "queued");

        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, proposer, executorRole)
        );
        vm.prank(proposer);
        split.execute(target, 0, data, bytes32(0), bytes32(0));
        assertEq(f2.feeAmountTickSpacing(100), 0, "proposer alone cannot apply anything");

        // the executor still owes the delay
        vm.expectPartialRevert(TimelockController.TimelockUnexpectedOperationState.selector);
        vm.prank(executor);
        split.execute(target, 0, data, bytes32(0), bytes32(0));

        vm.warp(block.timestamp + DELAY);
        vm.prank(executor);
        split.execute(target, 0, data, bytes32(0), bytes32(0));
        assertEq(f2.feeAmountTickSpacing(100), 1, "executor applied it after the delay");
    }

    function test_rehearsal_twoOfThreeMultisigDrivesTheTimelock() public {
        address[] memory none = new address[](0);
        TimelockController msigLock = new TimelockController(DELAY, none, none, address(this));

        address[] memory sigOwners = new address[](3);
        sigOwners[0] = makeAddr("sig1");
        sigOwners[1] = makeAddr("sig2");
        sigOwners[2] = makeAddr("sig3");
        MockMultisig msig = new MockMultisig(sigOwners, 2);

        // the timelock sees exactly one address; M-of-N is enforced inside it
        msigLock.grantRole(msigLock.PROPOSER_ROLE(), address(msig));
        msigLock.grantRole(msigLock.CANCELLER_ROLE(), address(msig));
        msigLock.grantRole(msigLock.EXECUTOR_ROLE(), address(msig));
        // hand administration over to governance and drop the shortcut
        msigLock.renounceRole(msigLock.DEFAULT_ADMIN_ROLE(), address(this));
        assertFalse(msigLock.hasRole(msigLock.DEFAULT_ADMIN_ROLE(), address(this)));

        SwapexFactory f2 = new SwapexFactory(address(msigLock));
        (address target, bytes memory data) = (address(f2), abi.encodeCall(SwapexFactory.enableFeeAmount, (100, int24(1))));

        bytes32 schedId = msig.operationId(msig.SCHEDULE(), target, 0, data, bytes32(0), bytes32(0));
        bytes32 execId = msig.operationId(msig.EXECUTE(), target, 0, data, bytes32(0), bytes32(0));
        // the *timelock's* operation id is a different hash — schedId/execId only gate the multisig
        bytes32 lockId = msigLock.hashOperation(target, 0, data, bytes32(0), bytes32(0));
        address stranger = makeAddr("stranger");

        // one signature — even from a legitimate owner — is not enough
        vm.prank(sigOwners[0]);
        msig.approve(schedId);
        vm.expectRevert(abi.encodeWithSelector(MockMultisig.ThresholdNotMet.selector, 1, 2));
        msig.schedule(msigLock, target, 0, data, bytes32(0), bytes32(0), DELAY);

        // a stranger has no vote at all
        vm.expectRevert(abi.encodeWithSelector(MockMultisig.NotAnOwner.selector, stranger));
        vm.prank(stranger);
        msig.approve(schedId);

        // the second signature carries it (relaying a fully-approved call is permissionless,
        // exactly as a Safe transaction can be submitted by anyone once it is confirmed)
        vm.prank(sigOwners[1]);
        msig.approve(schedId);
        msig.schedule(msigLock, target, 0, data, bytes32(0), bytes32(0), DELAY);
        assertTrue(msigLock.isOperationPending(lockId), "queued by 2-of-3");

        // still inside the delay, threshold met or not
        vm.prank(sigOwners[0]);
        msig.approve(execId);
        vm.prank(sigOwners[2]);
        msig.approve(execId);
        vm.expectPartialRevert(TimelockController.TimelockUnexpectedOperationState.selector);
        msig.execute(msigLock, target, 0, data, bytes32(0), bytes32(0));
        assertEq(f2.feeAmountTickSpacing(100), 0, "the delay still holds");

        // the failed attempt rolled back with it, so the same two confirmations carry the retry
        vm.warp(block.timestamp + DELAY);
        msig.execute(msigLock, target, 0, data, bytes32(0), bytes32(0));
        assertEq(f2.feeAmountTickSpacing(100), 1, "2-of-3 governed the change through the delay");

        // a consumed approval set cannot be replayed
        vm.expectRevert(abi.encodeWithSelector(MockMultisig.ThresholdNotMet.selector, 0, 2));
        msig.execute(msigLock, target, 0, data, bytes32(0), bytes32(0));
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

/// @dev Minimal M-of-N multisig stand-in for the ownership rehearsal. The timelock only ever
///      sees this one address, so "M of N must agree" has to be enforced here: each distinct
///      owner approves a proposal id, any owner can relay once the threshold is met, and a
///      successful relay burns the approval set so it cannot be replayed. A real deployment
///      would use an audited Safe — this exists purely so the rehearsal exercises the M-of-N
///      branch instead of assuming it.
contract MockMultisig {
    error NotAnOwner(address who);
    error ThresholdNotMet(uint256 approvals, uint256 threshold);

    bytes32 public constant SCHEDULE = keccak256("schedule");
    bytes32 public constant EXECUTE = keccak256("execute");

    uint256 public immutable threshold;
    address[] public owners;
    mapping(address => bool) public isOwner;
    mapping(bytes32 => uint256) public approvals;
    mapping(bytes32 => mapping(address => bool)) public hasApproved;

    constructor(address[] memory _owners, uint256 _threshold) {
        require(_threshold > 0 && _threshold <= _owners.length, "bad threshold");
        threshold = _threshold;
        for (uint256 i; i < _owners.length; ++i) {
            owners.push(_owners[i]);
            isOwner[_owners[i]] = true;
        }
    }

    function ownerCount() external view returns (uint256) {
        return owners.length;
    }

    /// @dev the id both signers and relayers work with — `kind` separates schedule from execute
    function operationId(bytes32 kind, address target, uint256 value, bytes memory data, bytes32 predecessor, bytes32 salt)
        public
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(address(this), block.chainid, kind, target, value, keccak256(data), predecessor, salt));
    }

    function approve(bytes32 id) external {
        if (!isOwner[msg.sender]) revert NotAnOwner(msg.sender);
        if (hasApproved[id][msg.sender]) return; // idempotent: re-signing after a rollback is free
        hasApproved[id][msg.sender] = true;
        approvals[id]++;
    }

    function schedule(
        TimelockController tl,
        address target,
        uint256 value,
        bytes calldata data,
        bytes32 predecessor,
        bytes32 salt,
        uint256 delay
    ) external {
        _consume(operationId(SCHEDULE, target, value, data, predecessor, salt));
        tl.schedule(target, value, data, predecessor, salt, delay);
    }

    function execute(TimelockController tl, address target, uint256 value, bytes calldata data, bytes32 predecessor, bytes32 salt)
        external
    {
        _consume(operationId(EXECUTE, target, value, data, predecessor, salt));
        tl.execute(target, value, data, predecessor, salt);
    }

    function _consume(bytes32 id) internal {
        uint256 got = approvals[id];
        if (got < threshold) revert ThresholdNotMet(got, threshold);
        approvals[id] = 0;
    }
}
