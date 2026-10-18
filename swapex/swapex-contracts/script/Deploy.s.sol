// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {SwapexFactory} from "../src/v3/SwapexFactory.sol";
import {SwapexRouter} from "../src/periphery/SwapexRouter.sol";
import {SwapexPositionManager} from "../src/periphery/SwapexPositionManager.sol";
import {SwapexQuoter} from "../src/periphery/SwapexQuoter.sol";
import {MockWETH} from "../test/mocks/MockWETH.sol";

/// Testnet-only deployment.
///
///   forge script script/Deploy.s.sol --rpc-url sepolia --account swapex-testnet-deployer --broadcast
///
/// - The signing key comes from a Foundry keystore (`--account`) or a hardware wallet (`--ledger`).
///   This script never reads a private key from the environment or from a file in the repo.
/// - It refuses to run on any chain that is not in the testnet allowlist below. To go to mainnet,
///   write a separate, reviewed script after an audit; do not just add a chain id here.
/// - WETH9: set WETH9_ADDRESS to override. Otherwise a per-chain default is used. Check the address on the
///   block explorer before broadcasting. On a local anvil node (31337) a mock WETH is deployed.
contract Deploy is Script {
    error UnsupportedChain(uint256 chainId);
    error NoWethConfigured(uint256 chainId);
    error WethHasNoCode(address weth);

    struct Deployed {
        SwapexFactory factory;
        SwapexRouter router;
        SwapexPositionManager positionManager;
        SwapexQuoter quoter;
        address weth;
    }

    function isAllowedChain(uint256 id) public pure returns (bool) {
        return id == 11155111 // Ethereum Sepolia
            || id == 84532 // Base Sepolia
            || id == 421614 // Arbitrum Sepolia
            || id == 31337; // local anvil / forge tests
    }

    /// @dev well-known WETH9 on each public testnet. Verify on the explorer before use.
    function defaultWeth(uint256 id) public pure returns (address) {
        if (id == 11155111) return 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;
        if (id == 84532) return 0x4200000000000000000000000000000000000006;
        if (id == 421614) return 0x980B62Da83eFf3D4576C647993b0c1D7faf17c73;
        return address(0);
    }

    function run() external returns (Deployed memory d) {
        if (!isAllowedChain(block.chainid)) revert UnsupportedChain(block.chainid);

        address weth = vm.envOr("WETH9_ADDRESS", address(0));
        if (weth == address(0)) weth = defaultWeth(block.chainid);

        vm.startBroadcast();
        if (weth == address(0)) {
            if (block.chainid != 31337) revert NoWethConfigured(block.chainid);
            weth = address(new MockWETH());
        }
        if (weth.code.length == 0) revert WethHasNoCode(weth);

        d.weth = weth;
        d.factory = new SwapexFactory(); // owner = the broadcasting (testnet) account
        d.router = new SwapexRouter(address(d.factory), weth);
        d.positionManager = new SwapexPositionManager(address(d.factory), weth);
        d.quoter = new SwapexQuoter(address(d.factory));
        vm.stopBroadcast();

        console2.log("chainId", block.chainid);
        console2.log("SwapexFactory", address(d.factory));
        console2.log("SwapexRouter", address(d.router));
        console2.log("SwapexPositionManager", address(d.positionManager));
        console2.log("SwapexQuoter", address(d.quoter));
        console2.log("WETH9", weth);

        _writeManifest(d);
    }

    /// @dev the web app reads this file; it records addresses and the facts needed to check them later
    function _writeManifest(Deployed memory d) internal {
        string memory key = "deployment";
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeUint(key, "blockNumber", block.number);
        vm.serializeAddress(key, "owner", d.factory.owner());
        vm.serializeAddress(key, "weth9", d.weth);
        vm.serializeAddress(key, "factory", address(d.factory));
        vm.serializeAddress(key, "router", address(d.router));
        vm.serializeAddress(key, "positionManager", address(d.positionManager));
        vm.serializeAddress(key, "quoter", address(d.quoter));
        vm.serializeBytes32(key, "factoryCodehash", address(d.factory).codehash);
        vm.serializeBytes32(key, "routerCodehash", address(d.router).codehash);
        vm.serializeBytes32(key, "positionManagerCodehash", address(d.positionManager).codehash);
        string memory json = vm.serializeBytes32(key, "quoterCodehash", address(d.quoter).codehash);
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), ".json"));
    }
}
