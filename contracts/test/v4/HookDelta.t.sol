// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolManager, IUnlockCallback, SwapParams, ModifyLiquidityParams} from "../../src/v4/PoolManager.sol";
import {currency} from "../../src/v4/types/Currency.sol";
import {BalanceDelta, toBalanceDelta} from "../../src/v4/types/BalanceDelta.sol";
import {PoolKey} from "../../src/v4/types/PoolKey.sol";
import {Hooks} from "../../src/v4/libraries/Hooks.sol";
import {TickMath} from "../../src/libraries/TickMath.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {DonateHook} from "../../src/v4/hooks/DonateHook.sol";

uint160 constant Q96 = uint160(1 << 96);

/// @notice hook that returns an invalid (positive) donation delta.
contract BadDeltaHook {
    function beforeSwapDelta(PoolKey calldata, SwapParams calldata, bytes calldata)
        external
        pure
        returns (BalanceDelta)
    {
        return toBalanceDelta(int256(1 ether), int256(0));
    }
}

/// @notice unlock-caller: seed liquidity, then a normal (token) swap.
contract DeltaRouter is IUnlockCallback {
    PoolManager public immutable pm;
    uint8 private _op;
    PoolKey private _key;
    int256 private _liq;
    SwapParams private _sp;

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

    function swap(PoolKey memory key, SwapParams memory sp) external {
        _key = key;
        _sp = sp;
        _op = 2;
        pm.unlock("");
    }

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        require(msg.sender == address(pm), "only manager");
        if (_op == 1) {
            pm.modifyLiquidity(_key, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: _liq}));
            _net(_key.currency0);
            _net(_key.currency1);
        } else {
            pm.swap(_key, _sp);
            _net(_key.currency0);
            _net(_key.currency1);
        }
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

contract HookDeltaTest is Test {
    PoolManager pm;
    DeltaRouter router;
    MockERC20 tokenA;
    MockERC20 tokenB;

    function setUp() public {
        pm = new PoolManager();
        router = new DeltaRouter(pm);
        tokenA = new MockERC20("A", "A", 18);
        tokenB = new MockERC20("B", "B", 18);
        tokenA.mint(address(router), 1_000_000e18);
        tokenB.mint(address(router), 1_000_000e18);
        tokenA.mint(address(this), 1_000_000e18);
        tokenB.mint(address(this), 1_000_000e18);
        router.approve(address(tokenA));
        router.approve(address(tokenB));
        tokenA.approve(address(pm), type(uint256).max);
        tokenB.approve(address(pm), type(uint256).max);
    }

    function _mineHook(address impl, uint256 flags) internal returns (address hook) {
        bytes memory code = impl.code;
        bytes32 salt = keccak256(abi.encodePacked(code, flags));
        hook = address(uint160((uint256(salt) & ~uint256(0x1FFF)) | flags));
        vm.etch(hook, code);
    }

    function _key(address hook) internal view returns (PoolKey memory) {
        (address lo, address hi) = address(tokenA) < address(tokenB)
            ? (address(tokenA), address(tokenB))
            : (address(tokenB), address(tokenA));
        return PoolKey({currency0: currency.wrap(lo), currency1: currency.wrap(hi), fee: 3000, tickSpacing: 60, hooks: hook});
    }

    function _sp(uint256 amt) internal pure returns (SwapParams memory) {
        // zeroForOne: token0 is the input
        return SwapParams({zeroForOne: true, amountSpecified: int256(amt), sqrtPriceLimitX96: TickMath.MIN_SQRT_RATIO + 1});
    }

    function test_beforeSwapDelta_donationCreditsCaller() public {
        uint256 donateAmt = 1e17;
        DonateHook impl = new DonateHook(donateAmt, 0);
        address hook = _mineHook(address(impl), Hooks.BEFORE_SWAP_DELTA_FLAG);
        PoolKey memory key = _key(hook);
        router.initialize(key, Q96);
        router.seed(key, 1e20);

        // zeroForOne: input is token0; deposit claims to the hook so it can donate token0
        currency inCur = key.currency0;
        pm.mint(inCur, hook, donateAmt);

        uint256 inBefore = MockERC20(currency.unwrap(inCur)).balanceOf(address(router));
        uint256 inputAmt = 1e18;
        router.swap(key, _sp(inputAmt));
        uint256 paid = inBefore - MockERC20(currency.unwrap(inCur)).balanceOf(address(router));

        // the caller is credited by the donation, so pays inputAmt - donateAmt
        assertEq(paid, inputAmt - donateAmt, "caller credited by the hook donation");
        // the hook's claims were burned to fund it; the swap settled cleanly (the net-zero sweep
        // would have reverted otherwise)
        assertEq(pm.claims(inCur, hook), 0, "hook claims burned");
    }

    function test_beforeSwapDelta_positiveReverts() public {
        BadDeltaHook impl = new BadDeltaHook();
        address hook = _mineHook(address(impl), Hooks.BEFORE_SWAP_DELTA_FLAG);
        PoolKey memory key = _key(hook);
        router.initialize(key, Q96);
        router.seed(key, 1e20);

        vm.expectRevert(PoolManager.InvalidHookDelta.selector);
        router.swap(key, _sp(1e18));
    }

    function test_beforeSwapDelta_insufficientHookClaimReverts() public {
        // hook donates more than it has claims for (none deposited)
        DonateHook impl = new DonateHook(1e18, 0);
        address hook = _mineHook(address(impl), Hooks.BEFORE_SWAP_DELTA_FLAG);
        PoolKey memory key = _key(hook);
        router.initialize(key, Q96);
        router.seed(key, 1e20);

        vm.expectRevert(PoolManager.InsufficientClaim.selector);
        router.swap(key, _sp(1e18));
    }
}
