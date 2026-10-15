// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {FullMath} from "../../libraries/FullMath.sol";
import {LiquidityMath} from "../../libraries/LiquidityMath.sol";
import {SafeCast} from "../../libraries/SafeCast.sol";
import {SwapMath} from "../../libraries/SwapMath.sol";
import {Tick} from "../../libraries/Tick.sol";
import {TickBitmap} from "../../libraries/TickBitmap.sol";
import {TickMath} from "../../libraries/TickMath.sol";
import {Slot0, Pool} from "./PoolState.sol";

/// @notice The concentrated-liquidity swap loop, split out of PoolManager so the singleton fits under
///         the EIP-170 code-size limit. It is an `external` library: PoolManager `delegatecall`s it, so it
///         runs against the manager's own storage (`pool` is a storage pointer into the manager).
///         It touches only pool state; flash accounting, hooks and events stay in PoolManager.
library SwapLogic {
    using Tick for mapping(int24 => Tick.Info);
    using TickBitmap for mapping(int16 => uint256);
    using SafeCast for uint256;

    error InvalidPriceLimit();

    uint24 internal constant PROTOCOL_FEE_DENOMINATOR = 1_000_000;

    struct SwapState {
        int256 amountSpecifiedRemaining;
        int256 amountCalculated;
        uint160 sqrtPriceX96;
        int24 tick;
        uint256 feeGrowthGlobalX128; // growth of the input token
        uint128 liquidity;
        uint256 protocolFees; // protocol's cut of the input-token fees, accrued this swap
    }

    struct StepComputations {
        uint160 sqrtPriceStartX96;
        int24 tickNext;
        bool initialized;
        uint160 sqrtPriceNextX96;
        uint256 amountIn;
        uint256 amountOut;
        uint256 feeAmount;
    }

    /// @dev V3-style raw amounts (positive = caller owes the pool, negative = pool owes the caller)
    ///      plus the post-swap pool state needed for the Swap event.
    struct Result {
        int256 amount0Raw;
        int256 amount1Raw;
        uint160 sqrtPriceX96;
        uint128 liquidity;
        int24 tick;
    }

    function run(
        Pool storage pool,
        int24 tickSpacing,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        uint24 lpFee
    )
        external
        returns (Result memory r)
    {
        Slot0 memory slot0Start = pool.slot0;
        if (
            zeroForOne
                ? !(sqrtPriceLimitX96 < slot0Start.sqrtPriceX96 && sqrtPriceLimitX96 > TickMath.MIN_SQRT_RATIO)
                : !(sqrtPriceLimitX96 > slot0Start.sqrtPriceX96 && sqrtPriceLimitX96 < TickMath.MAX_SQRT_RATIO)
        ) revert InvalidPriceLimit();

        bool exactInput = amountSpecified > 0;
        uint24 protocolFee = slot0Start.protocolFee;
        SwapState memory state = SwapState({
            amountSpecifiedRemaining: amountSpecified,
            amountCalculated: 0,
            sqrtPriceX96: slot0Start.sqrtPriceX96,
            tick: slot0Start.tick,
            feeGrowthGlobalX128: zeroForOne ? pool.feeGrowthGlobal0X128 : pool.feeGrowthGlobal1X128,
            liquidity: pool.liquidity,
            protocolFees: 0
        });

        while (state.amountSpecifiedRemaining != 0 && state.sqrtPriceX96 != sqrtPriceLimitX96) {
            StepComputations memory step;
            step.sqrtPriceStartX96 = state.sqrtPriceX96;

            (step.tickNext, step.initialized) =
                pool.tickBitmap.nextInitializedTickWithinOneWord(state.tick, tickSpacing, zeroForOne);

            // the bitmap does not know the global bounds
            if (step.tickNext < TickMath.MIN_TICK) step.tickNext = TickMath.MIN_TICK;
            else if (step.tickNext > TickMath.MAX_TICK) step.tickNext = TickMath.MAX_TICK;

            step.sqrtPriceNextX96 = TickMath.getSqrtRatioAtTick(step.tickNext);

            (state.sqrtPriceX96, step.amountIn, step.amountOut, step.feeAmount) = SwapMath.computeSwapStep(
                state.sqrtPriceX96,
                (zeroForOne ? step.sqrtPriceNextX96 < sqrtPriceLimitX96 : step.sqrtPriceNextX96 > sqrtPriceLimitX96)
                    ? sqrtPriceLimitX96
                    : step.sqrtPriceNextX96,
                state.liquidity,
                state.amountSpecifiedRemaining,
                lpFee
            );

            if (exactInput) {
                state.amountSpecifiedRemaining -= (step.amountIn + step.feeAmount).toInt256();
                state.amountCalculated -= step.amountOut.toInt256();
            } else {
                state.amountSpecifiedRemaining += step.amountOut.toInt256();
                state.amountCalculated += (step.amountIn + step.feeAmount).toInt256();
            }

            // carve the protocol's cut out of the fee before accruing the lp portion. The protocol
            // share is a fraction (protocolFee/1e6) of the fee and does not change the trader's
            // cost (amountSpecified above already used the full feeAmount); it only reduces what
            // the lp accrues. The protocol portion accrues in the input-token units.
            if (protocolFee > 0) {
                uint256 protocolPortion = FullMath.mulDiv(step.feeAmount, protocolFee, PROTOCOL_FEE_DENOMINATOR);
                step.feeAmount -= protocolPortion;
                state.protocolFees += protocolPortion;
            }

            // fees only accrue to in-range liquidity; wrap-around is intended
            if (state.liquidity > 0) {
                unchecked {
                    state.feeGrowthGlobalX128 += FullMath.mulDiv(step.feeAmount, 1 << 128, state.liquidity);
                }
            }

            if (state.sqrtPriceX96 == step.sqrtPriceNextX96) {
                // reached the next tick: cross it if it is initialised
                if (step.initialized) {
                    int128 liquidityNet = pool.ticks.cross(
                        step.tickNext,
                        zeroForOne ? state.feeGrowthGlobalX128 : pool.feeGrowthGlobal0X128,
                        zeroForOne ? pool.feeGrowthGlobal1X128 : state.feeGrowthGlobalX128
                    );
                    // moving left removes what moving right would add
                    if (zeroForOne) liquidityNet = -liquidityNet;
                    state.liquidity = LiquidityMath.addDelta(state.liquidity, liquidityNet);
                }
                state.tick = zeroForOne ? step.tickNext - 1 : step.tickNext;
            } else if (state.sqrtPriceX96 != step.sqrtPriceStartX96) {
                // price moved inside the range: recompute the tick
                state.tick = TickMath.getTickAtSqrtRatio(state.sqrtPriceX96);
            }
        }

        // ---- effects
        pool.slot0.sqrtPriceX96 = state.sqrtPriceX96;
        if (state.tick != slot0Start.tick) pool.slot0.tick = state.tick;
        if (pool.liquidity != state.liquidity) pool.liquidity = state.liquidity;
        if (zeroForOne) pool.feeGrowthGlobal0X128 = state.feeGrowthGlobalX128;
        else pool.feeGrowthGlobal1X128 = state.feeGrowthGlobalX128;
        if (state.protocolFees > 0) {
            // the protocol's cut is denominated in the input token (token0 when zeroForOne)
            if (zeroForOne) pool.protocolFees0 += state.protocolFees.toUint128();
            else pool.protocolFees1 += state.protocolFees.toUint128();
        }


        // V3-style amounts: positive = caller owes the pool, negative = pool owes the caller
        (r.amount0Raw, r.amount1Raw) = zeroForOne == exactInput
            ? (amountSpecified - state.amountSpecifiedRemaining, state.amountCalculated)
            : (state.amountCalculated, amountSpecified - state.amountSpecifiedRemaining);
        r.sqrtPriceX96 = state.sqrtPriceX96;
        r.liquidity = state.liquidity;
        r.tick = state.tick;
    }
}
