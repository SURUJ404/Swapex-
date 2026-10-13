// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @notice ERC-20 that supports EIP-2612 `permit` (OpenZeppelin implementation). Lets the tests
///         exercise `AllowanceTransfer.permitERC20` — signing a token approval instead of sending
///         an `approve` transaction — and confirm the failure path on a token that has no `permit`.
contract MockERC20Permit is ERC20, ERC20Permit {
    constructor() ERC20("Permit Token", "PMT") ERC20Permit("Permit Token") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
