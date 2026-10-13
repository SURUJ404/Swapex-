// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolManager, IUnlockCallback, SwapParams, ModifyLiquidityParams} from "../../src/v4/PoolManager.sol";
import {currency} from "../../src/v4/types/Currency.sol";
import {BalanceDelta, toBalanceDelta, amount0, amount1} from "../../src/v4/types/BalanceDelta.sol";
import {PoolKey, PoolId, toPoolId} from "../../src/v4/types/PoolKey.sol";
import {IERC20Minimal} from "../../src/interfaces/IERC20Minimal.sol";
import {TickMath} from "../../src/libraries/TickMath.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

uint160 constant Q96 = uint160(1 << 96);

/// @notice Test router: opens an unlock session, performs one operation, then settles/takes both
///         currencies of the key so the session's deltas net to zero.
contract V4Router is IUnlockCallback {
    PoolManager public immutable pm;
    uint8 private constant OP_SWAP = 0;
    uint8 private constant OP_MOD = 1;

    uint8 private _op;
    PoolKey private _key;
    SwapParams private _sp;
    ModifyLiquidityParams private _mp;
    BalanceDelta private _result;
    BalanceDelta private _cd;
    BalanceDelta private _fa;

    constructor(PoolManager _pm) {
        pm = _pm;
    }

    function initialize(PoolKey memory key, uint160 sqrtPriceX96) external returns (int24) {
        return pm.initialize(key, sqrtPriceX96);
    }

    function swap(PoolKey memory key, SwapParams memory sp) external returns (BalanceDelta d) {
        _key = key;
        _sp = sp;
        _op = OP_SWAP;
        pm.unlock("");
        d = _result;
    }

    function modifyLiquidity(PoolKey memory key, ModifyLiquidityParams memory mp)
        external
        returns (BalanceDelta callerDelta, BalanceDelta feesAccrued)
    {
        _key = key;
        _mp = mp;
        _op = OP_MOD;
        pm.unlock("");
        (callerDelta, feesAccrued) = (_cd, _fa);
    }

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        require(msg.sender == address(pm), "only manager");
        if (_op == OP_SWAP) {
            _result = pm.swap(_key, _sp);
        } else {
            (_cd, _fa) = pm.modifyLiquidity(_key, _mp);
        }
        _netZero(_key);
        return "";
    }

    function _netZero(PoolKey memory key) private {
        _settleOrTake(key.currency0);
        _settleOrTake(key.currency1);
    }

    function _settleOrTake(currency c) private {
        int256 delta = pm.getCurrencyDelta(c);
        if (delta < 0) {
            pm.settle(c); // pulls tokens from this router (must hold + have approved)
        } else if (delta > 0) {
            pm.take(c, address(this), uint256(delta));
        }
    }

    function approveAll(address tokenA, address tokenB) external {
        MockERC20(tokenA).approve(address(pm), type(uint256).max);
        MockERC20(tokenB).approve(address(pm), type(uint256).max);
    }
}

/// @dev a callback that swaps but never settles (delta stays negative) -> unlock must revert
contract UnsettledCallback is IUnlockCallback {
    PoolManager public immutable pm;
    PoolKey public key;
    SwapParams public sp;

    constructor(PoolManager _pm) {
        pm = _pm;
    }

    function arm(PoolKey memory _k, SwapParams memory _s) external {
        key = _k;
        sp = _s;
    }

    function go() external {
        pm.unlock("");
    }

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        require(msg.sender == address(pm), "only manager");
        pm.swap(key, sp); // deliberately no settle/take
        return "";
    }
}

/// @dev a callback that tries to open a nested unlock -> AlreadyUnlocked (caught, not fatal)
contract NestedUnlockCallback is IUnlockCallback {
    PoolManager public immutable pm;
    bool public reentered;

    constructor(PoolManager _pm) {
        pm = _pm;
    }

    function go() external {
        reentered = false;
        pm.unlock("");
    }

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        require(msg.sender == address(pm), "only manager");
        try pm.unlock("") {
            reentered = false;
        } catch {
            reentered = true;
        }
        return "";
    }
}

contract PoolManagerTest is Test {
    PoolManager pm;
    V4Router router;
    MockERC20 tokenA;
    MockERC20 tokenB;
    MockERC20 tokenC;
    currency curA;
    currency curB;
    currency curC;
    PoolKey keyAB;
    PoolKey keyBC;

    function setUp() public {
        pm = new PoolManager(address(this));
        router = new V4Router(pm);
        tokenA = new MockERC20("A", "A", 18);
        tokenB = new MockERC20("B", "B", 18);
        tokenC = new MockERC20("C", "C", 18);
        curA = currency.wrap(address(tokenA));
        curB = currency.wrap(address(tokenB));
        curC = currency.wrap(address(tokenC));

        keyAB = _key(address(tokenA), address(tokenB), 3000, 60);
        keyBC = _key(address(tokenB), address(tokenC), 3000, 60);

        tokenA.mint(address(router), 1_000_000e18);
        tokenB.mint(address(router), 1_000_000e18);
        tokenC.mint(address(router), 1_000_000e18);
        router.approveAll(address(tokenA), address(tokenB));
        router.approveAll(address(tokenB), address(tokenC));
    }

    function _key(address a, address b, uint24 fee, int24 spacing) internal pure returns (PoolKey memory) {
        (currency c0, currency c1) =
            a < b ? (currency.wrap(a), currency.wrap(b)) : (currency.wrap(b), currency.wrap(a));
        return PoolKey({currency0: c0, currency1: c1, fee: fee, tickSpacing: spacing, hooks: address(0)});
    }

    function _sortedCurs(address a, address b) internal pure returns (currency c0, currency c1) {
        (c0, c1) = a < b ? (currency.wrap(a), currency.wrap(b)) : (currency.wrap(b), currency.wrap(a));
    }

    function _seed(PoolKey memory key, uint128 liquidity) internal {
        router.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: int256(uint256(liquidity))})
        );
    }

    function test_initialize_setsTickAndSlot0() public {
        int24 tick = router.initialize(keyAB, Q96);
        assertEq(tick, 0, "initial tick at Q96 is 0");
        (uint160 sp, int24 t) = pm.getSlot0(keyAB);
        assertEq(uint256(sp), uint256(Q96), "sqrt price");
        assertEq(t, 0, "tick");
    }

    function test_swap_exactIn_netsToZeroAndMovesPrice() public {
        router.initialize(keyAB, Q96);
        _seed(keyAB, 10**20);

        (currency c0,) = _sortedCurs(address(tokenA), address(tokenB));
        bool zeroForOne = currency.unwrap(c0) == currency.unwrap(curA);
        BalanceDelta d = router.swap(
            keyAB,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: 1e18,
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1
            })
        );

        if (zeroForOne) {
            assertLt(amount0(d), 0, "owes token0");
            assertGt(amount1(d), 0, "owed token1");
        } else {
            assertGt(amount0(d), 0, "owed token0");
            assertLt(amount1(d), 0, "owes token1");
        }
        // reaching here means unlock's net-zero sweep passed (deltas settled)
        (uint160 sp, ) = pm.getSlot0(keyAB);
        if (zeroForOne) assertLt(sp, Q96, "price fell");
        else assertGt(sp, Q96, "price rose");
    }

    function test_multihop_intermediateCurrencyNetsToZero() public {
        router.initialize(keyAB, Q96);
        router.initialize(keyBC, Q96);
        _seed(keyAB, 10**20);
        _seed(keyBC, 10**20);

        MultiHop hop = new MultiHop(pm, curA, curC, keyAB, keyBC);
        tokenA.mint(address(hop), 100e18);

        uint256 cBefore = tokenC.balanceOf(address(hop));
        hop.go(1e18);
        assertGt(tokenC.balanceOf(address(hop)), cBefore, "received tokenC");
        // intermediate token B was never settled/taken: it nets to zero across the two pools
        assertEq(tokenB.balanceOf(address(hop)), 0, "no intermediate tokenB moved");
    }

    function test_addThenRemove_liquidity_solvency() public {
        router.initialize(keyAB, Q96);

        (BalanceDelta cdAdd,) = router.modifyLiquidity(
            keyAB, ModifyLiquidityParams({tickLower: -60, tickUpper: 60, liquidityDelta: 1e18})
        );
        assertLt(amount0(cdAdd), 0, "owes token0 on add");
        assertLt(amount1(cdAdd), 0, "owes token1 on add");

        (BalanceDelta cdRem,) = router.modifyLiquidity(
            keyAB, ModifyLiquidityParams({tickLower: -60, tickUpper: 60, liquidityDelta: -1e18})
        );
        assertGt(amount0(cdRem), 0, "owed token0 on remove");
        assertGt(amount1(cdRem), 0, "owed token1 on remove");
        // mint rounds up and burn rounds down, so the pool keeps >= what the caller gets back
        assertLe(uint256(-amount0(cdAdd)), uint256(amount0(cdRem)) + 1, "solvency token0");
        assertLe(uint256(-amount1(cdAdd)), uint256(amount1(cdRem)) + 1, "solvency token1");
    }

    function test_unsettledDelta_reverts() public {
        router.initialize(keyAB, Q96);
        _seed(keyAB, 10**20);
        UnsettledCallback bad = new UnsettledCallback(pm);
        (currency c0,) = _sortedCurs(address(tokenA), address(tokenB));
        bool zfo = currency.unwrap(c0) == currency.unwrap(curA);
        bad.arm(
            keyAB,
            SwapParams({
                zeroForOne: zfo,
                amountSpecified: 1e18,
                sqrtPriceLimitX96: zfo ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1
            })
        );
        vm.expectRevert(PoolManager.UnsettledDelta.selector);
        bad.go();
    }

    function test_nestedUnlock_reverts() public {
        NestedUnlockCallback nested = new NestedUnlockCallback(pm);
        nested.go();
        assertTrue(nested.reentered(), "nested unlock was rejected");
    }

    function test_initialize_revertsWhenUnsorted() public {
        (currency c0, currency c1) = _sortedCurs(address(tokenA), address(tokenB));
        PoolKey memory unsorted = PoolKey({currency0: c1, currency1: c0, fee: 3000, tickSpacing: 60, hooks: address(0)});
        vm.expectRevert(PoolManager.CurrencyNotSorted.selector);
        router.initialize(unsorted, Q96);
    }
}

/// @dev drives A -> B -> C across two pools inside a single unlock. Settles only the net input
///      (A) and takes the net output (C); the intermediate B never moves.
contract MultiHop is IUnlockCallback {
    PoolManager public immutable pm;
    currency public curIn;
    currency public curOut;
    PoolKey public keyAB;
    PoolKey public keyBC;
    uint256 public inAmount;

    constructor(PoolManager _pm, currency _in, currency _out, PoolKey memory _ab, PoolKey memory _bc) {
        pm = _pm;
        curIn = _in;
        curOut = _out;
        keyAB = _ab;
        keyBC = _bc;
        // this contract holds the input tokens and must approve the manager to pull them on settle
        MockERC20(currency.unwrap(_in)).approve(address(_pm), type(uint256).max);
    }

    function go(uint256 amount) external {
        inAmount = amount;
        pm.unlock("");
    }

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        require(msg.sender == address(pm), "only manager");
        PoolKey memory ab = keyAB;
        PoolKey memory bc = keyBC;

        // hop 1: sell curIn on pool AB
        bool zfo1 = ab.currency0 == curIn;
        pm.swap(
            ab,
            SwapParams({
                zeroForOne: zfo1,
                amountSpecified: int256(inAmount),
                sqrtPriceLimitX96: zfo1 ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1
            })
        );

        // hop 2: sell the full intermediate delta on pool BC
        currency mid = zfo1 ? ab.currency1 : ab.currency0;
        bool zfo2 = bc.currency0 == mid;
        int256 midDelta = pm.getCurrencyDelta(mid);
        uint256 midAmt = uint256(midDelta > 0 ? midDelta : -midDelta);
        pm.swap(
            bc,
            SwapParams({
                zeroForOne: zfo2,
                amountSpecified: int256(midAmt),
                sqrtPriceLimitX96: zfo2 ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1
            })
        );

        // settle only the net input and take only the net output; mid must already be zero
        int256 din = pm.getCurrencyDelta(curIn);
        if (din < 0) pm.settle(curIn);
        int256 dout = pm.getCurrencyDelta(curOut);
        if (dout > 0) pm.take(curOut, address(this), uint256(dout));
        return "";
    }
}

