// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolHandler} from "./PoolHandler.sol";
import {SwapexFactory} from "../../src/v3/SwapexFactory.sol";
import {SwapexPool} from "../../src/v3/SwapexPool.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {TickMath} from "../../src/libraries/TickMath.sol";

/// Randomised operation sequences against the pool; the handler's own bookkeeping is never
/// trusted — every invariant is computed from pool state and compared against handler data
/// only as an independent shadow.
contract PoolInvariants is Test {
    uint160 internal constant Q96 = uint160(1 << 96);
    uint24 internal constant FEE = 3000;

    SwapexFactory internal factory;
    SwapexPool internal pool;
    MockERC20 internal token0;
    MockERC20 internal token1;
    PoolHandler internal handler;

    function setUp() public {
        factory = new SwapexFactory();

        MockERC20 a = new MockERC20("Token A", "TKA", 18);
        MockERC20 b = new MockERC20("Token B", "TKB", 18);
        (token0, token1) = address(a) < address(b) ? (a, b) : (b, a);

        pool = SwapexPool(factory.createPool(address(token0), address(token1), FEE));
        pool.initialize(Q96);

        handler = new PoolHandler(pool, token0, token1);
        token0.mint(address(handler), 1e32);
        token1.mint(address(handler), 1e32);
        factory.setOwner(address(handler)); // handler may set/clear the protocol fee

        bytes4[] memory selectors = new bytes4[](8);
        selectors[0] = PoolHandler.mintPosition.selector;
        selectors[1] = PoolHandler.burnPosition.selector;
        selectors[2] = PoolHandler.pokePosition.selector;
        selectors[3] = PoolHandler.collectPosition.selector;
        selectors[4] = PoolHandler.swap.selector;
        selectors[5] = PoolHandler.flash.selector;
        selectors[6] = PoolHandler.setProtocolFee.selector;
        selectors[7] = PoolHandler.exitAll.selector;

        targetContract(address(handler));
        // FuzzSelector is inherited from StdInvariant (via Test), so it is in scope here
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// Every claim on the pool (LP tokensOwed + protocol fees) is backed by tokens.
    function invariant_poolBalanceBacksAllClaims() public {
        (uint256 owed0, uint256 owed1) = handler.owedTotals();
        uint256 bal0 = token0.balanceOf(address(pool));
        uint256 bal1 = token1.balanceOf(address(pool));
        uint256 pf0 = pool.protocolFees0();
        uint256 pf1 = pool.protocolFees1();
        assertGe(bal0, pf0 + owed0, "token0 claims exceed pool balance");
        assertGe(bal1, pf1 + owed1, "token1 claims exceed pool balance");
    }

    /// Liquidity added at ticks when moving right equals liquidity removed when moving left:
    /// the net over all initialised ticks is zero at all times.
    function invariant_liquidityNetSumsToZero() public {
        assertEq(handler.sumLiquidityNet(), 0, "liquidityNet over all ticks is not zero");
    }

    /// Active liquidity equals the sum of positions whose range covers the current tick.
    function invariant_activeLiquidityMatchesCoverage() public {
        assertEq(
            uint256(pool.liquidity()), handler.activeLiquidityFromSlots(), "active liquidity != sum of covering positions"
        );
    }

    function invariant_feeGrowthNeverDecreases() public {
        assertFalse(handler.feeGrowthDecreased(), "feeGrowthGlobal decreased between operations");
    }

    /// Price stays strictly inside the valid sqrt-ratio range.
    function invariant_priceStaysInBounds() public view {
        (uint160 sqrtP,,,) = pool.slot0();
        assertGt(sqrtP, TickMath.MIN_SQRT_RATIO, "sqrtPrice at/below MIN");
        assertLt(sqrtP, TickMath.MAX_SQRT_RATIO, "sqrtPrice at/above MAX");
    }
}
