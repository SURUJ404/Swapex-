// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {BitMath} from "./BitMath.sol";

/// Packed set of initialised ticks: one bit per (tick / tickSpacing), 256 per word.
library TickBitmap {
    error TickNotAligned(int24 tick, int24 tickSpacing);

    /// @dev compressed tick -> (word index, bit index inside the word)
    function position(int24 compressed) internal pure returns (int16 wordPos, uint8 bitPos) {
        wordPos = int16(compressed >> 8); // arithmetic shift: floor division
        bitPos = uint8(uint24(compressed) & 0xff); // low 8 bits, correct for negatives (two's complement)
    }

    function flipTick(mapping(int16 => uint256) storage self, int24 tick, int24 tickSpacing) internal {
        if (tick % tickSpacing != 0) revert TickNotAligned(tick, tickSpacing);
        (int16 wordPos, uint8 bitPos) = position(tick / tickSpacing);
        self[wordPos] ^= (1 << bitPos);
    }

    /// @notice next initialised tick in the same word as `tick`, searching left (lte) or right
    /// @return next the tick found, or the word boundary if none is initialised in this word
    function nextInitializedTickWithinOneWord(
        mapping(int16 => uint256) storage self,
        int24 tick,
        int24 tickSpacing,
        bool lte
    ) internal view returns (int24 next, bool initialized) {
        int24 compressed = tick / tickSpacing;
        if (tick < 0 && tick % tickSpacing != 0) compressed--; // round towards negative infinity

        if (lte) {
            (int16 wordPos, uint8 bitPos) = position(compressed);
            // all bits at or below bitPos
            uint256 mask = (1 << bitPos) - 1 + (1 << bitPos);
            uint256 masked = self[wordPos] & mask;
            initialized = masked != 0;
            next = initialized
                ? (compressed - int24(uint24(bitPos - BitMath.mostSignificantBit(masked)))) * tickSpacing
                : (compressed - int24(uint24(bitPos))) * tickSpacing;
        } else {
            // start from the next compressed tick
            (int16 wordPos, uint8 bitPos) = position(compressed + 1);
            // all bits at or above bitPos
            uint256 mask = ~((1 << bitPos) - 1);
            uint256 masked = self[wordPos] & mask;
            initialized = masked != 0;
            next = initialized
                ? (compressed + 1 + int24(uint24(BitMath.leastSignificantBit(masked) - bitPos))) * tickSpacing
                : (compressed + 1 + int24(uint24(type(uint8).max - bitPos))) * tickSpacing;
        }
    }
}
