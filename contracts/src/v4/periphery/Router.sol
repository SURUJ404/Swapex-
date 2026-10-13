// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {PoolManager, IUnlockCallback, SwapParams, ModifyLiquidityParams} from "../PoolManager.sol";
import {currency, isNative} from "../types/Currency.sol";
import {BalanceDelta, amount0, amount1} from "../types/BalanceDelta.sol";
import {PoolKey} from "../types/PoolKey.sol";
import {TickMath} from "../../libraries/TickMath.sol";
import {AllowanceTransfer} from "./AllowanceTransfer.sol";

/// @notice User-facing periphery: the single contract that opens `unlock` sessions and settles /
///         takes on the user's behalf, so callers never write a callback or manage deltas. For an
///         ERC-20 input the user grants a bounded allowance through `AllowanceTransfer` (either a
///         one-time EIP-2612 `permit` on the token, or `approve(allowanceTransfer)` once) and then
///         a per-spender grant the router can spend until it expires; for a native-ETH input the
///         user sends `msg.value`. Output always goes to the chosen recipient.
contract Router is IUnlockCallback {
    PoolManager public immutable pm;
    /// @notice the bounded-allowance contract every ERC-20 input is pulled through, so the router
    ///         never needs an unlimited, never-expiring ERC-20 approval of its own.
    AllowanceTransfer public immutable at;

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
    uint256 private _minOut;

    uint8 private constant OP_SINGLE = 0;
    uint8 private constant OP_MULTI = 1;
    uint8 private constant OP_LIQ = 2;

    error PathTooShort();
    error PathCurrenciesDisjoint();
    error InsufficientOutputAmount(int256 amountOut, uint256 minAmountOut);
    error InsufficientPositionLiquidity(uint128 requested, uint128 available);
    error InvalidPermitSpender(address expected, address actual);

    // ---------------------------------------------------------------- position registry
    // The manager keys positions by the *caller* of `modifyLiquidity` (this router), so every
    // user's liquidity merges into one on-chain slot per (pool, range). This registry tracks each
    // beneficiary's share so `removeLiquidity` can be attributed and over-removal rejected. Fees
    // still accrue to the merged slot (see DECISIONS.md D26 — a full per-user position manager is
    // future work; for the single-provider demo frontend this is sufficient).
    mapping(address => mapping(bytes32 => uint128)) private _positionLiquidity;

    constructor(PoolManager _pm, AllowanceTransfer _at) {
        pm = _pm;
        at = _at;
    }

    /// @notice initialize a pool (thin passthrough so tests/front-ends can use the router alone).
    function initialize(PoolKey memory key, uint160 sqrtPriceX96) external returns (int24) {
        return pm.initialize(key, sqrtPriceX96);
    }

    /// @notice exact-input swap on a single pool. `sp.amountSpecified` must be > 0 (exact in).
    ///         `minAmountOut` is a slippage floor on the output (in the output currency's base
    ///         units); the whole swap reverts if the realized output is below it. Zero disables.
    function exactInputSingle(PoolKey memory key, SwapParams memory sp, address recipient, uint256 minAmountOut)
        external
        payable
        returns (BalanceDelta)
    {
        _payer = msg.sender;
        _recipient = recipient;
        _singleKey = key;
        _singleParams = sp;
        _minOut = minAmountOut;
        _op = OP_SINGLE;
        delete _pathKeys;
        pm.unlock("");
        return _swapDelta;
    }

    /// @notice exact-input single swap that submits the payer's signed allowance grant
    ///         (EIP-712, see `AllowanceTransfer.permit`) in the *same* transaction, so there is no
    ///         window between approving and swapping.
    ///
    ///         If the grant's nonce was already consumed — a relayer or attacker submitted the same
    ///         signed permit first — this is not an error: the grant it carried is already in
    ///         effect, so the swap proceeds against the allowance it established. A front-run can
    ///         cost the original submitter gas, but it can neither steal the grant nor invalidate
    ///         it, and it can never turn a swap that would otherwise revert into one that
    ///         succeeds: every other failure (expired signature deadline, wrong signer, expiry,
    ///         insufficient allowance) still reverts. `permitSingle.spender` must be this router.
    function exactInputSingleWithPermit(
        PoolKey memory key,
        SwapParams memory sp,
        address recipient,
        uint256 minAmountOut,
        AllowanceTransfer.PermitSingle memory permitSingle,
        bytes calldata sig,
        uint256 sigDeadline
    ) external payable returns (BalanceDelta) {
        if (permitSingle.spender != address(this)) {
            revert InvalidPermitSpender(address(this), permitSingle.spender);
        }
        // a native input is paid from msg.value and needs no grant, so don't burn a nonce on it.
        currency input = sp.zeroForOne ? key.currency0 : key.currency1;
        if (!isNative(input) && !at.isNonceUsed(msg.sender, permitSingle.details.nonce)) {
            at.permit(msg.sender, permitSingle, sig, sigDeadline);
        }

        _payer = msg.sender;
        _recipient = recipient;
        _singleKey = key;
        _singleParams = sp;
        _minOut = minAmountOut;
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
        _recordPosition(msg.sender, key, mp);
        return (_liqCallerDelta, _liqFees);
    }

    /// @notice the liquidity `user` contributed to the given position slot (0 if none). Lets a
    ///         front-end read back how much of a range a wallet owns so it can size a removal.
    function getPositionLiquidity(address user, PoolKey memory key, int24 tickLower, int24 tickUpper)
        external
        view
        returns (uint128)
    {
        return _positionLiquidity[user][_positionId(key, tickLower, tickUpper)];
    }

    function _positionId(PoolKey memory key, int24 tickLower, int24 tickUpper) private pure returns (bytes32) {
        return keccak256(abi.encode(key.toPoolId(), tickLower, tickUpper));
    }

    /// @dev attribute a liquidity delta to the beneficiary (the router's caller). A removal larger
    ///      than what the caller previously added reverts, so one wallet can't spend another's.
    function _recordPosition(address user, PoolKey memory key, ModifyLiquidityParams memory mp) private {
        if (mp.liquidityDelta == 0) return;
        bytes32 id = _positionId(key, mp.tickLower, mp.tickUpper);
        if (mp.liquidityDelta > 0) {
            _positionLiquidity[user][id] += uint128(uint256(mp.liquidityDelta));
        } else {
            uint128 amount = uint128(uint256(-mp.liquidityDelta));
            uint128 current = _positionLiquidity[user][id];
            if (current < amount) revert InsufficientPositionLiquidity(amount, current);
            unchecked {
                // safe: guarded by the `current < amount` check above
                _positionLiquidity[user][id] = current - amount;
            }
        }
    }

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        require(msg.sender == address(pm), "only manager");
        if (_op == OP_SINGLE) {
            _swapDelta = pm.swap(_singleKey, _singleParams);
            _enforceMinOut(_singleParams.zeroForOne, _swapDelta, _minOut);
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
                // pull through the bounded-allowance contract: the payer granted *this router* an
                // allowance there, and this router holds its own ERC-20 approval to the manager.
                at.transferFrom(_payer, address(this), amt, currency.unwrap(c));
                c.approve(address(pm), amt); // let the manager pull from the router
                pm.settle(c);
            }
        } else if (delta > 0) {
            pm.take(c, _recipient, uint256(delta));
        }
    }

    /// @dev revert if the swap's output (the positive delta in the output currency) is below
    ///      `minOut`. A zero `minOut` disables the check. Under the caller-owes convention the
    ///      output currency is the one with a positive delta: selling currency0 (zeroForOne)
    ///      pays out currency1, otherwise currency0.
    function _enforceMinOut(bool zeroForOne, BalanceDelta d, uint256 minOut) private pure {
        if (minOut == 0) return;
        int256 out = zeroForOne ? amount1(d) : amount0(d);
        if (out < 0 || uint256(out) < minOut) revert InsufficientOutputAmount(out, minOut);
    }
}
