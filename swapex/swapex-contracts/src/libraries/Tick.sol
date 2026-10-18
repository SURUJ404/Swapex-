// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {LiquidityMath} from "./LiquidityMath.sol";
import {TickMath} from "./TickMath.sol";

/// Per-tick state: how much liquidity starts/stops here and fee growth on the other side of the tick.
library Tick {
    error TickLiquidityOverflow();

    struct Info {
        uint128 liquidityGross; // total liquidity referencing this tick (0 = tick not initialised)
        int128 liquidityNet; // liquidity added when crossing left-to-right (negated going right-to-left)
        uint256 feeGrowthOutside0X128; // fee growth on the far side of the tick, relative to the current tick
        uint256 feeGrowthOutside1X128;
    }

    /// @notice cap on liquidityGross per tick so the sum over all ticks never overflows uint128
    function tickSpacingToMaxLiquidityPerTick(int24 tickSpacing) internal pure returns (uint128) {
        int24 minTick = (TickMath.MIN_TICK / tickSpacing) * tickSpacing;
        int24 maxTick = (TickMath.MAX_TICK / tickSpacing) * tickSpacing;
        uint24 numTicks = uint24((maxTick - minTick) / tickSpacing) + 1;
        return type(uint128).max / numTicks;
    }

    /// @notice fee growth accumulated inside [tickLower, tickUpper)
    /// @dev all arithmetic wraps on purpose: only differences of fee-growth values are meaningful
    function getFeeGrowthInside(
        mapping(int24 => Info) storage self,
        int24 tickLower,
        int24 tickUpper,
        int24 tickCurrent,
        uint256 feeGrowthGlobal0X128,
        uint256 feeGrowthGlobal1X128
    ) internal view returns (uint256 feeGrowthInside0X128, uint256 feeGrowthInside1X128) {
        Info storage lower = self[tickLower];
        Info storage upper = self[tickUpper];

        unchecked {
            uint256 below0;
            uint256 below1;
            if (tickCurrent >= tickLower) {
                below0 = lower.feeGrowthOutside0X128;
                below1 = lower.feeGrowthOutside1X128;
            } else {
                below0 = feeGrowthGlobal0X128 - lower.feeGrowthOutside0X128;
                below1 = feeGrowthGlobal1X128 - lower.feeGrowthOutside1X128;
            }

            uint256 above0;
            uint256 above1;
            if (tickCurrent < tickUpper) {
                above0 = upper.feeGrowthOutside0X128;
                above1 = upper.feeGrowthOutside1X128;
            } else {
                above0 = feeGrowthGlobal0X128 - upper.feeGrowthOutside0X128;
                above1 = feeGrowthGlobal1X128 - upper.feeGrowthOutside1X128;
            }

            feeGrowthInside0X128 = feeGrowthGlobal0X128 - below0 - above0;
            feeGrowthInside1X128 = feeGrowthGlobal1X128 - below1 - above1;
        }
    }

    /// @notice apply a liquidity change at a tick; returns true if the tick became (un)initialised
    function update(
        mapping(int24 => Info) storage self,
        int24 tick,
        int24 tickCurrent,
        int128 liquidityDelta,
        uint256 feeGrowthGlobal0X128,
        uint256 feeGrowthGlobal1X128,
        bool upper,
        uint128 maxLiquidity
    ) internal returns (bool flipped) {
        Info storage info = self[tick];

        uint128 grossBefore = info.liquidityGross;
        uint128 grossAfter = LiquidityMath.addDelta(grossBefore, liquidityDelta);
        if (grossAfter > maxLiquidity) revert TickLiquidityOverflow();

        flipped = (grossAfter == 0) != (grossBefore == 0);

        if (grossBefore == 0) {
            // by convention all growth so far happened below the tick
            if (tick <= tickCurrent) {
                info.feeGrowthOutside0X128 = feeGrowthGlobal0X128;
                info.feeGrowthOutside1X128 = feeGrowthGlobal1X128;
            }
        }

        info.liquidityGross = grossAfter;
        // lower tick adds liquidity going right, upper tick removes it
        info.liquidityNet = upper ? info.liquidityNet - liquidityDelta : info.liquidityNet + liquidityDelta;
    }

    function clear(mapping(int24 => Info) storage self, int24 tick) internal {
        delete self[tick];
    }

    /// @notice flip the outside fee growth when the price crosses `tick`; returns liquidityNet
    function cross(
        mapping(int24 => Info) storage self,
        int24 tick,
        uint256 feeGrowthGlobal0X128,
        uint256 feeGrowthGlobal1X128
    ) internal returns (int128 liquidityNet) {
        Info storage info = self[tick];
        unchecked {
            info.feeGrowthOutside0X128 = feeGrowthGlobal0X128 - info.feeGrowthOutside0X128;
            info.feeGrowthOutside1X128 = feeGrowthGlobal1X128 - info.feeGrowthOutside1X128;
        }
        liquidityNet = info.liquidityNet;
    }
}
