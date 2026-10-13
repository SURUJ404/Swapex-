// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolManager, IUnlockCallback, SwapParams, ModifyLiquidityParams} from "../../src/v4/PoolManager.sol";
import {currency} from "../../src/v4/types/Currency.sol";
import {BalanceDelta, amount0, amount1} from "../../src/v4/types/BalanceDelta.sol";
import {PoolKey, PoolId, toPoolId} from "../../src/v4/types/PoolKey.sol";
import {Hooks} from "../../src/v4/libraries/Hooks.sol";
import {InvalidHookAddress} from "../../src/v4/libraries/Hooks.sol";
import {TickMath} from "../../src/libraries/TickMath.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {BlockSwapHook} from "../../src/v4/hooks/BlockSwapHook.sol";
import {DynamicFeeHook} from "../../src/v4/hooks/DynamicFeeHook.sol";
import {OracleHook} from "../../src/v4/hooks/OracleHook.sol";

uint160 constant Q96 = uint160(1 << 96);

/// @notice minimal unlock-caller router for hook tests (one op per session, then net to zero).
contract HookRouter is IUnlockCallback {
    PoolManager public immutable pm;

    uint8 private constant OP_SWAP = 0;
    uint8 private constant OP_MOD = 1;
    uint8 private _op;
    PoolKey private _key;
    SwapParams private _sp;
    ModifyLiquidityParams private _mp;
    BalanceDelta private _result;

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

    function modifyLiquidity(PoolKey memory key, ModifyLiquidityParams memory mp) external {
        _key = key;
        _mp = mp;
        _op = OP_MOD;
        pm.unlock("");
    }

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        require(msg.sender == address(pm), "only manager");
        if (_op == OP_SWAP) {
            _result = pm.swap(_key, _sp);
        } else {
            pm.modifyLiquidity(_key, _mp);
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
            pm.settle(c);
        } else if (delta > 0) {
            pm.take(c, address(this), uint256(delta));
        }
    }

    function approve(address token) external {
        MockERC20(token).approve(address(pm), type(uint256).max);
    }
}

contract HooksTest is Test {
    PoolManager pm;
    HookRouter router;
    MockERC20 tokenA;
    MockERC20 tokenB;
    currency curA;
    currency curB;

    function setUp() public {
        pm = new PoolManager(address(this));
        router = new HookRouter(pm);
        tokenA = new MockERC20("A", "A", 18);
        tokenB = new MockERC20("B", "B", 18);
        curA = currency.wrap(address(tokenA));
        curB = currency.wrap(address(tokenB));
        tokenA.mint(address(router), 1_000_000e18);
        tokenB.mint(address(router), 1_000_000e18);
        router.approve(address(tokenA));
        router.approve(address(tokenB));
    }

    /// @dev deploy the hook then etch its runtime code at a deterministic "mined" address whose
    ///      low flag bits encode `flags` (bits 0..2 stay clear, as `Hooks.validate` requires).
    function _mineHook(address impl, uint256 flags) internal returns (address hook) {
        bytes memory code = impl.code;
        bytes32 salt = keccak256(abi.encodePacked(code, flags));
        hook = address(uint160((uint256(salt) & ~uint256(0x1FFF)) | flags));
        vm.etch(hook, code);
    }

    function _key(address hook, uint24 fee) internal view returns (PoolKey memory) {
        (address lo, address hi) = address(tokenA) < address(tokenB)
            ? (address(tokenA), address(tokenB))
            : (address(tokenB), address(tokenA));
        return PoolKey({
            currency0: currency.wrap(lo),
            currency1: currency.wrap(hi),
            fee: fee,
            tickSpacing: 60,
            hooks: hook
        });
    }

    function _seed(PoolKey memory key) internal {
        router.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 1e18})
        );
    }

    function _swapExactIn(PoolKey memory key, uint256 amount) internal returns (BalanceDelta d) {
        bool zeroForOne = currency.unwrap(key.currency0) == currency.unwrap(curA);
        d = router.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: int256(amount),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1
            })
        );
    }

    function test_beforeSwap_hook_blocksSwap() public {
        address hook = _mineHook(address(new BlockSwapHook()), Hooks.BEFORE_SWAP_FLAG);
        PoolKey memory key = _key(hook, 3000);
        router.initialize(key, Q96);
        _seed(key);

        vm.expectRevert(BlockSwapHook.SwapBlocked.selector);
        _swapExactIn(key, 1e18);
    }

    function test_noPermissionBit_meansHookNotCalled() public {
        // the same blocking hook, but mined with NO permission bits: the manager must not call it
        address hook = _mineHook(address(new BlockSwapHook()), 0);
        PoolKey memory key = _key(hook, 3000);
        router.initialize(key, Q96);
        _seed(key);

        // no revert: the hook is present but not invoked because BEFORE_SWAP bit is clear
        BalanceDelta d = _swapExactIn(key, 1e18);
        assertTrue(amount0(d) != 0 || amount1(d) != 0, "swap executed");
    }

    function test_afterSwap_oracleRecordsPostSwapPrice() public {
        OracleHook impl = new OracleHook();
        address hook = _mineHook(address(impl), Hooks.AFTER_SWAP_FLAG);
        PoolKey memory key = _key(hook, 3000);
        router.initialize(key, Q96);
        _seed(key);

        _swapExactIn(key, 1e18);

        (uint160 expectedPrice,) = pm.getSlot0(key);
        assertEq(OracleHook(hook).lastSwapSqrtPriceAtPoolId(PoolId.unwrap(key.toPoolId())), expectedPrice, "hook recorded post-swap spot");
        assertEq(OracleHook(hook).lastSwapSqrtPrice(), expectedPrice, "lastSwapSqrtPrice matches");
        assertGt(expectedPrice, 0, "price is set");
    }

    function test_dynamicFee_hookChangesChargedFee() public {
        // control pool: no hook, fee 3000 (0.3%)
        PoolKey memory controlKey = _key(address(0), 3000);
        router.initialize(controlKey, Q96);
        _seed(controlKey);

        // hook pool: dynamic-fee hook charges 10000 (1%)
        address hook = _mineHook(address(new DynamicFeeHook(10000)), Hooks.BEFORE_SWAP_FLAG | Hooks.DYNAMIC_FEE_FLAG);
        PoolKey memory hookKey = _key(hook, 3000);
        router.initialize(hookKey, Q96);
        _seed(hookKey);

        bool zeroForOne = currency.unwrap(controlKey.currency0) == currency.unwrap(curA);

        // a small exact-in trade (well within range, so it does not hit the price limit): the
        // higher-fee pool must return strictly less output token.
        uint256 amt = 10**15;
        BalanceDelta control = _swapExactIn(controlKey, amt);
        BalanceDelta hooked = _swapExactIn(hookKey, amt);

        uint256 controlOut = uint256(zeroForOne ? amount1(control) : amount0(control));
        uint256 hookOut = uint256(zeroForOne ? amount1(hooked) : amount0(hooked));
        assertGt(hookOut, 0, "hook pool produced output");
        assertLt(hookOut, controlOut, "dynamic fee reduced output");
    }

    function test_invalidHookAddress_revertsAtInitialize() public {
        // mine a hook with a stray reserved bit (bit 0) set -> Hooks.validate rejects it
        address bad = _mineHook(address(new BlockSwapHook()), 1);
        PoolKey memory key = _key(bad, 3000);
        vm.expectRevert(InvalidHookAddress.selector);
        router.initialize(key, Q96);
    }
}
