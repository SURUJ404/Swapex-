// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice A minimal ERC-1271 smart-contract wallet for exercising the contract branch of
///         OpenZeppelin's `SignatureChecker`. `mode` selects the three outcomes a verifier must
///         treat identically-well:
///           0 = validate: magic value only when `signature` recovers to `owner`
///           1 = invalid:  always return a non-magic value
///           2 = revert:    always revert — a wallet that throws must read as *invalid*, never crash
///                          the caller or be mistaken for approval.
contract MockERC1271Wallet is IERC1271 {
    bytes4 private constant MAGIC = IERC1271.isValidSignature.selector;

    address public immutable owner;
    uint8 public mode;

    constructor(address owner_) {
        owner = owner_;
    }

    function setMode(uint8 m) external {
        mode = m;
    }

    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4) {
        if (mode == 2) revert("MockERC1271Wallet: validation reverts");
        if (mode == 1) return 0xffffffff;
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == owner) return MAGIC;
        return 0xffffffff;
    }
}
