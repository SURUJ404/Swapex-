// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolManager, IUnlockCallback, SwapParams, ModifyLiquidityParams} from "../../src/v4/PoolManager.sol";
import {currency} from "../../src/v4/types/Currency.sol";
import {PoolKey} from "../../src/v4/types/PoolKey.sol";
import {TickMath} from "../../src/libraries/TickMath.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

uint160 constant Q96 = uint160(1 << 96);
uint256 constant MIN_LIQ = 1e10;

/// @notice Fuzz/invariant handler: performs one bounded operation per call inside an unlock. Keeps
///         a minimum liquidity so swaps always have a market (and a valid price limit).
contract Handler is IUnlockCallback {
    PoolManager public immutable pm;
    PoolKey public key;
    currency public cur0;
    currency public cur1;
    MockERC20 public token0;
    MockERC20 public token1;

    uint8 private _op; // 1 = modify liquidity, 2 = swap, 3 = donate
    int256 private _liq;
    SwapParams private _sp;
    uint256 private _d0;
    uint256 private _d1;

    // ghosts for the fee-growth monotonicity invariant (before/after the most recent op)
    uint256 public ghostFg0Before;
    uint256 public ghostFg1Before;
    uint256 public ghostFg0After;
    uint256 public ghostFg1After;

    constructor(PoolManager _pm, PoolKey memory _key) {
        pm = _pm;
        key = _key;
        cur0 = _key.currency0;
        cur1 = _key.currency1;
        token0 = MockERC20(currency.unwrap(_key.currency0));
        token1 = MockERC20(currency.unwrap(_key.currency1));
    }

    function approveAll() external {
        token0.approve(address(pm), type(uint256).max);
        token1.approve(address(pm), type(uint256).max);
    }

    function _clamp(uint256 x, uint256 lo, uint256 hi) private pure returns (uint256) {
        return x < lo ? lo : (x > hi ? hi : x);
    }

    function addLiquidity(uint256 amount) external {
        _begin();
        _liq = int256(_clamp(amount, 1e10, 1e22));
        _op = 1;
        pm.unlock("");
        _end();
    }

    function removeLiquidity(uint256 amount) external {
        uint256 current = pm.getLiquidity(key);
        if (current <= MIN_LIQ) return;
        uint256 liq = _clamp(amount, 0, current - MIN_LIQ);
        if (liq == 0) return;
        _begin();
        _liq = -int256(liq);
        _op = 1;
        pm.unlock("");
        _end();
    }

    function swap0to1(uint256 amount) external {
        _begin();
        _sp = SwapParams({
            zeroForOne: true,
            amountSpecified: int256(_clamp(amount, 1e12, 1e20)),
            sqrtPriceLimitX96: TickMath.MIN_SQRT_RATIO + 1
        });
        _op = 2;
        pm.unlock("");
        _end();
    }

    function swap1to0(uint256 amount) external {
        _begin();
        _sp = SwapParams({
            zeroForOne: false,
            amountSpecified: int256(_clamp(amount, 1e12, 1e20)),
            sqrtPriceLimitX96: TickMath.MAX_SQRT_RATIO - 1
        });
        _op = 2;
        pm.unlock("");
        _end();
    }

    function donate(uint256 a0, uint256 a1) external {
        if (pm.getLiquidity(key) == 0) return;
        _begin();
        _d0 = _clamp(a0, 0, 1e18);
        _d1 = _clamp(a1, 0, 1e18);
        _op = 3;
        pm.unlock("");
        _end();
    }

    function _begin() private {
        (ghostFg0Before, ghostFg1Before) = pm.getFeeGrowthGlobals(key);
    }

    function _end() private {
        (ghostFg0After, ghostFg1After) = pm.getFeeGrowthGlobals(key);
    }

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        require(msg.sender == address(pm), "only manager");
        if (_op == 1) {
            pm.modifyLiquidity(key, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: _liq}));
        } else if (_op == 2) {
            pm.swap(key, _sp);
        } else {
            pm.donate(key, _d0, _d1);
        }
        _net(cur0);
        _net(cur1);
        return "";
    }

    function _net(currency c) private {
        int256 delta = pm.getCurrencyDelta(c);
        if (delta < 0) pm.settle(c);
        else if (delta > 0) pm.take(c, address(this), uint256(delta));
    }
}

contract InvariantTest is Test {
    PoolManager pm;
    Handler handler;
    PoolKey key;
    MockERC20 tokenA;
    MockERC20 tokenB;

    function setUp() public {
        pm = new PoolManager();
        tokenA = new MockERC20("A", "A", 18);
        tokenB = new MockERC20("B", "B", 18);
        (address lo, address hi) = address(tokenA) < address(tokenB)
            ? (address(tokenA), address(tokenB))
            : (address(tokenB), address(tokenA));
        key = PoolKey({currency0: currency.wrap(lo), currency1: currency.wrap(hi), fee: 3000, tickSpacing: 60, hooks: address(0)});

        handler = new Handler(pm, key);
        tokenA.mint(address(handler), 1e30);
        tokenB.mint(address(handler), 1e30);
        handler.approveAll();

        pm.initialize(key, Q96);
        handler.addLiquidity(1e20); // seed a baseline market

        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = Handler.addLiquidity.selector;
        selectors[1] = Handler.removeLiquidity.selector;
        selectors[2] = Handler.swap0to1.selector;
        selectors[3] = Handler.swap1to0.selector;
        selectors[4] = Handler.donate.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @notice the manager always holds at least the tokens it tracks in `reserves`.
    function invariant_solvency() public view {
        assertGe(handler.token0().balanceOf(address(pm)), pm.reserves(handler.cur0()), "cur0 solvency");
        assertGe(handler.token1().balanceOf(address(pm)), pm.reserves(handler.cur1()), "cur1 solvency");
    }

    /// @notice a swap or donate never decreases a pool's fee growth (fees only accrue).
    function invariant_feeGrowthMonotonic() public view {
        assertGe(handler.ghostFg0After(), handler.ghostFg0Before(), "feeGrowthGlobal0 monotonic");
        assertGe(handler.ghostFg1After(), handler.ghostFg1Before(), "feeGrowthGlobal1 monotonic");
    }
}
