// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";

contract DeployGuardTest is Test {
    function test_refusesMainnetAndOtherUnlistedChains() public {
        Deploy d = new Deploy();
        uint256[4] memory bad = [uint256(1), 10, 8453, 42161]; // Ethereum, Optimism, Base, Arbitrum mainnets
        for (uint256 i = 0; i < bad.length; i++) {
            vm.chainId(bad[i]);
            vm.expectRevert(abi.encodeWithSelector(Deploy.UnsupportedChain.selector, bad[i]));
            d.run();
        }
    }

    function test_allowlistIsExactlyTheTestnets() public {
        Deploy d = new Deploy();
        assertTrue(d.isAllowedChain(11155111));
        assertTrue(d.isAllowedChain(84532));
        assertTrue(d.isAllowedChain(421614));
        assertTrue(!d.isAllowedChain(1));
        assertTrue(!d.isAllowedChain(137));
    }
}
