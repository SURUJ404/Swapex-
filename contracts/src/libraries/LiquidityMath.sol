// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

library LiquidityMath {
    error LiquidityUnderflow();
    error LiquidityOverflow();

    /// @notice x + y for a signed delta, reverting on under/overflow of uint128
    function addDelta(uint128 x, int128 y) internal pure returns (uint128 z) {
        unchecked {
            if (y < 0) {
                uint128 d = uint128(-y); // -type(int128).min wraps to 2^127, which is still correct as uint128
                if (d > x) revert LiquidityUnderflow();
                z = x - d;
            } else {
                z = x + uint128(y);
                if (z < x) revert LiquidityOverflow();
            }
        }
    }
}
