// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {StdUtils} from "forge-std/StdUtils.sol";
import {SwapexPool} from "../../src/v3/SwapexPool.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {TickMath} from "../../src/libraries/TickMath.sol";
import {ISwapexMintCallback, ISwapexSwapCallback, ISwapexFlashCallback} from "../../src/interfaces/ICallbacks.sol";

/// Fuzz driver for SwapexPool used by the invariant suite.
///
/// Every pool call is wrapped in try/catch so one bad fuzz input cannot stall the campaign;
/// the properties that must hold regardless are asserted in PoolInvariants.t.sol.
/// The handler is the only LP and trader, so it can reason about total claims on the pool.
contract PoolHandler is StdUtils, ISwapexMintCallback, ISwapexSwapCallback, ISwapexFlashCallback {
    uint256 internal constant Q96 = 1 << 96;
    uint256 internal constant MAX_SLOTS = 12;

    struct Slot {
        int24 lower;
        int24 upper;
        uint128 liquidity;
        bool used;
    }

    SwapexPool public immutable pool;
    MockERC20 public immutable token0;
    MockERC20 public immutable token1;

    Slot[] public slots;
    mapping(int24 => bool) public tickTouched;
    int24[] public touchedTickList;

    /// set if feeGrowthGlobal ever decreased between two operations (wrap-around is
    /// unreachable in this campaign: increments are <= ~1e41 per swap vs 2^256 total)
    bool public feeGrowthDecreased;
    uint256 internal lastFg0;
    uint256 internal lastFg1;

    uint256 internal flashAmount0;
    uint256 internal flashAmount1;

    constructor(SwapexPool p, MockERC20 t0, MockERC20 t1) {
        pool = p;
        token0 = t0;
        token1 = t1;
        for (uint256 i; i < MAX_SLOTS; i++) {
            slots.push();
        }
    }

    modifier recordsFeeGrowth() {
        _;
        uint256 fg0 = pool.feeGrowthGlobal0X128();
        uint256 fg1 = pool.feeGrowthGlobal1X128();
        if (fg0 < lastFg0 || fg1 < lastFg1) feeGrowthDecreased = true;
        lastFg0 = fg0;
        lastFg1 = fg1;
    }

    // ------------------------------------------------------------------ ops
    function mintPosition(uint256 slot, int256 lowerOff, int256 widthUnits, uint128 amount) external recordsFeeGrowth {
        slot = bound(slot, 0, MAX_SLOTS - 1);
        Slot storage s = slots[slot];
        if (!s.used) {
            (, int24 tick,,) = pool.slot0();
            int256 spacing = int256(pool.tickSpacing());
            int256 minT = (int256(TickMath.MIN_TICK) / spacing) * spacing;
            int256 maxT = (int256(TickMath.MAX_TICK) / spacing) * spacing;
            int256 base = (int256(tick) / spacing) * spacing;
            int256 l = base + bound(lowerOff, -200, 200) * spacing;
            if (l < minT) l = minT;
            if (l > maxT - spacing) l = maxT - spacing;
            int256 u = l + bound(widthUnits, 1, 100) * spacing;
            if (u > maxT) u = maxT;
            s.lower = int24(l);
            s.upper = int24(u);
            s.used = true;
            _touch(s.lower);
            _touch(s.upper);
        }
        uint128 amt = uint128(bound(amount, 1e15, 1e21));
        try pool.mint(address(this), s.lower, s.upper, amt, "") {
            s.liquidity += amt;
        } catch {}
    }

    function burnPosition(uint256 slot, uint128 amount) external recordsFeeGrowth {
        slot = bound(slot, 0, MAX_SLOTS - 1);
        Slot storage s = slots[slot];
        if (s.liquidity == 0) return;
        uint128 amt = uint128(bound(amount, 1, s.liquidity));
        try pool.burn(s.lower, s.upper, amt) {
            s.liquidity -= amt;
        } catch {}
    }

    function pokePosition(uint256 slot) external recordsFeeGrowth {
        slot = bound(slot, 0, MAX_SLOTS - 1);
        Slot storage s = slots[slot];
        if (s.liquidity == 0) return;
        try pool.burn(s.lower, s.upper, 0) {} catch {}
    }

    function collectPosition(uint256 slot) external recordsFeeGrowth {
        slot = bound(slot, 0, MAX_SLOTS - 1);
        Slot storage s = slots[slot];
        if (!s.used) return;
        try pool.collect(address(this), s.lower, s.upper, type(uint128).max, type(uint128).max) {} catch {}
    }

    function swap(bool zeroForOne, uint256 amount, bool exactOut) external recordsFeeGrowth {
        if (pool.liquidity() == 0) return;
        uint160 limit = zeroForOne ? uint160(Q96 * 9 / 10) : uint160(Q96 * 11 / 10);
        int256 spec = exactOut ? -int256(bound(amount, 1e12, 1e17)) : int256(bound(amount, 1e12, 1e20));
        try pool.swap(address(this), zeroForOne, spec, limit, "") {} catch {}
    }

    function flash(uint256 a0, uint256 a1) external recordsFeeGrowth {
        if (pool.liquidity() == 0) return;
        uint256 b0 = token0.balanceOf(address(this));
        uint256 b1 = token1.balanceOf(address(this));
        flashAmount0 = bound(a0, 0, b0 / 2);
        flashAmount1 = bound(a1, 0, b1 / 2);
        if (flashAmount0 == 0 && flashAmount1 == 0) return;
        try pool.flash(address(this), flashAmount0, flashAmount1, "") {} catch {}
        flashAmount0 = 0;
        flashAmount1 = 0;
    }

    function setProtocolFee(uint8 denom) external {
        // maps fuzz bytes onto {0, 4..10} (valid) and 1..3/11+ (must revert, caught below)
        uint8 d = uint8(bound(denom, 0, 10));
        try pool.setProtocolFee(d) {} catch {}
    }

    /// Burns and collects everything, then checks the full-redeem property inline.
    function exitAll() external {
        for (uint256 i; i < slots.length; i++) {
            Slot storage s = slots[i];
            if (s.liquidity > 0) {
                try pool.burn(s.lower, s.upper, s.liquidity) {
                    s.liquidity = 0;
                } catch {}
            }
            if (s.used) {
                try pool.collect(address(this), s.lower, s.upper, type(uint128).max, type(uint128).max) {} catch {}
            }
        }
        require(pool.liquidity() == 0, "active liquidity left after full exit");
        uint256 pf0 = pool.protocolFees0();
        uint256 pf1 = pool.protocolFees1();
        uint256 bal0 = token0.balanceOf(address(pool));
        uint256 bal1 = token1.balanceOf(address(pool));
        require(bal0 >= pf0 && bal0 - pf0 <= 1e4, "token0 dust beyond rounding after full exit");
        require(bal1 >= pf1 && bal1 - pf1 <= 1e4, "token1 dust beyond rounding after full exit");
    }

    // ------------------------------------------------------------------ callbacks
    function swapexMintCallback(uint256 a0, uint256 a1, bytes calldata) external {
        require(msg.sender == address(pool), "not pool");
        if (a0 > 0) token0.transfer(msg.sender, a0);
        if (a1 > 0) token1.transfer(msg.sender, a1);
    }

    function swapexSwapCallback(int256 a0, int256 a1, bytes calldata) external {
        require(msg.sender == address(pool), "not pool");
        if (a0 > 0) token0.transfer(msg.sender, uint256(a0));
        if (a1 > 0) token1.transfer(msg.sender, uint256(a1));
    }

    function swapexFlashCallback(uint256 fee0, uint256 fee1, bytes calldata) external {
        require(msg.sender == address(pool), "not pool");
        if (flashAmount0 > 0) token0.transfer(msg.sender, flashAmount0 + fee0);
        if (flashAmount1 > 0) token1.transfer(msg.sender, flashAmount1 + fee1);
    }

    // ------------------------------------------------------------------ views for invariants
    /// Sum of tokensOwed over every position the handler owns.
    function owedTotals() external view returns (uint256 owed0, uint256 owed1) {
        for (uint256 i; i < slots.length; i++) {
            Slot storage s = slots[i];
            if (!s.used) continue;
            (,, , uint128 o0, uint128 o1) =
                pool.positions(keccak256(abi.encodePacked(address(this), s.lower, s.upper)));
            owed0 += o0;
            owed1 += o1;
        }
    }

    /// Sum of liquidityNet over every tick ever touched (untouched ticks are zero).
    function sumLiquidityNet() external view returns (int256 sum) {
        for (uint256 i; i < touchedTickList.length; i++) {
            (, int128 net,,) = pool.ticks(touchedTickList[i]);
            sum += net;
        }
    }

    /// Liquidity that should be active: sum of handler positions covering the current tick.
    function activeLiquidityFromSlots() external view returns (uint256 sum) {
        (, int24 tick,,) = pool.slot0();
        for (uint256 i; i < slots.length; i++) {
            Slot storage s = slots[i];
            if (s.used && s.lower <= tick && tick < s.upper) sum += s.liquidity;
        }
    }

    function _touch(int24 t) internal {
        if (!tickTouched[t]) {
            tickTouched[t] = true;
            touchedTickList.push(t);
        }
    }
}
