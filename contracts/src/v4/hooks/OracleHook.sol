// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {PoolManager, SwapParams} from "../PoolManager.sol";
import {PoolKey, PoolId, toPoolId} from "../types/PoolKey.sol";
import {BalanceDelta} from "../types/BalanceDelta.sol";

/// @notice Reference post-swap price RECORDER - not a TWAP oracle. Mines with AFTER_SWAP_FLAG
///         and stores each pool's post-swap sqrt price keyed by PoolId. This is a spot feed:
///         a single swap (or flash-style slam-and-return inside one block) moves it, so it must
///         never be used for value decisions - liquidations, mint/swap bounds, pricing. The V4
///         core deliberately has no observation ring; manipulation-resistant time-weighted reads
///         live in the V3 pool oracle behind `TwapGuard` (contracts/docs/DECISIONS.md D33).
///         It only observes (a view call back into the manager) and writes to its own storage,
///         so it cannot affect settlement.
contract OracleHook {
    mapping(bytes32 => uint160) public lastSwapSqrtPriceAtPoolId;
    uint160 public lastSwapSqrtPrice;

    function afterSwap(PoolKey calldata key, SwapParams calldata, BalanceDelta, bytes calldata) external {
        (uint160 sqrtPriceX96,) = PoolManager(msg.sender).getSlot0(key);
        lastSwapSqrtPriceAtPoolId[PoolId.unwrap(key.toPoolId())] = sqrtPriceX96;
        lastSwapSqrtPrice = sqrtPriceX96;
    }
}
