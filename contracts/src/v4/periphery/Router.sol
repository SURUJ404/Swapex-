// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {PoolManager, IUnlockCallback, SwapParams, ModifyLiquidityParams} from "../PoolManager.sol";
import {currency, isNative} from "../types/Currency.sol";
import {BalanceDelta, amount0, amount1, toBalanceDelta} from "../types/BalanceDelta.sol";
import {PoolKey} from "../types/PoolKey.sol";
import {TickMath} from "../../libraries/TickMath.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
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

    // ---------------------------------------------------------------- user-supplied bounds
    /// @notice execution bounds for one `modifyLiquidity` call (B.1). The sign of each delta
    ///         decides which fields apply: a *negative* delta (the caller pays) is checked against
    ///         the `Max` fields, a *positive* delta (the caller receives) against the `Min` fields.
    ///         Callers set the fields they don't use to 0 (mins) or `type(uint256).max` (maxes).
    struct LiquidityBounds {
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 amount0Max;
        uint256 amount1Max;
    }

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
    LiquidityBounds private _liqBounds;
    BalanceDelta private _swapDelta;
    BalanceDelta private _liqCallerDelta;
    BalanceDelta private _liqFees;
    uint256 private _minOut;

    uint8 private constant OP_SINGLE = 0;
    uint8 private constant OP_MULTI = 1;
    uint8 private constant OP_LIQ = 2;

    error PathTooShort();
    error PathCurrenciesDisjoint();
    error PathBrokenHop();
    error InsufficientOutputAmount(int256 amountOut, uint256 minAmountOut);
    error TransactionTooOld(uint256 deadline, uint256 blockTimestamp);
    error AmountBelowMin(uint8 currencyIndex, uint256 amount, uint256 minAmount);
    error AmountAboveMax(uint8 currencyIndex, uint256 amount, uint256 maxAmount);
    error InsufficientPositionLiquidity(uint128 requested, uint128 available);
    error InvalidPermitSpender(address expected, address actual);
    error NativeRefundFailed();
    error NativeInputShortfall(uint256 required, uint256 available);
    error ZeroRecipient();

    uint256 private constant FEE_GROWTH_SCALE = 1 << 128;

    // ---------------------------------------------------------------- position registry
    // The manager keys positions by the *caller* of `modifyLiquidity` (this router), so every
    // user's liquidity merges into one on-chain slot per (pool, range). This registry tracks each
    // beneficiary's share of that slot: their liquidity, their own fee-growth checkpoint, and the
    // fees credited to them but not yet paid out. Settlement is split so the caller always pays
    // (or receives) the *whole* principal while every fee the merged slot accrues is booked to
    // this contract's reserve — see DECISIONS.md D41.
    struct FeePosition {
        uint128 liquidity;
        uint256 feeGrowthInside0LastX128;
        uint256 feeGrowthInside1LastX128;
        uint256 tokensOwed0;
        uint256 tokensOwed1;
    }

    mapping(address => mapping(bytes32 => FeePosition)) private _feePositions;
    /// @notice fees this contract holds on behalf of LPs, per currency (native is address(0)).
    ///         Always backed by the matching real balance — `collectFees` / a liquidity change
    ///         release at most what the reserve holds, so `balanceOf(this) >= feeReserve[c]`
    ///         after every operation. The sum of unpaid ledger claims can transiently exceed
    ///         the reserve by floor-rounding only (the manager floors each touch, a claim floors
    ///         its whole checkpoint span); such an excess stays claimed in the ledger and is
    ///         paid as soon as later touches book enough — never by dipping below the reserve.
    mapping(address => uint256) public feeReserve;
    /// @dev native half of `feeReserve`, kept separately so `_refundNative` returns only the
    ///      payer's surplus and never the ETH held for LPs.
    uint256 private _nativeReserve;

    // filled by `_settleLiquidity` inside the session, released once it has closed
    uint256 private _pendingOut0;
    uint256 private _pendingOut1;

    constructor(PoolManager _pm, AllowanceTransfer _at) {
        pm = _pm;
        at = _at;
    }

    /// @dev the router has to *hold* native currency now: a removal's principal is taken back from
    ///      the manager before it is forwarded to the recipient, and the native half of the fee
    ///      reserve sits here between accrual and `collectFees`. Only the manager may deliver it —
    ///      a stray donation must never become somebody else's refund.
    receive() external payable {
        require(msg.sender == address(pm), "only manager");
    }

    /// @notice initialize a pool (thin passthrough so tests/front-ends can use the router alone).
    function initialize(PoolKey memory key, uint160 sqrtPriceX96) external returns (int24) {
        return pm.initialize(key, sqrtPriceX96);
    }

    /// @notice exact-input swap on a single pool. `sp.amountSpecified` must be > 0 (exact in).
    ///         `minAmountOut` is a slippage floor on the output (in the output currency's base
    ///         units); the whole swap reverts if the realized output is below it. Zero disables.
    ///         `deadline` is an absolute unix timestamp the tx must land by (`block.timestamp >
    ///         deadline` reverts) — it makes a pending tx worthless after the user's chosen time,
    ///         so a stuck order can't execute against a price the user never accepted.
    function exactInputSingle(PoolKey memory key, SwapParams memory sp, address recipient, uint256 minAmountOut, uint256 deadline)
        external
        payable
        returns (BalanceDelta)
    {
        _enforceDeadline(deadline);
        _payer = msg.sender;
        _recipient = recipient;
        _singleKey = key;
        _singleParams = sp;
        _minOut = minAmountOut;
        _op = OP_SINGLE;
        delete _pathKeys;
        pm.unlock("");
        _refundNative();
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
    ///         `deadline` is the same tx-level bound as in `exactInputSingle`.
    function exactInputSingleWithPermit(
        PoolKey memory key,
        SwapParams memory sp,
        address recipient,
        uint256 minAmountOut,
        uint256 deadline,
        AllowanceTransfer.PermitSingle memory permitSingle,
        bytes calldata sig
    ) external payable returns (BalanceDelta) {
        _enforceDeadline(deadline);
        if (permitSingle.spender != address(this)) {
            revert InvalidPermitSpender(address(this), permitSingle.spender);
        }
        // a native input is paid from msg.value and needs no grant, so don't burn a nonce on it.
        currency input = sp.zeroForOne ? key.currency0 : key.currency1;
        if (!isNative(input) && !at.isNonceUsed(msg.sender, permitSingle.details.nonce)) {
            at.permit(msg.sender, permitSingle, sig);
        }

        _payer = msg.sender;
        _recipient = recipient;
        _singleKey = key;
        _singleParams = sp;
        _minOut = minAmountOut;
        _op = OP_SINGLE;
        delete _pathKeys;
        pm.unlock("");
        _refundNative();
        return _swapDelta;
    }

    /// @notice exact-input swap across a path of pools. The first hop sells `amountIn` of the
    ///         input token (side chosen by `zeroForOneFirst`); each later hop sells exactly the
    ///         intermediate amount the prior hop produced, so intermediate currencies net to zero
    ///         and only the first input and last output ever move tokens. `minAmountOut` bounds
    ///         the final output and `deadline` the execution time, exactly as for a single swap
    ///         (B.1: a multi-hop path must never execute unbounded — each hop is a new sandwich
    ///         surface).
    function exactInput(
        PoolKey[] memory keys,
        bool zeroForOneFirst,
        uint256 amountIn,
        address recipient,
        uint256 minAmountOut,
        uint256 deadline
    ) external payable returns (BalanceDelta) {
        if (keys.length < 2) revert PathTooShort();
        _enforceDeadline(deadline);
        _payer = msg.sender;
        _recipient = recipient;
        _op = OP_MULTI;
        _minOut = minAmountOut;
        delete _pathKeys;
        for (uint256 i = 0; i < keys.length; i++) {
            _pathKeys.push(keys[i]);
        }
        _zeroForOneFirst = zeroForOneFirst;
        _amountIn = amountIn;
        pm.unlock("");
        _refundNative();
        return _swapDelta;
    }

    /// @notice add or remove liquidity in one pool (sign of `mp.liquidityDelta` selects).
    ///         `bounds` caps what this call may pay (add, negative deltas) or must receive (remove,
    ///         positive deltas) per currency, and `deadline` caps execution time — the same
    ///         sandwich/stale-tx protections swaps get (B.1).
    ///
    ///         Settlement is split so this call is always *principal-only* from the caller's point
    ///         of view: they pay (or receive) their whole `callerDelta`, never a fee-netted
    ///         version of it. The fees the merged on-chain slot accrued in the meantime are booked
    ///         to this contract's reserve and the caller's own share of them — computed from their
    ///         private fee-growth checkpoint — is paid out to `recipient` in the same transaction.
    ///         `feesAccrued` reports exactly that share (not the slot's total), so it is never
    ///         bounded by `bounds`: it is already the caller's balance.
    function modifyLiquidity(
        PoolKey memory key,
        ModifyLiquidityParams memory mp,
        address recipient,
        LiquidityBounds memory bounds,
        uint256 deadline
    ) external payable returns (BalanceDelta callerDelta, BalanceDelta feesAccrued) {
        _enforceDeadline(deadline);
        _payer = msg.sender;
        _recipient = recipient;
        _liqKey = key;
        _liqParams = mp;
        _liqBounds = bounds;
        _op = OP_LIQ;
        pm.unlock("");
        // snapshot before any outbound transfer: a receiver that re-enters re-runs the whole entry
        // point and would overwrite the session slots we must still return from.
        callerDelta = _liqCallerDelta;
        feesAccrued = _flushLiquidityOutflows();
        _refundNative();
    }

    /// @notice accrue and pay out the caller's share of this range's swap fees to `recipient`,
    ///         without changing any liquidity. An LP who never adds or removes still has to be able
    ///         to collect, so this is the same operation as a `liquidityDelta == 0` poke: it first
    ///         makes the manager realise the shared slot's fees (they only become this contract's
    ///         to hand out once the slot is touched — until then they are still the manager's
    ///         reserves), books them to `feeReserve`, then pays out the caller's own share.
    /// @return amount0Out the amount of `key.currency0` paid out (0 when nothing was owed).
    /// @return amount1Out the amount of `key.currency1` paid out.
    function collectFees(PoolKey memory key, int24 tickLower, int24 tickUpper, address recipient)
        external
        returns (uint256 amount0Out, uint256 amount1Out)
    {
        _payer = msg.sender;
        _recipient = recipient;
        _liqKey = key;
        _liqParams = ModifyLiquidityParams({tickLower: tickLower, tickUpper: tickUpper, liquidityDelta: 0});
        // a poke moves no principal, so there is nothing to bound
        _liqBounds = LiquidityBounds({amount0Min: 0, amount1Min: 0, amount0Max: type(uint256).max, amount1Max: type(uint256).max});
        _op = OP_LIQ;
        pm.unlock("");
        BalanceDelta paid = _flushLiquidityOutflows();
        amount0Out = uint256(amount0(paid));
        amount1Out = uint256(amount1(paid));
    }

    /// @notice the liquidity `user` contributed to the given position slot (0 if none). Lets a
    ///         front-end read back how much of a range a wallet owns so it can size a removal.
    function getPositionLiquidity(address user, PoolKey memory key, int24 tickLower, int24 tickUpper)
        external
        view
        returns (uint128)
    {
        return _feePositions[user][_positionId(key, tickLower, tickUpper)].liquidity;
    }

    /// @notice the caller's accrued-but-unpaid fees for a range, before `collectFees` realises
    ///         them. Both components are in the pool's own currencies.
    function getUnclaimedFees(address user, PoolKey memory key, int24 tickLower, int24 tickUpper)
        external
        view
        returns (uint256 unclaimed0, uint256 unclaimed1)
    {
        FeePosition storage p = _feePositions[user][_positionId(key, tickLower, tickUpper)];
        (uint256 in0, uint256 in1) = pm.getFeeGrowthInside(key, tickLower, tickUpper);
        if (p.liquidity != 0) {
            unclaimed0 = p.tokensOwed0
                + Math.mulDiv(uint256(p.liquidity), in0 - p.feeGrowthInside0LastX128, FEE_GROWTH_SCALE);
            unclaimed1 = p.tokensOwed1
                + Math.mulDiv(uint256(p.liquidity), in1 - p.feeGrowthInside1LastX128, FEE_GROWTH_SCALE);
        } else {
            unclaimed0 = p.tokensOwed0;
            unclaimed1 = p.tokensOwed1;
        }
    }

    function _positionId(PoolKey memory key, int24 tickLower, int24 tickUpper) private pure returns (bytes32) {
        return keccak256(abi.encode(key.toPoolId(), tickLower, tickUpper));
    }

    /// @dev credit `p` with the fees its own liquidity earned since its last checkpoint. The
    ///      subtraction is checked on purpose: `feeGrowthInside` only stands still or moves
    ///      forward while the position holds liquidity (its boundary ticks stay initialised, so
    ///      their `feeGrowthOutside` cannot be rewritten underneath it), so an underflow here can
    ///      only mean a broken checkpoint — reverting beats minting an unbacked credit.
    function _accrue(FeePosition storage p, uint256 in0, uint256 in1) private {
        if (p.liquidity == 0) return;
        p.tokensOwed0 += Math.mulDiv(uint256(p.liquidity), in0 - p.feeGrowthInside0LastX128, FEE_GROWTH_SCALE);
        p.tokensOwed1 += Math.mulDiv(uint256(p.liquidity), in1 - p.feeGrowthInside1LastX128, FEE_GROWTH_SCALE);
    }

    /// @dev attribute a liquidity delta to the beneficiary (the router's caller). A removal larger
    ///      than what the caller previously added reverts, so one wallet can't spend another's.
    function _applyLiquidityDelta(FeePosition storage p, int256 delta) private {
        if (delta == 0) return;
        if (delta > 0) {
            p.liquidity += uint128(uint256(delta));
        } else {
            uint128 amount = uint128(uint256(-delta));
            uint128 current = p.liquidity;
            if (current < amount) revert InsufficientPositionLiquidity(amount, current);
            unchecked {
                // safe: guarded by the `current < amount` check above
                p.liquidity = current - amount;
            }
        }
    }

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        require(msg.sender == address(pm), "only manager");
        if (_op == OP_SINGLE) {
            _swapDelta = pm.swap(_singleKey, _singleParams);
            _enforceMinOut(_swapDelta, _minOut);
            _settleOrTake(_singleKey.currency0);
            _settleOrTake(_singleKey.currency1);
        } else if (_op == OP_MULTI) {
            _swapDelta = _doMulti();
            _enforceMinOut(_swapDelta, _minOut);
            uint256 n = _pathKeys.length;
            for (uint256 i = 0; i < n; i++) {
                PoolKey memory pk = _pathKeys[i];
                _settleOrTake(pk.currency0);
                _settleOrTake(pk.currency1);
            }
        } else {
            _doModifyLiquidity();
        }
        return "";
    }

    /// @dev the whole liquidity operation, in order:
    ///      1. credit the caller with their share of the range's fees up to the pre-call state,
    ///      2. apply their liquidity delta to their ledger (over-removal reverts here, CEI),
    ///      3. run the manager's op, which merges them into the shared slot,
    ///      4. re-checkpoint the caller from a *post*-call fee-growth read,
    ///      5. enforce the caller's bounds, then settle: the caller moves the full principal and
    ///         the slot's total fees are booked to this contract's reserve.
    ///
    ///      Step 4 always re-reads after the op, for two reasons. A first (or
    ///      first-after-full-removal) mint initialises the boundary ticks and rewrites their
    ///      `feeGrowthOutside`, jumping `feeGrowthInside` underneath us; and a before/after
    ///      liquidity hook may swap or donate mid-op, advancing `feeGrowthInside` while the
    ///      caller's new delta already sits in the ledger but is not yet in the shared slot.
    ///      Checkpointing a pre-hook value would credit the joiner growth their liquidity did
    ///      not produce — the manager booked that window at the *old* slot liquidity, so the
    ///      extra claim could only be paid by draining other LPs' backed fees. The post-read is
    ///      the conservative direction in every case: growth the caller genuinely earned inside
    ///      the op (their delta in the slot during an after-hook) is left to the next touch —
    ///      an under-credit of at most that window, never an unbacked claim.
    function _doModifyLiquidity() private {
        PoolKey memory key = _liqKey;
        ModifyLiquidityParams memory mp = _liqParams;
        FeePosition storage p = _feePositions[_payer][_positionId(key, mp.tickLower, mp.tickUpper)];

        if (p.liquidity != 0) {
            (uint256 in0, uint256 in1) = pm.getFeeGrowthInside(key, mp.tickLower, mp.tickUpper);
            _accrue(p, in0, in1);
        }

        _applyLiquidityDelta(p, mp.liquidityDelta);

        // An empty-ledger poke has nothing to realise for its caller, so don't touch the shared
        // slot at all: the manager would floor this window's accrual against every other LP's
        // un-floored span, and anybody can insert foreign pokes to wedge a wei-sized shortfall
        // into a holder's collect (and, through the flush, into their removal too). Holders
        // still realise fees whenever they themselves touch.
        if (p.liquidity == 0 && mp.liquidityDelta == 0) {
            _liqCallerDelta = toBalanceDelta(0, 0);
            _liqFees = toBalanceDelta(0, 0);
            _pendingOut0 = 0;
            _pendingOut1 = 0;
        } else {
            (_liqCallerDelta, _liqFees) = pm.modifyLiquidity(key, mp);

            (uint256 out0, uint256 out1) = pm.getFeeGrowthInside(key, mp.tickLower, mp.tickUpper);
            p.feeGrowthInside0LastX128 = out0;
            p.feeGrowthInside1LastX128 = out1;

            _enforceBounds(_liqCallerDelta, _liqBounds);
            _settleLiquidity();
        }
    }

    /// @dev settle both sides of the liquidity op with the split the caller is owed: they move the
    ///      whole principal, the manager only ever sees `principal - fees`, and whatever the
    ///      manager does not collect stays here as fee reserve. Returns nothing — the principal
    ///      owed *back* to the recipient is stashed in `_pendingOutN` and released after the
    ///      session closes, so no receiver can re-enter a half-finished unlock.
    function _settleLiquidity() private {
        _pendingOut0 = _settleLiqSide(_liqKey.currency0, amount0(_liqCallerDelta), amount0(_liqFees));
        _pendingOut1 = _settleLiqSide(_liqKey.currency1, amount1(_liqCallerDelta), amount1(_liqFees));
    }

    /// @dev one currency's half. `callerDelta` is the caller-owes component (positive = the caller
    ///      receives it), `fees` is what the shared slot accrued. The manager's open delta for
    ///      this side is exactly `fees + callerDelta`.
    /// @return principalToSend amount the caller is owed back, to be paid once the session closes.
    function _settleLiqSide(currency c, int256 callerDelta, int256 fees) private returns (uint256 principalToSend) {
        int256 delta = fees + callerDelta;

        if (callerDelta < 0) {
            // the caller always funds the *full* principal; the manager collects only the part
            // the slot's accrued fees do not cover, so the difference stays here as reserve.
            uint256 pay = uint256(-callerDelta);
            if (isNative(c)) {
                uint256 held = address(this).balance;
                uint256 available = held > _nativeReserve ? held - _nativeReserve : 0;
                if (available < pay) revert NativeInputShortfall(pay, available);
            } else {
                at.transferFrom(_payer, address(this), pay, currency.unwrap(c));
            }
        }

        if (delta < 0) {
            uint256 owed = uint256(-delta);
            if (isNative(c)) {
                pm.settle{value: owed}(c);
            } else {
                c.approve(address(pm), owed);
                pm.settle(c);
            }
        } else if (delta > 0) {
            pm.take(c, address(this), uint256(delta));
        }

        if (fees > 0) {
            uint256 f = uint256(fees);
            feeReserve[currency.unwrap(c)] += f;
            if (isNative(c)) _nativeReserve += f;
        }

        if (callerDelta > 0) principalToSend = uint256(callerDelta);
    }

    /// @dev release the caller's principal and their realised fee share to `recipient` — the
    ///      fees only as far as the reserve actually backs them. Runs after `pm.unlock` has
    ///      closed, so a receiver that re-enters starts a self-contained call and cannot observe
    ///      a half-settled session; every value it reads is copied to memory or cleared first,
    ///      so a re-entrant run cannot corrupt what we still owe. Whatever the reserve cannot
    ///      back right now stays claimed in the ledger (`tokensOwed`) and becomes payable on a
    ///      later touch.
    function _flushLiquidityOutflows() private returns (BalanceDelta feesPaid) {
        PoolKey memory key = _liqKey;
        address to = _recipient;
        bytes32 id = _positionId(key, _liqParams.tickLower, _liqParams.tickUpper);

        uint256 principal0 = _pendingOut0;
        uint256 principal1 = _pendingOut1;
        _pendingOut0 = 0;
        _pendingOut1 = 0;

        FeePosition storage p = _feePositions[_payer][id];
        uint256 fee0 = p.tokensOwed0;
        uint256 fee1 = p.tokensOwed1;
        uint256 paid0 = 0;
        uint256 paid1 = 0;
        if (fee0 != 0) {
            paid0 = _releasePartial(key.currency0, fee0);
            p.tokensOwed0 = fee0 - paid0;
        }
        if (fee1 != 0) {
            paid1 = _releasePartial(key.currency1, fee1);
            p.tokensOwed1 = fee1 - paid1;
        }
        feesPaid = toBalanceDelta(int256(paid0), int256(paid1));

        principal0 += paid0;
        principal1 += paid1;
        if (principal0 != 0) _send(key.currency0, to, principal0);
        if (principal1 != 0) _send(key.currency1, to, principal1);
    }

    /// @dev draw up to `amt` of fees out of the reserve this contract holds for LPs: pay exactly
    ///      what the reserve backs and no more — an unbacked credit would be theft from every
    ///      other LP. Reverting instead (the old `_release`) turned the few wei of
    ///      union-floor-vs-per-window-floor rounding a foreign touch can wedge in into a
    ///      permanent freeze of the caller's fees *and* their principal, so the shortfall
    ///      stays claimed in the ledger until a later touch books enough to cover it.
    function _releasePartial(currency c, uint256 amt) private returns (uint256 paid) {
        address a = currency.unwrap(c);
        uint256 reserved = feeReserve[a];
        paid = amt > reserved ? reserved : amt;
        if (paid == 0) return 0;
        feeReserve[a] = reserved - paid;
        if (isNative(c)) {
            unchecked {
                // safe: `_nativeReserve` and `feeReserve[address(0)]` are always updated together
                _nativeReserve -= paid;
            }
        }
    }

    function _send(currency c, address to, uint256 amt) private {
        if (to == address(0)) revert ZeroRecipient();
        c.transfer(to, amt);
    }

    /// @dev chain the hops: hop 0 is exact-in with the user's amount; each later hop sells exactly
    ///      the amount of the currency the previous hop produced (read from this router's own delta,
    ///      which no hook or recipient can alter). The direction of every hop is derived by walking
    ///      the path with the *current* currency, so a path whose adjacent pools share both
    ///      currencies (e.g. two fee tiers of the same pair) is unambiguous.
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
        // the currency the path holds after hop 0 is hop 0's output
        currency cur = zfo0 ? k0.currency1 : k0.currency0;

        // hops 1..n-1: the input is the currency held, which must be one side of the next pool
        for (uint256 i = 1; i < n; i++) {
            PoolKey memory k = _pathKeys[i];
            bool zfo;
            if (k.currency0 == cur) zfo = true;
            else if (k.currency1 == cur) zfo = false;
            else revert PathCurrenciesDisjoint();
            int256 held = pm.getCurrencyDelta(address(this), cur);
            if (held <= 0) revert PathBrokenHop();
            lastDelta = pm.swap(
                k,
                SwapParams({
                    zeroForOne: zfo,
                    amountSpecified: held,
                    sqrtPriceLimitX96: zfo ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1
                })
            );
            cur = zfo ? k.currency1 : k.currency0;
        }
    }

    /// @dev pay a negative delta (pull input from the payer, or send held ETH for native) and
    ///      withdraw a positive delta to the recipient.
    function _settleOrTake(currency c) private {
        int256 delta = pm.getCurrencyDelta(address(this), c);
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

    /// @dev return any native currency the caller attached but the operation did not consume: an
    ///      exact-input swap that hit its price limit and only partially filled, or simply an
    ///      over-payment (settlement only forwards the owed delta). Without this the leftover
    ///      would be stranded — the router has no owner and no withdrawal path.
    ///      Fees held for LPs sit in the same balance and are excluded via `_nativeReserve`, so an
    ///      LP's native fee share is never swept back to whoever happened to call last.
    /// @dev reentrancy note: this runs after `pm.unlock` has closed the session, so a receiver
    ///      that re-enters starts a fresh, self-contained call of its own and can only touch the
    ///      allowance and balance it brought itself.
    function _refundNative() private {
        uint256 held = address(this).balance;
        uint256 excess = held > _nativeReserve ? held - _nativeReserve : 0;
        if (excess == 0) return;
        (bool ok, ) = payable(msg.sender).call{value: excess}("");
        if (!ok) revert NativeRefundFailed();
    }

    /// @dev revert if `block.timestamp` is past `deadline`. Checked at the top of every state-
    ///      mutating entry (B.1), before any session state is written.
    function _enforceDeadline(uint256 deadline) private view {
        if (block.timestamp > deadline) revert TransactionTooOld(deadline, block.timestamp);
    }

    /// @dev revert if the swap's output (the positive delta — the other side is what the caller
    ///      owes) is below `minOut`. A zero `minOut` disables the check (documented opt-out: the
    ///      caller explicitly accepts any price; a front-end should always pass a real floor).
    ///      Used for both the single-pool path (positive side == output currency) and the multi-
    ///      hop path (`d` is the last hop's delta, so its positive side is the final output).
    function _enforceMinOut(BalanceDelta d, uint256 minOut) private pure {
        if (minOut == 0) return;
        int256 a0 = amount0(d);
        int256 out = a0 > 0 ? a0 : amount1(d);
        if (out < 0 || uint256(out) < minOut) revert InsufficientOutputAmount(out, minOut);
    }

    /// @dev enforce `bounds` against the caller's net delta: negative (caller pays) sides must be
    ///      at or below the Max fields, positive (caller receives) sides at or above the Min
    ///      fields. Runs inside the unlock callback, before settlement, so a breach reverts the
    ///      whole session.
    function _enforceBounds(BalanceDelta d, LiquidityBounds memory bounds) private pure {
        int256 a0 = amount0(d);
        int256 a1 = amount1(d);
        if (a0 < 0 && uint256(-a0) > bounds.amount0Max) revert AmountAboveMax(0, uint256(-a0), bounds.amount0Max);
        if (a1 < 0 && uint256(-a1) > bounds.amount1Max) revert AmountAboveMax(1, uint256(-a1), bounds.amount1Max);
        if (a0 > 0 && uint256(a0) < bounds.amount0Min) revert AmountBelowMin(0, uint256(a0), bounds.amount0Min);
        if (a1 > 0 && uint256(a1) < bounds.amount1Min) revert AmountBelowMin(1, uint256(a1), bounds.amount1Min);
    }
}
