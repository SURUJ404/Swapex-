// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {PoolManager, IUnlockCallback, SwapParams, ModifyLiquidityParams} from "../PoolManager.sol";
import {currency, isNative} from "../types/Currency.sol";
import {BalanceDelta} from "../types/BalanceDelta.sol";
import {PoolKey} from "../types/PoolKey.sol";
import {TickMath} from "../../libraries/TickMath.sol";

/// @notice User-facing periphery: the single contract that opens `unlock` sessions and settles /
///         takes on the user's behalf, so callers never write a callback or manage deltas. For an
///         ERC-20 input the user approves this router; for a native-ETH input the user sends
///         `msg.value`. Output always goes to the chosen recipient.
contract Router is IUnlockCallback {
    PoolManager public immutable pm;

    // ---------------------------------------------------------------- per-session state
    // one operation per external call; the manager's unlock lock already forbids concurrency, so
    // plain storage is safe here (it is overwritten on every entry).
    address private _payer;
    address private _recipient;
    uint8 private _op;
    PoolKey private _singleKey;
    SwapParams private _singleParams;
    PoolKey[] private _pathKeys;
    bool private _zeroForOneFirst;
    uint256 private _amountIn;
    PoolKey private _liqKey;
    ModifyLiquidityParams private _liqParams;
    BalanceDelta private _swapDelta;
    BalanceDelta private _liqCallerDelta;
    BalanceDelta private _liqFees;

    uint8 private constant OP_SINGLE = 0;
    uint8 private constant OP_MULTI = 1;
    uint8 private constant OP_LIQ = 2;

    error PathTooShort();
    error PathCurrenciesDisjoint();

    constructor(PoolManager _pm) {
        pm = _pm;
    }

    /// @notice initialize a pool (thin passthrough so tests/front-ends can use the router alone).
    function initialize(PoolKey memory key, uint160 sqrtPriceX96) external returns (int24) {
        return pm.initialize(key, sqrtPriceX96);
    }

    /// @notice exact-input swap on a single pool. `sp.amountSpecified` must be > 0 (exact in).
    function exactInputSingle(PoolKey memory key, SwapParams memory sp, address recipient)
        external
        payable
        returns (BalanceDelta)
    {
        _payer = msg.sender;
        _recipient = recipient;
        _singleKey = key;
        _singleParams = sp;
        _op = OP_SINGLE;
        delete _pathKeys;
        pm.unlock("");
        return _swapDelta;
    }

    /// @notice exact-input swap across a path of pools. The first hop sells `amountIn` of the
    ///         input token (side chosen by `zeroForOneFirst`); each later hop sells exactly the
    ///         intermediate amount the prior hop produced, so intermediate currencies net to zero
    ///         and only the first input and last output ever move tokens.
    function exactInput(PoolKey[] memory keys, bool zeroForOneFirst, uint256 amountIn, address recipient)
        external
        payable
        returns (BalanceDelta)
    {
        if (keys.length < 2) revert PathTooShort();
        _payer = msg.sender;
        _recipient = recipient;
        _op = OP_MULTI;
        delete _pathKeys;
        for (uint256 i = 0; i < keys.length; i++) {
            _pathKeys.push(keys[i]);
        }
        _zeroForOneFirst = zeroForOneFirst;
        _amountIn = amountIn;
        pm.unlock("");
        return _swapDelta;
    }

    /// @notice add or remove liquidity in one pool (sign of `mp.liquidityDelta` selects).
    function modifyLiquidity(PoolKey memory key, ModifyLiquidityParams memory mp, address recipient)
        external
        payable
        returns (BalanceDelta callerDelta, BalanceDelta feesAccrued)
    {
        _payer = msg.sender;
        _recipient = recipient;
        _liqKey = key;
        _liqParams = mp;
        _op = OP_LIQ;
        pm.unlock("");
        return (_liqCallerDelta, _liqFees);
    }

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        require(msg.sender == address(pm), "only manager");
        if (_op == OP_SINGLE) {
            _swapDelta = pm.swap(_singleKey, _singleParams);
            _settleOrTake(_singleKey.currency0);
            _settleOrTake(_singleKey.currency1);
        } else if (_op == OP_MULTI) {
            _swapDelta = _doMulti();
            uint256 n = _pathKeys.length;
            PoolKey memory first = _pathKeys[0];
            PoolKey memory last = _pathKeys[n - 1];
            _settleOrTake(first.currency0);
            _settleOrTake(first.currency1);
            _settleOrTake(last.currency0);
            _settleOrTake(last.currency1);
        } else {
            (_liqCallerDelta, _liqFees) = pm.modifyLiquidity(_liqKey, _liqParams);
            _settleOrTake(_liqKey.currency0);
            _settleOrTake(_liqKey.currency1);
        }
        return "";
    }

    /// @dev chain the hops: hop 0 is exact-in with the user's amount; each later hop sells exactly
    ///      the intermediate currency amount the previous hop produced (read from its delta).
    function _doMulti() private returns (BalanceDelta lastDelta) {
        uint256 n = _pathKeys.length;

        // hop 0
        PoolKey memory k0 = _pathKeys[0];
        bool zfo0 = _zeroForOneFirst;
        lastDelta = pm.swap(
            k0,
            SwapParams({
                zeroForOne: zfo0,
                amountSpecified: int256(_amountIn),
                sqrtPriceLimitX96: zfo0 ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1
            })
        );

        // hops 1..n-1: input is the shared currency with the previous pool
        for (uint256 i = 1; i < n; i++) {
            PoolKey memory prev = _pathKeys[i - 1];
            PoolKey memory k = _pathKeys[i];
            currency mid = _sharedCurrency(prev, k);
            int256 midDelta = pm.getCurrencyDelta(mid);
            uint256 midAmt = uint256(midDelta > 0 ? midDelta : -midDelta);
            bool zfo = k.currency0 == mid;
            lastDelta = pm.swap(
                k,
                SwapParams({
                    zeroForOne: zfo,
                    amountSpecified: int256(midAmt),
                    sqrtPriceLimitX96: zfo ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1
                })
            );
        }
    }

    /// @dev the currency present in both adjacent pool keys (the hop intermediate); reverts if the
    ///      path is invalid (two pools that share no currency).
    function _sharedCurrency(PoolKey memory a, PoolKey memory b) private pure returns (currency) {
        if (a.currency0 == b.currency0 || a.currency0 == b.currency1) return a.currency0;
        if (a.currency1 == b.currency0 || a.currency1 == b.currency1) return a.currency1;
        revert PathCurrenciesDisjoint();
    }

    /// @dev pay a negative delta (pull input from the payer, or send held ETH for native) and
    ///      withdraw a positive delta to the recipient.
    function _settleOrTake(currency c) private {
        int256 delta = pm.getCurrencyDelta(c);
        if (delta < 0) {
            uint256 amt = uint256(-delta);
            if (isNative(c)) {
                // native input: the user's msg.value is already held by this router
                pm.settle{value: amt}(c);
            } else {
                c.transferFrom(_payer, address(this), amt); // payer approved this router
                c.approve(address(pm), amt); // let the manager pull from the router
                pm.settle(c);
            }
        } else if (delta > 0) {
            pm.take(c, _recipient, uint256(delta));
        }
    }
}
