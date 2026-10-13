// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolManager, IUnlockCallback, SwapParams, ModifyLiquidityParams} from "../../src/v4/PoolManager.sol";
import {currency} from "../../src/v4/types/Currency.sol";
import {BalanceDelta} from "../../src/v4/types/BalanceDelta.sol";
import {PoolKey} from "../../src/v4/types/PoolKey.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

uint160 constant Q96 = uint160(1 << 96);

/// @notice unlock-caller supporting seed / donate / remove in one session each.
contract DonateRouter is IUnlockCallback {
    PoolManager public immutable pm;
    uint8 private _op; // 1 = seed, 2 = donate, 3 = remove
    PoolKey private _key;
    int256 private _liq;
    uint256 private _d0;
    uint256 private _d1;
    BalanceDelta private _fees;

    constructor(PoolManager _pm) {
        pm = _pm;
    }

    function initialize(PoolKey memory key, uint160 sqrtPriceX96) external returns (int24) {
        return pm.initialize(key, sqrtPriceX96);
    }

    function seed(PoolKey memory key, int256 liquidityDelta) external {
        _key = key;
        _liq = liquidityDelta;
        _op = 1;
        pm.unlock("");
    }

    function donate(PoolKey memory key, uint256 amount0, uint256 amount1) external {
        _key = key;
        _d0 = amount0;
        _d1 = amount1;
        _op = 2;
        pm.unlock("");
    }

    function remove(PoolKey memory key, int256 liquidityDelta) external returns (BalanceDelta fees) {
        _key = key;
        _liq = liquidityDelta;
        _op = 3;
        pm.unlock("");
        fees = _fees;
    }

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        require(msg.sender == address(pm), "only manager");
        if (_op == 1) {
            pm.modifyLiquidity(_key, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: _liq}));
        } else if (_op == 3) {
            (, BalanceDelta feesAccrued) =
                pm.modifyLiquidity(_key, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: _liq}));
            _fees = feesAccrued;
        } else {
            pm.donate(_key, _d0, _d1);
        }
        _net(_key.currency0);
        _net(_key.currency1);
        return "";
    }

    function _net(currency c) private {
        int256 delta = pm.getCurrencyDelta(c);
        if (delta < 0) pm.settle(c);
        else if (delta > 0) pm.take(c, address(this), uint256(delta));
    }

    function approve(address token) external {
        MockERC20(token).approve(address(pm), type(uint256).max);
    }
}

contract DonateTest is Test {
    PoolManager pm;
    DonateRouter router;
    MockERC20 tokenA;
    MockERC20 tokenB;
    PoolKey key;

    function setUp() public {
        pm = new PoolManager(address(this));
        router = new DonateRouter(pm);
        tokenA = new MockERC20("A", "A", 18);
        tokenB = new MockERC20("B", "B", 18);
        (address lo, address hi) = address(tokenA) < address(tokenB)
            ? (address(tokenA), address(tokenB))
            : (address(tokenB), address(tokenA));
        key = PoolKey({currency0: currency.wrap(lo), currency1: currency.wrap(hi), fee: 3000, tickSpacing: 60, hooks: address(0)});

        tokenA.mint(address(router), 1_000_000e18);
        tokenB.mint(address(router), 1_000_000e18);
        router.approve(address(tokenA));
        router.approve(address(tokenB));
        router.initialize(key, Q96);
    }

    function test_donate_accruesToFeeGrowth() public {
        router.seed(key, 1e20);
        assertEq(pm.getLiquidity(key), 1e20, "seeded liquidity");

        uint256 d0 = 5e18;
        router.donate(key, d0, 0);

        (uint256 fg0, uint256 fg1) = pm.getFeeGrowthGlobals(key);
        // a single donation credits amount0 * 2^128 / liquidity to feeGrowthGlobal0
        uint256 expected = (d0 * (1 << 128)) / 1e20;
        assertEq(fg0, expected, "donation credited to feeGrowthGlobal0");
        assertEq(fg1, 0, "feeGrowthGlobal1 untouched by amount0 donation");
    }

    function test_donate_bothTokens() public {
        router.seed(key, 1e20);
        uint256 d0 = 4e18;
        uint256 d1 = 9e18;
        router.donate(key, d0, d1);
        (uint256 fg0, uint256 fg1) = pm.getFeeGrowthGlobals(key);
        assertEq(fg0, (d0 * (1 << 128)) / 1e20, "fg0 credited");
        assertEq(fg1, (d1 * (1 << 128)) / 1e20, "fg1 credited");
    }

    function test_donate_lpCanClaimDonation() public {
        router.seed(key, 1e20);
        uint256 d0 = 5e18;
        router.donate(key, d0, 0);

        // the sole LP removing all liquidity is owed the donated amount as fees
        BalanceDelta fees = router.remove(key, -int256(1e20));
        // fees are in caller-owes convention: positive = pool owes caller
        uint256 fees0 = uint256(fees.amount0());
        assertApproxEqAbs(fees0, d0, 2, "LP is owed the donated amount (token0)");
    }

    function test_donate_revertsWithoutLiquidity() public {
        // pool initialized but no liquidity seeded
        vm.expectRevert(PoolManager.NoLiquidityToAccrue.selector);
        router.donate(key, 1e18, 0);
    }

    function test_donate_revertsOutsideUnlock() public {
        router.seed(key, 1e20);
        vm.expectRevert(PoolManager.NotUnlocked.selector);
        pm.donate(key, 1e18, 0);
    }

    function test_donate_revertsZeroAmount() public {
        router.seed(key, 1e20);
        vm.expectRevert(PoolManager.ZeroAmount.selector);
        router.donate(key, 0, 0);
    }
}
