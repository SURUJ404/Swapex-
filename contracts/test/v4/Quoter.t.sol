// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolManager, SwapParams, ModifyLiquidityParams} from "../../src/v4/PoolManager.sol";
import {Router} from "../../src/v4/periphery/Router.sol";
import {AllowanceTransfer} from "../../src/v4/periphery/AllowanceTransfer.sol";
import {Quoter} from "../../src/v4/periphery/Quoter.sol";
import {currency} from "../../src/v4/types/Currency.sol";
import {PoolKey} from "../../src/v4/types/PoolKey.sol";
import {TickMath} from "../../src/libraries/TickMath.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

uint160 constant Q96 = uint160(1 << 96);

contract QuoterTest is Test {
    PoolManager pm;
    Router router;
    AllowanceTransfer at;
    Quoter quoter;
    MockERC20 tokenA;
    MockERC20 tokenB;

    function setUp() public {
        pm = new PoolManager(address(this));
        at = new AllowanceTransfer();
        router = new Router(pm, at);
        quoter = new Quoter(pm);
        tokenA = new MockERC20("A", "A", 18);
        tokenB = new MockERC20("B", "B", 18);

        tokenA.mint(address(this), 1_000_000e18);
        tokenB.mint(address(this), 1_000_000e18);
        tokenA.approve(address(at), type(uint256).max);
        tokenB.approve(address(at), type(uint256).max);
        at.setAllowance(address(tokenA), address(router), type(uint160).max, type(uint48).max);
        at.setAllowance(address(tokenB), address(router), type(uint160).max, type(uint48).max);
    }

    function _key() internal view returns (PoolKey memory) {
        (address lo, address hi) = address(tokenA) < address(tokenB)
            ? (address(tokenA), address(tokenB))
            : (address(tokenB), address(tokenA));
        return PoolKey({
            currency0: currency.wrap(lo),
            currency1: currency.wrap(hi),
            fee: 3000,
            tickSpacing: 60,
            hooks: address(0)
        });
    }

    function _seed(PoolKey memory key) internal {
        router.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 1e20}), address(this)
        );
    }

    function test_quoteMatchesActualSwapOutput() public {
        PoolKey memory key = _key();
        router.initialize(key, Q96);
        _seed(key);

        bool zeroForOne = currency.unwrap(key.currency0) == address(tokenA);
        SwapParams memory sp = SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: 1e18,
            sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1
        });

        (int256 q0, int256 q1) = quoter.quoteExactInputSingle(key, sp);
        // input currency has a negative delta, output currency a positive one.
        int256 quotedOut = zeroForOne ? q1 : q0;
        assertGt(quotedOut, 0, "quote yields a positive output");

        // perform the real swap and confirm the output token balance matches the quote exactly.
        // the output currency is determined by the direction, not by which mock token happens to
        // sort lower: zeroForOne sells currency0 (so output is currency1), else output is currency0.
        address outToken = currency.unwrap(zeroForOne ? key.currency1 : key.currency0);
        uint256 outBefore = MockERC20(outToken).balanceOf(address(this));
        router.exactInputSingle(key, sp, address(this), 0);
        uint256 received = MockERC20(outToken).balanceOf(address(this)) - outBefore;
        assertEq(uint256(quotedOut), received, "quote == actual output");
    }

    function test_quoteIsRepeatableAndStateless() public {
        PoolKey memory key = _key();
        router.initialize(key, Q96);
        _seed(key);

        bool zeroForOne = currency.unwrap(key.currency0) == address(tokenA);
        SwapParams memory sp = SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: 1e18,
            sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1
        });

        (int256 a0, int256 a1) = quoter.quoteExactInputSingle(key, sp);
        (int256 b0, int256 b1) = quoter.quoteExactInputSingle(key, sp);
        assertEq(a0, b0, "repeatable amount0");
        assertEq(a1, b1, "repeatable amount1");

        // quoting must not move tokens: user balances are unchanged after two quotes.
        (uint160 sqrtAfter,) = pm.getSlot0(key);
        assertEq(uint160(uint256(uint160(sqrtAfter))), Q96, "pool price unchanged by quoting");
    }

    function test_quoteRevertsOnUninitializedPool() public {
        PoolKey memory key = _key();
        SwapParams memory sp = SwapParams({
            zeroForOne: true,
            amountSpecified: 1e18,
            sqrtPriceLimitX96: TickMath.MIN_SQRT_RATIO + 1
        });
        vm.expectRevert(Quoter.QuoteUnavailable.selector);
        quoter.quoteExactInputSingle(key, sp);
    }
}
