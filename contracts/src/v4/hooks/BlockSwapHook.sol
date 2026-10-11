// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {PoolKey} from "../types/PoolKey.sol";
import {SwapParams} from "../PoolManager.sol";

/// @notice Reference hook that blocks every swap. Demonstrates that a hook can veto an action by
///         reverting: the pool with this hook (mined with BEFORE_SWAP_FLAG) can never be swapped.
contract BlockSwapHook {
    error SwapBlocked();

    function beforeSwap(PoolKey calldata, SwapParams calldata, bytes calldata) external pure {
        revert SwapBlocked();
    }
}
