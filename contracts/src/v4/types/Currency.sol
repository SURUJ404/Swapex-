// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {IERC20Minimal} from "../../interfaces/IERC20Minimal.sol";

/// @notice An ERC-20 token or the native currency at address(0).
/// A user-defined value type so currency handles are strongly typed and cannot be confused
/// with plain addresses in the PoolManager API.
type currency is address;

using {equals as ==, notEquals as !=, isNative} for currency global;
using CurrencyLibrary for currency global;

error NativeCurrencyTransferFailed();
error ERC20TransferFailed();
error NativeCurrencyNotTransferable();

/// @notice The native-currency sentinel (address(0)).
function ADDRESS_ZERO() pure returns (currency) {
    return currency.wrap(address(0));
}

function equals(currency self, currency other) pure returns (bool) {
    return currency.unwrap(self) == currency.unwrap(other);
}

function notEquals(currency self, currency other) pure returns (bool) {
    return currency.unwrap(self) != currency.unwrap(other);
}

/// @notice true when this currency is the native currency (address(0)), not an ERC-20.
function isNative(currency self) pure returns (bool) {
    return currency.unwrap(self) == address(0);
}

/// @notice Movement and balance helpers for a currency. Internal library functions inline into
///         the calling contract, so `address(this)` is the PoolManager (or whichever contract
///         uses them) and native transfers draw on that contract's ETH balance.
library CurrencyLibrary {
    /// @notice the calling contract's balance of `self` (its ETH balance when native).
    function balanceOf(currency self) internal view returns (uint256) {
        if (isNative(self)) return address(this).balance;
        return IERC20Minimal(currency.unwrap(self)).balanceOf(address(this));
    }

    /// @notice move `amount` of `self` from this contract to `to` (sends ETH when native).
    function transfer(currency self, address to, uint256 amount) internal {
        if (isNative(self)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert NativeCurrencyTransferFailed();
        } else {
            if (!IERC20Minimal(currency.unwrap(self)).transfer(to, amount)) revert ERC20TransferFailed();
        }
    }

    /// @notice pull `amount` of an ERC-20 `self` from `from` to `to`. Native currency has no
    ///         transferFrom; it only moves via a payable `settle` (in) or `take` (out).
    function transferFrom(currency self, address from, address to, uint256 amount) internal {
        if (isNative(self)) revert NativeCurrencyNotTransferable();
        if (!IERC20Minimal(currency.unwrap(self)).transferFrom(from, to, amount)) revert ERC20TransferFailed();
    }

    /// @notice approve `spender` to pull `amount` of an ERC-20 `self` from this contract. Native
    ///         currency needs no allowance (it moves only via payable settle/take).
    function approve(currency self, address spender, uint256 amount) internal {
        if (isNative(self)) revert NativeCurrencyNotTransferable();
        if (!IERC20Minimal(currency.unwrap(self)).approve(spender, amount)) revert ERC20TransferFailed();
    }
}
