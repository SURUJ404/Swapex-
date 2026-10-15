// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {Position} from "../../libraries/Position.sol";
import {Tick} from "../../libraries/Tick.sol";

/// @dev `protocolFee` is the share (in 1e6, so 1e6 = 100%) of the lp fee that the protocol
///      carves out on each swap. It does not change what the trader pays; it reduces what the
///      lp accrues. It is set by the owner and defaults to 0.
struct Slot0 {
    uint160 sqrtPriceX96;
    int24 tick;
    uint24 protocolFee;
}

/// @dev Nested mappings make Pool non-copyable; it lives only in storage keyed by PoolId.
struct Pool {
    Slot0 slot0;
    uint128 liquidity;
    uint256 feeGrowthGlobal0X128;
    uint256 feeGrowthGlobal1X128;
    /// @notice accrued (unsettled-to-owner) protocol fees per currency.
    uint128 protocolFees0;
    uint128 protocolFees1;
    mapping(int24 => Tick.Info) ticks;
    mapping(int16 => uint256) tickBitmap;
    mapping(bytes32 => Position.Info) positions;
}
