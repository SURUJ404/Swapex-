// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {currency} from "./Currency.sol";

/// @notice The identity of a pool: two sorted currencies, a fee tier, a tick spacing, and the
/// hook contract (Phase 3; address(0) means "no hooks" and is ignored by the Phase 2 manager).
type PoolId is bytes32;

using {toPoolId} for PoolKey global;

struct PoolKey {
    currency currency0;
    currency currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

/// @notice Deterministic id for a pool key: keccak256 of the tightly-packed fields.
/// currency0 must sort below currency1 (enforced by the manager on initialize).
function toPoolId(PoolKey memory key) pure returns (PoolId) {
    return PoolId.wrap(
        keccak256(
            abi.encodePacked(key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks)
        )
    );
}
