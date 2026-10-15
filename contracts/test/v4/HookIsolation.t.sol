// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolManager, SwapParams, ModifyLiquidityParams} from "../../src/v4/PoolManager.sol";
import {currency} from "../../src/v4/types/Currency.sol";
import {BalanceDelta, amount0, amount1} from "../../src/v4/types/BalanceDelta.sol";
import {PoolKey} from "../../src/v4/types/PoolKey.sol";
import {Hooks} from "../../src/v4/libraries/Hooks.sol";
import {TickMath} from "../../src/libraries/TickMath.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {HookRouter} from "./Hooks.t.sol";

uint160 constant Q96_ = uint160(1 << 96);

/// @notice Adversarial hook: right after a swap it tries to `take` the swapper's output out of the
///         open flash-accounting session and send it to `THIEF`. With a currency-keyed (global)
///         delta ledger this succeeds and the swapper is left with nothing; with per-account
///         deltas the hook only has its own (zero) delta and the take reverts.
contract StealHook {
    address public immutable THIEF;

    constructor(address thief) {
        THIEF = thief;
    }

    function afterSwap(PoolKey calldata key, SwapParams calldata p, BalanceDelta d, bytes calldata) external {
        if (p.zeroForOne) {
            PoolManager(msg.sender).take(key.currency1, THIEF, uint256(amount1(d)));
        } else {
            PoolManager(msg.sender).take(key.currency0, THIEF, uint256(amount0(d)));
        }
    }
}

/// @notice Adversarial hook: forces a donation to the pool's LPs inside the swapper's session. With a
///         global ledger the swapper's router would silently pay for it while netting its own deltas;
///         with per-account deltas the donation is the hook's own debt, which it never settles, so the
///         whole session reverts `UnsettledDelta`.
contract DonateGriefHook {
    function afterSwap(PoolKey calldata key, SwapParams calldata, BalanceDelta, bytes calldata) external {
        PoolManager(msg.sender).donate(key, 1e12, 0);
    }
}

contract HookIsolationTest is Test {
    PoolManager pm;
    HookRouter router;
    MockERC20 tokenA;
    MockERC20 tokenB;
    address thief = address(0xBAD);

    function setUp() public {
        pm = new PoolManager(address(this));
        router = new HookRouter(pm);
        tokenA = new MockERC20("A", "A", 18);
        tokenB = new MockERC20("B", "B", 18);
        tokenA.mint(address(router), 1_000_000e18);
        tokenB.mint(address(router), 1_000_000e18);
        router.approve(address(tokenA));
        router.approve(address(tokenB));
    }

    function _mine(address impl, uint256 flags) internal returns (address hook) {
        bytes memory code = impl.code;
        bytes32 salt = keccak256(abi.encodePacked(code, flags));
        hook = address(uint160((uint256(salt) & ~uint256(0x1FFF)) | flags));
        vm.etch(hook, code);
    }

    function _seededKey(address hook) internal returns (PoolKey memory key) {
        (address lo, address hi) =
            address(tokenA) < address(tokenB) ? (address(tokenA), address(tokenB)) : (address(tokenB), address(tokenA));
        key = PoolKey({
            currency0: currency.wrap(lo),
            currency1: currency.wrap(hi),
            fee: 3000,
            tickSpacing: 60,
            hooks: hook
        });
        router.initialize(key, Q96_);
        router.modifyLiquidity(key, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 1e18}));
    }

    function _sp(PoolKey memory key, uint256 amountIn) internal pure returns (SwapParams memory) {
        // swap the currency0 side in, so the output is currency1
        key;
        return SwapParams({
            zeroForOne: true,
            amountSpecified: int256(amountIn),
            sqrtPriceLimitX96: TickMath.MIN_SQRT_RATIO + 1
        });
    }

    /// @dev The hook must never be able to move the swapper's proceeds. Either the swap reverts, or the
    ///      swapper receives the full output; in no case may the thief end up with a token.
    function test_afterSwapHook_cannotTakeSwappersProceeds() public {
        StealHook impl = new StealHook(thief);
        address hook = _mine(address(impl), Hooks.AFTER_SWAP_FLAG);
        PoolKey memory key = _seededKey(hook);
        MockERC20 out = MockERC20(currency.unwrap(key.currency1));
        uint256 routerOutBefore = out.balanceOf(address(router));

        bool ok;
        try router.swap(key, _sp(key, 1e15)) {
            ok = true;
        } catch {}

        assertEq(out.balanceOf(thief), 0, "hook stole the swapper's output");
        if (ok) assertGt(out.balanceOf(address(router)), routerOutBefore, "swapper got nothing");
    }

    function test_afterSwapHook_cannotMakeSwapperPayForAHookDonation() public {
        DonateGriefHook impl = new DonateGriefHook();
        address hook = _mine(address(impl), Hooks.AFTER_SWAP_FLAG);
        PoolKey memory key = _seededKey(hook);

        vm.expectRevert(PoolManager.UnsettledDelta.selector);
        router.swap(key, _sp(key, 1e15));
    }

    function test_deltaOf_isReportedPerAccount() public view {
        // an account with no open session has a zero delta for any currency
        assertEq(pm.getCurrencyDelta(address(router), currency.wrap(address(tokenA))), 0);
        assertEq(pm.getCurrencyDelta(thief, currency.wrap(address(tokenA))), 0);
    }
}
