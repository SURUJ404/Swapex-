// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolManager, SwapParams, ModifyLiquidityParams} from "../../src/v4/PoolManager.sol";
import {currency} from "../../src/v4/types/Currency.sol";
import {PoolKey} from "../../src/v4/types/PoolKey.sol";
import {Hooks} from "../../src/v4/libraries/Hooks.sol";
import {TickMath} from "../../src/libraries/TickMath.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {FeeOnTransferToken} from "../mocks/FeeOnTransferToken.sol";
import {DynamicFeeHook} from "../../src/v4/hooks/DynamicFeeHook.sol";
import {HookRouter} from "./Hooks.t.sol";

uint160 constant Q96_SA = uint160(1 << 96);

/// @notice The manager must only ever credit `reserves` with tokens that actually arrived, and must
///         refuse pool parameters that would break swap math.
contract SettleAccountingTest is Test {
    PoolManager pm;
    HookRouter router;
    FeeOnTransferToken fot;
    MockERC20 good;

    function setUp() public {
        pm = new PoolManager(address(this));
        router = new HookRouter(pm);
        fot = new FeeOnTransferToken("FOT", "FOT", 18, 0); // fee off while the pool is seeded
        good = new MockERC20("GOOD", "GOOD", 18);
        fot.mint(address(router), 1e24);
        good.mint(address(router), 1e24);
        router.approve(address(fot));
        router.approve(address(good));
    }

    function _key(uint24 fee, int24 spacing, address hook) internal view returns (PoolKey memory) {
        (address lo, address hi) =
            address(fot) < address(good) ? (address(fot), address(good)) : (address(good), address(fot));
        return PoolKey({currency0: currency.wrap(lo), currency1: currency.wrap(hi), fee: fee, tickSpacing: spacing, hooks: hook});
    }

    function test_settle_feeOnTransferInput_revertsInsteadOfGoingInsolvent() public {
        PoolKey memory key = _key(3000, 60, address(0));
        router.initialize(key, Q96_SA);
        router.modifyLiquidity(key, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 1e20}));

        fot.setFeeBps(100); // 1% skimmed on every transfer from here on
        bool fotIsCurrency0 = currency.unwrap(key.currency0) == address(fot);
        vm.expectRevert(PoolManager.TransferShortfall.selector);
        router.swap(
            key,
            SwapParams({
                zeroForOne: fotIsCurrency0,
                amountSpecified: int256(1e18),
                sqrtPriceLimitX96: fotIsCurrency0 ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1
            })
        );
    }

    function test_mintClaims_feeOnTransfer_reverts() public {
        fot.setFeeBps(100);
        fot.mint(address(this), 1e18);
        fot.approve(address(pm), 1e18);
        vm.expectRevert(PoolManager.TransferShortfall.selector);
        pm.mint(currency.wrap(address(fot)), address(this), 1e18);
        // nothing was credited
        assertEq(pm.claims(currency.wrap(address(fot)), address(this)), 0);
        assertEq(pm.reserves(currency.wrap(address(fot))), 0);
    }

    function test_initialize_rejectsStaticFeeOfOneHundredPercent() public {
        PoolKey memory key = _key(1_000_000, 60, address(0));
        vm.expectRevert(PoolManager.InvalidLpFee.selector);
        pm.initialize(key, Q96_SA);
    }

    function test_initialize_rejectsOversizedTickSpacing() public {
        PoolKey memory key = _key(3000, 16384, address(0));
        vm.expectRevert(PoolManager.InvalidTickSpacing.selector);
        pm.initialize(key, Q96_SA);
    }

    function test_dynamicFeeHook_cannotReturnAFeeThatBricksSwaps() public {
        DynamicFeeHook impl = new DynamicFeeHook(1_000_000);
        uint256 flags = Hooks.BEFORE_SWAP_FLAG | Hooks.DYNAMIC_FEE_FLAG;
        bytes memory code = address(impl).code;
        address hook = address(uint160((uint256(keccak256(abi.encodePacked(code, flags))) & ~uint256(0x1FFF)) | flags));
        vm.etch(hook, code);

        PoolKey memory key = _key(3000, 60, hook);
        router.initialize(key, Q96_SA);
        router.modifyLiquidity(key, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 1e20}));
        bool fotIsCurrency0 = currency.unwrap(key.currency0) == address(fot);
        vm.expectRevert(PoolManager.InvalidLpFee.selector);
        router.swap(
            key,
            SwapParams({
                zeroForOne: fotIsCurrency0,
                amountSpecified: int256(1e18),
                sqrtPriceLimitX96: fotIsCurrency0 ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1
            })
        );
    }
}
