// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {PoolKey} from "../types/PoolKey.sol";
import {SwapParams} from "../PoolManager.sol";

/// @notice Reference dynamic-fee hook. Mines with BEFORE_SWAP_FLAG | DYNAMIC_FEE_FLAG; the manager
///         calls `getSwapFee` and charges that lp fee instead of `key.fee`. The fee is an immutable
///         so it survives being etched at a mined address in tests.
contract DynamicFeeHook {
    uint24 public immutable fee;

    constructor(uint24 _fee) {
        fee = _fee;
    }

    function beforeSwap(PoolKey calldata, SwapParams calldata, bytes calldata) external pure {
        // no-op: the permission is what forces this call; the fee comes from getSwapFee
    }

    function getSwapFee(PoolKey calldata) external view returns (uint24) {
        return fee;
    }
}
