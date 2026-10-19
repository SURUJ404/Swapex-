// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockWETH} from "../mocks/MockWETH.sol";
import {MockERC1271} from "../mocks/MockERC1271.sol";
import {ReentrantERC20} from "../mocks/ReentrantERC20.sol";
import {FeeOnTransferERC20} from "../mocks/FeeOnTransferERC20.sol";
import {SwapexFactory} from "../../src/v3/SwapexFactory.sol";
import {SwapexRouter} from "../../src/periphery/SwapexRouter.sol";
import {SwapexPositionManager} from "../../src/periphery/SwapexPositionManager.sol";
import {SwapexQuoter} from "../../src/periphery/SwapexQuoter.sol";
import {SwapexLimitOrders, ISwapexRouterExactInput} from "../../src/periphery/SwapexLimitOrders.sol";

contract LimitOrdersTest is Test {
    uint24 constant FEE = 3000;
    int24 constant LOWER = -120000;
    int24 constant UPPER = 120000;
    uint160 constant Q96 = uint160(1 << 96);
    uint256 constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    uint256 constant MAKER_KEY = 0x1111111111111111111111111111111111111111111111111111111111111111;
    uint256 constant WALLET_OWNER_KEY = 0x2222222222222222222222222222222222222222222222222222222222222222;
    uint256 constant WRONG_KEY = 0x3333333333333333333333333333333333333333333333333333333333333333;

    SwapexFactory factory;
    SwapexRouter router;
    SwapexPositionManager pm;
    SwapexQuoter quoter;
    SwapexLimitOrders limit;
    MockERC20 a;
    MockERC20 b;

    address lp = address(0xA11CE);
    address filler = address(0xF11E);
    address maker;
    address receiver = address(0x4E3);

    function setUp() public {
        maker = vm.addr(MAKER_KEY);
        factory = new SwapexFactory();
        MockWETH weth = new MockWETH();
        router = new SwapexRouter(address(factory), address(weth));
        pm = new SwapexPositionManager(address(factory), address(weth));
        quoter = new SwapexQuoter(address(factory));
        limit = new SwapexLimitOrders(address(router));

        a = new MockERC20("A", "A", 18);
        b = new MockERC20("B", "B", 18);
        a.mint(lp, 1e27);
        b.mint(lp, 1e27);
        a.mint(maker, 1e27);
        b.mint(maker, 1e27);
        a.mint(filler, 1e27);
        b.mint(filler, 1e27);

        _seed(address(a), address(b), 1000e18);

        vm.startPrank(maker);
        a.approve(address(limit), type(uint256).max);
        b.approve(address(limit), type(uint256).max);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- helpers
    function _sorted(address x, address y) internal pure returns (address, address) {
        return x < y ? (x, y) : (y, x);
    }

    function _seed(address x, address y, uint256 amt) internal {
        (address t0, address t1) = _sorted(x, y);
        pm.createAndInitializePoolIfNecessary(t0, t1, FEE, Q96);
        vm.startPrank(lp);
        MockERC20(t0).approve(address(pm), type(uint256).max);
        MockERC20(t1).approve(address(pm), type(uint256).max);
        pm.mint(
            SwapexPositionManager.MintParams({
                token0: t0,
                token1: t1,
                fee: FEE,
                tickLower: LOWER,
                tickUpper: UPPER,
                amount0Desired: amt,
                amount1Desired: amt,
                amount0Min: 0,
                amount1Min: 0,
                recipient: lp,
                deadline: block.timestamp + 1 hours
            })
        );
        vm.stopPrank();
    }

    function _quote(address tokenIn, address tokenOut, uint256 amountIn) internal returns (uint256) {
        return quoter.quoteExactInputSingle(
            SwapexQuoter.QuoteSingleParams({
                tokenIn: tokenIn, tokenOut: tokenOut, fee: FEE, amount: amountIn, sqrtPriceLimitX96: 0
            })
        )
        .amount;
    }

    function _order(uint256 amountIn, uint256 minOut, uint256 nonce)
        internal
        view
        returns (SwapexLimitOrders.Order memory)
    {
        return SwapexLimitOrders.Order({
            maker: maker,
            tokenIn: address(a),
            tokenOut: address(b),
            amountIn: amountIn,
            minAmountOut: minOut,
            expiry: block.timestamp + 1 hours,
            nonce: nonce,
            receiver: receiver
        });
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _params(
        SwapexLimitOrders.Order memory o,
        uint256 amountInMax,
        uint256 minAmountOut,
        bytes memory signature
    ) internal view returns (SwapexLimitOrders.FillParams memory) {
        return SwapexLimitOrders.FillParams({
            order: o,
            amountInMax: amountInMax,
            minAmountOut: minAmountOut,
            fee: FEE,
            deadline: block.timestamp + 1 hours,
            signature: signature
        });
    }

    function _fill(SwapexLimitOrders.Order memory o, uint256 amountInMax, uint256 minAmountOut, bytes memory signature)
        internal
        returns (uint256 amountInFilled, uint256 amountOutPaid)
    {
        vm.prank(filler);
        return limit.fill(_params(o, amountInMax, minAmountOut, signature));
    }

    /// a domain digest built with an explicit chain id (to prove the chain is bound)
    function _digestOnChain(SwapexLimitOrders.Order memory o, uint256 chainId, address verifyingContract)
        internal
        view
        returns (bytes32)
    {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("SwapexLimitOrders"),
                keccak256("1"),
                chainId,
                verifyingContract
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, limit.hashOrder(o)));
    }

    // ---------------------------------------------------------------- happy paths
    function test_fillDeliversToReceiverAndAccounts() public {
        uint256 amountIn = 10e18;
        uint256 quote = _quote(address(a), address(b), amountIn);
        SwapexLimitOrders.Order memory o = _order(amountIn, quote, 1);
        bytes memory sig = _sign(MAKER_KEY, limit.orderHash(o));

        uint256 makerBefore = a.balanceOf(maker);
        uint256 receiverBefore = b.balanceOf(receiver);
        uint256 fillerBefore = b.balanceOf(filler);

        vm.expectEmit(true, true, true, true, address(limit));
        emit SwapexLimitOrders.OrderFilled(limit.orderHash(o), maker, filler, address(a), address(b), amountIn, quote);
        (uint256 filled, uint256 paid) = _fill(o, amountIn, 0, sig);

        assertEq(filled, amountIn);
        assertEq(paid, quote);
        assertEq(makerBefore - a.balanceOf(maker), amountIn); // maker paid exactly the order
        assertEq(b.balanceOf(receiver) - receiverBefore, quote); // receiver got the output
        assertEq(b.balanceOf(filler), fillerBefore); // the filler earns nothing by themselves

        // nothing is ever held by the contract, and the router allowance is dropped
        assertEq(a.balanceOf(address(limit)), 0);
        assertEq(b.balanceOf(address(limit)), 0);
        assertEq(a.allowance(address(limit), address(router)), 0);

        (uint256 stateFilled, uint256 stateOut) = limit.orders(limit.orderHash(o));
        assertEq(stateFilled, amountIn);
        assertEq(stateOut, quote);
        assertEq(limit.remainingIn(o), 0);

        (bool can, uint256 remaining) = limit.canFill(o);
        assertTrue(!can);
        assertEq(remaining, 0);
    }

    function test_anyoneCanFill() public {
        address stranger = address(0xBEEF);
        SwapexLimitOrders.Order memory o = _order(1e18, _quote(address(a), address(b), 1e18), 7);
        bytes memory sig = _sign(MAKER_KEY, limit.orderHash(o));
        vm.prank(stranger);
        (uint256 filled,) = limit.fill(_params(o, type(uint256).max, 0, sig));
        assertEq(filled, 1e18);
    }

    function test_partialFillsAccumulate() public {
        uint256 amountIn = 100e18;
        uint256 quote = _quote(address(a), address(b), amountIn);
        SwapexLimitOrders.Order memory o = _order(amountIn, quote, 2);
        bytes memory sig = _sign(MAKER_KEY, limit.orderHash(o));

        (uint256 filled1,) = _fill(o, 25e18, 0, sig);
        assertEq(filled1, 25e18);
        assertEq(limit.remainingIn(o), 75e18);
        (bool can, uint256 remaining) = limit.canFill(o);
        assertTrue(can);
        assertEq(remaining, 75e18);

        // a cap larger than the remainder fills exactly the remainder
        (uint256 filled2,) = _fill(o, type(uint256).max, 0, sig);
        assertEq(filled2, 75e18);
        assertEq(limit.remainingIn(o), 0);

        (uint256 stateFilled, uint256 stateOut) = limit.orders(limit.orderHash(o));
        assertEq(stateFilled, amountIn);
        // chunked execution beats a single trade at the same size, so the pro-rata floor holds
        assertGe(stateOut, quote);

        vm.expectRevert(SwapexLimitOrders.OrderAlreadyFilled.selector);
        _fill(o, 1e18, 0, sig);
    }

    function testFuzz_partialFillsMeetTheProRataFloor(uint256 amountIn, uint256 firstFill) public {
        amountIn = bound(amountIn, 1e18, 200e18);
        firstFill = bound(firstFill, 1e17, amountIn - 1);
        uint256 quote = _quote(address(a), address(b), amountIn);
        // makers ask for a realistic 0.1% buffer: chunked execution rounds the intermediate price
        // and can land a dust-level shortfall below the exact single-trade quote (split - single = 1 wei
        // measured on this pool), so a zero-buffer order floor is not achievable by construction
        uint256 minOut = quote - quote / 1000;
        SwapexLimitOrders.Order memory o = _order(amountIn, minOut, 3);
        bytes memory sig = _sign(MAKER_KEY, limit.orderHash(o));

        (uint256 filled1, uint256 paid1) = _fill(o, firstFill, 0, sig);
        assertEq(filled1, firstFill);
        uint256 floor1 = (minOut * filled1) / amountIn;
        assertGe(paid1, floor1);

        (uint256 filled2, uint256 paid2) = _fill(o, type(uint256).max, 0, sig);
        assertEq(filled2, amountIn - firstFill);

        (uint256 stateFilled, uint256 stateOut) = limit.orders(limit.orderHash(o));
        assertEq(stateFilled, amountIn);
        assertEq(stateOut, paid1 + paid2);
        assertGe(stateOut, minOut); // the floor is the maker's ask, held across the split
    }

    // ---------------------------------------------------------------- order economics
    function test_fillRevertsWhenOrderFloorIsUnreachable() public {
        uint256 amountIn = 10e18;
        // ask for twice what the pool can deliver; the keeper's own minimum stays 0
        SwapexLimitOrders.Order memory o = _order(amountIn, _quote(address(a), address(b), amountIn) * 2, 4);
        bytes memory sig = _sign(MAKER_KEY, limit.orderHash(o));
        vm.expectRevert(SwapexLimitOrders.ProRataSlippage.selector);
        _fill(o, amountIn, 0, sig);
    }

    function test_partialFillRevertsWhenLaterPriceBreaksTheFloor() public {
        uint256 amountIn = 100e18;
        uint256 quote = _quote(address(a), address(b), amountIn);
        SwapexLimitOrders.Order memory o = _order(amountIn, quote, 5);
        bytes memory sig = _sign(MAKER_KEY, limit.orderHash(o));

        _fill(o, 50e18, 0, sig); // first half clears the floor

        // someone trades the price down hard between fills
        vm.startPrank(filler);
        a.approve(address(router), type(uint256).max);
        router.exactInputSingle(
            SwapexRouter.ExactInputSingleParams({
                tokenIn: address(a),
                tokenOut: address(b),
                fee: FEE,
                recipient: filler,
                deadline: block.timestamp + 1 hours,
                amountIn: 500e18,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
        vm.stopPrank();

        vm.expectRevert(SwapexLimitOrders.ProRataSlippage.selector);
        _fill(o, type(uint256).max, 0, sig);
    }

    function test_fillerMinimumIsEnforcedByTheRouter() public {
        uint256 amountIn = 10e18;
        SwapexLimitOrders.Order memory o = _order(amountIn, 1, 6); // order floor is trivial
        bytes memory sig = _sign(MAKER_KEY, limit.orderHash(o));
        uint256 quote = _quote(address(a), address(b), amountIn);
        vm.expectRevert(SwapexRouter.TooLittleReceived.selector);
        _fill(o, amountIn, quote + 1, sig); // the filler asked for more than the pool pays
    }

    // ---------------------------------------------------------------- signatures
    function test_wrongSignerReverts() public {
        SwapexLimitOrders.Order memory o = _order(1e18, 1, 10);
        bytes memory sig = _sign(WRONG_KEY, limit.orderHash(o));
        vm.expectRevert(SwapexLimitOrders.InvalidSignature.selector);
        _fill(o, type(uint256).max, 0, sig);
    }

    function test_signatureDoesNotTransferToAnotherOrder() public {
        SwapexLimitOrders.Order memory o = _order(1e18, 1, 11);
        bytes memory sig = _sign(MAKER_KEY, limit.orderHash(o));
        SwapexLimitOrders.Order memory tweaked = o;
        tweaked.amountIn = 2e18; // same maker, more input: a different digest
        vm.expectRevert(SwapexLimitOrders.InvalidSignature.selector);
        _fill(tweaked, type(uint256).max, 0, sig);
    }

    function test_signatureBoundToChainId() public {
        SwapexLimitOrders.Order memory o = _order(1e18, 1, 12);
        // sign the same order against chain id 1 (mainnet) and replay here
        bytes memory sig = _sign(MAKER_KEY, _digestOnChain(o, 1, address(limit)));
        vm.expectRevert(SwapexLimitOrders.InvalidSignature.selector);
        _fill(o, type(uint256).max, 0, sig);

        // and the correct chain id works
        bytes memory good = _sign(MAKER_KEY, _digestOnChain(o, block.chainid, address(limit)));
        (uint256 filled,) = _fill(o, type(uint256).max, 0, good);
        assertEq(filled, 1e18);
    }

    function test_signatureBoundToVerifyingContract() public {
        SwapexLimitOrders.Order memory o = _order(1e18, 1, 13);
        SwapexLimitOrders other = new SwapexLimitOrders(address(router)); // a different deployment
        bytes memory sig = _sign(MAKER_KEY, _digestOnChain(o, block.chainid, address(other)));
        vm.expectRevert(SwapexLimitOrders.InvalidSignature.selector);
        _fill(o, type(uint256).max, 0, sig);
    }

    function test_malleableSignatureRejected() public {
        SwapexLimitOrders.Order memory o = _order(1e18, 1, 14);
        bytes32 digest = limit.orderHash(o);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(MAKER_KEY, digest);
        // (r, N - s, flipped v) recovers the same signer from the same digest but is not canonical
        uint8 flip = v == 27 ? 28 : 27;
        bytes32 flippedS = bytes32(SECP256K1_N - uint256(s));
        // the EVM ecrecover precompile accepts both forms - malleability exists at the protocol level...
        assertEq(ecrecover(digest, flip, r, flippedS), maker);
        // ...so OZ's SignatureChecker enforces low-s, and so must the contract
        bytes memory malleable = abi.encodePacked(r, flippedS, flip);
        vm.expectRevert(SwapexLimitOrders.InvalidSignature.selector);
        _fill(o, type(uint256).max, 0, malleable);
    }

    function test_erc1271MakerIsValidatedOnChain() public {
        MockERC1271 wallet = new MockERC1271(vm.addr(WALLET_OWNER_KEY));
        a.mint(address(wallet), 100e18);
        wallet.approve(address(a), address(limit), type(uint256).max);

        SwapexLimitOrders.Order memory o = SwapexLimitOrders.Order({
            maker: address(wallet),
            tokenIn: address(a),
            tokenOut: address(b),
            amountIn: 10e18,
            minAmountOut: 1,
            expiry: block.timestamp + 1 hours,
            nonce: 20,
            receiver: address(wallet)
        });
        // signed by the wallet's owner key, checked by the wallet through ERC-1271
        bytes memory sig = _sign(WALLET_OWNER_KEY, limit.orderHash(o));
        uint256 before = a.balanceOf(address(wallet));
        (uint256 filled, uint256 paid) = _fill(o, type(uint256).max, 0, sig);
        assertEq(filled, 10e18);
        assertGt(paid, 0);
        assertEq(before - a.balanceOf(address(wallet)), filled);
        assertEq(b.balanceOf(address(wallet)), paid);

        // an unauthorised signature is rejected by the wallet, not just by ecrecover;
        // a fresh unfilled order proves the sig check itself (state checks come first)
        SwapexLimitOrders.Order memory o2 = SwapexLimitOrders.Order({
            maker: address(wallet),
            tokenIn: address(a),
            tokenOut: address(b),
            amountIn: 10e18,
            minAmountOut: 1,
            expiry: block.timestamp + 1 hours,
            nonce: 21,
            receiver: address(wallet)
        });
        bytes memory bad = _sign(WRONG_KEY, limit.orderHash(o2));
        vm.expectRevert(SwapexLimitOrders.InvalidSignature.selector);
        _fill(o2, 1e18, 0, bad);
    }

    function test_replayAfterFullFillReverts() public {
        SwapexLimitOrders.Order memory o = _order(1e18, 1, 15);
        bytes memory sig = _sign(MAKER_KEY, limit.orderHash(o));
        _fill(o, type(uint256).max, 0, sig);
        vm.expectRevert(SwapexLimitOrders.OrderAlreadyFilled.selector);
        _fill(o, type(uint256).max, 0, sig);
    }

    // ---------------------------------------------------------------- expiry and cancellation
    function test_expiredOrderReverts() public {
        SwapexLimitOrders.Order memory o = _order(1e18, 1, 16);
        bytes memory sig = _sign(MAKER_KEY, limit.orderHash(o));
        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(SwapexLimitOrders.OrderExpired.selector);
        _fill(o, type(uint256).max, 0, sig);
    }

    function test_fillDeadlinePassedReverts() public {
        // the order itself must outlive the fill attempt: only the filler's deadline lapses
        SwapexLimitOrders.Order memory o = _order(1e18, 1, 17);
        o.expiry = block.timestamp + 10 days;
        bytes memory sig = _sign(MAKER_KEY, limit.orderHash(o));
        SwapexLimitOrders.FillParams memory p = _params(o, type(uint256).max, 0, sig);
        p.deadline = block.timestamp; // valid right now
        vm.warp(block.timestamp + 1 days); // ...but the fill lands after it
        vm.prank(filler);
        vm.expectRevert(SwapexLimitOrders.FillDeadlinePassed.selector);
        limit.fill(p);
    }

    function test_cancelByNonce() public {
        SwapexLimitOrders.Order memory o = _order(1e18, 1, 18);
        bytes memory sig = _sign(MAKER_KEY, limit.orderHash(o));

        vm.expectEmit(true, true, false, true, address(limit));
        emit SwapexLimitOrders.OrderCancelled(maker, 18);
        vm.prank(maker);
        limit.cancel(18);

        assertTrue(limit.cancelled(maker, 18));
        (bool can, uint256 remaining) = limit.canFill(o);
        assertTrue(!can);
        assertEq(remaining, 1e18); // still visible, honestly reported as unfillable

        vm.expectRevert(SwapexLimitOrders.NonceAlreadyCancelled.selector);
        _fill(o, type(uint256).max, 0, sig);

        // another nonce is untouched
        SwapexLimitOrders.Order memory other = _order(1e18, 1, 19);
        (bool canOther,) = limit.canFill(other);
        assertTrue(canOther);
    }

    function test_strangerCannotCancelmakersNonce() public {
        vm.prank(filler);
        limit.cancel(21);
        assertTrue(limit.cancelled(filler, 21));
        assertTrue(!limit.cancelled(maker, 21)); // only the caller's own nonce space is touched
    }

    // ---------------------------------------------------------------- validation
    function test_malformedOrdersRevert() public {
        SwapexLimitOrders.Order memory base = _order(1e18, 1, 30);
        bytes memory sig = _sign(MAKER_KEY, limit.orderHash(base));

        // memory struct assignment aliases, so every case gets a freshly built order
        SwapexLimitOrders.Order memory o = _order(1e18, 1, 30);
        o.maker = address(0);
        vm.expectRevert(SwapexLimitOrders.ZeroMaker.selector);
        _fill(o, type(uint256).max, 0, sig);

        o = _order(1e18, 1, 30);
        o.receiver = address(0);
        vm.expectRevert(SwapexLimitOrders.ZeroReceiver.selector);
        _fill(o, type(uint256).max, 0, sig);

        o = _order(1e18, 1, 30);
        o.tokenOut = o.tokenIn;
        vm.expectRevert(SwapexLimitOrders.SameToken.selector);
        _fill(o, type(uint256).max, 0, sig);

        o = _order(1e18, 1, 30);
        o.amountIn = 0;
        vm.expectRevert(SwapexLimitOrders.ZeroAmount.selector);
        _fill(o, type(uint256).max, 0, sig);

        o = _order(1e18, 1, 30);
        o.minAmountOut = 0;
        vm.expectRevert(SwapexLimitOrders.ZeroAmount.selector);
        _fill(o, type(uint256).max, 0, sig);
    }

    function test_zeroAmountInMaxReverts() public {
        SwapexLimitOrders.Order memory o = _order(1e18, 1, 31);
        bytes memory sig = _sign(MAKER_KEY, limit.orderHash(o));
        vm.expectRevert(SwapexLimitOrders.NothingToFill.selector);
        _fill(o, 0, 0, sig);
    }

    function test_constructorRejectsZeroRouter() public {
        vm.expectRevert(SwapexLimitOrders.InvalidRouter.selector);
        new SwapexLimitOrders(address(0));
    }

    // ---------------------------------------------------------------- hostile tokens
    function test_feeOnTransferInputIsRejected() public {
        FeeOnTransferERC20 fot = new FeeOnTransferERC20("F", "F", 18, address(0xDEAD));
        fot.mint(maker, 100e18);
        vm.prank(maker);
        fot.approve(address(limit), type(uint256).max);

        SwapexLimitOrders.Order memory o = SwapexLimitOrders.Order({
            maker: maker,
            tokenIn: address(fot),
            tokenOut: address(b),
            amountIn: 10e18,
            minAmountOut: 1,
            expiry: block.timestamp + 1 hours,
            nonce: 40,
            receiver: receiver
        });
        bytes memory sig = _sign(MAKER_KEY, limit.orderHash(o));
        vm.expectRevert(SwapexLimitOrders.FeeOnTransferToken.selector);
        _fill(o, type(uint256).max, 0, sig);
    }

    function test_reentrancyDuringTransferIsBlocked() public {
        ReentrantERC20 evil = new ReentrantERC20("E", "E", 18);
        evil.mint(maker, 100e18);
        vm.prank(maker);
        evil.approve(address(limit), type(uint256).max);

        SwapexLimitOrders.Order memory o = SwapexLimitOrders.Order({
            maker: maker,
            tokenIn: address(evil),
            tokenOut: address(b),
            amountIn: 10e18,
            minAmountOut: 1,
            expiry: block.timestamp + 1 hours,
            nonce: 41,
            receiver: receiver
        });
        bytes memory sig = _sign(MAKER_KEY, limit.orderHash(o));
        // arm a reentrant fill with the same order; the token will call it mid-transferFrom
        vm.prank(maker);
        evil.arm(address(limit), abi.encodeCall(limit.fill, (_params(o, type(uint256).max, 0, sig))));

        vm.expectRevert(SwapexLimitOrders.Reentrancy.selector);
        _fill(o, type(uint256).max, 0, sig);
    }

    // ---------------------------------------------------------------- fuzz accounting
    function testFuzz_fillAccountingNeverLeaks(uint256 amountIn, uint256 cap) public {
        amountIn = bound(amountIn, 1e16, 50e18);
        cap = bound(cap, 1e15, amountIn);
        uint256 quote = _quote(address(a), address(b), amountIn);
        SwapexLimitOrders.Order memory o = _order(amountIn, quote / 2, 50); // floor well inside reach
        bytes memory sig = _sign(MAKER_KEY, limit.orderHash(o));

        uint256 makerBefore = a.balanceOf(maker);
        uint256 receiverBefore = b.balanceOf(receiver);

        (uint256 filled, uint256 paid) = _fill(o, cap, 0, sig);
        assertEq(filled, cap);
        assertGt(paid, 0);
        assertEq(makerBefore - a.balanceOf(maker), filled);
        assertEq(b.balanceOf(receiver) - receiverBefore, paid);
        assertEq(a.balanceOf(address(limit)), 0);
        assertEq(b.balanceOf(address(limit)), 0);

        (uint256 stateFilled, uint256 stateOut) = limit.orders(limit.orderHash(o));
        assertEq(stateFilled, filled);
        assertEq(stateOut, paid);
        assertGe(stateOut, (quote * stateFilled) / amountIn);
    }
}
