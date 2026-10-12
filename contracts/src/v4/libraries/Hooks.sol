// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

error InvalidHookAddress();

/// @notice The address-permission scheme. A hook's permissions are encoded in the low bits of its
///         contract address (the deployer mines a CREATE2 salt so the resulting address carries the
///         desired flags). The manager consults these bits to decide which hook functions to call.
///         Bits 3..12 are the flag region; bits 0..2 are reserved and must be clear, which is what
///         `validate` enforces at initialize time.
library Hooks {
    uint256 internal constant BEFORE_INITIALIZE_FLAG = 1 << 11;
    uint256 internal constant AFTER_INITIALIZE_FLAG = 1 << 10;
    uint256 internal constant BEFORE_ADD_LIQUIDITY_FLAG = 1 << 9;
    uint256 internal constant AFTER_ADD_LIQUIDITY_FLAG = 1 << 8;
    uint256 internal constant BEFORE_REMOVE_LIQUIDITY_FLAG = 1 << 7;
    uint256 internal constant AFTER_REMOVE_LIQUIDITY_FLAG = 1 << 6;
    uint256 internal constant BEFORE_SWAP_FLAG = 1 << 5;
    uint256 internal constant AFTER_SWAP_FLAG = 1 << 4;
    uint256 internal constant DYNAMIC_FEE_FLAG = 1 << 3;
    uint256 internal constant BEFORE_SWAP_DELTA_FLAG = 1 << 12;

    /// @dev every valid permission bit. A mined address may only set bits from this mask.
    uint256 internal constant VALID_MASK = BEFORE_INITIALIZE_FLAG | AFTER_INITIALIZE_FLAG
        | BEFORE_ADD_LIQUIDITY_FLAG | AFTER_ADD_LIQUIDITY_FLAG | BEFORE_REMOVE_LIQUIDITY_FLAG
        | AFTER_REMOVE_LIQUIDITY_FLAG | BEFORE_SWAP_FLAG | AFTER_SWAP_FLAG | DYNAMIC_FEE_FLAG
        | BEFORE_SWAP_DELTA_FLAG;

    /// @dev the low 13 bits are the flag region; bits 0..2 are reserved and must be clear.
    uint256 private constant FLAG_REGION_MASK = 0x1FFF;

    function hasPermission(address hook, uint256 flag) internal pure returns (bool) {
        return (uint160(hook) & uint160(flag)) != 0;
    }

    /// @notice reject hook addresses that were not mined (a stray bit set in the reserved low bits).
    function validate(address hook) internal pure {
        if ((uint160(hook) & FLAG_REGION_MASK) & ~uint160(VALID_MASK) != 0) revert InvalidHookAddress();
    }
}
