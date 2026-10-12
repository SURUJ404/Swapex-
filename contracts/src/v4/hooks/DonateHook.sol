// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {PoolKey} from "../types/PoolKey.sol";
import {BalanceDelta, toBalanceDelta} from "../types/BalanceDelta.sol";
import {SwapParams} from "../PoolManager.sol";

/// @notice Reference hook. Mines with BEFORE_SWAP_DELTA_FLAG; before every swap it donates a fixed
///         amount of each token to the pool (a non-positive BalanceDelta), funded by its ERC-6909
///         claims. The donation is credited to the swap caller, who therefore settles less.
contract DonateHook {
    uint256 public immutable donate0;
    uint256 public immutable donate1;

    constructor(uint256 _donate0, uint256 _donate1) {
        donate0 = _donate0;
        donate1 = _donate1;
    }

    function beforeSwapDelta(PoolKey calldata, SwapParams calldata, bytes calldata)
        external
        view
        returns (BalanceDelta)
    {
        // caller-owes convention for the hook: a donation is negative (the hook owes the pool)
        return toBalanceDelta(-int256(donate0), -int256(donate1));
    }
}
