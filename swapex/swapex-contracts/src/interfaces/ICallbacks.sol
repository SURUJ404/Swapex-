// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

interface ISwapexMintCallback {
    /// @notice pay `amount0Owed` / `amount1Owed` to the pool (msg.sender) before returning
    function swapexMintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata data) external;
}

interface ISwapexSwapCallback {
    /// @notice a positive delta is owed to the pool, a negative delta was already sent to the recipient
    function swapexSwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}

interface ISwapexFlashCallback {
    /// @notice repay the flash-loaned amounts plus `fee0` / `fee1` before returning
    function swapexFlashCallback(uint256 fee0, uint256 fee1, bytes calldata data) external;
}
