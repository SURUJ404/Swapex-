// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

/// @title Observations - TWAP oracle ring buffer, mirrored from reference/poolmodel.py
/// @notice An observation records the cumulative `tick * time` and `time / liquidity` integrals at a
///         point in time. Every state-changing pool operation (swap/mint/burn) appends one, so a
///         consumer can `observe` the time-weighted average tick (or seconds-per-liquidity) over any
///         window that the retained ring buffer still covers. This is written from scratch.
library Observations {
    struct Observation {
        uint32 blockTimestamp; // the timestamp of the observation
        int56 tickCumulative; // per-second tick sums at the time of observation
        uint160 secondsPerLiquidityCumulativeX128; // liquidity-weighted seconds sums, Q128
        bool initialized; // whether the observation has been written
    }

    /// @dev Overwrite slot 0 with the bootstrap observation, stamped with the pool's creation
    ///      time and zeroed cumulatives. Stamping `time` (not epoch 0) means a window that
    ///      predates pool creation truncates to this bootstrap instead of interpolating fake
    ///      pre-creation tick history (Unix epoch > pool creation in any real deployment).
    function initialize(Observation[65535] storage self, uint32 time) internal {
        self[0] = Observation({blockTimestamp: time, tickCumulative: 0, secondsPerLiquidityCumulativeX128: 0, initialized: true});
    }

    /// @notice Advance the cumulatives from the newest observation up to `blockTimestamp` using the
    ///         CURRENT (pre-operation) `tick` and `liquidity`, then append a new observation.
    /// @return indexUpdated      the index of the newly written observation
    /// @return cardinalityUpdated the new number of retained observations (grows by one, at most,
    ///                            when the write fills the last unfilled slot up to cardinalityNext)
    function write(
        Observation[65535] storage self,
        uint16 index,
        uint32 blockTimestamp,
        int24 tick,
        uint128 liquidity,
        uint16 cardinality,
        uint16 cardinalityNext
    ) internal returns (uint16 indexUpdated, uint16 cardinalityUpdated) {
        Observation storage last = self[index];

        uint32 delta = blockTimestamp - last.blockTimestamp;
        // tick is bounded by |tick| <= 887272 and delta < 2^32, so the product fits int56
        // (max ~3.8e15 << 3.6e16); the running sum is likewise bounded in practice. Checked math
        // is kept here so an out-of-range input reverts rather than silently corrupting the oracle.
        int56 tickCumulative = last.tickCumulative + int56(tick) * int56(uint56(delta));

        uint160 secondsPerLiquidityCumulativeX128;
        if (liquidity > 0) {
            // A wrapping cumulative (like fee growth): with unchecked this saturates/wraps instead of
            // reverting so a low-liquidity pool can never brick observe(). The reference model uses
            // unbounded ints and matches bit-for-bit until such a wrap, which tests never reach.
            unchecked {
                secondsPerLiquidityCumulativeX128 = last.secondsPerLiquidityCumulativeX128 +
                    uint160((uint256(delta) << 128) / liquidity);
            }
        } else {
            // no liquidity to average over: carry the previous value forward
            secondsPerLiquidityCumulativeX128 = last.secondsPerLiquidityCumulativeX128;
        }

        uint16 updatedCardinality = cardinality;
        if (cardinalityNext > cardinality && index == cardinality - 1) {
            updatedCardinality = cardinality + 1;
        }
        uint16 nextIndex = (index + 1) % cardinalityNext;

        self[nextIndex] = Observation({
            blockTimestamp: blockTimestamp,
            tickCumulative: tickCumulative,
            secondsPerLiquidityCumulativeX128: secondsPerLiquidityCumulativeX128,
            initialized: true
        });
        return (nextIndex, updatedCardinality);
    }

    /// @notice Cumulative values at `blockTimestamp - secondsAgo`, interpolating within the ring.
    function observe(
        Observation[65535] storage self,
        uint32 time,
        uint32[] memory secondsAgos,
        int24 tick,
        uint128 liquidity,
        uint16 index,
        uint16 cardinality,
        uint16 cardinalityNext
    ) internal view returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativesX128) {
        require(cardinality > 0, 'NE');
        uint256 n = secondsAgos.length;
        tickCumulatives = new int56[](n);
        secondsPerLiquidityCumulativesX128 = new uint160[](n);
        for (uint256 i = 0; i < n; i++) {
            (tickCumulatives[i], secondsPerLiquidityCumulativesX128[i]) = observeSingle(
                self, time, secondsAgos[i], tick, liquidity, index, cardinality, cardinalityNext
            );
        }
    }

    function observeSingle(
        Observation[65535] storage self,
        uint32 time,
        uint32 secondsAgo,
        int24 tick,
        uint128 liquidity,
        uint16 index,
        uint16 cardinality,
        uint16 cardinalityNext
    ) internal view returns (int56 tickCumulative, uint160 secondsPerLiquidityCumulativeX128) {
        require(cardinality > 0, 'NE');
        uint32 target = time - secondsAgo;

        Observation storage last = self[index];
        if (target >= last.blockTimestamp) {
            // between the newest observation and now: the tick and liquidity are constant
            uint32 dt = target - last.blockTimestamp;
            tickCumulative = last.tickCumulative + int56(tick) * int56(uint56(dt));
            if (liquidity > 0) {
                unchecked {
                    secondsPerLiquidityCumulativeX128 = last.secondsPerLiquidityCumulativeX128 +
                        uint160((uint256(dt) << 128) / liquidity);
                }
            } else {
                secondsPerLiquidityCumulativeX128 = last.secondsPerLiquidityCumulativeX128;
            }
            return (tickCumulative, secondsPerLiquidityCumulativeX128);
        }

        // target is older than the newest observation: locate the surrounding stored pair
        (Observation storage beforeOrAt, Observation storage atOrAfter) =
            getSurroundingObservations(self, target, index, cardinality, cardinalityNext);

        if (target <= beforeOrAt.blockTimestamp) {
            // exact match, or `target` predates every retained observation (truncated window):
            // return the oldest cumulative, matching the reference model. This also guards the
            // `target - beforeOrAt.blockTimestamp` subtraction below from underflowing.
            return (beforeOrAt.tickCumulative, beforeOrAt.secondsPerLiquidityCumulativeX128);
        }
        if (target == atOrAfter.blockTimestamp) {
            return (atOrAfter.tickCumulative, atOrAfter.secondsPerLiquidityCumulativeX128);
        }

        // linearly interpolate between the two surrounding observations. Within one inter-observation
        // interval the tick is constant, so the tickCumulative division below is exact (floor == trunc).
        uint32 observationTimeDelta = atOrAfter.blockTimestamp - beforeOrAt.blockTimestamp;
        uint32 targetDelta = target - beforeOrAt.blockTimestamp;
        if (observationTimeDelta == 0) {
            // duplicate timestamps (zero-length interval): no meaningful interpolation
            return (beforeOrAt.tickCumulative, beforeOrAt.secondsPerLiquidityCumulativeX128);
        }
        // tick*targetDelta is bounded (~3.8e15) so the int56 cast cannot truncate in range
        tickCumulative = beforeOrAt.tickCumulative +
            int56(
                (int256(atOrAfter.tickCumulative - beforeOrAt.tickCumulative) / int256(uint256(observationTimeDelta))) *
                    int256(uint256(targetDelta))
            );
        secondsPerLiquidityCumulativeX128 = beforeOrAt.secondsPerLiquidityCumulativeX128 +
            uint160(
                (uint256(atOrAfter.secondsPerLiquidityCumulativeX128 - beforeOrAt.secondsPerLiquidityCumulativeX128) /
                    uint256(observationTimeDelta)) * uint256(targetDelta)
            );
    }

    /// @dev Walk backward from `index` over the retained observations to find the pair that brackets
    ///      `target`. If `target` predates every retained observation the window is truncated and the
    ///      oldest observation is returned for both (matching the reference model's truncation).
    function getSurroundingObservations(
        Observation[65535] storage self,
        uint32 target,
        uint16 index,
        uint16 cardinality,
        uint16 cardinalityNext
    ) private view returns (Observation storage beforeOrAt, Observation storage atOrAfter) {
        atOrAfter = self[index]; // newest; also the running "more recent" candidate
        for (uint16 i = 1; i < cardinality; i++) {
            uint16 idx = (index + cardinalityNext - i) % cardinalityNext;
            Observation storage obs = self[idx];
            if (obs.blockTimestamp <= target) {
                return (obs, atOrAfter);
            }
            atOrAfter = obs;
        }
        // target is older than every retained observation: truncate to the oldest
        return (atOrAfter, atOrAfter);
    }
}
