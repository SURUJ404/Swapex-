// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {FullMath} from "../../src/libraries/FullMath.sol";
import {BitMath} from "../../src/libraries/BitMath.sol";
import {TickMath} from "../../src/libraries/TickMath.sol";
import {TickBitmap} from "../../src/libraries/TickBitmap.sol";
import {LiquidityMath} from "../../src/libraries/LiquidityMath.sol";
import {SqrtPriceMath} from "../../src/libraries/SqrtPriceMath.sol";
import {Tick} from "../../src/libraries/Tick.sol";

contract MathTest is Test {
    using TickBitmap for mapping(int16 => uint256);

    mapping(int16 => uint256) internal bitmap;

    // ------------------------------------------------------------ FullMath
    function testFuzz_mulDiv_matchesSimpleDivisionWhenProductFits(uint128 a, uint128 b, uint256 d) public {
        d = bound(d, 1, type(uint256).max);
        assertEq(FullMath.mulDiv(a, b, d), (uint256(a) * uint256(b)) / d);
    }

    /// a * b / b == a even when a * b needs more than 256 bits
    function testFuzz_mulDiv_exactForOverflowingProducts(uint256 a, uint256 b) public {
        b = bound(b, 1, type(uint256).max);
        assertEq(FullMath.mulDiv(a, b, b), a);
    }

    function testFuzz_mulDivRoundingUp_isCeil(uint128 a, uint128 b, uint128 d) public {
        d = uint128(bound(d, 1, type(uint128).max));
        uint256 down = FullMath.mulDiv(a, b, d);
        uint256 up = FullMath.mulDivRoundingUp(a, b, d);
        if (mulmod(a, b, d) == 0) assertEq(up, down);
        else assertEq(up, down + 1);
    }

    function test_mulDiv_revertsOnOverflowAndZero() public {
        vm.expectRevert(FullMath.MulDivOverflow.selector);
        this.callMulDiv(type(uint256).max, type(uint256).max, 1);
        vm.expectRevert(FullMath.MulDivOverflow.selector);
        this.callMulDiv(1, 1, 0);
    }

    function callMulDiv(uint256 a, uint256 b, uint256 d) external pure returns (uint256) {
        return FullMath.mulDiv(a, b, d);
    }

    // ------------------------------------------------------------ BitMath
    function testFuzz_bitMath_matchesNaiveLoops(uint256 x) public {
        x = bound(x, 1, type(uint256).max);
        uint8 msb;
        for (uint256 i = 255;; i--) {
            if ((x >> i) & 1 == 1) {
                msb = uint8(i);
                break;
            }
        }
        uint8 lsb;
        for (uint256 i = 0;; i++) {
            if ((x >> i) & 1 == 1) {
                lsb = uint8(i);
                break;
            }
        }
        assertEq(BitMath.mostSignificantBit(x), msb);
        assertEq(BitMath.leastSignificantBit(x), lsb);
    }

    // ------------------------------------------------------------ TickMath
    function test_tickMath_bounds() public {
        assertEq(TickMath.getSqrtRatioAtTick(TickMath.MIN_TICK), TickMath.MIN_SQRT_RATIO);
        assertEq(TickMath.getSqrtRatioAtTick(TickMath.MAX_TICK), TickMath.MAX_SQRT_RATIO);
        assertEq(TickMath.getSqrtRatioAtTick(0), 1 << 96);
    }

    function testFuzz_tickMath_roundTrip(int24 tick) public {
        tick = int24(bound(int256(tick), TickMath.MIN_TICK, TickMath.MAX_TICK - 1));
        uint160 s = TickMath.getSqrtRatioAtTick(tick);
        assertEq(int256(TickMath.getTickAtSqrtRatio(s)), int256(tick));
        // the price just below the next tick still maps to this tick
        uint160 nextS = TickMath.getSqrtRatioAtTick(tick + 1);
        assertEq(int256(TickMath.getTickAtSqrtRatio(nextS - 1)), int256(tick));
    }

    function testFuzz_tickMath_strictlyMonotonic(int24 tick) public {
        tick = int24(bound(int256(tick), TickMath.MIN_TICK, TickMath.MAX_TICK - 1));
        assertLt(TickMath.getSqrtRatioAtTick(tick), TickMath.getSqrtRatioAtTick(tick + 1));
    }

    /// The log2-based getTickAtSqrtRatio must agree exactly with the binary-search oracle.
    function testFuzz_getTickAtSqrtRatio_matchesBinarySearch(uint160 s) public {
        s = uint160(bound(uint256(s), uint256(TickMath.MIN_SQRT_RATIO), uint256(TickMath.MAX_SQRT_RATIO) - 1));
        assertEq(int256(TickMath.getTickAtSqrtRatio(s)), int256(TickMath._tickAtSqrtRatioBinarySearch(s)));
    }

    /// Same, but sampling in-between prices anchored across the whole tick range (uniform
    /// coverage of low/mid/high, which pure random uint160 would bias toward the top).
    function testFuzz_getTickAtSqrtRatio_matchesBinarySearch_acrossRanges(uint256 tickSeed, uint256 offset) public {
        int24 t = int24(bound(int256(tickSeed), TickMath.MIN_TICK, TickMath.MAX_TICK - 1));
        uint160 base = TickMath.getSqrtRatioAtTick(t);
        uint160 nxt = TickMath.getSqrtRatioAtTick(t + 1);
        uint160 s = base + uint160(bound(offset, 0, uint256(nxt - base)));
        if (s >= TickMath.MAX_SQRT_RATIO) s = TickMath.MAX_SQRT_RATIO - 1;
        assertEq(int256(TickMath.getTickAtSqrtRatio(s)), int256(TickMath._tickAtSqrtRatioBinarySearch(s)));
    }

    function test_tickMath_outOfRangeReverts() public {
        vm.expectRevert();
        this.callSqrt(TickMath.MAX_TICK + 1);
        vm.expectRevert();
        this.callTick(TickMath.MAX_SQRT_RATIO);
        vm.expectRevert();
        this.callTick(TickMath.MIN_SQRT_RATIO - 1);
    }

    function callSqrt(int24 t) external pure returns (uint160) {
        return TickMath.getSqrtRatioAtTick(t);
    }

    function callTick(uint160 s) external pure returns (int24) {
        return TickMath.getTickAtSqrtRatio(s);
    }

    // ------------------------------------------------------------ SqrtPriceMath
    /// amounts for adding then removing the same liquidity: add rounds up, remove rounds down
    function testFuzz_amountDeltas_roundInPoolFavour(int24 t0, int24 t1, uint128 liq) public {
        t0 = int24(bound(int256(t0), -100000, 100000));
        t1 = int24(bound(int256(t1), -100000, 100000));
        vm.assume(t0 != t1);
        liq = uint128(bound(liq, 1, type(uint96).max));
        uint160 a = TickMath.getSqrtRatioAtTick(t0);
        uint160 b = TickMath.getSqrtRatioAtTick(t1);
        assertGe(SqrtPriceMath.getAmount0Delta(a, b, liq, true), SqrtPriceMath.getAmount0Delta(a, b, liq, false));
        assertGe(SqrtPriceMath.getAmount1Delta(a, b, liq, true), SqrtPriceMath.getAmount1Delta(a, b, liq, false));
        // and the gap is at most 1 unit per rounding step (<= 2 for amount0 which rounds twice)
        assertLe(
            SqrtPriceMath.getAmount0Delta(a, b, liq, true) - SqrtPriceMath.getAmount0Delta(a, b, liq, false), 2
        );
        assertLe(
            SqrtPriceMath.getAmount1Delta(a, b, liq, true) - SqrtPriceMath.getAmount1Delta(a, b, liq, false), 1
        );
    }

    // ------------------------------------------------------------ LiquidityMath
    function testFuzz_liquidityAddDelta(uint128 x, int128 y) public {
        if (y < 0) {
            uint128 d;
            unchecked { d = uint128(-y); } // -int128.min wraps to 2^127, matching the library
            if (d > x) {
                vm.expectRevert(LiquidityMath.LiquidityUnderflow.selector);
                this.callAdd(x, y);
            } else {
                assertEq(this.callAdd(x, y), x - d);
            }
        } else {
            uint256 sum = uint256(x) + uint256(uint128(y));
            if (sum > type(uint128).max) {
                vm.expectRevert(LiquidityMath.LiquidityOverflow.selector);
                this.callAdd(x, y);
            } else {
                assertEq(this.callAdd(x, y), uint128(sum));
            }
        }
    }

    function callAdd(uint128 x, int128 y) external pure returns (uint128) {
        return LiquidityMath.addDelta(x, y);
    }

    // ------------------------------------------------------------ TickBitmap
    function testFuzz_bitmap_flipAndFindNeighbours(int16 a, int16 b) public {
        int24 spacing = 60;
        int24 ta = int24(a) * spacing;
        int24 tb = int24(b) * spacing;
        vm.assume(ta >= TickMath.MIN_TICK && ta <= TickMath.MAX_TICK && tb >= TickMath.MIN_TICK && tb <= TickMath.MAX_TICK);
        vm.assume(ta != tb);

        bitmap.flipTick(ta, spacing);
        bitmap.flipTick(tb, spacing);

        // searching right from a tick just below the smaller one never skips it when in the same word
        (int24 next, bool init) = bitmap.nextInitializedTickWithinOneWord(ta, spacing, true);
        assertEq(int256(next), int256(ta));
        assertTrue(init);

        // flipping twice clears
        bitmap.flipTick(ta, spacing);
        (next, init) = bitmap.nextInitializedTickWithinOneWord(ta, spacing, true);
        assertTrue(!init || next != ta);
    }

    function test_tickBitmap_misalignedReverts() public {
        vm.expectRevert();
        this.callFlip(61, 60);
    }

    function callFlip(int24 t, int24 s) external {
        bitmap.flipTick(t, s);
    }

    // ------------------------------------------------------------ Tick
    function test_tick_maxLiquidityPerTick() public {
        // spacing 60: ticks -887220..887220 step 60 => 29575 ticks
        assertEq(Tick.tickSpacingToMaxLiquidityPerTick(60), type(uint128).max / 29575);
        // spacing 1: 1774545 ticks
        assertEq(Tick.tickSpacingToMaxLiquidityPerTick(1), type(uint128).max / 1774545);
    }
}
