// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolManager, IUnlockCallback, SwapParams, ModifyLiquidityParams} from "../../src/v4/PoolManager.sol";
import {currency} from "../../src/v4/types/Currency.sol";
import {BalanceDelta} from "../../src/v4/types/BalanceDelta.sol";
import {PoolKey} from "../../src/v4/types/PoolKey.sol";
import {TickMath} from "../../src/libraries/TickMath.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

uint160 constant Q96 = uint160(1 << 96);

/// @notice compact unlock-caller: one op (seed or swap) per session, then nets to zero.
contract PFRouter is IUnlockCallback {
    PoolManager public immutable pm;
    uint8 private _op; // 0 = swap, 1 = seed
    PoolKey private _key;
    SwapParams private _sp;
    int256 private _liq;
    BalanceDelta private _result;

    constructor(PoolManager _pm) {
        pm = _pm;
    }

    function initialize(PoolKey memory key, uint160 sqrtPriceX96) external returns (int24) {
        return pm.initialize(key, sqrtPriceX96);
    }

    function seed(PoolKey memory key, int256 liquidityDelta) external {
        _key = key;
        _liq = liquidityDelta;
        _op = 1;
        pm.unlock("");
    }

    function swap(PoolKey memory key, SwapParams memory sp) external returns (BalanceDelta d) {
        _key = key;
        _sp = sp;
        _op = 0;
        pm.unlock("");
        d = _result;
    }

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        require(msg.sender == address(pm), "only manager");
        if (_op == 1) {
            pm.modifyLiquidity(_key, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: _liq}));
        } else {
            _result = pm.swap(_key, _sp);
        }
        _net(_key.currency0);
        _net(_key.currency1);
        return "";
    }

    function _net(currency c) private {
        int256 delta = pm.getCurrencyDelta(c);
        if (delta < 0) pm.settle(c);
        else if (delta > 0) pm.take(c, address(this), uint256(delta));
    }

    function approve(address token) external {
        MockERC20(token).approve(address(pm), type(uint256).max);
    }
}

contract ProtocolFeeTest is Test {
    PoolManager pm;
    PFRouter router;
    MockERC20 tokenA;
    MockERC20 tokenB;
    currency curA;

    function setUp() public {
        pm = new PoolManager(); // owner = this test contract
        router = new PFRouter(pm);
        tokenA = new MockERC20("A", "A", 18);
        tokenB = new MockERC20("B", "B", 18);
        curA = currency.wrap(address(tokenA));

        tokenA.mint(address(router), 1_000_000e18);
        tokenB.mint(address(router), 1_000_000e18);
        router.approve(address(tokenA));
        router.approve(address(tokenB));
    }

    function _keyWithFee(uint24 fee) internal view returns (PoolKey memory) {
        (address lo, address hi) = address(tokenA) < address(tokenB)
            ? (address(tokenA), address(tokenB))
            : (address(tokenB), address(tokenA));
        return PoolKey({currency0: currency.wrap(lo), currency1: currency.wrap(hi), fee: fee, tickSpacing: 60, hooks: address(0)});
    }

    function _spFor(PoolKey memory key, uint256 amt) internal view returns (SwapParams memory) {
        bool zfo = currency.unwrap(key.currency0) == currency.unwrap(curA);
        return SwapParams({
            zeroForOne: zfo,
            amountSpecified: int256(amt),
            sqrtPriceLimitX96: zfo ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1
        });
    }

    function test_setProtocolFee_onlyOwner() public {
        PoolKey memory key = _keyWithFee(3000);
        router.initialize(key, Q96);

        vm.expectRevert(PoolManager.NotOwner.selector);
        vm.prank(address(0xBEEF));
        pm.setProtocolFee(key, 100000);

        pm.setProtocolFee(key, 100000); // owner succeeds
        assertEq(pm.getProtocolFee(key), 100000, "protocol fee set");
    }

    function test_setProtocolFee_revertsAboveDenominator() public {
        PoolKey memory key = _keyWithFee(3000);
        router.initialize(key, Q96);
        vm.expectRevert(PoolManager.InvalidProtocolFee.selector);
        pm.setProtocolFee(key, 1_000_001);
    }

    function test_protocolFee_carvedFromLpFee() public {
        // control pool (fee 500, protocolFee defaults to 0) — distinct pool from the fee pool
        PoolKey memory controlKey = _keyWithFee(500);
        router.initialize(controlKey, Q96);
        router.seed(controlKey, 1e20);

        // fee pool (fee 3000, protocolFee = 50% of the lp fee)
        PoolKey memory feeKey = _keyWithFee(3000);
        router.initialize(feeKey, Q96);
        router.seed(feeKey, 1e20);
        pm.setProtocolFee(feeKey, 500000);

        uint256 amt = 1e18;
        router.swap(controlKey, _spFor(controlKey, amt));
        router.swap(feeKey, _spFor(feeKey, amt));

        (uint128 c0, uint128 c1) = pm.getProtocolFees(controlKey);
        assertEq(uint256(c0) + uint256(c1), 0, "control accrues no protocol fee");

        bool zfo = currency.unwrap(feeKey.currency0) == currency.unwrap(curA);
        (uint128 f0, uint128 f1) = pm.getProtocolFees(feeKey);
        uint256 accrued = zfo ? uint256(f0) : uint256(f1);
        assertGt(accrued, 0, "protocol fee accrued");
        assertLt(accrued, amt, "protocol fee less than input");
        assertEq(zfo ? uint256(f1) : uint256(f0), 0, "no fee on output side");
    }

    function test_collectProtocol_withdrawsToRecipient() public {
        PoolKey memory key = _keyWithFee(3000);
        router.initialize(key, Q96);
        router.seed(key, 1e20);
        pm.setProtocolFee(key, 1_000_000); // 100% of the lp fee goes to the protocol

        bool zfo = currency.unwrap(key.currency0) == currency.unwrap(curA);
        router.swap(key, _spFor(key, 1e18));

        (uint128 f0, uint128 f1) = pm.getProtocolFees(key);
        uint256 accrued = zfo ? uint256(f0) : uint256(f1);
        assertGt(accrued, 0, "accrued before collect");

        address recipient = makeAddr("recipient");
        (uint128 a0, uint128 a1) = pm.collectProtocol(key, recipient);
        uint256 got = zfo ? uint256(a0) : uint256(a1);
        assertEq(got, accrued, "collected the accrued amount");

        MockERC20 inputToken = MockERC20(currency.unwrap(zfo ? key.currency0 : key.currency1));
        assertEq(inputToken.balanceOf(recipient), got, "recipient received tokens");

        (uint128 g0, uint128 g1) = pm.getProtocolFees(key);
        assertEq(uint256(g0) + uint256(g1), 0, "protocol fees zeroed after collect");
    }
}
