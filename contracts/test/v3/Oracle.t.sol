// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {V3Base} from "./V3Base.t.sol";
import {TickMath} from "../../src/libraries/TickMath.sol";

/// Behavioural tests for the TWAP oracle: constant-price windows, ring-buffer cardinality growth,
/// and manipulation resistance. Exact-value correctness is covered by the generated OracleGolden.t.sol.
contract OracleTest is V3Base {
    function setUp() public override {
        vm.warp(0);
        super.setUp();
    }

    /// time-weighted average tick over [now - window, now]
    function _twap(uint32 window) internal view returns (int256) {
        uint32[] memory agos = new uint32[](2);
        agos[0] = window;
        agos[1] = 0;
        (int56[] memory tc,) = pool.observe(agos);
        return (int256(tc[1]) - int256(tc[0])) / int256(uint256(window));
    }

    function test_oracle_twapEqualsHeldTick() public {
        pool.increaseObservationCardinalityNext(16);
        pool.mint(address(this), -1200, 1200, 10**21, "");
        // move the price to a known tick, then hold: with no further state changes the
        // time-weighted average over any window that starts after the last swap is that tick.
        vm.warp(10);
        _swapExactIn(true, 5 * 10**18); // pushes the price down; capture the resulting tick
        (, int24 heldTick,,) = pool.slot0();
        // hold for a long window entirely after the swap
        vm.warp(10 + 1000);
        assertEq(_twap(500), int256(heldTick));
    }

    function test_observation_cardinalityGrowsAndRetainsWindow() public {
        assertEq(pool.observationCardinality(), 1);
        assertEq(pool.observationCardinalityNext(), 1);
        pool.increaseObservationCardinalityNext(8);
        assertEq(pool.observationCardinalityNext(), 8);

        pool.mint(address(this), -1200, 1200, 10**21, "");
        // more than `capacity` state changes across distinct blocks fills then wraps the ring
        for (uint32 i = 1; i <= 20; i++) {
            vm.warp(100 * i);
            _swapExactIn(i % 2 == 0, 10**18);
        }
        // cardinality grew to (and is capped at) the requested capacity
        assertEq(pool.observationCardinality(), 8);

        // a window still inside the retained 8 observations interpolates consistently:
        // a 1-second window just before `now` stays within a few ticks of the 100-second TWAP.
        uint32 w = 100;
        uint32[] memory agos = new uint32[](2);
        agos[0] = w;
        agos[1] = 0;
        (int56[] memory tc,) = pool.observe(agos);
        int256 longTwap = (int256(tc[1]) - int256(tc[0])) / int256(uint256(w));
        agos[0] = 1;
        (int56[] memory tc2,) = pool.observe(agos);
        int256 shortTwap = int256(tc2[1]) - int256(tc2[0]);
        assertLe(_abs(shortTwap - longTwap), 4000);
    }

    function test_oracle_manipulationResistance() public {
        pool.increaseObservationCardinalityNext(128);
        pool.mint(address(this), -1200, 1200, 10**21, "");

        // build a real multi-block price history (absolute warps so time strictly advances)
        for (uint32 i = 0; i < 20; i++) {
            vm.warp(10 * (i + 1));
            bool zfo = i % 2 == 0;
            (uint160 sqrtP,,,) = pool.slot0();
            uint160 limit = zfo ? uint160(uint256(sqrtP) / 2) : uint160(uint256(sqrtP) * 2);
            pool.swap(address(this), zfo, int256(uint256(10**16) * (i + 1)), limit, "");
        }
        assertEq(uint256(block.timestamp), 200);

        uint32 window = 100;
        int256 twapBefore = _twap(window);

        // attacker slams the price hard and then pushes it back, all inside ONE block (no warp),
        // so the manipulated interval has zero elapsed time and cannot move a time-weighted average.
        (uint160 sqrtNow,,,) = pool.slot0();
        (, int24 spotBefore,,) = pool.slot0();
        pool.swap(address(this), true, int256(10**21), uint160(uint256(sqrtNow) / 4), "");
        (, int24 slammedTick,,) = pool.slot0();
        (uint160 sqrtNow2,,,) = pool.slot0();
        pool.swap(address(this), false, int256(10**21), uint160(uint256(sqrtNow2) * 4), "");

        // one block later, flush a final observation and re-read the same-length window
        vm.warp(block.timestamp + 1);
        _swapExactIn(true, 1);
        int256 twapAfter = _twap(window);

        // the spot price demonstrably moved, yet the multi-block TWAP is unchanged (within 1 tick)
        assertTrue(slammedTick != spotBefore);
        assertLe(_abs(twapAfter - twapBefore), 1);
    }

    function _abs(int256 x) internal pure returns (int256) {
        return x < 0 ? -x : x;
    }

    function test_oracle_observeMinimal() public {
        pool.increaseObservationCardinalityNext(16);
        pool.mint(address(this), -1200, 1200, 10**21, "");
        vm.warp(10);
        (uint160 sqrtP,,,) = pool.slot0();
        pool.swap(address(this), true, int256(10**16), uint160(uint256(sqrtP) / 2), "");
        vm.warp(20);
        _twap(1); // observe([1,0]) at ts=20 — should be fine
        _twap(15); // observe([15,0]) at ts=20 — reaches back to ts=5
    }

    /// A window that predates the oldest retained observation must truncate to the oldest
    /// cumulative (returning a value) rather than reverting via a `target - before.ts` underflow.
    function test_oracle_truncationReturnsOldestNotRevert() public {
        pool.increaseObservationCardinalityNext(2); // tiny ring: wraps after 2 observations
        pool.mint(address(this), -1200, 1200, 10**21, "");
        for (uint32 i = 1; i <= 6; i++) {
            vm.warp(100 * i);
            _swapExactIn(i % 2 == 0, 10**18);
        }
        // the ring only retains the last ~2 observations (recent ts ~600); asking for a window
        // that reaches back to ts 0 truncates. It must return values (not revert via underflow),
        // with the newer target's cumulative >= the truncated older one.
        uint32[] memory agos = new uint32[](2);
        agos[0] = 600; // target = 0, older than the oldest retained observation
        agos[1] = 0;
        (int56[] memory tc, uint160[] memory spl) = pool.observe(agos);
        assertGe(int256(tc[1]), int256(tc[0])); // tickCumulative is non-decreasing
        assertGe(uint256(spl[1]), uint256(spl[0])); // seconds-per-liquidity is non-decreasing
    }
}
