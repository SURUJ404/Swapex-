// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {V3Base} from "./V3Base.t.sol";
import {SwapexPool} from "../../src/v3/SwapexPool.sol";
import {SwapexFactory} from "../../src/v3/SwapexFactory.sol";
import {TickMath} from "../../src/libraries/TickMath.sol";

contract V3PoolTest is V3Base {
    int24 internal constant LOWER = -120;
    int24 internal constant UPPER = 120;
    uint128 internal constant L = 1e21;

    function _seed() internal returns (uint256 a0, uint256 a1) {
        (a0, a1) = pool.mint(address(this), LOWER, UPPER, L, "");
    }

    // ------------------------------------------------------------ factory
    function test_factory_poolAddressIsDeterministicAndOrderIndependent() public {
        assertEq(factory.getPool(address(token0), address(token1), FEE), address(pool));
        assertEq(factory.getPool(address(token1), address(token0), FEE), address(pool));
        assertEq(factory.computePoolAddress(address(token0), address(token1), FEE), address(pool));
        assertEq(factory.computePoolAddress(address(token1), address(token0), FEE), address(pool));
        assertEq(pool.token0(), address(token0));
        assertEq(pool.token1(), address(token1));
        assertEq(pool.fee(), FEE);
        assertEq(int256(pool.tickSpacing()), int256(TICK_SPACING));
    }

    function test_factory_rejectsDuplicatesAndBadInput() public {
        vm.expectRevert(SwapexFactory.PoolExists.selector);
        factory.createPool(address(token0), address(token1), FEE);
        vm.expectRevert(SwapexFactory.IdenticalTokens.selector);
        factory.createPool(address(token0), address(token0), FEE);
        vm.expectRevert(SwapexFactory.FeeNotEnabled.selector);
        factory.createPool(address(token0), address(token1), 1234);
        vm.expectRevert(SwapexFactory.ZeroAddress.selector);
        factory.createPool(address(0), address(token1), FEE);
    }

    function test_factory_onlyOwnerCanEnableFees() public {
        factory.enableFeeAmount(100, 1);
        assertEq(int256(factory.feeAmountTickSpacing(100)), 1);
        vm.prank(address(0xBEEF));
        vm.expectRevert(SwapexFactory.NotOwner.selector);
        factory.enableFeeAmount(200, 5);
        vm.expectRevert(SwapexFactory.FeeAlreadyEnabled.selector);
        factory.enableFeeAmount(100, 1);
        vm.expectRevert(SwapexFactory.InvalidTickSpacing.selector);
        factory.enableFeeAmount(300, 16384);
    }

    function test_factory_setOwnerRevertsOnZeroAddress() public {
        // regression: transferring ownership to the zero address would brick the factory
        vm.expectRevert(SwapexFactory.ZeroAddress.selector);
        factory.setOwner(address(0));
        factory.setOwner(address(0xBEEF));
        assertEq(factory.owner(), address(0xBEEF));
    }

    // ------------------------------------------------------------ initialise
    function test_initialize_setsPrice() public {
        (uint160 sqrtP, int24 tick,, bool unlocked) = pool.slot0();
        assertEq(sqrtP, Q96);
        assertEq(int256(tick), 0);
        assertTrue(unlocked);
    }

    function test_initialize_twiceReverts() public {
        vm.expectRevert(SwapexPool.AlreadyInitialized.selector);
        pool.initialize(Q96);
    }

    function test_uninitializedPoolIsLocked() public {
        address other = factory.createPool(address(token0), address(token1), 500);
        vm.expectRevert(SwapexPool.Locked.selector);
        SwapexPool(other).swap(address(this), true, 1e15, _limit(true), "");
    }

    // ------------------------------------------------------------ liquidity
    function test_mint_pullsBothTokensForInRangePosition() public {
        uint256 b0 = token0.balanceOf(address(this));
        uint256 b1 = token1.balanceOf(address(this));
        (uint256 a0, uint256 a1) = _seed();
        assertGt(a0, 0);
        assertGt(a1, 0);
        assertEq(b0 - token0.balanceOf(address(this)), a0);
        assertEq(b1 - token1.balanceOf(address(this)), a1);
        assertEq(pool.liquidity(), L);
        assertEq(token0.balanceOf(address(pool)), a0);
        assertEq(token1.balanceOf(address(pool)), a1);
    }

    function test_mint_outOfRangeIsSingleSidedAndNotActive() public {
        (uint256 a0, uint256 a1) = pool.mint(address(this), 60, 600, L, ""); // above price: token0 only
        assertGt(a0, 0);
        assertEq(a1, 0);
        assertEq(pool.liquidity(), 0);
        (a0, a1) = pool.mint(address(this), -600, -60, L, ""); // below price: token1 only
        assertEq(a0, 0);
        assertGt(a1, 0);
        assertEq(pool.liquidity(), 0);
    }

    function test_mint_validatesTicksAndAmount() public {
        vm.expectRevert(SwapexPool.ZeroLiquidity.selector);
        pool.mint(address(this), LOWER, UPPER, 0, "");
        vm.expectRevert(SwapexPool.TicksNotOrdered.selector);
        pool.mint(address(this), UPPER, LOWER, L, "");
        vm.expectRevert(SwapexPool.TickSpacingMismatch.selector);
        pool.mint(address(this), -100, 120, L, "");
        vm.expectRevert(SwapexPool.TickBelowMin.selector);
        pool.mint(address(this), -887280, 120, L, "");
        vm.expectRevert(SwapexPool.TickAboveMax.selector);
        pool.mint(address(this), -120, 887280, L, "");
    }

    function test_burnMoreThanOwnedReverts() public {
        _seed();
        vm.expectRevert();
        pool.burn(LOWER, UPPER, L + 1);
    }

    function test_pokeEmptyPositionReverts() public {
        vm.expectRevert();
        pool.burn(LOWER, UPPER, 0);
    }

    // ------------------------------------------------------------ swaps
    function test_swap_zeroForOne_movesPriceDownAndPaysOut() public {
        _seed();
        (uint160 before,,,) = pool.slot0();
        (int256 d0, int256 d1) = _swapExactIn(true, 1e17);
        (uint160 afterP,,,) = pool.slot0();
        assertEq(d0, int256(1e17), "all input consumed");
        assertLt(d1, 0, "pool pays token1");
        assertLt(afterP, before, "price falls when selling token0");
        assertLt(uint256(-d1), 1e17);
    }

    function test_swap_oneForZero_movesPriceUp() public {
        _seed();
        (uint160 before,,,) = pool.slot0();
        (int256 d0, int256 d1) = _swapExactIn(false, 1e17);
        (uint160 afterP,,,) = pool.slot0();
        assertEq(d1, int256(1e17));
        assertLt(d0, 0);
        assertGt(afterP, before);
    }

    function test_swap_exactOutput_deliversRequestedAmount() public {
        _seed();
        uint256 before = token1.balanceOf(address(this));
        (int256 d0, int256 d1) = pool.swap(address(this), true, -int256(1e17), _limit(true), "");
        assertEq(d1, -int256(1e17));
        assertGt(d0, int256(1e17), "pays more than it receives (fee + impact)");
        assertEq(token1.balanceOf(address(this)) - before, 1e17);
    }

    function test_swap_feesAccrueToLiquidityProvider() public {
        _seed();
        uint256 amountIn = 1e17;
        _swapExactIn(true, amountIn);
        pool.burn(LOWER, UPPER, 0); // poke: crystallises fees into tokensOwed
        (, , , uint128 owed0, uint128 owed1) = pool.positions(_positionKey(address(this), LOWER, UPPER));
        uint256 expectedFee = amountIn * FEE / 1e6; // 0.3%
        assertApproxEqAbs(uint256(owed0), expectedFee, 3, "fee in token0");
        assertEq(owed1, 0, "no fee in the other token");
    }

    function test_swap_revertsOnBadLimitsAndZeroAmount() public {
        _seed();
        vm.expectRevert(SwapexPool.ZeroAmount.selector);
        pool.swap(address(this), true, 0, _limit(true), "");
        vm.expectRevert(SwapexPool.InvalidPriceLimit.selector);
        pool.swap(address(this), true, 1e15, _limit(false), ""); // limit on the wrong side
        vm.expectRevert(SwapexPool.InvalidPriceLimit.selector);
        pool.swap(address(this), false, 1e15, TickMath.MAX_SQRT_RATIO, "");
    }

    function test_swap_revertsWhenNotPaidInCallback() public {
        _seed();
        underpay = true;
        vm.expectRevert(SwapexPool.InsufficientPayment.selector);
        pool.swap(address(this), true, int256(1e15), _limit(true), "");
    }

    function test_swap_stopsAtPriceLimitAndLeavesRestUnspent() public {
        _seed();
        uint160 limit = TickMath.getSqrtRatioAtTick(-30);
        (int256 d0,) = pool.swap(address(this), true, int256(1e21), limit, "");
        (uint160 sqrtP,,,) = pool.slot0();
        assertEq(sqrtP, limit);
        assertLt(uint256(d0), 1e21, "only part of the input was used");
    }

    // ------------------------------------------------------------ burn / collect
    function test_burnAndCollect_returnsLiquidityAndFees() public {
        _seed();
        _swapExactIn(true, 1e17);
        (uint256 p0, uint256 p1) = pool.burn(LOWER, UPPER, L);
        (uint128 c0, uint128 c1) = pool.collect(address(this), LOWER, UPPER, type(uint128).max, type(uint128).max);
        assertGe(uint256(c0), p0, "collected includes principal + fees");
        assertGe(uint256(c1), p1);
        assertEq(pool.liquidity(), 0);
    }

    function test_collectIsLimitedToWhatIsOwed() public {
        _seed();
        pool.burn(LOWER, UPPER, L);
        (uint128 c0, uint128 c1) = pool.collect(address(this), LOWER, UPPER, 1, 1);
        assertEq(c0, 1);
        assertEq(c1, 1);
    }

    function test_onlyOwnerOfPositionCanBurnIt() public {
        _seed();
        vm.prank(address(0xBEEF));
        vm.expectRevert(); // that account has no liquidity at the range
        pool.burn(LOWER, UPPER, L);
    }

    // ------------------------------------------------------------ flash
    function test_flash_paysFeeToLiquidityProviders() public {
        _seed();
        uint256 before0 = token0.balanceOf(address(pool));
        pool.flash(address(this), 1e18, 1e18, "");
        uint256 fee = (1e18 * uint256(FEE) + 1e6 - 1) / 1e6;
        assertEq(token0.balanceOf(address(pool)) - before0, fee);
        pool.burn(LOWER, UPPER, 0);
        (, , , uint128 owed0,) = pool.positions(_positionKey(address(this), LOWER, UPPER));
        assertApproxEqAbs(uint256(owed0), fee, 2);
    }

    function test_flash_revertsWhenNotRepaid() public {
        _seed();
        flashExtra = 1; // 1 wei short
        vm.expectRevert(SwapexPool.InsufficientPayment.selector);
        pool.flash(address(this), 1e18, 1e18, "");
    }

    function test_flash_revertsWithoutLiquidity() public {
        vm.expectRevert(SwapexPool.NoActiveLiquidity.selector);
        pool.flash(address(this), 1, 1, "");
    }

    // ------------------------------------------------------------ protocol fee
    function test_protocolFee_ownerOnlyAndCollectable() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert(SwapexPool.NotFactoryOwner.selector);
        pool.setProtocolFee(5);

        vm.expectRevert(SwapexPool.InvalidProtocolFee.selector);
        pool.setProtocolFee(3);
        pool.setProtocolFee(5); // 1/5 of fees

        _seed();
        _swapExactIn(true, 1e17);
        uint256 totalFee = 1e17 * uint256(FEE) / 1e6;
        assertApproxEqAbs(uint256(pool.protocolFees0()), totalFee / 5, 2);

        address sink = address(0xCAFE);
        (uint128 got0,) = pool.collectProtocol(sink, type(uint128).max, type(uint128).max);
        assertEq(token0.balanceOf(sink), uint256(got0));
        assertEq(pool.protocolFees0(), 0);

        // LPs get the remaining 4/5
        pool.burn(LOWER, UPPER, 0);
        (, , , uint128 owed0,) = pool.positions(_positionKey(address(this), LOWER, UPPER));
        assertApproxEqAbs(uint256(owed0), totalFee * 4 / 5, 3);

        vm.prank(address(0xBEEF));
        vm.expectRevert(SwapexPool.NotFactoryOwner.selector);
        pool.collectProtocol(sink, 1, 1);
    }

    // ------------------------------------------------------------ invariants / fuzz
    /// Whatever sequence of swaps happens, the LP must be able to redeem everything:
    /// the actor is the only LP and only trader, so tokens can only be lost to rounding dust.
    function testFuzz_poolIsFullyRedeemableAfterSwaps(uint256[6] memory amounts, uint8 dirBits) public {
        _seed();
        uint256 i0 = token0.balanceOf(address(this)) + token0.balanceOf(address(pool));
        uint256 i1 = token1.balanceOf(address(this)) + token1.balanceOf(address(pool));

        for (uint256 i = 0; i < amounts.length; i++) {
            uint256 amt = bound(amounts[i], 1e12, 1e18);
            bool zeroForOne = (dirBits >> i) & 1 == 1;
            _swapExactIn(zeroForOne, amt);
        }

        pool.burn(LOWER, UPPER, L);
        pool.collect(address(this), LOWER, UPPER, type(uint128).max, type(uint128).max);

        uint256 f0 = token0.balanceOf(address(this));
        uint256 f1 = token1.balanceOf(address(this));
        assertLe(f0, i0);
        assertLe(f1, i1);
        assertLt(i0 - f0, 1e4, "token0 stuck in pool beyond dust");
        assertLt(i1 - f1, 1e4, "token1 stuck in pool beyond dust");
        assertEq(pool.liquidity(), 0);
    }

    /// Fuzzed positions + swaps that cross ticks: active liquidity always equals the sum of
    /// positions whose range contains the current tick, and the pool stays solvent.
    function testFuzz_activeLiquidityMatchesPositionsAfterCrossings(
        uint8 lo1,
        uint8 len1,
        uint8 lo2,
        uint8 len2,
        uint256 amtA,
        uint256 amtB,
        bool dirA
    ) public {
        int24 l1 = -int24(int256(bound(lo1, 0, 20))) * TICK_SPACING;
        int24 u1 = l1 + int24(int256(bound(len1, 1, 30))) * TICK_SPACING;
        int24 l2 = -int24(int256(bound(lo2, 0, 20))) * TICK_SPACING;
        int24 u2 = l2 + int24(int256(bound(len2, 1, 30))) * TICK_SPACING;
        pool.mint(address(this), l1, u1, 1e20, "");
        pool.mint(address(this), l2, u2, 3e20, "");

        pool.swap(address(this), dirA, int256(bound(amtA, 1e10, 1e20)), dirA ? TickMath.getSqrtRatioAtTick(-5000) : TickMath.getSqrtRatioAtTick(5000), "");
        pool.swap(address(this), !dirA, int256(bound(amtB, 1e10, 1e20)), !dirA ? TickMath.getSqrtRatioAtTick(-5000) : TickMath.getSqrtRatioAtTick(5000), "");

        (, int24 tick,,) = pool.slot0();
        uint128 expected;
        if (l1 <= tick && tick < u1) expected += 1e20;
        if (l2 <= tick && tick < u2) expected += 3e20;
        assertEq(pool.liquidity(), expected);

        pool.burn(l1, u1, 1e20);
        pool.burn(l2, u2, 3e20);
        pool.collect(address(this), l1, u1, type(uint128).max, type(uint128).max);
        pool.collect(address(this), l2, u2, type(uint128).max, type(uint128).max);
        assertEq(pool.liquidity(), 0);
        assertLt(token0.balanceOf(address(pool)), 1e4);
        assertLt(token1.balanceOf(address(pool)), 1e4);
    }
}
