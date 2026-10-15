// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolManager} from "../../src/v4/PoolManager.sol";
import {Router} from "../../src/v4/periphery/Router.sol";
import {AllowanceTransfer} from "../../src/v4/periphery/AllowanceTransfer.sol";

/// @notice EIP-170 guard. A contract over 24,576 bytes of runtime code cannot be deployed on mainnet or
///         any standard testnet, and `forge test` happily runs oversized contracts, so without this test
///         a size regression is only discovered at deploy time. Run on the default (optimized) profile.
contract CodeSizeTest is Test {
    uint256 constant EIP170 = 24_576;

    function test_poolManager_fitsUnderEip170() public {
        PoolManager pm = new PoolManager(address(this));
        assertLe(address(pm).code.length, EIP170, "PoolManager exceeds EIP-170");
    }

    function test_router_fitsUnderEip170() public {
        PoolManager pm = new PoolManager(address(this));
        Router r = new Router(pm, new AllowanceTransfer());
        assertLe(address(r).code.length, EIP170, "Router exceeds EIP-170");
    }
}
