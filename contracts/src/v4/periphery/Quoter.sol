// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {PoolManager, SwapParams} from "../PoolManager.sol";
import {BalanceDelta, amount0, amount1} from "../types/BalanceDelta.sol";
import {PoolKey} from "../types/PoolKey.sol";

/// @notice Read-only quoter: simulates an exact-input single swap inside a throwaway unlock
///         session and returns the resulting signed amounts. The callback always reverts, so the
///         entire session (including the manager's transient flash-accounting state) unwinds and
///         nothing is committed. This makes the function safe to call via `eth_call` with no
///         balance, allowance, or side effects.
contract Quoter {
    PoolManager public immutable pm;

    error QuoteUnavailable();

    /// @dev carries the simulated result out of the reverted callback through the revert payload.
    error Quoted(int256 amount0, int256 amount1);

    // one quote per external call; the manager's unlock lock forbids concurrency, so plain storage
    // is safe here (and is reverted away with the session regardless).
    PoolKey private _key;
    SwapParams private _params;

    constructor(PoolManager _pm) {
        pm = _pm;
    }

    /// @notice simulate an exact-input single swap and return the signed deltas.
    /// @return amount0 signed amount of currency0 in the caller-owes convention (negative = the
    ///         caller pays currency0; positive = the pool pays the caller currency0).
    /// @return amount1 signed amount of currency1 in the caller-owes convention.
    function quoteExactInputSingle(PoolKey memory key, SwapParams memory sp)
        external
        returns (int256 amount0, int256 amount1)
    {
        _key = key;
        _params = sp;
        try pm.unlock("") {
            // unreachable: the callback always reverts.
            revert QuoteUnavailable();
        } catch (bytes memory reason) {
            (bool ok, int256 a0, int256 a1) = _decodeQuoted(reason);
            if (!ok) revert QuoteUnavailable();
            return (a0, a1);
        }
    }

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        require(msg.sender == address(pm), "only manager");
        BalanceDelta d = pm.swap(_key, _params);
        // encode the result into the revert reason so the outer call can recover it; reverts unwind
        // the whole unlock session (transient deltas included), leaving no committed state.
        revert Quoted(amount0(d), amount1(d));
    }

    /// @dev decode a `Quoted(int256,int256)` revert payload (4-byte selector + two 32-byte words).
    ///      Returns false for any other revert (e.g. pool not initialized, invalid params).
    function _decodeQuoted(bytes memory reason) private pure returns (bool, int256, int256) {
        if (reason.length != 68) return (false, 0, 0); // 4-byte selector + 2 * 32-byte int256
        bytes4 sel;
        // the selector is the first 4 bytes of the payload, left-aligned in the first word.
        assembly ("memory-safe") {
            sel := mload(add(reason, 32))
        }
        if (sel != Quoted.selector) return (false, 0, 0);
        // strip the 4-byte selector and abi.decode the two int256 words that follow.
        bytes memory payload = new bytes(64);
        assembly ("memory-safe") {
            let src := add(reason, 36) // skip the 32-byte length word and the 4-byte selector
            let dst := add(payload, 32)
            for { let i := 0 } lt(i, 64) { i := add(i, 32) } {
                mstore(add(dst, i), mload(add(src, i)))
            }
        }
        (int256 a0, int256 a1) = abi.decode(payload, (int256, int256));
        return (true, a0, a1);
    }
}
