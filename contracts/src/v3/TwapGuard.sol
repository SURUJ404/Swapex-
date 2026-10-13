// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {SwapexPool} from "./SwapexPool.sol";

// Minimum seconds a consultable TWAP window must span. Shorter windows are dominated by
// single-block spot manipulation (see DECISIONS D33) and are refused outright.
uint32 constant TWAP_MIN_WINDOW = 30 minutes;

/// @title TwapGuard - policy-enforcing reader for the V3 pool's observation ring
/// @notice The raw `SwapexPool.observe*` API is deliberately permissive (D7: truncation over
///         revert, matching the reference model) - it will happily hand back a cumulative for a
///         window it does not actually cover. That silent truncation is a value-decision hazard:
///         a consumer dividing by the requested window length gets a wrong average with no error
///         signal. This library is the enforceable "no spot, min window, known coverage" rule for
///         anything that would USE the oracle to move money:
///         - refuses windows shorter than `TWAP_MIN_WINDOW`,
///         - refuses windows older than the pool's oldest retained observation (no silent
///           truncation - the caller must grow cardinality or wait),
///         - refuses uninitialized pools.
///         It returns the time-weighted average tick over [now - window, now]; it never returns
///         the spot tick, and no code path reads `slot0` here.
library TwapGuard {
    error OracleWindowTooShort(uint32 requested, uint32 minimum);
    error OracleWindowNotCovered(uint32 requested, uint32 covered);
    error OracleUninitialized();

    /// @notice Time-weighted average tick over `[block.timestamp - window, block.timestamp]`.
    /// @param pool  The V3 pool to read.
    /// @param window Seconds to average over; must be >= TWAP_MIN_WINDOW and fully covered by
    ///               the retained observation ring.
    /// @return twapTick The time-weighted average tick for the window.
    function consult(SwapexPool pool, uint32 window) internal view returns (int24 twapTick) {
        if (window < TWAP_MIN_WINDOW) revert OracleWindowTooShort(window, TWAP_MIN_WINDOW);

        uint16 cardNext = pool.observationCardinalityNext();
        uint16 card = pool.observationCardinality();
        if (cardNext == 0 || card == 0) revert OracleUninitialized();

        uint32 nowTs = uint32(block.timestamp);
        uint16 index = pool.observationIndex();
        // oldest retained slot: the ring fills forward from 0 until it wraps at cardinalityNext
        uint16 oldestIdx = uint16((uint256(index) + cardNext - (card - 1)) % cardNext);
        (uint32 oldestTs,,,) = pool.observations(oldestIdx);

        if (nowTs < window) revert OracleWindowNotCovered(window, nowTs);
        uint32 target = nowTs - window;
        if (oldestTs > target) {
            uint32 covered = nowTs - oldestTs;
            revert OracleWindowNotCovered(window, covered);
        }

        (int56 cStart,) = pool.observeSingle(window);
        (int56 cEnd,) = pool.observeSingle(0);
        twapTick = int24(int256(cEnd - cStart) / int256(uint256(window)));
    }
}
