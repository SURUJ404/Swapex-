// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolManager, IUnlockCallback, SwapParams, ModifyLiquidityParams} from "../../src/v4/PoolManager.sol";
import {currency} from "../../src/v4/types/Currency.sol";
import {PoolKey} from "../../src/v4/types/PoolKey.sol";
import {TickMath} from "../../src/libraries/TickMath.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

uint160 constant Q96 = uint160(1 << 96);

/// @notice targeted fuzz properties: liquidity round-trips and swap round-trips never create value.
contract FuzzTest is Test, IUnlockCallback {
    PoolManager pm;
    PoolKey key;
    MockERC20 tokenA;
    MockERC20 tokenB;

    uint8 private _op;
    ModifyLiquidityParams private _lp;
    SwapParams private _sp;

    function setUp() public {
        pm = new PoolManager(address(this));
        tokenA = new MockERC20("A", "A", 18);
        tokenB = new MockERC20("B", "B", 18);
        (address lo, address hi) = address(tokenA) < address(tokenB)
            ? (address(tokenA), address(tokenB))
            : (address(tokenB), address(tokenA));
        key = PoolKey({currency0: currency.wrap(lo), currency1: currency.wrap(hi), fee: 3000, tickSpacing: 60, hooks: address(0)});

        tokenA.mint(address(this), 1e30);
        tokenB.mint(address(this), 1e30);
        tokenA.approve(address(pm), type(uint256).max);
        tokenB.approve(address(pm), type(uint256).max);

        pm.initialize(key, Q96);
        _modify(ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: int256(1e22)}));
    }

    /// @notice add then remove the same liquidity returns at most the principal (no value minted)
    ///         and loses at most a couple wei to rounding per leg.
    function testFuzz_liquidityRoundTrip(uint96 amount) public {
        uint256 liq = bound(uint256(amount), 1e12, 1e21);

        uint256 aBefore = tokenA.balanceOf(address(this));
        uint256 bBefore = tokenB.balanceOf(address(this));

        _modify(ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: int256(liq)}));
        _modify(ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: -int256(liq)}));

        uint256 aAfter = tokenA.balanceOf(address(this));
        uint256 bAfter = tokenB.balanceOf(address(this));

        assertLe(aAfter, aBefore, "no tokenA value minted");
        assertLe(bAfter, bBefore, "no tokenB value minted");
        assertGe(aAfter, aBefore - 2, "tokenA conservation");
        assertGe(bAfter, bBefore - 2, "tokenB conservation");
    }

    /// @notice swapping A->B then B->A can never return more A than we started with (no free tokens).
    function testFuzz_swapRoundTrip_noFreeTokens(uint96 amount) public {
        uint256 input = bound(uint256(amount), 1e15, 1e20);
        bool aIs0 = address(tokenA) == currency.unwrap(key.currency0);

        uint256 aBefore = tokenA.balanceOf(address(this));
        uint256 bBefore = tokenB.balanceOf(address(this));

        _swap(aIs0, input);
        uint256 bGot = tokenB.balanceOf(address(this)) - bBefore;
        if (bGot > 0) _swap(!aIs0, bGot);

        uint256 aAfter = tokenA.balanceOf(address(this));
        assertLe(aAfter, aBefore, "no free tokenA from a round-trip");
    }

    // ---- unlock-caller harness ---------------------------------------------------

    function _modify(ModifyLiquidityParams memory lp) private {
        _lp = lp;
        _op = 1;
        pm.unlock("");
    }

    function _swap(bool zeroForOne, uint256 amt) private {
        uint160 limit = zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1;
        _sp = SwapParams({zeroForOne: zeroForOne, amountSpecified: int256(amt), sqrtPriceLimitX96: limit});
        _op = 2;
        pm.unlock("");
    }

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        require(msg.sender == address(pm), "only manager");
        if (_op == 1) {
            pm.modifyLiquidity(key, _lp);
        } else {
            pm.swap(key, _sp);
        }
        _net(currency.wrap(address(tokenA)));
        _net(currency.wrap(address(tokenB)));
        return "";
    }

    function _net(currency c) private {
        int256 delta = pm.getCurrencyDelta(address(this), c);
        if (delta < 0) pm.settle(c);
        else if (delta > 0) pm.take(c, address(this), uint256(delta));
    }
}
