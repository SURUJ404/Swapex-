// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {V3Base} from "./V3Base.t.sol";
import {SwapexPool} from "../../src/v3/SwapexPool.sol";
import {TwapGuard, TWAP_MIN_WINDOW} from "../../src/v3/TwapGuard.sol";
import {TickMath} from "../../src/libraries/TickMath.sol";

/// Behavioural tests for the enforceable oracle-read policy (DECISIONS D33): minimum window,
/// ring-coverage checking (no silent truncation), bootstrap stamped with pool creation time,
/// and spot-manipulation resistance through the guarded reader itself.
contract TwapGuardTest is V3Base {
    TwapGuardProbe internal probe;

    function setUp() public override {
        vm.warp(0);
        super.setUp();
        probe = new TwapGuardProbe();
    }

    function test_policy_minimumWindowIsThirtyMinutes() public pure {
        assertEq(uint256(TWAP_MIN_WINDOW), 1800);
    }

    function test_consult_revertsWhenWindowShorterThanMinimum() public {
        pool.increaseObservationCardinalityNext(16);
        pool.mint(address(this), -1200, 1200, 10**21, "");
        vm.warp(4000);

        vm.expectRevert(abi.encodeWithSelector(TwapGuard.OracleWindowTooShort.selector, uint32(1799), TWAP_MIN_WINDOW));
        probe.consult(pool, 1799);

        vm.expectRevert(abi.encodeWithSelector(TwapGuard.OracleWindowTooShort.selector, uint32(60), TWAP_MIN_WINDOW));
        probe.consult(pool, 60);

        vm.expectRevert(abi.encodeWithSelector(TwapGuard.OracleWindowTooShort.selector, uint32(0), TWAP_MIN_WINDOW));
        probe.consult(pool, 0);
    }

    function test_consult_revertsWhenWindowOlderThanRetainedRing() public {
        // ring of 4: bootstrap survives until the 4th write wraps over it, so after one mint and
        // three swaps the oldest retained observation is the mint at t=5000
        pool.increaseObservationCardinalityNext(4);
        vm.warp(5000);
        pool.mint(address(this), -1200, 1200, 10**21, "");
        vm.warp(6000);
        _swapExactIn(true, 10**18);
        vm.warp(7000);
        _swapExactIn(false, 10**18);
        vm.warp(8000);
        _swapExactIn(true, 10**18);

        // t=8000, oldest retained = 5000 -> only 3000 seconds of coverage
        vm.expectRevert(abi.encodeWithSelector(TwapGuard.OracleWindowNotCovered.selector, uint32(3600), uint32(3000)));
        probe.consult(pool, 3600);

        // a window inside the covered span succeeds
        int24 twap = probe.consult(pool, 1800);
        assertEq(int256(twap), int256(twap)); // value returned (no revert)

        // no new writes: coverage is a property of the OLDEST observation, so a later read with
        // a window reaching before t=5000 still refuses, reporting actual coverage
        vm.warp(50_000);
        vm.expectRevert(abi.encodeWithSelector(TwapGuard.OracleWindowNotCovered.selector, uint32(46_000), uint32(45_000)));
        probe.consult(pool, 46_000);
    }

    function test_consult_returnsHeldTickThroughGuard() public {
        pool.increaseObservationCardinalityNext(16);
        pool.mint(address(this), -1200, 1200, 10**21, "");
        vm.warp(10);
        _swapExactIn(true, 5 * 10**18);
        (, int24 heldTick,,) = pool.slot0();

        vm.warp(10 + 4000);
        assertEq(int256(probe.consult(pool, 1800)), int256(heldTick));
    }

    function test_consult_sameBlockSpotSlamDoesNotMoveGuardedTwap() public {
        pool.increaseObservationCardinalityNext(128);
        pool.mint(address(this), -1200, 1200, 10**21, "");

        // real multi-block price history out to t=2000
        for (uint32 i = 0; i < 20; i++) {
            vm.warp(100 * (i + 1));
            bool zfo = i % 2 == 0;
            (uint160 sqrtP,,,) = pool.slot0();
            uint160 limit = zfo ? uint160(uint256(sqrtP) / 2) : uint160(uint256(sqrtP) * 2);
            pool.swap(address(this), zfo, int256(uint256(10**16) * (i + 1)), limit, "");
        }

        int24 before = probe.consult(pool, 1800);

        // attacker slams and reverts the price inside ONE block (flash-style push)
        (, int24 spotBefore,,) = pool.slot0();
        (uint160 sqrtNow,,,) = pool.slot0();
        pool.swap(address(this), true, int256(10**21), uint160(uint256(sqrtNow) / 4), "");
        (, int24 slammed,,) = pool.slot0();
        (uint160 sqrtNow2,,,) = pool.slot0();
        pool.swap(address(this), false, int256(10**21), uint160(uint256(sqrtNow2) * 4), "");

        vm.warp(block.timestamp + 1);
        _swapExactIn(true, 1); // flush one more observation

        int24 after_ = probe.consult(pool, 1800);

        assertTrue(slammed != spotBefore, "spot moved");
        int256 drift = int256(after_) - int256(before);
        if (drift < 0) drift = -drift;
        assertLe(drift, 1);
    }

    function test_bootstrapStampedWithCreationTime() public {
        vm.warp(1_000_000);
        SwapexPool young = SwapexPool(factory.createPool(address(token0), address(token1), 500));
        young.initialize(TickMath.getSqrtRatioAtTick(6000));

        // D33: the bootstrap observation is stamped with pool creation, not unix epoch 0
        (uint32 created,,,) = young.observations(0);
        assertEq(uint256(created), 1_000_000);

        vm.warp(1_000_100);
        // a target older than pool creation truncates to the zeroed bootstrap cumulative
        // instead of interpolating fake tick-6000 history back to epoch 0 (pre-fix: 6000*998300)
        (int56 tc,) = young.observeSingle(1800);
        assertEq(int256(tc), 0);

        // and the guard refuses the window: only 100 seconds of real history exist
        vm.expectRevert(abi.encodeWithSelector(TwapGuard.OracleWindowNotCovered.selector, uint32(1800), uint32(100)));
        probe.consult(young, 1800);
    }

    function test_consult_revertsOnUninitializedPool() public {
        SwapexPool fresh = SwapexPool(factory.createPool(address(token0), address(token1), 10000));
        vm.warp(4000);
        vm.expectRevert(TwapGuard.OracleUninitialized.selector);
        probe.consult(fresh, 1800);
    }
}

/// External facade so vm.expectRevert observes a call boundary (TwapGuard.consult is internal).
contract TwapGuardProbe {
    function consult(SwapexPool pool, uint32 window) external view returns (int24) {
        return TwapGuard.consult(pool, window);
    }
}
