// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolManager, IUnlockCallback, SwapParams, ModifyLiquidityParams} from "../../src/v4/PoolManager.sol";
import {currency, ADDRESS_ZERO, isNative} from "../../src/v4/types/Currency.sol";
import {BalanceDelta, amount0, amount1} from "../../src/v4/types/BalanceDelta.sol";
import {PoolKey} from "../../src/v4/types/PoolKey.sol";
import {TickMath} from "../../src/libraries/TickMath.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

uint160 constant Q96 = uint160(1 << 96);

/// @notice Router that can settle the native currency with msg.value. Holds ETH (seeded by the
///         test) and pays it into `settle` when a pool's native delta is negative.
contract NativeRouter is IUnlockCallback {
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

    receive() external payable {}

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
        int256 delta = pm.getCurrencyDelta(address(this), c);
        if (delta < 0) {
            if (isNative(c)) {
                // native settle: send exactly the owed amount as msg.value
                pm.settle{value: uint256(-delta)}(c);
            } else {
                pm.settle(c);
            }
        } else if (delta > 0) {
            pm.take(c, address(this), uint256(delta));
        }
    }

    function approveToken(address token) external {
        MockERC20(token).approve(address(pm), type(uint256).max);
    }
}

contract NativeETHTest is Test {
    PoolManager pm;
    NativeRouter router;
    MockERC20 tokenB;
    currency native;
    currency curB;
    PoolKey keyNB;

    receive() external payable {}

    function setUp() public {
        pm = new PoolManager(address(this));
        router = new NativeRouter(pm);
        tokenB = new MockERC20("B", "B", 18);
        native = ADDRESS_ZERO();
        curB = currency.wrap(address(tokenB));

        // native is address(0), the smallest address, so it is always currency0
        keyNB = PoolKey({currency0: native, currency1: curB, fee: 3000, tickSpacing: 60, hooks: address(0)});

        vm.deal(address(router), 1_000_000e18);
        tokenB.mint(address(router), 1_000_000e18);
        router.approveToken(address(tokenB));
    }

    function test_nativePool_initialize_setsTick() public {
        int24 tick = router.initialize(keyNB, Q96);
        assertEq(tick, 0, "initial tick at Q96 is 0");
        (uint160 sp, int24 t) = pm.getSlot0(keyNB);
        assertEq(uint256(sp), uint256(Q96), "sqrt price");
        assertEq(t, 0, "tick");
    }

    function test_swap_nativeToToken_settlesEthAndReceivesToken() public {
        router.initialize(keyNB, Q96);
        _seed(keyNB, 10**18);

        uint256 ethBefore = address(router).balance;
        uint256 tokenBefore = tokenB.balanceOf(address(router));

        // zeroForOne: pay native (currency0), receive tokenB (currency1)
        BalanceDelta d = router.swap(
            keyNB,
            SwapParams({zeroForOne: true, amountSpecified: 1e18, sqrtPriceLimitX96: TickMath.MIN_SQRT_RATIO + 1})
        );

        assertLt(amount0(d), 0, "owes native");
        assertGt(amount1(d), 0, "owed tokenB");
        assertLt(address(router).balance, ethBefore, "spent native ETH");
        assertGt(tokenB.balanceOf(address(router)), tokenBefore, "received tokenB");
        // reaching here means the net-zero sweep passed (native delta settled via msg.value)
    }

    function test_swap_tokenToNative_receivesEth() public {
        router.initialize(keyNB, Q96);
        _seed(keyNB, 10**18);

        uint256 ethBefore = address(router).balance;
        uint256 tokenBefore = tokenB.balanceOf(address(router));

        // oneForZero: pay tokenB (currency1), receive native (currency0)
        BalanceDelta d = router.swap(
            keyNB,
            SwapParams({zeroForOne: false, amountSpecified: 1e18, sqrtPriceLimitX96: TickMath.MAX_SQRT_RATIO - 1})
        );

        assertGt(amount0(d), 0, "owed native");
        assertLt(amount1(d), 0, "owes tokenB");
        assertGt(address(router).balance, ethBefore, "received native ETH");
        assertLt(tokenB.balanceOf(address(router)), tokenBefore, "spent tokenB");
    }

    function test_addThenRemove_liquidity_nativeSolvency() public {
        router.initialize(keyNB, Q96);

        // add liquidity: router owes both native and tokenB
        (BalanceDelta cdAdd,) = router.modifyLiquidity(
            keyNB, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 1e18})
        );
        assertLt(amount0(cdAdd), 0, "owes native on add");
        assertLt(amount1(cdAdd), 0, "owes tokenB on add");
        uint256 nativeDeposited = uint256(-amount0(cdAdd));

        uint256 ethBeforeRemove = address(router).balance;

        // remove liquidity: pool owes native and tokenB back
        (BalanceDelta cdRem,) = router.modifyLiquidity(
            keyNB, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: -1e18})
        );
        assertGt(amount0(cdRem), 0, "owed native on remove");
        assertGt(amount1(cdRem), 0, "owed tokenB on remove");
        uint256 nativeReturned = uint256(amount0(cdRem));

        // pool keeps a rounding surplus, so returned <= deposited, but never more
        assertLe(nativeReturned, nativeDeposited, "returned <= deposited");
        assertGt(address(router).balance, ethBeforeRemove, "ETH balance rose on remove");
    }

    function test_take_native_creditsRecipientBalance() public {
        router.initialize(keyNB, Q96);
        _seed(keyNB, 10**18);

        uint256 recipientEthBefore = address(this).balance;
        // swap token->native but take the native to this test contract instead of the router
        TakeToCallback cb = new TakeToCallback(pm, keyNB);
        tokenB.mint(address(cb), 100e18);
        cb.approveToken(address(tokenB));
        vm.deal(address(cb), 1000e18);

        cb.go(address(this));
        assertGt(address(this).balance, recipientEthBefore, "recipient got native ETH");
    }

    function _seed(PoolKey memory key, uint128 liquidity) internal {
        router.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: int256(uint256(liquidity))})
        );
    }
}

/// @dev swaps token->native and takes the native proceeds to an arbitrary recipient.
contract TakeToCallback is IUnlockCallback {
    PoolManager public immutable pm;
    PoolKey public key;
    address public recipient;

    constructor(PoolManager _pm, PoolKey memory _key) {
        pm = _pm;
        key = _key;
    }

    receive() external payable {}

    function approveToken(address token) external {
        MockERC20(token).approve(address(pm), type(uint256).max);
    }

    function go(address _recipient) external {
        recipient = _recipient;
        pm.unlock("");
    }

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        require(msg.sender == address(pm), "only manager");
        pm.swap(
            key,
            SwapParams({zeroForOne: false, amountSpecified: 1e18, sqrtPriceLimitX96: TickMath.MAX_SQRT_RATIO - 1})
        );
        // take the positive native delta to the recipient; settle the tokenB we owe
        int256 nativeDelta = pm.getCurrencyDelta(address(this), key.currency0);
        if (nativeDelta > 0) pm.take(key.currency0, recipient, uint256(nativeDelta));
        int256 bDelta = pm.getCurrencyDelta(address(this), key.currency1);
        if (bDelta < 0) pm.settle(key.currency1);
        return "";
    }
}
