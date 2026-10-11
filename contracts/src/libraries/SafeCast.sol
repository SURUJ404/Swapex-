// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

library SafeCast {
    error CastOverflow();

    function toUint160(uint256 y) internal pure returns (uint160 z) {
        if (y > type(uint160).max) revert CastOverflow();
        z = uint160(y);
    }

    function toUint128(uint256 y) internal pure returns (uint128 z) {
        if (y > type(uint128).max) revert CastOverflow();
        z = uint128(y);
    }

    function toInt128(uint256 y) internal pure returns (int128 z) {
        if (y > uint128(type(int128).max)) revert CastOverflow();
        z = int128(int256(y));
    }

    function toInt256(uint256 y) internal pure returns (int256 z) {
        if (y > uint256(type(int256).max)) revert CastOverflow();
        z = int256(y);
    }
}
