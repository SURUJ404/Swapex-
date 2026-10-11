// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {PoolManager, SwapParams} from "../PoolManager.sol";
import {PoolKey, PoolId, toPoolId} from "../types/PoolKey.sol";
import {BalanceDelta} from "../types/BalanceDelta.sol";

/// @notice Reference oracle hook. Mines with AFTER_SWAP_FLAG; after every swap it records the
///         pool's post-swap sqrt price keyed by PoolId, giving a read-only TWAP-style feed. It only
///         observes (a view call back into the manager) and writes to its own storage, so it cannot
///         affect settlement.
contract OracleHook {
    mapping(bytes32 => uint160) public priceAtPoolId;
    uint160 public lastPrice;

    function afterSwap(PoolKey calldata key, SwapParams calldata, BalanceDelta, bytes calldata) external {
        (uint160 sqrtPriceX96,) = PoolManager(msg.sender).getSlot0(key);
        priceAtPoolId[PoolId.unwrap(key.toPoolId())] = sqrtPriceX96;
        lastPrice = sqrtPriceX96;
    }
}
