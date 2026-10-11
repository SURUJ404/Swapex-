// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {currency, ADDRESS_ZERO} from "../../src/v4/types/Currency.sol";
import {BalanceDelta, toBalanceDelta, amount0, amount1} from "../../src/v4/types/BalanceDelta.sol";
import {PoolKey, PoolId, toPoolId} from "../../src/v4/types/PoolKey.sol";

contract TypesTest is Test {
    function test_balanceDelta_roundTripsSignedComponents() public pure {
        // positive / negative / zero / extremes must survive pack -> unpack
        int128[6] memory a0s = [int128(0), 1, -1, type(int128).max, type(int128).min, 123456789];
        int128[6] memory a1s = [int128(0), -1, 1, type(int128).min, type(int128).max, -987654321];
        for (uint256 i = 0; i < a0s.length; i++) {
            BalanceDelta d = toBalanceDelta(a0s[i], a1s[i]);
            assertEq(amount0(d), a0s[i], "amount0");
            assertEq(amount1(d), a1s[i], "amount1");
        }
    }

    function test_balanceDelta_componentsDoNotBleed() public pure {
        // amount1 must not leak into amount0 and vice versa (high/low packing is independent)
        BalanceDelta d = toBalanceDelta(type(int128).min, type(int128).max);
        assertEq(amount0(d), type(int128).min);
        assertEq(amount1(d), type(int128).max);
        BalanceDelta e = toBalanceDelta(type(int128).max, type(int128).min);
        assertEq(amount0(e), type(int128).max);
        assertEq(amount1(e), type(int128).min);
    }

    function test_balanceDelta_rejectsOutOfRange() public {
        vm.expectRevert(bytes("a0 overflow"));
        this.ext(type(int256).max, 0);
        vm.expectRevert(bytes("a1 overflow"));
        this.ext(0, type(int256).min);
    }

    /// @dev external wrapper so vm.expectRevert catches the require inside toBalanceDelta
    function ext(int256 a0, int256 a1) external pure {
        toBalanceDelta(a0, a1);
    }

    function test_currency_equality() public pure {
        currency a = currency.wrap(address(1));
        currency b = currency.wrap(address(1));
        currency c = currency.wrap(address(2));
        assertTrue(a == b);
        assertTrue(a != c);
        assertTrue(ADDRESS_ZERO() == currency.wrap(address(0)));
    }

    function test_poolId_isDeterministicAndOrderSensitive() public pure {
        PoolKey memory k = PoolKey({
            currency0: currency.wrap(address(1)),
            currency1: currency.wrap(address(2)),
            fee: 3000,
            tickSpacing: 60,
            hooks: address(0)
        });
        PoolId id1 = toPoolId(k);
        PoolId id2 = toPoolId(k);
        assertEq(PoolId.unwrap(id1), PoolId.unwrap(id2), "same key -> same id");

        // swapping the currencies must change the id (order sensitivity)
        PoolKey memory flipped = PoolKey({
            currency0: currency.wrap(address(2)),
            currency1: currency.wrap(address(1)),
            fee: 3000,
            tickSpacing: 60,
            hooks: address(0)
        });
        assertTrue(PoolId.unwrap(id1) != PoolId.unwrap(toPoolId(flipped)), "order changes id");

        // changing the fee must change the id
        PoolKey memory feeChanged = PoolKey({
            currency0: currency.wrap(address(1)),
            currency1: currency.wrap(address(2)),
            fee: 500,
            tickSpacing: 10,
            hooks: address(0)
        });
        assertTrue(PoolId.unwrap(id1) != PoolId.unwrap(toPoolId(feeChanged)), "fee changes id");
    }
}
