// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

/// @notice A packed pair of signed token amounts (amount0 in the high 128 bits, amount1 in the
/// low 128 bits). The sign convention throughout the PoolManager is the caller-owes convention:
/// a positive amount is owed BY the pool TO the caller (the caller may `take` it); a negative
/// amount is owed BY the caller TO the pool (the caller must `settle` it).
type BalanceDelta is int256;

using {amount0, amount1} for BalanceDelta global;

/// @notice Pack two int128 amounts into a single BalanceDelta.
function toBalanceDelta(int256 a0, int256 a1) pure returns (BalanceDelta) {
    // both amounts must fit in int128; the high/low packing makes overflow impossible to hide
    require(a0 >= type(int128).min && a0 <= type(int128).max, "a0 overflow");
    require(a1 >= type(int128).min && a1 <= type(int128).max, "a1 overflow");
    // mask the low 128 bits (keeps a1's two's-complement sign bit); a0 shifts into the high half
    int256 lowMask = int256(uint256(type(uint128).max)); // 2^128 - 1
    return BalanceDelta.wrap((a0 << 128) | (a1 & lowMask));
}

/// @notice The token0 component (high 128 bits, sign-extended).
function amount0(BalanceDelta self) pure returns (int256) {
    return BalanceDelta.unwrap(self) >> 128;
}

/// @notice The token1 component (low 128 bits, sign-extended).
function amount1(BalanceDelta self) pure returns (int256) {
    int256 x = BalanceDelta.unwrap(self);
    // shift left 128 then arithmetic-shift right 128 to sign-extend the low half
    unchecked {
        // pure bit operation; no arithmetic overflow is possible
        return (x << 128) >> 128;
    }
}
