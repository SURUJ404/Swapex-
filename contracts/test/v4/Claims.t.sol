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

/// @notice unlock-caller: seed liquidity, then a swap that can settle the input and/or take the
///         output via ERC-6909 claims instead of moving tokens.
contract ClaimsRouter is IUnlockCallback {
    PoolManager public immutable pm;
    uint8 private _op; // 1 = seed, 2 = swap
    PoolKey private _key;
    int256 private _liq;
    SwapParams private _sp;
    bool private _settleViaClaim;
    bool private _takeViaClaim;
    currency private _claimCur;
    uint256 private _claimAmt;
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

    function swapWithClaims(PoolKey memory key, SwapParams memory sp, bool settleViaClaim, bool takeViaClaim)
        external
        returns (BalanceDelta d)
    {
        _key = key;
        _sp = sp;
        _settleViaClaim = settleViaClaim;
        _takeViaClaim = takeViaClaim;
        _op = 2;
        pm.unlock("");
        d = _result;
    }

    function trySettleViaClaim(currency c) external {
        _claimCur = c;
        _op = 3;
        pm.unlock("");
    }

    function tryTakeViaClaim(currency c, uint256 amount) external {
        _claimCur = c;
        _claimAmt = amount;
        _op = 4;
        pm.unlock("");
    }

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        require(msg.sender == address(pm), "only manager");
        if (_op == 3) {
            pm.settleViaClaim(_claimCur);
        } else if (_op == 4) {
            pm.takeViaClaim(_claimCur, address(this), _claimAmt);
        } else if (_op == 1) {
            pm.modifyLiquidity(_key, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: _liq}));
            _net(_key.currency0);
            _net(_key.currency1);
        } else {
            _result = pm.swap(_key, _sp);
            (currency inCur, currency outCur) = _sp.zeroForOne
                ? (_key.currency0, _key.currency1)
                : (_key.currency1, _key.currency0);
            if (_settleViaClaim) {
                pm.settleViaClaim(inCur);
            } else {
                pm.settle(inCur);
            }
            uint256 outAmt = uint256(pm.getCurrencyDelta(address(this), outCur));
            if (_takeViaClaim) {
                pm.takeViaClaim(outCur, address(this), outAmt);
            } else {
                pm.take(outCur, address(this), outAmt);
            }
        }
        return "";
    }

    function _net(currency c) private {
        int256 delta = pm.getCurrencyDelta(address(this), c);
        if (delta < 0) pm.settle(c);
        else if (delta > 0) pm.take(c, address(this), uint256(delta));
    }

    function approve(address token) external {
        MockERC20(token).approve(address(pm), type(uint256).max);
    }
}

contract ClaimsTest is Test {
    PoolManager pm;
    ClaimsRouter router;
    MockERC20 tokenA;
    MockERC20 tokenB;
    currency curA;
    currency curB;
    PoolKey key;

    function setUp() public {
        pm = new PoolManager(address(this));
        router = new ClaimsRouter(pm);
        tokenA = new MockERC20("A", "A", 18);
        tokenB = new MockERC20("B", "B", 18);
        curA = currency.wrap(address(tokenA));
        curB = currency.wrap(address(tokenB));
        (address lo, address hi) = address(tokenA) < address(tokenB)
            ? (address(tokenA), address(tokenB))
            : (address(tokenB), address(tokenA));
        key = PoolKey({currency0: currency.wrap(lo), currency1: currency.wrap(hi), fee: 3000, tickSpacing: 60, hooks: address(0)});

        // router holds tokens for seed + normal settle; the test also holds tokens to deposit via mint
        tokenA.mint(address(router), 1_000_000e18);
        tokenB.mint(address(router), 1_000_000e18);
        tokenA.mint(address(this), 1_000_000e18);
        tokenB.mint(address(this), 1_000_000e18);
        router.approve(address(tokenA));
        router.approve(address(tokenB));
        tokenA.approve(address(pm), type(uint256).max);
        tokenB.approve(address(pm), type(uint256).max);
        router.initialize(key, Q96);
    }

    function _isToken0() internal view returns (bool) {
        return currency.unwrap(key.currency0) == address(tokenA);
    }

    function _inputCur() internal view returns (currency) {
        return _isToken0() ? key.currency0 : key.currency1;
    }

    function _spFor(uint256 amt) internal view returns (SwapParams memory) {
        bool zfo = _isToken0();
        return SwapParams({
            zeroForOne: zfo,
            amountSpecified: int256(amt),
            sqrtPriceLimitX96: zfo ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1
        });
    }

    function test_mint_burn_roundTrip() public {
        uint256 amt = 100e18;
        uint256 balBefore = tokenA.balanceOf(address(this));

        pm.mint(curA, address(this), amt);
        assertEq(pm.claims(curA, address(this)), amt, "claims minted");
        assertEq(tokenA.balanceOf(address(pm)), amt, "manager holds the deposited tokens");
        assertEq(tokenA.balanceOf(address(this)), balBefore - amt, "tokens pulled from depositor");

        pm.burn(curA, address(this), amt);
        assertEq(pm.claims(curA, address(this)), 0, "claims burned");
        assertEq(tokenA.balanceOf(address(pm)), 0, "manager no longer holds them");
        assertEq(tokenA.balanceOf(address(this)), balBefore, "tokens returned to redeemer");
    }

    function test_burn_revertsWithoutEnoughClaim() public {
        pm.mint(curA, address(this), 10e18);
        vm.expectRevert(PoolManager.InsufficientClaim.selector);
        pm.burn(curA, address(this), 20e18);
    }

    function test_swap_settleViaClaim() public {
        router.seed(key, 1e20);
        currency inCur = _inputCur();
        currency outCur = _isToken0() ? key.currency1 : key.currency0;
        MockERC20 inToken = MockERC20(currency.unwrap(inCur));
        MockERC20 outToken = MockERC20(currency.unwrap(outCur));

        // deposit input tokens for claims, credited to the router (the unlock caller)
        uint256 deposit = 10e18;
        pm.mint(inCur, address(router), deposit);
        uint256 routerClaimsBefore = pm.claims(inCur, address(router));
        uint256 routerOutBefore = outToken.balanceOf(address(router));
        uint256 pmInBefore = inToken.balanceOf(address(pm));

        uint256 inputAmt = 1e18;
        router.swapWithClaims(key, _spFor(inputAmt), true, false);

        // input settled from claims (burned), not pulled as tokens; exact-in means the input delta
        // equals amountSpecified (the fee is carved out of it, not added on top)
        assertEq(pm.claims(inCur, address(router)), routerClaimsBefore - inputAmt, "claims burned = exact input");
        assertEq(inToken.balanceOf(address(pm)), pmInBefore, "no input tokens moved (settled via claim)");
        // output was taken as real tokens
        assertGt(outToken.balanceOf(address(router)), routerOutBefore, "output tokens received");
    }

    function test_swap_takeViaClaim() public {
        router.seed(key, 1e20);
        currency outCur = _isToken0() ? key.currency1 : key.currency0;

        uint256 inputAmt = 1e18;
        uint256 routerOutTokenBefore = MockERC20(currency.unwrap(outCur)).balanceOf(address(router));

        router.swapWithClaims(key, _spFor(inputAmt), false, true);

        // output was credited as claims, not transferred out
        uint256 outClaim = pm.claims(outCur, address(router));
        assertGt(outClaim, 0, "output credited as claim");
        assertEq(
            MockERC20(currency.unwrap(outCur)).balanceOf(address(router)), routerOutTokenBefore, "no output tokens moved"
        );
        // the manager still holds the output tokens backing the claim
        assertGe(MockERC20(currency.unwrap(outCur)).balanceOf(address(pm)), outClaim, "claim is backed by manager balance");
    }

    function test_settleViaClaim_revertsWithoutNegativeDelta() public {
        vm.expectRevert(PoolManager.DeltaNotNegative.selector);
        router.trySettleViaClaim(curA);
    }

    function test_takeViaClaim_revertsWithoutPositiveDelta() public {
        vm.expectRevert(PoolManager.InsufficientTake.selector);
        router.tryTakeViaClaim(curA, 1e18);
    }
}
