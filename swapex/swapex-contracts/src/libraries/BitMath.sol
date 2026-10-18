// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

library BitMath {
    error ZeroValue();

    /// @notice index (0 = least significant) of the highest set bit
    function mostSignificantBit(uint256 x) internal pure returns (uint8 r) {
        if (x == 0) revert ZeroValue();
        if (x >= 1 << 128) { x >>= 128; r += 128; }
        if (x >= 1 << 64) { x >>= 64; r += 64; }
        if (x >= 1 << 32) { x >>= 32; r += 32; }
        if (x >= 1 << 16) { x >>= 16; r += 16; }
        if (x >= 1 << 8) { x >>= 8; r += 8; }
        if (x >= 1 << 4) { x >>= 4; r += 4; }
        if (x >= 1 << 2) { x >>= 2; r += 2; }
        if (x >= 1 << 1) { r += 1; }
    }

    /// @notice index (0 = least significant) of the lowest set bit
    function leastSignificantBit(uint256 x) internal pure returns (uint8 r) {
        if (x == 0) revert ZeroValue();
        if (x & type(uint128).max == 0) { x >>= 128; r += 128; }
        if (x & type(uint64).max == 0) { x >>= 64; r += 64; }
        if (x & type(uint32).max == 0) { x >>= 32; r += 32; }
        if (x & type(uint16).max == 0) { x >>= 16; r += 16; }
        if (x & type(uint8).max == 0) { x >>= 8; r += 8; }
        if (x & 0xf == 0) { x >>= 4; r += 4; }
        if (x & 0x3 == 0) { x >>= 2; r += 2; }
        if (x & 0x1 == 0) { r += 1; }
    }
}
