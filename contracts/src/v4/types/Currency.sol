// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

/// @notice An ERC-20 token (or, in a future phase, the native currency at address(0)).
/// A user-defined value type so currency handles are strongly typed and cannot be confused
/// with plain addresses in the PoolManager API.
type currency is address;

using {equals as ==, notEquals as !=} for currency global;

/// @notice The native-currency sentinel (reserved; Phase 3 wires up native ETH handling).
function ADDRESS_ZERO() pure returns (currency) {
    return currency.wrap(address(0));
}

function equals(currency self, currency other) pure returns (bool) {
    return currency.unwrap(self) == currency.unwrap(other);
}

function notEquals(currency self, currency other) pure returns (bool) {
    return currency.unwrap(self) != currency.unwrap(other);
}
