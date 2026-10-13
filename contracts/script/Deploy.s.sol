// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {PoolManager, ModifyLiquidityParams} from "../src/v4/PoolManager.sol";
import {Router} from "../src/v4/periphery/Router.sol";
import {AllowanceTransfer} from "../src/v4/periphery/AllowanceTransfer.sol";
import {Quoter} from "../src/v4/periphery/Quoter.sol";
import {currency} from "../src/v4/types/Currency.sol";
import {PoolKey} from "../src/v4/types/PoolKey.sol";
import {MockERC20} from "../test/mocks/MockERC20.sol";

uint160 constant Q96 = uint160(1 << 96);

/// @notice Local-dev deploy: spins up the Swapex V4 core + periphery, three 18-decimal mock
///         tokens, and a handful of 1:1 pools seeded with liquidity so the frontend has live,
///         tradeable markets on a fresh anvil node. Logs every address as `KEY=0x...` so a
///         script can parse them straight into the web app's config.
contract Deploy is Script {
    address internal deployer;

    function run() external {
        // default to anvil account #0 so `forge script --broadcast` works out of the box.
        uint256 pk = vm.envOr(
            "PRIVATE_KEY", uint256(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80)
        );
        deployer = vm.addr(pk);
        vm.startBroadcast(pk);

        PoolManager pm = new PoolManager();
        AllowanceTransfer at = new AllowanceTransfer();
        Router router = new Router(pm, at);
        Quoter quoter = new Quoter(pm);

        MockERC20 swa = new MockERC20("Swapex A", "SWA", 18);
        MockERC20 swb = new MockERC20("Swapex B", "SWB", 18);
        MockERC20 swc = new MockERC20("Swapex C", "SWC", 18);

        // fund the deployer and grant the router a bounded allowance over each token so it can
        // pull input / liquidity tokens (one-time ERC-20 approval to the allowance contract, then
        // a per-spender grant the router may spend until expiry).
        swa.mint(deployer, 1_000_000e18);
        swb.mint(deployer, 1_000_000e18);
        swc.mint(deployer, 1_000_000e18);
        swa.approve(address(at), type(uint256).max);
        swb.approve(address(at), type(uint256).max);
        swc.approve(address(at), type(uint256).max);
        at.setAllowance(address(swa), address(router), type(uint160).max, type(uint48).max);
        at.setAllowance(address(swb), address(router), type(uint160).max, type(uint48).max);
        at.setAllowance(address(swc), address(router), type(uint160).max, type(uint48).max);

        // 1:1 pools (all 18-decimal, price = Q96). Native ETH is address(0) and sorts first.
        _seedPool(pm, router, address(0), address(swa));
        _seedPool(pm, router, address(0), address(swb));
        _seedPool(pm, router, address(0), address(swc));
        _seedPool(pm, router, address(swa), address(swb));
        _seedPool(pm, router, address(swb), address(swc));

        vm.stopBroadcast();

        console.log("POOL_MANAGER=%s", address(pm));
        console.log("ALLOWANCE_TRANSFER=%s", address(at));
        console.log("ROUTER=%s", address(router));
        console.log("QUOTER=%s", address(quoter));
        console.log("SWA=%s", address(swa));
        console.log("SWB=%s", address(swb));
        console.log("SWC=%s", address(swc));
    }

    /// @dev initialize the 1:1 pool for the sorted (a, b) pair and seed it with liquidity. When
    ///      currency0 is native the router is paid from msg.value; the ERC-20 side is pulled from
    ///      the deployer's pre-approved balance.
    function _seedPool(PoolManager pm, Router router, address a, address b) internal {
        (address lo, address hi) = a < b ? (a, b) : (b, a);
        PoolKey memory key = PoolKey({
            currency0: currency.wrap(lo),
            currency1: currency.wrap(hi),
            fee: 3000,
            tickSpacing: 60,
            hooks: address(0)
        });
        pm.initialize(key, Q96);

        // seed a symmetric position around the current price; 1e20 liquidity over ticks
        // [-6000, 6000] needs ~2.6e19 of each side, so 1e20 native + the ERC-20 balance covers it.
        uint256 value = lo == address(0) ? 1e20 : 0;
        ModifyLiquidityParams memory mp =
            ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 1e20});
        if (value > 0) {
            router.modifyLiquidity{value: value}(key, mp, deployer);
        } else {
            router.modifyLiquidity(key, mp, deployer);
        }
    }
}
