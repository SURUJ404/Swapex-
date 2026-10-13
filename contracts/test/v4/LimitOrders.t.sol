// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolManager, SwapParams, ModifyLiquidityParams} from "../../src/v4/PoolManager.sol";
import {Router} from "../../src/v4/periphery/Router.sol";
import {AllowanceTransfer} from "../../src/v4/periphery/AllowanceTransfer.sol";
import {LimitOrders} from "../../src/v4/periphery/LimitOrders.sol";
import {currency} from "../../src/v4/types/Currency.sol";
import {PoolKey} from "../../src/v4/types/PoolKey.sol";
import {TickMath} from "../../src/libraries/TickMath.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockERC1271Wallet} from "../mocks/MockERC1271Wallet.sol";

uint160 constant Q96 = uint160(1 << 96);

/// @notice A.3 (signed limit orders, partial fills, cancel-by-nonce) coverage: every way a signed
///         order can be wrong must be rejected on-chain, and a correct one must move exactly what
///         was signed — at most `amountIn`, at least the signed rate, to the signed receiver.
contract LimitOrdersTest is Test {
    /// secp256k1 group order — used to construct the malleable (s, v) twin of a signature.
    uint256 internal constant N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    uint256 internal constant ALICE_PK = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    uint256 internal constant MALLORY_PK = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;

    PoolManager pm;
    Router router;
    AllowanceTransfer at;
    LimitOrders orders;
    MockERC20 tokenA;
    MockERC20 tokenB;
    MockERC20 tokenC;

    address alice;
    address mallory;
    address bob;

    function setUp() public {
        pm = new PoolManager();
        at = new AllowanceTransfer();
        router = new Router(pm, at);
        orders = new LimitOrders(router, at);
        tokenA = new MockERC20("A", "A", 18);
        tokenB = new MockERC20("B", "B", 18);
        tokenC = new MockERC20("C", "C", 18);

        alice = vm.addr(ALICE_PK);
        mallory = vm.addr(MALLORY_PK);
        bob = makeAddr("bob");

        // the maker: funded in tokenIn, the one-time outer ERC-20 approval, and a bounded grant
        // the orders contract may spend (exactly the two-layer flow the web app performs).
        tokenA.mint(alice, 1_000_000e18);
        vm.startPrank(alice);
        tokenA.approve(address(at), type(uint256).max);
        at.setAllowance(address(tokenA), address(orders), type(uint160).max, type(uint48).max);
        vm.stopPrank();

        // this contract seeds liquidity, so it needs both sides and its own router grant
        tokenA.mint(address(this), 1_000_000e18);
        tokenB.mint(address(this), 1_000_000e18);
        tokenA.approve(address(at), type(uint256).max);
        tokenB.approve(address(at), type(uint256).max);
        at.setAllowance(address(tokenA), address(router), type(uint160).max, type(uint48).max);
        at.setAllowance(address(tokenB), address(router), type(uint160).max, type(uint48).max);

        // deep 1:1 pool so the signed rate below is comfortably reachable: 1e23 liquidity holds
        // ~2.6e22 per side, making a 100e18 fill a ~0.4% trade (no meaningful price impact).
        PoolKey memory key = _key(address(tokenA), address(tokenB));
        router.initialize(key, Q96);
        router.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 1e23}), address(this)
        );
    }

    // ---------------------------------------------------------------- helpers

    function _key(address a, address b) internal pure returns (PoolKey memory) {
        (address lo, address hi) = a < b ? (a, b) : (b, a);
        return PoolKey({currency0: currency.wrap(lo), currency1: currency.wrap(hi), fee: 3000, tickSpacing: 60, hooks: address(0)});
    }

    /// @dev the canonical order every test starts from: alice sells 100 A for >= 95 B (a rate
    ///      the 1:1, 0.3%-fee pool clears with room), paid to bob, nonce 1, valid for a day.
    function _order() internal view returns (LimitOrders.Order memory) {
        return LimitOrders.Order({
            maker: alice,
            tokenIn: address(tokenA),
            tokenOut: address(tokenB),
            fee: 3000,
            amountIn: 100e18,
            minAmountOut: 95e18,
            receiver: bob,
            nonce: 1,
            deadline: uint48(block.timestamp + 1 days)
        });
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (uint8 v, bytes32 r, bytes32 s) {
        return vm.sign(pk, digest);
    }

    /// @dev a ready-to-submit 65-byte signature pinned to the canonical low-s branch.
    function _sigLow(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return _lowS(v, r, s);
    }

    function _lowS(uint8 v, bytes32 r, bytes32 s) internal pure returns (bytes memory) {
        uint256 sU = uint256(s);
        if (sU > N / 2) return abi.encodePacked(r, bytes32(N - sU), v == 27 ? uint8(28) : uint8(27));
        return abi.encodePacked(r, s, v);
    }

    function _highS(uint8 v, bytes32 r, bytes32 s) internal pure returns (bytes memory) {
        uint256 sU = uint256(s);
        if (sU > N / 2) return abi.encodePacked(r, s, v);
        return abi.encodePacked(r, bytes32(N - sU), v == 27 ? uint8(28) : uint8(27));
    }

    function _signOrder(LimitOrders.Order memory o, uint256 pk) internal view returns (bytes memory) {
        return _sigLow(pk, orders.hashOrder(o));
    }

    function _expectInvalid(address signer) internal {
        vm.expectRevert(abi.encodeWithSelector(LimitOrders.InvalidSignature.selector, signer));
    }

    function _fill(LimitOrders.Order memory o, uint256 amount, bytes memory sig) internal returns (uint256) {
        return orders.fillOrder(o, _key(o.tokenIn, o.tokenOut), amount, sig);
    }

    // ================================================================ the happy paths

    function test_fillOrder_fullFill_landsAtTheSignedRate() public {
        LimitOrders.Order memory o = _order();
        bytes memory sig = _signOrder(o, ALICE_PK);

        uint256 aliceBefore = tokenA.balanceOf(alice);
        uint256 bobBefore = tokenB.balanceOf(bob);
        uint256 fillerBefore = tokenB.balanceOf(address(this));

        vm.expectEmit(true, true, true, false, address(orders));
        emit LimitOrders.OrderFilled(alice, 1, address(this), 100e18, 0, bob);
        uint256 amountOut = _fill(o, 100e18, sig);

        assertEq(tokenA.balanceOf(alice), aliceBefore - 100e18, "maker debited exactly the signed amountIn");
        assertEq(tokenB.balanceOf(bob), bobBefore + amountOut, "output paid to the signed receiver");
        assertGt(amountOut, o.minAmountOut, "signed floor cleared");
        assertEq(tokenB.balanceOf(address(this)), fillerBefore, "the filler earns nothing by calling");
        assertEq(tokenB.balanceOf(address(orders)), 0, "orders contract holds nothing after settlement");
        assertEq(tokenB.balanceOf(address(router)), 0, "router holds nothing after settlement");
        assertEq(orders.filled(alice, 1), 100e18, "fully filled");
    }

    function test_fillOrder_partialFills_accumulateUpToAmountIn() public {
        LimitOrders.Order memory o = _order();
        bytes memory sig = _signOrder(o, ALICE_PK);
        uint256 bobBefore = tokenB.balanceOf(bob);

        uint256 out1 = _fill(o, 40e18, sig);
        uint256 out2 = _fill(o, 60e18, sig);
        assertGe(out1, (o.minAmountOut * 40e18) / o.amountIn, "first partial cleared its scaled floor");
        assertGe(out2, (o.minAmountOut * 60e18) / o.amountIn, "second partial cleared its scaled floor");
        assertEq(orders.filled(alice, 1), 100e18, "two partials sum to amountIn");
        assertEq(tokenA.balanceOf(alice), 1_000_000e18 - 100e18, "maker debited the sum");
        assertGe(tokenB.balanceOf(bob) - bobBefore, o.minAmountOut, "signed floor holds across the two fills");

        // replaying the same signed order beyond amountIn is refused, not double-paid
        vm.expectRevert(abi.encodeWithSelector(LimitOrders.FillExceedsRemaining.selector, 1e18, 0));
        _fill(o, 1e18, sig);
    }

    function test_fillOrder_overfillRevertsWhileRemainderStands() public {
        LimitOrders.Order memory o = _order();
        bytes memory sig = _signOrder(o, ALICE_PK);

        _fill(o, 60e18, sig);
        vm.expectRevert(abi.encodeWithSelector(LimitOrders.FillExceedsRemaining.selector, 50e18, 40e18));
        _fill(o, 50e18, sig);
    }

    function test_fillOrder_anyoneCanFill_remainderGoesToTheNextCaller() public {
        LimitOrders.Order memory o = _order();
        bytes memory sig = _signOrder(o, ALICE_PK);
        uint256 bobBefore = tokenB.balanceOf(bob);

        address filler1 = makeAddr("filler1");
        address filler2 = makeAddr("filler2");
        vm.prank(filler1);
        uint256 out1 = _fill(o, 30e18, sig);
        vm.prank(filler2);
        uint256 out2 = _fill(o, 70e18, sig);

        assertGt(out1 + out2, 0, "permissionless fills produce output");
        assertGe(tokenB.balanceOf(bob) - bobBefore, o.minAmountOut, "signed floor holds across fillers");
        assertEq(tokenB.balanceOf(filler1), 0, "filler 1 paid nothing to itself");
        assertEq(tokenB.balanceOf(filler2), 0, "filler 2 paid nothing to itself");
    }

    // ================================================================ signature attacks

    function test_fillOrder_wrongSigner_reverts() public {
        LimitOrders.Order memory o = _order();
        bytes memory sig = _signOrder(o, MALLORY_PK);
        _expectInvalid(alice);
        _fill(o, 100e18, sig);
    }

    function test_fillOrder_crossChainReplay_reverts() public {
        LimitOrders.Order memory o = _order();
        bytes memory sig = _signOrder(o, ALICE_PK);
        // sign on one chain, replay the identical bytes on another: the EIP-712 domain's chainId
        // makes the digest — and therefore the recovered signer — different. Fork-free by design.
        vm.chainId(999);
        _expectInvalid(alice);
        _fill(o, 100e18, sig);
    }

    function test_fillOrder_wrongVerifyingContract_reverts() public {
        LimitOrders.Order memory o = _order();
        LimitOrders orders2 = new LimitOrders(router, at); // a look-alike deployment
        bytes memory sig = _sigLow(ALICE_PK, orders2.hashOrder(o)); // signed for the other domain
        _expectInvalid(alice);
        _fill(o, 100e18, sig);
    }

    function test_fillOrder_expired_reverts() public {
        LimitOrders.Order memory o = _order();
        bytes memory sig = _signOrder(o, ALICE_PK);
        vm.warp(uint256(o.deadline) + 1);
        vm.expectRevert(abi.encodeWithSelector(LimitOrders.OrderExpired.selector, o.deadline));
        _fill(o, 100e18, sig);
    }

    function test_fillOrder_malleableHighS_twinReverts() public {
        LimitOrders.Order memory o = _order();
        bytes32 digest = orders.hashOrder(o);
        (uint8 v, bytes32 r, bytes32 s) = _sign(ALICE_PK, digest);
        // the malleable twin recovers to alice under raw ecrecover but fails OZ's low-s check:
        // a signature must have exactly one valid encoding or identity-based checks are bypassable.
        _expectInvalid(alice);
        _fill(o, 100e18, _highS(v, r, s));
    }

    function test_fillOrder_canonicalLowS_succeeds() public {
        LimitOrders.Order memory o = _order();
        bytes32 digest = orders.hashOrder(o);
        (uint8 v, bytes32 r, bytes32 s) = _sign(ALICE_PK, digest);
        uint256 bobBefore = tokenB.balanceOf(bob);
        _fill(o, 100e18, _lowS(v, r, s));
        assertGt(tokenB.balanceOf(bob), bobBefore, "canonical encoding accepted");
    }

    function test_fillOrder_acceptsThe65ByteFormAndRejectsThe64ByteCompactForm() public {
        LimitOrders.Order memory o = _order();
        bytes32 digest = orders.hashOrder(o);
        (uint8 v, bytes32 r, bytes32 s) = _sign(ALICE_PK, digest);

        (bytes32 sC, uint8 vC) = uint256(s) > N / 2
            ? (bytes32(N - uint256(s)), v == 27 ? uint8(28) : uint8(27))
            : (s, v);
        bytes memory canonical65 = abi.encodePacked(r, sC, vC);
        bytes memory compact64 = abi.encodePacked(r, bytes32(uint256(sC) | ((uint256(vC) - 27) << 255)));
        assertEq(canonical65.length, 65, "65-byte form");
        assertEq(compact64.length, 64, "EIP-2098 is 64 bytes");

        // only the canonical 65-byte (r, s, v) encoding is accepted — see CRYPTO_DECISIONS A.2:
        // accepting 64 bytes would mean hand-rolling (r, vs) unpacking in the verification path.
        _expectInvalid(alice);
        _fill(o, 100e18, compact64);

        uint256 bobBefore = tokenB.balanceOf(bob);
        _fill(o, 100e18, canonical65);
        assertGt(tokenB.balanceOf(bob), bobBefore, "identical signer+digest accepted in 65-byte form");
    }

    function test_fillOrder_tamperedReceiver_reverts() public {
        LimitOrders.Order memory o = _order();
        bytes memory sig = _signOrder(o, ALICE_PK);
        o.receiver = mallory; // redirect the payout after signing
        _expectInvalid(alice);
        _fill(o, 100e18, sig);
    }

    function test_fillOrder_nonceReusedForDifferentOrder_reverts() public {
        LimitOrders.Order memory o1 = _order();
        bytes memory sig1 = _signOrder(o1, ALICE_PK);
        _fill(o1, 100e18, sig1);

        LimitOrders.Order memory o2 = _order();
        o2.amountIn = 50e18; // a genuinely different order on the same nonce
        bytes memory sig2 = _signOrder(o2, ALICE_PK);
        vm.expectRevert(abi.encodeWithSelector(LimitOrders.NonceReusedForDifferentOrder.selector, alice, 1));
        _fill(o2, 50e18, sig2);
    }

    // ================================================================ ERC-1271 contract wallets

    function _wallet() internal returns (MockERC1271Wallet w) {
        w = new MockERC1271Wallet(alice); // alice's smart-contract wallet
        tokenA.mint(address(w), 1_000e18);
        vm.startPrank(address(w)); // the wallet grants the outer approval and the orders spend right
        tokenA.approve(address(at), type(uint256).max);
        at.setAllowance(address(tokenA), address(orders), type(uint160).max, type(uint48).max);
        vm.stopPrank();
    }

    function _walletOrder(address maker) internal view returns (LimitOrders.Order memory o) {
        o = _order();
        o.maker = maker;
        o.amountIn = 100e18;
    }

    function test_fillOrder_erc1271Wallet_validSignature() public {
        MockERC1271Wallet w = _wallet();
        LimitOrders.Order memory o = _walletOrder(address(w));
        bytes memory sig = _sigLow(ALICE_PK, orders.hashOrder(o)); // the wallet's owner signs

        uint256 out = _fill(o, 100e18, sig);
        assertGt(out, 0, "contract wallet order filled");
        assertEq(orders.filled(address(w), 1), 100e18, "accounted against the wallet");
    }

    function test_fillOrder_erc1271Wallet_invalidReply_reverts() public {
        MockERC1271Wallet w = _wallet();
        w.setMode(1); // wallet answers "not valid"
        LimitOrders.Order memory o = _walletOrder(address(w));
        bytes memory sig = _sigLow(ALICE_PK, orders.hashOrder(o));

        _expectInvalid(address(w));
        _fill(o, 100e18, sig);
    }

    function test_fillOrder_erc1271Wallet_revertingWallet_revertsAsInvalid() public {
        MockERC1271Wallet w = _wallet();
        w.setMode(2); // wallet throws instead of answering
        LimitOrders.Order memory o = _walletOrder(address(w));
        bytes memory sig = _sigLow(ALICE_PK, orders.hashOrder(o));

        _expectInvalid(address(w));
        _fill(o, 100e18, sig);
    }

    // ================================================================ cancel-by-nonce

    function test_cancel_killsAPendingOrder() public {
        LimitOrders.Order memory o = _order();
        bytes memory sig = _signOrder(o, ALICE_PK);

        vm.prank(alice);
        orders.cancel(o.nonce);
        assertTrue(orders.canceled(alice, o.nonce), "cancel recorded");

        vm.expectRevert(abi.encodeWithSelector(LimitOrders.OrderCanceledError.selector, alice, o.nonce));
        _fill(o, 100e18, sig);
    }

    function test_cancel_killsTheRemainderOfAPartiallyFilledOrder() public {
        LimitOrders.Order memory o = _order();
        bytes memory sig = _signOrder(o, ALICE_PK);
        _fill(o, 40e18, sig);

        vm.prank(alice);
        orders.cancel(o.nonce);
        vm.expectRevert(abi.encodeWithSelector(LimitOrders.OrderCanceledError.selector, alice, o.nonce));
        _fill(o, 60e18, sig);
    }

    function test_cancel_isScopedToTheCallerNonce() public {
        LimitOrders.Order memory o = _order();
        bytes memory sig = _signOrder(o, ALICE_PK);

        // mallory "cancels" nonce 1 — but it binds to mallory's own nonces, not alice's
        vm.prank(mallory);
        orders.cancel(o.nonce);
        assertFalse(orders.canceled(alice, o.nonce), "alice's nonce untouched");

        uint256 out = _fill(o, 100e18, sig);
        assertGt(out, 0, "alice's order still fillable");
    }

    // ================================================================ order shape checks

    function test_fillOrder_poolFeeMismatch_reverts() public {
        LimitOrders.Order memory o = _order();
        bytes memory sig = _signOrder(o, ALICE_PK);
        PoolKey memory key = _key(address(tokenA), address(tokenB));
        key.fee = 500; // not the signed fee
        vm.expectRevert(LimitOrders.PoolMismatch.selector);
        orders.fillOrder(o, key, 100e18, sig);
    }

    function test_fillOrder_wrongTokenPair_reverts() public {
        LimitOrders.Order memory o = _order();
        bytes memory sig = _signOrder(o, ALICE_PK);
        PoolKey memory key = _key(address(tokenA), address(tokenC)); // signed pair was A/B
        vm.expectRevert(LimitOrders.PoolMismatch.selector);
        orders.fillOrder(o, key, 100e18, sig);
    }

    function test_fillOrder_nativeInputNotSupported_reverts() public {
        LimitOrders.Order memory o = _order();
        o.tokenIn = address(0);
        bytes memory sig = _signOrder(o, ALICE_PK);
        vm.expectRevert(LimitOrders.NativeInputNotSupported.selector);
        _fill(o, 100e18, sig);
    }

    function test_fillOrder_zeroFill_reverts() public {
        LimitOrders.Order memory o = _order();
        bytes memory sig = _signOrder(o, ALICE_PK);
        vm.expectRevert(LimitOrders.ZeroFill.selector);
        _fill(o, 0, sig);
    }

    function test_fillOrder_zeroAmountIn_reverts() public {
        LimitOrders.Order memory o = _order();
        o.amountIn = 0;
        bytes memory sig = _signOrder(o, ALICE_PK);
        vm.expectRevert(LimitOrders.ZeroAmountIn.selector);
        _fill(o, 1, sig);
    }

    function test_fillOrder_unreachableSignedRate_reverts() public {
        LimitOrders.Order memory o = _order();
        o.minAmountOut = 1_000e18; // demand 10x the pool can pay for 100 in
        bytes memory sig = _signOrder(o, ALICE_PK);
        vm.expectRevert();
        _fill(o, 100e18, sig);
        assertEq(orders.filled(alice, 1), 0, "a failed fill records nothing");
        assertEq(tokenA.balanceOf(alice), 1_000_000e18, "maker uncharged on failure");
    }

    function test_fillOrder_withoutMakerGrant_reverts() public {
        // mallory has funds and the outer approval but never granted the orders contract a spend
        tokenA.mint(mallory, 1_000e18);
        vm.startPrank(mallory);
        tokenA.approve(address(at), type(uint256).max);
        vm.stopPrank();

        LimitOrders.Order memory o = _order();
        o.maker = mallory;
        bytes memory sig = _signOrder(o, MALLORY_PK);
        vm.expectRevert();
        _fill(o, 100e18, sig);
    }

    // ================================================================ fuzz (run with --fuzz-runs 5000)

    function testFuzz_fillOrder_anySplitFillsTheWholeOrder(uint96 first) public {
        uint256 total = 100e18;
        // both legs >= 1e3 base units: a dust fill pays the pool fee + integer rounding on a
        // tiny notional and genuinely cannot clear the signed rate, so the contract refuses it —
        // correct behaviour (the maker loses nothing; the filler just can't execute dust).
        uint256 a = bound(uint256(first), 1e3, total - 1e3);
        uint256 b = total - a;

        LimitOrders.Order memory o = _order();
        bytes memory sig = _signOrder(o, ALICE_PK);
        uint256 aliceBefore = tokenA.balanceOf(alice);
        uint256 bobBefore = tokenB.balanceOf(bob);

        uint256 out1 = _fill(o, a, sig);
        uint256 out2 = _fill(o, b, sig);

        // conservation: the maker pays exactly amountIn across the splits, the receiver gets at
        // least the signed rate in total, and each split individually cleared its scaled floor.
        assertEq(aliceBefore - tokenA.balanceOf(alice), total, "maker paid exactly amountIn");
        assertGe(tokenB.balanceOf(bob) - bobBefore, o.minAmountOut, "signed floor held across the split");
        assertGe(out1, (o.minAmountOut * a) / total, "first split cleared its scaled floor");
        assertGe(out2, (o.minAmountOut * b) / total, "second split cleared its scaled floor");
        assertEq(orders.filled(alice, 1), total, "accounting closed at amountIn");
    }

    function testFuzz_orderTamperingBreaksTheSignature(uint96 delta) public {
        uint256 d = bound(uint256(delta), 1, 1e24);
        LimitOrders.Order memory o = _order();
        bytes memory sig = _signOrder(o, ALICE_PK);

        o.amountIn += d; // any change to a signed field invalidates the digest
        _expectInvalid(alice);
        _fill(o, 1, sig);
    }
}
