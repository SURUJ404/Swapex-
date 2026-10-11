// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {PoolKey} from "../types/PoolKey.sol";
import {BalanceDelta} from "../types/BalanceDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "../PoolManager.sol";

/// @notice The points of a pool's life a hook can run at. The manager only calls a given function
///         when the hook contract's mined address carries the matching permission flag (see
///         `Hooks`), so a hook need implement only the functions it flags. Hooks are untrusted:
///         they may observe and may revert to block an action, but the flash-accounting net-zero
///         sweep guarantees they cannot leave the manager insolvent.
interface IHooks {
    function beforeInitialize(PoolKey calldata key, uint160 sqrtPriceX96, bytes calldata hookData) external;
    function afterInitialize(PoolKey calldata key, uint160 sqrtPriceX96, int24 tick, bytes calldata hookData) external;

    function beforeAddLiquidity(PoolKey calldata key, ModifyLiquidityParams calldata params, bytes calldata hookData) external;
    function afterAddLiquidity(PoolKey calldata key, ModifyLiquidityParams calldata params, BalanceDelta delta, bytes calldata hookData) external;

    function beforeRemoveLiquidity(PoolKey calldata key, ModifyLiquidityParams calldata params, bytes calldata hookData) external;
    function afterRemoveLiquidity(PoolKey calldata key, ModifyLiquidityParams calldata params, BalanceDelta delta, bytes calldata hookData) external;

    function beforeSwap(PoolKey calldata key, SwapParams calldata params, bytes calldata hookData) external;
    function afterSwap(PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata hookData) external;

    /// @notice a dynamic-fee hook returns the lp fee (in hundredths of a bip) to charge for a swap.
    function getSwapFee(PoolKey calldata key) external view returns (uint24);
}
