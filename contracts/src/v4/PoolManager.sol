// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {FullMath} from "../libraries/FullMath.sol";
import {LiquidityMath} from "../libraries/LiquidityMath.sol";
import {Position} from "../libraries/Position.sol";
import {SafeCast} from "../libraries/SafeCast.sol";
import {SqrtPriceMath} from "../libraries/SqrtPriceMath.sol";
import {SwapMath} from "../libraries/SwapMath.sol";
import {SwapLogic} from "./libraries/SwapLogic.sol";
import {Slot0, Pool} from "./libraries/PoolState.sol";
import {Tick} from "../libraries/Tick.sol";
import {TickBitmap} from "../libraries/TickBitmap.sol";
import {TickMath} from "../libraries/TickMath.sol";
import {currency} from "./types/Currency.sol";
import {BalanceDelta, toBalanceDelta, amount0, amount1} from "./types/BalanceDelta.sol";
import {PoolKey, PoolId, toPoolId} from "./types/PoolKey.sol";
import {Hooks} from "./libraries/Hooks.sol";
import {IHooks} from "./interfaces/IHooks.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @notice Called back inside `unlock` so the caller can settle/take against accumulated deltas.
interface IUnlockCallback {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}



struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified; // > 0: exact input, < 0: exact output
    uint160 sqrtPriceLimitX96;
}

struct ModifyLiquidityParams {
    int24 tickLower;
    int24 tickUpper;
    int256 liquidityDelta;
}

/// @title PoolManager: a singleton that holds every Swapex pool and defers token movement to the
///        end of an `unlock` session via flash accounting.
/// @dev Per-pool concentrated-liquidity math is reused verbatim from the V3 libraries. Instead of
///      moving tokens on every operation, each swap/liquidity change accumulates a signed
///      delta, kept **per account and per currency**, in transient storage (what the pool owes
///      that account, positive, or what the account owes the pool, negative). Inside the unlock
///      callback an account `settle`s its negative deltas (paying tokens in) and `take`s its
///      positive deltas (withdrawing tokens); it can touch only its own deltas. When the session
///      closes every account's delta must be exactly zero, so multi-hop swaps across pools net out
///      and move no tokens until the end, and a hook or any other contract that re-enters the
///      manager cannot move the session locker's funds. Native currency (address(0)) is a
///      first-class currency: settle accepts ETH via msg.value and take sends it.
/// @dev Ownership follows OpenZeppelin's two-step transfer (F.1): protocol-fee admin
///      (`setProtocolFee`, `collectProtocol`) is `onlyOwner`, the owner is set at construction,
///      and a real deployment hands it to a TimelockController (docs/DECISIONS.md D29) so admin
///      actions are delayed and cancellable.
contract PoolManager is Ownable2Step {
    using Tick for mapping(int24 => Tick.Info);
    using TickBitmap for mapping(int16 => uint256);
    using Position for mapping(bytes32 => Position.Info);
    using Position for Position.Info;
    using SafeCast for uint256;

    // ---------------------------------------------------------------- errors
    error AlreadyUnlocked();
    error NotUnlocked();
    error CurrencyNotSorted();
    error InvalidTickSpacing();
    error PoolAlreadyInitialized();
    error PoolNotInitialized();
    error ZeroAmount();
    error InvalidPriceLimit();
    error TicksNotOrdered();
    error TickBelowMin();
    error TickAboveMax();
    error TickSpacingMismatch();
    error UnsettledDelta();
    error DeltaNotNegative();
    error InsufficientTake();
    error NativeSettleAmountMismatch();
    error UnexpectedEth();
    error LiquidityDeltaOverflow();
    error InvalidProtocolFee();
    error NoLiquidityToAccrue();
    error InsufficientClaim();
    error InvalidHookDelta();
    error TransferShortfall();
    error InvalidLpFee();

    // ---------------------------------------------------------------- events
    event Initialize(PoolId indexed id, int24 tick);
    event Swap(PoolId indexed id, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick);
    event ModifyLiquidity(PoolId indexed id, address indexed owner, int24 tickLower, int24 tickUpper, int256 liquidityDelta, int256 amount0, int256 amount1);
    event SetProtocolFee(PoolId indexed id, uint24 protocolFee);
    event CollectProtocol(PoolId indexed id, address indexed recipient, uint128 amount0, uint128 amount1);
    event ClaimMove(currency indexed id, address indexed from, address indexed to, uint256 amount);

    // ---------------------------------------------------------------- pool state


    mapping(PoolId => Pool) public pools;
    /// @notice tokens actually held by the manager per currency (mirrors its ERC-20 balance).
    mapping(currency => uint256) public reserves;

    /// @dev protocolFee is expressed in 1e6 units; 1e6 means the protocol takes the entire lp fee.
    uint24 public constant PROTOCOL_FEE_DENOMINATOR = 1_000_000;

    constructor(address initialOwner) Ownable(initialOwner) {}

    // ---------------------------------------------------------------- flash accounting
    /// @dev Deltas are kept **per account** (the address that performed the operation or settlement),
    ///      not per currency. A hook, a native-ETH recipient or any other contract that receives control
    ///      while a session is open therefore only ever sees and moves its *own* delta; it can never
    ///      `take` what the session's locker is owed or `settle` away what it owes. The session closes
    ///      only when the number of non-zero (account, currency) deltas is zero.
    /// @dev solc 0.8.26 supports only transient *value* types, not mappings, so each delta is addressed
    ///      directly in transient storage via tstore/tload at a keccak-derived slot. Transient storage
    ///      is cleared automatically at transaction end.
    bytes32 private constant _DELTA_SALT = keccak256("swapex.v4.accountCurrencyDelta");
    /// @dev transient slot 0 holds the current locker (the `unlock` caller); zero means locked.
    uint256 private constant _LOCKER_SLOT = 0;
    /// @dev transient slot 1 counts the (account, currency) pairs whose delta is currently non-zero.
    uint256 private constant _NONZERO_COUNT_SLOT = 1;

    function _deltaSlot(address account, currency c) private pure returns (uint256 slot) {
        // the salt prevents cross-contract slot clashes
        slot = uint256(keccak256(abi.encode(account, c, _DELTA_SALT)));
    }

    function _getDelta(address account, currency c) private view returns (int256 v) {
        uint256 slot = _deltaSlot(account, c);
        assembly ("memory-safe") {
            v := tload(slot)
        }
    }

    /// @dev write `next` over `prev` (the caller passes the value it already read) and keep the
    ///      non-zero counter in step.
    function _writeDelta(address account, currency c, int256 prev, int256 next) private {
        if (prev == next) return;
        uint256 slot = _deltaSlot(account, c);
        assembly ("memory-safe") {
            tstore(slot, next)
        }
        if (prev == 0) _setNonzeroCount(_nonzeroCount() + 1);
        else if (next == 0) _setNonzeroCount(_nonzeroCount() - 1);
    }

    /// @dev accumulate `delta` (caller-owes convention) into `account`'s delta for `c`.
    function _accountDelta(address account, currency c, int256 delta) private {
        if (delta == 0) return;
        int256 prev = _getDelta(account, c);
        _writeDelta(account, c, prev, prev + delta);
    }

    function _nonzeroCount() private view returns (uint256 n) {
        uint256 slot = _NONZERO_COUNT_SLOT;
        assembly ("memory-safe") {
            n := tload(slot)
        }
    }

    function _setNonzeroCount(uint256 n) private {
        uint256 slot = _NONZERO_COUNT_SLOT;
        assembly ("memory-safe") {
            tstore(slot, n)
        }
    }

    function _locker() private view returns (address a) {
        uint256 slot = _LOCKER_SLOT;
        assembly ("memory-safe") {
            a := tload(slot)
        }
    }

    function _setLocker(address a) private {
        uint256 slot = _LOCKER_SLOT;
        assembly ("memory-safe") {
            tstore(slot, a)
        }
    }

    modifier onlyUnlocked() {
        if (_locker() == address(0)) revert NotUnlocked();
        _;
    }

    // ---------------------------------------------------------------- unlock session
    /// @notice open a flash-accounting session; `msg.sender` must implement IUnlockCallback.
    /// @dev reverts unless every account's delta for every currency netted to zero before the session
    ///      closes (including deltas created by hooks or other contracts that re-entered the manager).
    function unlock(bytes calldata data) external returns (bytes memory result) {
        if (_locker() != address(0)) revert AlreadyUnlocked();
        _setLocker(msg.sender);
        result = IUnlockCallback(msg.sender).unlockCallback(data);
        if (_nonzeroCount() != 0) revert UnsettledDelta();
        _setLocker(address(0));
    }

    /// @dev burn `amount` of a hook's ERC-6909 claims to fund its donation. The claims are backed
    ///      1:1 by tokens in `reserves`, so burning them frees real tokens to the pool.
    function _burnHookClaim(currency c, address hook, uint256 amount) private {
        if (claims[c][hook] < amount) revert InsufficientClaim();
        claims[c][hook] -= amount;
    }

    // ---------------------------------------------------------------- setup
    function initialize(PoolKey memory key, uint160 sqrtPriceX96) external returns (int24 tick) {
        return _initialize(key, sqrtPriceX96, new bytes(0));
    }

    function initialize(PoolKey memory key, uint160 sqrtPriceX96, bytes memory hookData)
        external
        returns (int24 tick)
    {
        return _initialize(key, sqrtPriceX96, hookData);
    }

    function _initialize(PoolKey memory key, uint160 sqrtPriceX96, bytes memory hookData)
        private
        returns (int24 tick)
    {
        if (currency.unwrap(key.currency0) >= currency.unwrap(key.currency1)) revert CurrencyNotSorted();
        // spacing is bounded exactly like the V3 factory (keeps `(tick / spacing) * spacing` inside int24)
        if (key.tickSpacing <= 0 || key.tickSpacing >= 16384) revert InvalidTickSpacing();
        // a static fee must leave room for the swap input (`1e6 - fee` is used as a divisor/multiplier)
        if (key.fee >= 1_000_000) revert InvalidLpFee();
        address h = key.hooks;
        if (h != address(0)) Hooks.validate(h);
        PoolId id = key.toPoolId();
        Pool storage pool = pools[id];
        if (pool.slot0.sqrtPriceX96 != 0) revert PoolAlreadyInitialized();

        if (h != address(0) && Hooks.hasPermission(h, Hooks.BEFORE_INITIALIZE_FLAG)) {
            IHooks(h).beforeInitialize(key, sqrtPriceX96, hookData);
        }
        tick = TickMath.getTickAtSqrtRatio(sqrtPriceX96);
        pool.slot0 = Slot0({sqrtPriceX96: sqrtPriceX96, tick: tick, protocolFee: 0});
        if (h != address(0) && Hooks.hasPermission(h, Hooks.AFTER_INITIALIZE_FLAG)) {
            IHooks(h).afterInitialize(key, sqrtPriceX96, tick, hookData);
        }
        emit Initialize(id, tick);
    }

    // ---------------------------------------------------------------- protocol fee
    /// @notice set the protocol's share (in 1e6) of the lp fee for a pool. Owner-only.
    function setProtocolFee(PoolKey memory key, uint24 newProtocolFee) external onlyOwner {
        if (newProtocolFee > PROTOCOL_FEE_DENOMINATOR) revert InvalidProtocolFee();
        PoolId id = key.toPoolId();
        Pool storage pool = pools[id];
        if (pool.slot0.sqrtPriceX96 == 0) revert PoolNotInitialized();
        pool.slot0.protocolFee = newProtocolFee;
        emit SetProtocolFee(id, newProtocolFee);
    }

    /// @notice withdraw all accrued protocol fees for a pool to `recipient`. Owner-only. Not part
    ///         of an unlock session: protocol fees are already-settled tokens the manager holds.
    function collectProtocol(PoolKey memory key, address recipient)
        external
        onlyOwner
        returns (uint128 amount0, uint128 amount1)
    {
        PoolId id = key.toPoolId();
        Pool storage pool = pools[id];
        amount0 = pool.protocolFees0;
        amount1 = pool.protocolFees1;
        if (amount0 == 0 && amount1 == 0) return (0, 0);
        pool.protocolFees0 = 0;
        pool.protocolFees1 = 0;
        reserves[key.currency0] -= amount0;
        reserves[key.currency1] -= amount1;
        if (amount0 > 0) key.currency0.transfer(recipient, amount0);
        if (amount1 > 0) key.currency1.transfer(recipient, amount1);
        emit CollectProtocol(id, recipient, amount0, amount1);
    }

    /// @notice accrued (not-yet-collected) protocol fees for a pool.
    function getProtocolFees(PoolKey memory key) external view returns (uint128 amount0, uint128 amount1) {
        Pool storage pool = pools[key.toPoolId()];
        return (pool.protocolFees0, pool.protocolFees1);
    }

    /// @notice the current protocol fee share (in 1e6) for a pool.
    function getProtocolFee(PoolKey memory key) external view returns (uint24) {
        return pools[key.toPoolId()].slot0.protocolFee;
    }

    // ---------------------------------------------------------------- swap


    /// @notice swap within one pool; the resulting delta is accumulated into flash accounting.
    /// @return callerDelta caller-owes convention (positive = pool owes caller).
    function swap(PoolKey memory key, SwapParams memory params) external returns (BalanceDelta callerDelta) {
        return _swap(key, params, new bytes(0));
    }

    function swap(PoolKey memory key, SwapParams memory params, bytes memory hookData)
        external
        returns (BalanceDelta callerDelta)
    {
        return _swap(key, params, hookData);
    }

    function _swap(PoolKey memory key, SwapParams memory params, bytes memory hookData)
        private
        onlyUnlocked
        returns (BalanceDelta callerDelta)
    {
        if (params.amountSpecified == 0) revert ZeroAmount();
        PoolId id = key.toPoolId();
        Pool storage pool = pools[id];
        if (pool.slot0.sqrtPriceX96 == 0) revert PoolNotInitialized();

        // resolve the effective lp fee (a dynamic-fee hook overrides key.fee) and run beforeSwap
        address h = key.hooks;
        uint24 lpFee = key.fee;
        if (h != address(0)) {
            if (Hooks.hasPermission(h, Hooks.BEFORE_SWAP_FLAG)) {
                IHooks(h).beforeSwap(key, params, hookData);
            }
            if (Hooks.hasPermission(h, Hooks.DYNAMIC_FEE_FLAG)) {
                lpFee = IHooks(h).getSwapFee(key);
                if (lpFee >= 1_000_000) revert InvalidLpFee();
            }
        }

        SwapLogic.Result memory r = SwapLogic.run(pool, key.tickSpacing, params.zeroForOne, params.amountSpecified, params.sqrtPriceLimitX96, lpFee);

        // flip to the caller-owes convention used by currencyDelta (positive = pool owes caller)
        callerDelta = toBalanceDelta(-r.amount0Raw, -r.amount1Raw);
        _accountDelta(msg.sender, key.currency0, -r.amount0Raw);
        _accountDelta(msg.sender, key.currency1, -r.amount1Raw);

        if (h != address(0)) {
            if (Hooks.hasPermission(h, Hooks.BEFORE_SWAP_DELTA_FLAG)) {
                callerDelta = _applyHookSwapDelta(key, params, hookData, callerDelta);
            }
            if (Hooks.hasPermission(h, Hooks.AFTER_SWAP_FLAG)) {
                IHooks(h).afterSwap(key, params, callerDelta, hookData);
            }
        }

        emit Swap(id, -r.amount0Raw, -r.amount1Raw, r.sqrtPriceX96, r.liquidity, r.tick);
    }

    /// @dev opt-in hook donation (D21): a hook flagged BEFORE_SWAP_DELTA may return a non-positive
    ///      delta it donates to the pool, funded by burning its ERC-6909 claims. The donation is
    ///      credited to the caller, who therefore settles less. A positive component would mint free
    ///      claims and is rejected. The hook's claims are already backed by tokens in `reserves`, so
    ///      burning them frees real tokens to the pool and keeps net-zero + solvency intact.
    function _applyHookSwapDelta(
        PoolKey memory key,
        SwapParams memory params,
        bytes memory hookData,
        BalanceDelta callerDelta
    ) private returns (BalanceDelta) {
        address h = key.hooks;
        BalanceDelta hd = IHooks(h).beforeSwapDelta(key, params, hookData);
        int256 hd0 = hd.amount0();
        int256 hd1 = hd.amount1();
        if (hd0 > 0 || hd1 > 0) revert InvalidHookDelta();
        if (hd0 < 0) _burnHookClaim(key.currency0, h, uint256(-hd0));
        if (hd1 < 0) _burnHookClaim(key.currency1, h, uint256(-hd1));
        // credit the caller: they owe less because the hook donated (negate the hook's delta)
        _accountDelta(msg.sender, key.currency0, -hd0);
        _accountDelta(msg.sender, key.currency1, -hd1);
        return toBalanceDelta(callerDelta.amount0() - hd0, callerDelta.amount1() - hd1);
    }

    // ---------------------------------------------------------------- donate
    /// @notice donate `amount0`/`amount1` directly to a pool's in-range LPs by crediting them to
    ///         the fee growth (they are paid out on the next liquidity-remove/claim, like fees).
    ///         Donations go to LPs, not the protocol. Must be called inside an unlock session: the
    ///         donor's deltas go negative (they owe the manager) and are settled as usual.
    function donate(PoolKey memory key, uint256 amount0, uint256 amount1)
        external
        onlyUnlocked
        returns (BalanceDelta callerDelta)
    {
        if (amount0 == 0 && amount1 == 0) revert ZeroAmount();
        PoolId id = key.toPoolId();
        Pool storage pool = pools[id];
        if (pool.slot0.sqrtPriceX96 == 0) revert PoolNotInitialized();
        // a donation is credited as extra fees per unit of in-range liquidity; with no liquidity
        // there is nobody to accrue it to (and the fee-growth division would be by zero)
        if (pool.liquidity == 0) revert NoLiquidityToAccrue();

        if (amount0 > 0) {
            unchecked {
                pool.feeGrowthGlobal0X128 += FullMath.mulDiv(amount0, 1 << 128, pool.liquidity);
            }
        }
        if (amount1 > 0) {
            unchecked {
                pool.feeGrowthGlobal1X128 += FullMath.mulDiv(amount1, 1 << 128, pool.liquidity);
            }
        }

        // the donor owes the manager both donated amounts (caller-owes: negative = caller owes pool)
        callerDelta = toBalanceDelta(-amount0.toInt256(), -amount1.toInt256());
        _accountDelta(msg.sender, key.currency0, callerDelta.amount0());
        _accountDelta(msg.sender, key.currency1, callerDelta.amount1());
    }

    // ---------------------------------------------------------------- liquidity
    function modifyLiquidity(PoolKey memory key, ModifyLiquidityParams memory params)
        external
        returns (BalanceDelta callerDelta, BalanceDelta feesAccrued)
    {
        return _modifyLiquidity(key, params, new bytes(0));
    }

    function modifyLiquidity(PoolKey memory key, ModifyLiquidityParams memory params, bytes memory hookData)
        external
        returns (BalanceDelta callerDelta, BalanceDelta feesAccrued)
    {
        return _modifyLiquidity(key, params, hookData);
    }

    function _modifyLiquidity(PoolKey memory key, ModifyLiquidityParams memory params, bytes memory hookData)
        private
        onlyUnlocked
        returns (BalanceDelta callerDelta, BalanceDelta feesAccrued)
    {
        PoolId id = key.toPoolId();
        Pool storage pool = pools[id];
        if (pool.slot0.sqrtPriceX96 == 0) revert PoolNotInitialized();
        _checkTicks(params.tickLower, params.tickUpper, key.tickSpacing);

        address h = key.hooks;
        bool isAdd = params.liquidityDelta > 0;
        bool isRemove = params.liquidityDelta < 0;
        if (h != address(0)) {
            if (isAdd && Hooks.hasPermission(h, Hooks.BEFORE_ADD_LIQUIDITY_FLAG)) {
                IHooks(h).beforeAddLiquidity(key, params, hookData);
            } else if (isRemove && Hooks.hasPermission(h, Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG)) {
                IHooks(h).beforeRemoveLiquidity(key, params, hookData);
            }
        }

        Slot0 memory _slot0 = pool.slot0;

        int128 ld = _toInt128(params.liquidityDelta);
        (int256 fees0, int256 fees1) = _updatePosition(pool, msg.sender, key, params, ld, _slot0.tick);

        // principal token amounts for the liquidity change (positive = caller owes, e.g. a mint)
        int256 principal0 = 0;
        int256 principal1 = 0;
        if (ld != 0) {
            if (_slot0.tick < params.tickLower) {
                principal0 = SqrtPriceMath.getAmount0Delta(
                    TickMath.getSqrtRatioAtTick(params.tickLower), TickMath.getSqrtRatioAtTick(params.tickUpper), ld
                );
            } else if (_slot0.tick < params.tickUpper) {
                principal0 =
                    SqrtPriceMath.getAmount0Delta(_slot0.sqrtPriceX96, TickMath.getSqrtRatioAtTick(params.tickUpper), ld);
                principal1 =
                    SqrtPriceMath.getAmount1Delta(TickMath.getSqrtRatioAtTick(params.tickLower), _slot0.sqrtPriceX96, ld);
                pool.liquidity = LiquidityMath.addDelta(pool.liquidity, ld);
            } else {
                principal1 = SqrtPriceMath.getAmount1Delta(
                    TickMath.getSqrtRatioAtTick(params.tickLower), TickMath.getSqrtRatioAtTick(params.tickUpper), ld
                );
            }
        }

        // caller-owes convention: negate principal (mint => caller owes => negative), fees are owed to caller
        callerDelta = toBalanceDelta(-principal0, -principal1);
        feesAccrued = toBalanceDelta(fees0, fees1);
        _accountDelta(msg.sender, key.currency0, -principal0 + fees0);
        _accountDelta(msg.sender, key.currency1, -principal1 + fees1);

        if (h != address(0)) {
            if (isAdd && Hooks.hasPermission(h, Hooks.AFTER_ADD_LIQUIDITY_FLAG)) {
                IHooks(h).afterAddLiquidity(key, params, callerDelta, hookData);
            } else if (isRemove && Hooks.hasPermission(h, Hooks.AFTER_REMOVE_LIQUIDITY_FLAG)) {
                IHooks(h).afterRemoveLiquidity(key, params, callerDelta, hookData);
            }
        }

        emit ModifyLiquidity(id, msg.sender, params.tickLower, params.tickUpper, params.liquidityDelta, -principal0, -principal1);
    }

    function _updatePosition(
        Pool storage pool,
        address positionOwner,
        PoolKey memory key,
        ModifyLiquidityParams memory params,
        int128 ld,
        int24 tick
    ) private returns (int256 fees0, int256 fees1) {
        Position.Info storage position = pool.positions.get(positionOwner, params.tickLower, params.tickUpper);
        uint256 fg0 = pool.feeGrowthGlobal0X128;
        uint256 fg1 = pool.feeGrowthGlobal1X128;

        // the tick crossing lives in its own frame: its `ticks.update` inlines are the deepest
        // part of this contract, and keeping them out of ours is what keeps the stack legal
        (bool flippedLower, bool flippedUpper) =
            ld == 0 ? (false, false) : _crossTicks(pool, key, params, ld, tick, fg0, fg1);

        (uint256 inside0, uint256 inside1) = pool.ticks.getFeeGrowthInside(params.tickLower, params.tickUpper, tick, fg0, fg1);

        // capture the fees this update credits to the position (tokensOwed delta)
        uint128 owed0Before = position.tokensOwed0;
        uint128 owed1Before = position.tokensOwed1;
        position.update(ld, inside0, inside1);
        // tokensOwed only ever grows here (fees are added, never subtracted), so the delta is a
        // non-negative uint128; widen through uint256 before the signed cast
        fees0 = int256(uint256(position.tokensOwed0 - owed0Before));
        fees1 = int256(uint256(position.tokensOwed1 - owed1Before));

        // a removed boundary tick no longer needs its storage. This must happen *after*
        // `getFeeGrowthInside` above: clearing zeroes the tick's `feeGrowthOutside`, which that
        // read depends on.
        if (ld < 0) {
            if (flippedLower) pool.ticks.clear(params.tickLower);
            if (flippedUpper) pool.ticks.clear(params.tickUpper);
        }
    }

    /// @dev apply `ld` to both boundary ticks and keep the bitmap in step. Returns which of them
    ///      flipped (liquidity gross crossed zero) so the caller can reclaim cleared ticks.
    function _crossTicks(
        Pool storage pool,
        PoolKey memory key,
        ModifyLiquidityParams memory params,
        int128 ld,
        int24 tick,
        uint256 fg0,
        uint256 fg1
    ) private returns (bool flippedLower, bool flippedUpper) {
        uint128 maxLiqPerTick = Tick.tickSpacingToMaxLiquidityPerTick(key.tickSpacing);
        flippedLower = pool.ticks.update(params.tickLower, tick, ld, fg0, fg1, false, maxLiqPerTick);
        flippedUpper = pool.ticks.update(params.tickUpper, tick, ld, fg0, fg1, true, maxLiqPerTick);
        if (flippedLower) pool.tickBitmap.flipTick(params.tickLower, key.tickSpacing);
        if (flippedUpper) pool.tickBitmap.flipTick(params.tickUpper, key.tickSpacing);
    }

    function _checkTicks(int24 tickLower, int24 tickUpper, int24 tickSpacing) private pure {
        if (tickLower >= tickUpper) revert TicksNotOrdered();
        if (tickLower < TickMath.MIN_TICK) revert TickBelowMin();
        if (tickUpper > TickMath.MAX_TICK) revert TickAboveMax();
        if (tickLower % tickSpacing != 0 || tickUpper % tickSpacing != 0) revert TickSpacingMismatch();
    }

    function _toInt128(int256 x) private pure returns (int128) {
        if (x < type(int128).min || x > type(int128).max) revert LiquidityDeltaOverflow();
        return int128(x);
    }

    // ---------------------------------------------------------------- settlement
    /// @dev pull `amount` of ERC-20 `c` from `from` and require that the manager's balance really grew by
    ///      at least `amount`. `reserves` is only ever credited with tokens that actually arrived, so a
    ///      fee-on-transfer (or otherwise lying) token can make a settlement revert but can never make the
    ///      manager insolvent.
    function _pull(currency c, address from, uint256 amount) private {
        uint256 balanceBefore = c.balanceOf();
        c.transferFrom(from, address(this), amount);
        if (c.balanceOf() < balanceBefore + amount) revert TransferShortfall();
    }

    /// @notice pay the amount owed for `c` and clear the delta. For an ERC-20 this pulls the
    ///         tokens from the caller via `transferFrom`; for the native currency the caller must
    ///         send exactly the owed amount as `msg.value` with this call (the ETH is already in
    ///         the manager when the body runs).
    function settle(currency c) external payable onlyUnlocked returns (uint256 amount) {
        int256 delta = _getDelta(msg.sender, c);
        if (delta >= 0) revert DeltaNotNegative();
        amount = uint256(-delta);
        if (c.isNative()) {
            if (msg.value != amount) revert NativeSettleAmountMismatch();
        } else {
            if (msg.value != 0) revert UnexpectedEth();
            _pull(c, msg.sender, amount);
        }
        reserves[c] += amount;
        _writeDelta(msg.sender, c, delta, 0);
    }

    /// @notice withdraw `amount` of `c` that the pool owes the caller; reduces the positive delta.
    ///         Sends ETH when `c` is the native currency. Effects are applied before the transfer
    ///         (checks-effects-interactions), so a re-entering recipient sees the updated state.
    function take(currency c, address to, uint256 amount) external onlyUnlocked {
        int256 delta = _getDelta(msg.sender, c);
        if (delta < int256(amount)) revert InsufficientTake();
        reserves[c] -= amount;
        unchecked {
            // delta >= amount > 0 was checked above, so the subtraction cannot go negative
            _writeDelta(msg.sender, c, delta, delta - int256(amount));
        }
        c.transfer(to, amount);
    }

    // ---------------------------------------------------------------- claims (ERC-6909)
    /// @notice ERC-6909 claim ledger: `claims[currency][account]` is `account`'s ownership of the
    ///         manager's held `currency`. Every claim is backed 1:1 by tokens the manager already
    ///         holds (tracked in `reserves`), so it can always be redeemed via `burn`. Solvency
    ///         invariant `reserves[c] >= claims[c] + (positive deltas for c)` is maintained:
    ///         `mint`/`burn` move real tokens and reserves together; `settleViaClaim` turns a
    ///         negative delta into a claim burn and `takeViaClaim` turns a positive delta into a
    ///         claim mint — neither moves tokens, so reserves is unchanged and still covers the
    ///         reclassified obligation.
    mapping(currency => mapping(address => uint256)) public claims;

    /// @notice deposit `amount` of `c` (pulled from the caller) and mint that many claims to `to`.
    ///         Standalone (not part of an unlock): it only moves the caller's tokens for claims.
    function mint(currency c, address to, uint256 amount) external {
        _pull(c, msg.sender, amount);
        reserves[c] += amount;
        claims[c][to] += amount;
        emit ClaimMove(c, address(0), to, amount);
    }

    /// @notice redeem `amount` of the caller's claims for real tokens sent to `to`.
    function burn(currency c, address to, uint256 amount) external {
        if (claims[c][msg.sender] < amount) revert InsufficientClaim();
        claims[c][msg.sender] -= amount;
        reserves[c] -= amount;
        c.transfer(to, amount);
        emit ClaimMove(c, msg.sender, address(0), amount);
    }

    /// @notice within an unlock: cover the caller's negative delta for `c` by burning their claims
    ///         (the tokens already sit in the manager backing those claims). No token transfer.
    function settleViaClaim(currency c) external onlyUnlocked returns (uint256 amount) {
        int256 delta = _getDelta(msg.sender, c);
        if (delta >= 0) revert DeltaNotNegative();
        amount = uint256(-delta);
        if (claims[c][msg.sender] < amount) revert InsufficientClaim();
        claims[c][msg.sender] -= amount;
        _writeDelta(msg.sender, c, delta, 0);
        emit ClaimMove(c, msg.sender, address(0), amount);
    }

    /// @notice within an unlock: cover `amount` of the caller's positive delta for `c` by minting
    ///         claims to `to` instead of transferring tokens out. No token transfer.
    function takeViaClaim(currency c, address to, uint256 amount) external onlyUnlocked {
        int256 delta = _getDelta(msg.sender, c);
        if (delta < int256(amount)) revert InsufficientTake();
        claims[c][to] += amount;
        unchecked {
            // delta >= amount > 0 was checked above, so the subtraction cannot go negative
            _writeDelta(msg.sender, c, delta, delta - int256(amount));
        }
        emit ClaimMove(c, address(0), to, amount);
    }

    // ---------------------------------------------------------------- views
    function getSlot0(PoolKey memory key) external view returns (uint160 sqrtPriceX96, int24 tick) {
        Pool storage pool = pools[key.toPoolId()];
        return (pool.slot0.sqrtPriceX96, pool.slot0.tick);
    }

    function getLiquidity(PoolKey memory key) external view returns (uint128) {
        return pools[key.toPoolId()].liquidity;
    }

    function getFeeGrowthGlobals(PoolKey memory key) external view returns (uint256 feeGrowthGlobal0X128, uint256 feeGrowthGlobal1X128) {
        Pool storage pool = pools[key.toPoolId()];
        return (pool.feeGrowthGlobal0X128, pool.feeGrowthGlobal1X128);
    }

    /// @notice the fee growth *inside* `[tickLower, tickUpper]` as of the pool's current tick —
    ///         the same value `_updatePosition` checkpoints a position against. Exposed so
    ///         periphery that merges many LPs into one on-chain position slot (the Router) can
    ///         split the slot's fees back out to the individual beneficiaries (D41).
    /// @dev    reads pool state only; safe to call at any time, including outside an unlock.
    function getFeeGrowthInside(PoolKey memory key, int24 tickLower, int24 tickUpper)
        external
        view
        returns (uint256 feeGrowthInside0X128, uint256 feeGrowthInside1X128)
    {
        Pool storage pool = pools[key.toPoolId()];
        if (pool.slot0.sqrtPriceX96 == 0) revert PoolNotInitialized();
        return pool.ticks.getFeeGrowthInside(
            tickLower, tickUpper, pool.slot0.tick, pool.feeGrowthGlobal0X128, pool.feeGrowthGlobal1X128
        );
    }

    /// @notice the open delta `account` holds for `c` in the current session (caller-owes convention).
    function getCurrencyDelta(address account, currency c) external view returns (int256) {
        return _getDelta(account, c);
    }
}
