// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

interface ISwapexFactory {
    function owner() external view returns (address);

    /// @dev read by a pool in its constructor so the pool's init code is identical for every pool
    function parameters()
        external
        view
        returns (address factory, address token0, address token1, uint24 fee, int24 tickSpacing);
}
