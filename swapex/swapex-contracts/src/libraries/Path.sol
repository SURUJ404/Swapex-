// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

/// A swap path is packed bytes: token (20) | fee (3) | token (20) | fee (3) | token (20) ...
/// Exact-input paths run tokenIn -> tokenOut. Exact-output paths are encoded in reverse (tokenOut -> tokenIn).
library Path {
    error InvalidPath();

    uint256 internal constant ADDR = 20;
    uint256 internal constant FEE = 3;
    uint256 internal constant HOP = ADDR + FEE; // 23
    uint256 internal constant POOL = ADDR + FEE + ADDR; // 43
    uint256 internal constant MAX_POOLS = 4;

    function isValid(bytes memory path) internal pure returns (bool) {
        if (path.length < POOL) return false;
        if ((path.length - ADDR) % HOP != 0) return false;
        return (path.length - ADDR) / HOP <= MAX_POOLS;
    }

    function numPools(bytes memory path) internal pure returns (uint256) {
        return (path.length - ADDR) / HOP;
    }

    function hasMultiplePools(bytes memory path) internal pure returns (bool) {
        return path.length >= POOL + HOP;
    }

    function decodeFirstPool(bytes memory path) internal pure returns (address tokenA, address tokenB, uint24 fee) {
        if (path.length < POOL) revert InvalidPath();
        assembly {
            let p := add(path, 0x20)
            tokenA := shr(96, mload(p))
            fee := and(shr(72, mload(p)), 0xffffff) // bytes 20..22
            tokenB := shr(96, mload(add(p, 23)))
        }
    }

    /// @notice path without its first token and fee (the next hop starts at the old tokenB)
    function skipToken(bytes memory path) internal pure returns (bytes memory out) {
        if (path.length < POOL) revert InvalidPath();
        uint256 len = path.length - HOP;
        out = new bytes(len);
        for (uint256 i = 0; i < len; i++) {
            out[i] = path[i + HOP];
        }
    }

    function firstToken(bytes memory path) internal pure returns (address token) {
        if (path.length < ADDR) revert InvalidPath();
        assembly {
            token := shr(96, mload(add(path, 0x20)))
        }
    }

    function lastToken(bytes memory path) internal pure returns (address token) {
        if (path.length < ADDR) revert InvalidPath();
        assembly {
            token := shr(96, mload(add(add(path, 0x20), sub(mload(path), 20))))
        }
    }
}
