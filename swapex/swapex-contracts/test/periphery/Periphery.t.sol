// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockWETH} from "../mocks/MockWETH.sol";
import {SwapexFactory} from "../../src/v3/SwapexFactory.sol";
import {SwapexPool} from "../../src/v3/SwapexPool.sol";
import {SwapexRouter} from "../../src/periphery/SwapexRouter.sol";
import {SwapexPositionManager} from "../../src/periphery/SwapexPositionManager.sol";
import {SwapexQuoter} from "../../src/periphery/SwapexQuoter.sol";
import {PeripheryBase} from "../../src/periphery/PeripheryBase.sol";
import {ERC721Minimal} from "../../src/periphery/ERC721Minimal.sol";

contract PeripheryTest is Test {
    uint24 constant FEE = 3000;
    int24 constant LOWER = -120000; // multiples of the 60 tick spacing
    int24 constant UPPER = 120000;
    uint160 constant Q96 = uint160(1 << 96);
    address constant ADDRESS_THIS = address(2);

    SwapexFactory factory;
    MockWETH weth;
    SwapexRouter router;
    SwapexPositionManager pm;
    SwapexQuoter quoter;
    MockERC20 a;
    MockERC20 b;
    MockERC20 c;

    address lp = address(0xA11CE);
    address trader = address(0xB0B);

    function setUp() public {
        factory = new SwapexFactory();
        weth = new MockWETH();
        router = new SwapexRouter(address(factory), address(weth));
        pm = new SwapexPositionManager(address(factory), address(weth));
        quoter = new SwapexQuoter(address(factory));

        a = new MockERC20("A", "A", 18);
        b = new MockERC20("B", "B", 18);
        c = new MockERC20("C", "C", 18);

        address[3] memory toks = [address(a), address(b), address(c)];
        for (uint256 i = 0; i < 3; i++) {
            MockERC20(toks[i]).mint(lp, 1e27);
            MockERC20(toks[i]).mint(trader, 1e27);
        }
        vm.deal(lp, 1e24);
        vm.deal(trader, 1e24);
        vm.prank(lp);
        weth.deposit{value: 1e23}();

        _seed(address(a), address(b), 1000e18);
        _seed(address(b), address(c), 1000e18);
        _seed(address(weth), address(a), 1000e18);

        vm.startPrank(trader);
        a.approve(address(router), type(uint256).max);
        b.approve(address(router), type(uint256).max);
        c.approve(address(router), type(uint256).max);
        weth.approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- helpers
    function _sorted(address x, address y) internal pure returns (address, address) {
        return x < y ? (x, y) : (y, x);
    }

    function _mintParams(address t0, address t1, uint256 amt) internal view returns (SwapexPositionManager.MintParams memory) {
        return SwapexPositionManager.MintParams({
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
        });
    }

    function _seed(address x, address y, uint256 amt) internal returns (uint256 tokenId) {
        (address t0, address t1) = _sorted(x, y);
        pm.createAndInitializePoolIfNecessary(t0, t1, FEE, Q96);
        vm.startPrank(lp);
        MockERC20(t0).approve(address(pm), type(uint256).max);
        MockERC20(t1).approve(address(pm), type(uint256).max);
        (tokenId,,,) = pm.mint(_mintParams(t0, t1, amt));
        vm.stopPrank();
    }

    function _single(address tokenIn, address tokenOut, uint256 amountIn)
        internal
        view
        returns (SwapexRouter.ExactInputSingleParams memory)
    {
        return SwapexRouter.ExactInputSingleParams({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            fee: FEE,
            recipient: trader,
            deadline: block.timestamp + 1 hours,
            amountIn: amountIn,
            amountOutMinimum: 0,
            sqrtPriceLimitX96: 0
        });
    }

    function _quoteIn(address tokenIn, address tokenOut, uint256 amountIn) internal returns (uint256) {
        return quoter.quoteExactInputSingle(
            SwapexQuoter.QuoteSingleParams({tokenIn: tokenIn, tokenOut: tokenOut, fee: FEE, amount: amountIn, sqrtPriceLimitX96: 0})
        ).amount;
    }

    // ---------------------------------------------------------------- position manager
    function test_mintCreatesPositionAndNft() public {
        uint256 id = _seed(address(a), address(c), 500e18);
        assertEq(pm.ownerOf(id), lp);
        SwapexPositionManager.PositionData memory p = pm.positions(id);
        assertGt(p.liquidity, 0);
        assertEq(p.tickLower, LOWER);
        assertEq(p.tickUpper, UPPER);
        (address t0,) = _sorted(address(a), address(c));
        assertEq(p.token0, t0);
        address pool = factory.getPool(address(a), address(c), FEE);
        assertEq(SwapexPool(pool).liquidity(), p.liquidity);
    }

    function test_mintRespectsMinimums() public {
        (address t0, address t1) = _sorted(address(a), address(b));
        SwapexPositionManager.MintParams memory p = _mintParams(t0, t1, 1e18);
        p.amount0Min = 2e18; // more than the desired amount can ever deliver
        vm.prank(lp);
        vm.expectRevert(SwapexPositionManager.PriceSlippage.selector);
        pm.mint(p);
    }

    function test_mintRequiresSortedTokens() public {
        (address t0, address t1) = _sorted(address(a), address(b));
        SwapexPositionManager.MintParams memory p = _mintParams(t1, t0, 1e18);
        vm.prank(lp);
        vm.expectRevert(SwapexPositionManager.TokensNotSorted.selector);
        pm.mint(p);
    }

    function test_mintExpired() public {
        (address t0, address t1) = _sorted(address(a), address(b));
        SwapexPositionManager.MintParams memory p = _mintParams(t0, t1, 1e18);
        p.deadline = block.timestamp - 1;
        vm.prank(lp);
        vm.expectRevert(PeripheryBase.Expired.selector);
        pm.mint(p);
    }

    function test_feesAccrueAndCollect() public {
        uint256 id = _seed(address(a), address(c), 1000e18);
        MockERC20 tokenIn = a;
        MockERC20 tokenOut = c;

        vm.startPrank(trader);
        for (uint256 i = 0; i < 5; i++) {
            router.exactInputSingle(_single(address(tokenIn), address(tokenOut), 10e18));
        }
        vm.stopPrank();

        uint256 before = tokenIn.balanceOf(lp);
        vm.prank(lp);
        pm.collect(SwapexPositionManager.CollectParams({tokenId: id, recipient: lp, amount0Max: type(uint128).max, amount1Max: type(uint128).max}));
        uint256 gained = tokenIn.balanceOf(lp) - before;
        // 5 swaps x 10e18 x 0.3% fee = 0.15e18; the position owns all liquidity in this pool
        assertApproxEqRel(gained, 15e16, 1e15); // 0.1% (1e18 = 100%)
    }

    function test_decreaseCollectBurn() public {
        uint256 id = _seed(address(a), address(c), 1000e18);
        SwapexPositionManager.PositionData memory p = pm.positions(id);

        vm.startPrank(lp);
        (uint256 d0, uint256 d1) = pm.decreaseLiquidity(
            SwapexPositionManager.DecreaseParams({tokenId: id, liquidity: p.liquidity, amount0Min: 0, amount1Min: 0, deadline: block.timestamp + 1})
        );
        assertGt(d0, 0);
        assertGt(d1, 0);

        // cannot burn while tokens are still owed
        vm.expectRevert(SwapexPositionManager.NotCleared.selector);
        pm.burn(id);

        (uint256 c0, uint256 c1) = pm.collect(
            SwapexPositionManager.CollectParams({tokenId: id, recipient: lp, amount0Max: type(uint128).max, amount1Max: type(uint128).max})
        );
        assertEq(c0, d0);
        assertEq(c1, d1);
        pm.burn(id);
        vm.stopPrank();

        vm.expectRevert(ERC721Minimal.NonexistentToken.selector);
        pm.positions(id);
    }

    function test_decreaseMoreThanOwnedReverts() public {
        uint256 id = _seed(address(a), address(c), 1000e18);
        SwapexPositionManager.PositionData memory p = pm.positions(id);
        vm.prank(lp);
        vm.expectRevert(SwapexPositionManager.InsufficientLiquidity.selector);
        pm.decreaseLiquidity(
            SwapexPositionManager.DecreaseParams({tokenId: id, liquidity: p.liquidity + 1, amount0Min: 0, amount1Min: 0, deadline: block.timestamp + 1})
        );
    }

    function test_strangerCannotManagePosition() public {
        uint256 id = _seed(address(a), address(c), 1000e18);
        vm.startPrank(trader);
        vm.expectRevert(SwapexPositionManager.NotAuthorized.selector);
        pm.decreaseLiquidity(
            SwapexPositionManager.DecreaseParams({tokenId: id, liquidity: 1, amount0Min: 0, amount1Min: 0, deadline: block.timestamp + 1})
        );
        vm.expectRevert(SwapexPositionManager.NotAuthorized.selector);
        pm.collect(SwapexPositionManager.CollectParams({tokenId: id, recipient: trader, amount0Max: 1, amount1Max: 1}));
        vm.expectRevert(SwapexPositionManager.NotAuthorized.selector);
        pm.burn(id);
        vm.stopPrank();
    }

    function test_increaseLiquidityKeepsEarnedFees() public {
        uint256 id = _seed(address(a), address(c), 1000e18);
        vm.prank(trader);
        router.exactInputSingle(_single(address(a), address(c), 10e18));

        vm.startPrank(lp);
        (uint128 added,,) = pm.increaseLiquidity(
            SwapexPositionManager.IncreaseParams({
                tokenId: id,
                amount0Desired: 100e18,
                amount1Desired: 100e18,
                amount0Min: 0,
                amount1Min: 0,
                deadline: block.timestamp + 1
            })
        );
        assertGt(added, 0);
        SwapexPositionManager.PositionData memory p = pm.positions(id);
        // fees from before the top-up are owed to the position, not lost
        assertGt(uint256(p.tokensOwed0) + uint256(p.tokensOwed1), 0);
        vm.stopPrank();
    }

    function test_nftTransferMovesControl() public {
        uint256 id = _seed(address(a), address(c), 1000e18);
        vm.prank(lp);
        pm.transferFrom(lp, trader, id);
        assertEq(pm.ownerOf(id), trader);

        SwapexPositionManager.PositionData memory p = pm.positions(id);
        vm.prank(lp);
        vm.expectRevert(SwapexPositionManager.NotAuthorized.selector);
        pm.decreaseLiquidity(
            SwapexPositionManager.DecreaseParams({tokenId: id, liquidity: 1, amount0Min: 0, amount1Min: 0, deadline: block.timestamp + 1})
        );
        vm.prank(trader);
        pm.decreaseLiquidity(
            SwapexPositionManager.DecreaseParams({tokenId: id, liquidity: p.liquidity / 2, amount0Min: 0, amount1Min: 0, deadline: block.timestamp + 1})
        );
    }

    function test_safeTransferToNonReceiverReverts() public {
        uint256 id = _seed(address(a), address(c), 1000e18);
        vm.prank(lp);
        vm.expectRevert(ERC721Minimal.UnsafeRecipient.selector);
        pm.safeTransferFrom(lp, address(this), id); // this test contract has no onERC721Received
    }

    // ---------------------------------------------------------------- router
    function test_exactInputSingleMatchesQuote() public {
        uint256 quote = _quoteIn(address(a), address(b), 10e18);
        uint256 before = b.balanceOf(trader);
        vm.prank(trader);
        uint256 out = router.exactInputSingle(_single(address(a), address(b), 10e18));
        assertEq(out, quote);
        assertEq(b.balanceOf(trader) - before, out);
    }

    function testFuzz_quoteMatchesExecution(uint256 amountIn) public {
        amountIn = bound(amountIn, 1e15, 5e20);
        uint256 quote = _quoteIn(address(a), address(b), amountIn);
        vm.prank(trader);
        uint256 out = router.exactInputSingle(_single(address(a), address(b), amountIn));
        assertEq(out, quote);
    }

    function test_exactInputRevertsBelowMinimum() public {
        uint256 quote = _quoteIn(address(a), address(b), 10e18);
        SwapexRouter.ExactInputSingleParams memory p = _single(address(a), address(b), 10e18);
        p.amountOutMinimum = quote + 1;
        vm.prank(trader);
        vm.expectRevert(SwapexRouter.TooLittleReceived.selector);
        router.exactInputSingle(p);
    }

    function test_swapExpired() public {
        SwapexRouter.ExactInputSingleParams memory p = _single(address(a), address(b), 1e18);
        p.deadline = block.timestamp - 1;
        vm.prank(trader);
        vm.expectRevert(PeripheryBase.Expired.selector);
        router.exactInputSingle(p);
    }

    function test_swapToZeroAddressReverts() public {
        SwapexRouter.ExactInputSingleParams memory p = _single(address(a), address(b), 1e18);
        p.recipient = address(0);
        vm.prank(trader);
        vm.expectRevert(PeripheryBase.ZeroRecipient.selector);
        router.exactInputSingle(p);
    }

    function test_swapUnknownPoolReverts() public {
        SwapexRouter.ExactInputSingleParams memory p = _single(address(a), address(b), 1e18);
        p.fee = 500; // pool for this fee was never created
        vm.prank(trader);
        vm.expectRevert(SwapexRouter.PoolNotFound.selector);
        router.exactInputSingle(p);
    }

    function test_exactOutputSingleMatchesQuote() public {
        uint256 want = 5e18;
        SwapexQuoter.Quote memory q = quoter.quoteExactOutputSingle(
            SwapexQuoter.QuoteSingleParams({tokenIn: address(a), tokenOut: address(b), fee: FEE, amount: want, sqrtPriceLimitX96: 0})
        );
        uint256 bBefore = b.balanceOf(trader);
        uint256 aBefore = a.balanceOf(trader);

        vm.prank(trader);
        uint256 spent = router.exactOutputSingle(
            SwapexRouter.ExactOutputSingleParams({
                tokenIn: address(a),
                tokenOut: address(b),
                fee: FEE,
                recipient: trader,
                deadline: block.timestamp + 1,
                amountOut: want,
                amountInMaximum: q.amount,
                sqrtPriceLimitX96: 0
            })
        );
        assertEq(spent, q.amount);
        assertEq(b.balanceOf(trader) - bBefore, want);
        assertEq(aBefore - a.balanceOf(trader), spent);
    }

    function test_exactOutputRevertsAboveMaximum() public {
        vm.prank(trader);
        vm.expectRevert(SwapexRouter.TooMuchRequested.selector);
        router.exactOutputSingle(
            SwapexRouter.ExactOutputSingleParams({
                tokenIn: address(a),
                tokenOut: address(b),
                fee: FEE,
                recipient: trader,
                deadline: block.timestamp + 1,
                amountOut: 5e18,
                amountInMaximum: 1e18, // far too little for 5e18 out
                sqrtPriceLimitX96: 0
            })
        );
    }

    function test_multiHopExactInputMatchesQuote() public {
        bytes memory path = abi.encodePacked(address(a), FEE, address(b), FEE, address(c));
        (uint256 quote,,,) = quoter.quoteExactInput(path, 10e18);
        uint256 before = c.balanceOf(trader);
        vm.prank(trader);
        uint256 out = router.exactInput(
            SwapexRouter.ExactInputParams({path: path, recipient: trader, deadline: block.timestamp + 1, amountIn: 10e18, amountOutMinimum: quote})
        );
        assertEq(out, quote);
        assertEq(c.balanceOf(trader) - before, out);
        assertEq(b.balanceOf(address(router)), 0); // nothing left stranded in the router
    }

    function test_multiHopExactOutputMatchesQuote() public {
        bytes memory rev = abi.encodePacked(address(c), FEE, address(b), FEE, address(a));
        (uint256 quoteIn,,,) = quoter.quoteExactOutput(rev, 5e18);
        uint256 aBefore = a.balanceOf(trader);
        uint256 cBefore = c.balanceOf(trader);
        vm.prank(trader);
        uint256 spent = router.exactOutput(
            SwapexRouter.ExactOutputParams({path: rev, recipient: trader, deadline: block.timestamp + 1, amountOut: 5e18, amountInMaximum: quoteIn})
        );
        assertEq(spent, quoteIn);
        assertEq(aBefore - a.balanceOf(trader), spent);
        assertEq(c.balanceOf(trader) - cBefore, 5e18);
        assertEq(b.balanceOf(address(router)), 0);
    }

    function test_invalidPathReverts() public {
        bytes memory bad = abi.encodePacked(address(a), FEE); // truncated
        vm.prank(trader);
        vm.expectRevert(SwapexRouter.InvalidPath.selector);
        router.exactInput(
            SwapexRouter.ExactInputParams({path: bad, recipient: trader, deadline: block.timestamp + 1, amountIn: 1e18, amountOutMinimum: 0})
        );
    }

    // ---------------------------------------------------------------- native ETH
    function test_swapEthForToken() public {
        uint256 quote = _quoteIn(address(weth), address(a), 1e18);
        uint256 before = a.balanceOf(trader);
        vm.prank(trader);
        uint256 out = router.exactInputSingle{value: 1e18}(_single(address(weth), address(a), 1e18));
        assertEq(out, quote);
        assertEq(a.balanceOf(trader) - before, out);
        assertEq(address(router).balance, 0);
    }

    function test_swapTokenForEthViaMulticall() public {
        SwapexRouter.ExactInputSingleParams memory p = _single(address(a), address(weth), 1e18);
        p.recipient = ADDRESS_THIS;
        uint256 quote = _quoteIn(address(a), address(weth), 1e18);

        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(router.exactInputSingle, (p));
        calls[1] = abi.encodeCall(router.unwrapWETH9, (quote, trader));

        uint256 before = trader.balance;
        vm.prank(trader);
        router.multicall(calls);
        assertEq(trader.balance - before, quote);
        assertEq(weth.balanceOf(address(router)), 0);
    }

    function test_unwrapBelowMinimumReverts() public {
        vm.prank(trader);
        vm.expectRevert(PeripheryBase.InsufficientETH.selector);
        router.unwrapWETH9(1, trader);
    }

    function test_randomEthIsRejected() public {
        vm.prank(trader);
        (bool ok,) = address(router).call{value: 1 ether}("");
        assertTrue(!ok); // only WETH may send ETH
    }

    // ---------------------------------------------------------------- callback safety
    function test_routerCallbackRejectsNonPool() public {
        bytes memory path = abi.encodePacked(address(a), FEE, address(b));
        vm.prank(trader);
        vm.expectRevert(SwapexRouter.InvalidCaller.selector);
        router.swapexSwapCallback(1e18, 0, abi.encode(SwapexRouter.CallbackData({path: path, payer: lp, exactInput: true})));
    }

    function test_positionManagerCallbackRejectsNonPool() public {
        (address t0, address t1) = _sorted(address(a), address(b));
        vm.prank(trader);
        vm.expectRevert(SwapexPositionManager.InvalidCaller.selector);
        pm.swapexMintCallback(
            1e18, 1e18, abi.encode(SwapexPositionManager.MintCallbackData({token0: t0, token1: t1, fee: FEE, payer: lp}))
        );
    }

    function test_cannotDrainApprovedUserThroughForgedCallback() public {
        // an attacker contract pretends to be a pool and asks the router to pay from a victim who approved it
        bytes memory path = abi.encodePacked(address(a), FEE, address(b));
        uint256 before = a.balanceOf(trader);
        vm.prank(address(0xBAD));
        vm.expectRevert(SwapexRouter.InvalidCaller.selector);
        router.swapexSwapCallback(100e18, 0, abi.encode(SwapexRouter.CallbackData({path: path, payer: trader, exactInput: true})));
        assertEq(a.balanceOf(trader), before);
    }

    // ---------------------------------------------------------------- quoter
    function test_quoterLeavesNoState() public {
        address pool = factory.getPool(address(a), address(b), FEE);
        (uint160 priceBefore,,,) = SwapexPool(pool).slot0();
        _quoteIn(address(a), address(b), 50e18);
        (uint160 priceAfter,,,) = SwapexPool(pool).slot0();
        assertEq(priceBefore, priceAfter);
    }

    function test_quoterPassesThroughPoolErrors() public {
        // a price limit on the wrong side of the current price (price is 1.0) is rejected by the pool
        bool zeroForOne = address(a) < address(b);
        uint160 wrongSide = zeroForOne ? Q96 * 2 : Q96 / 2;
        vm.expectRevert(SwapexPool.InvalidPriceLimit.selector);
        quoter.quoteExactInputSingle(
            SwapexQuoter.QuoteSingleParams({tokenIn: address(a), tokenOut: address(b), fee: FEE, amount: 1e18, sqrtPriceLimitX96: wrongSide})
        );
    }

    function test_quoterRejectsTradesThePoolCannotFill() public {
        // far more than the pool holds: a partial fill must not be reported as a normal quote
        vm.expectRevert(SwapexQuoter.InsufficientLiquidity.selector);
        quoter.quoteExactInputSingle(
            SwapexQuoter.QuoteSingleParams({tokenIn: address(a), tokenOut: address(b), fee: FEE, amount: 1e26, sqrtPriceLimitX96: 0})
        );
        vm.expectRevert(SwapexQuoter.InsufficientLiquidity.selector);
        quoter.quoteExactOutputSingle(
            SwapexQuoter.QuoteSingleParams({tokenIn: address(a), tokenOut: address(b), fee: FEE, amount: 1e26, sqrtPriceLimitX96: 0})
        );
    }

    function test_routerRefusesPartialFill() public {
        vm.prank(trader);
        vm.expectRevert(SwapexRouter.PartialFill.selector);
        router.exactInputSingle(_single(address(a), address(b), 1e26));
    }

    function test_quoterUnknownPool() public {
        vm.expectRevert(SwapexQuoter.PoolNotFound.selector);
        quoter.quoteExactInputSingle(
            SwapexQuoter.QuoteSingleParams({tokenIn: address(a), tokenOut: address(c), fee: 10000, amount: 1e18, sqrtPriceLimitX96: 0})
        );
    }
}
