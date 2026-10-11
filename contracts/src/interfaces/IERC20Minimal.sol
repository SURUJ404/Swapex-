// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}
