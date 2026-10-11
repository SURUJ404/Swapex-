// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {FullMath} from "../libraries/FullMath.sol";
import {LiquidityMath} from "../libraries/LiquidityMath.sol";
import {Position} from "../libraries/Position.sol";
import {SafeCast} from "../libraries/SafeCast.sol";
import {SqrtPriceMath} from "../libraries/SqrtPriceMath.sol";
import {SwapMath} from "../libraries/SwapMath.sol";
import {Tick} from "../libraries/Tick.sol";
import {TickBitmap} from "../libraries/TickBitmap.sol";
import {TickMath} from "../libraries/TickMath.sol";
import {currency} from "./types/Currency.sol";
import {BalanceDelta, toBalanceDelta, amount0, amount1} from "./types/BalanceDelta.sol";
import {PoolKey, PoolId, toPoolId} from "./types/PoolKey.sol";
import {Hooks} from "./libraries/Hooks.sol";
import {IHooks} from "./interfaces/IHooks.sol";

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
///      per-currency delta (what the pool owes the caller, positive, or the caller owes the pool,
///      negative) in transient storage. Inside the unlock callback the caller `settle`s negative
///      deltas (paying tokens in) and `take`s positive deltas (withdrawing tokens). When the
///      session closes every currency delta must be exactly zero, so multi-hop swaps across pools
///      net out and move no tokens until the end. Native currency (address(0)) is a first-class
///      currency: settle accepts ETH via msg.value and take sends it. Hooks and protocol fee are
///      Phase 3 scope.
contract PoolManager {
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

    // ---------------------------------------------------------------- events
    event Initialize(PoolId indexed id, int24 tick);
    event Swap(PoolId indexed id, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick);
    event ModifyLiquidity(PoolId indexed id, address indexed owner, int24 tickLower, int24 tickUpper, int256 liquidityDelta, int256 amount0, int256 amount1);

    // ---------------------------------------------------------------- pool state
    struct Slot0 {
        uint160 sqrtPriceX96;
        int24 tick;
    }

    /// @dev Nested mappings make Pool non-copyable; it lives only in storage keyed by PoolId.
    struct Pool {
        Slot0 slot0;
        uint128 liquidity;
        uint256 feeGrowthGlobal0X128;
        uint256 feeGrowthGlobal1X128;
        mapping(int24 => Tick.Info) ticks;
        mapping(int16 => uint256) tickBitmap;
        mapping(bytes32 => Position.Info) positions;
    }

    mapping(PoolId => Pool) public pools;
    /// @notice tokens actually held by the manager per currency (mirrors its ERC-20 balance).
    mapping(currency => uint256) public reserves;

    // ---------------------------------------------------------------- flash accounting
    /// @dev solc 0.8.26 supports only transient *value* types, not mappings, so the per-currency
    ///      delta is addressed directly in transient storage via tstore/tload at keccak-derived
    ///      slots (one slot per currency). Transient storage is cleared automatically at tx end.
    bytes32 private constant _DELTA_SALT = keccak256("swapex.v4.currencyDelta");
    /// @dev solc 0.8.26 has no high-level `transient` keyword for state variables (added in 0.8.28),
    ///      so the reentrancy lock is also kept in transient storage at a fixed slot.
    uint256 private constant _UNLOCKED_SLOT = 0;
    /// @dev currencies touched this session (persistent only for the end-of-unlock net-zero sweep).
    currency[] private _touched;
    mapping(currency => bool) private _isTouched;

    function _deltaSlot(currency c) private pure returns (uint256 slot) {
        // each currency maps to its own transient slot; the salt prevents cross-contract clashes
        slot = uint256(keccak256(abi.encode(c, _DELTA_SALT)));
    }

    function _getDelta(currency c) private view returns (int256 v) {
        uint256 slot = _deltaSlot(c);
        assembly ("memory-safe") {
            v := tload(slot)
        }
    }

    function _setDelta(currency c, int256 v) private {
        uint256 slot = _deltaSlot(c);
        assembly ("memory-safe") {
            tstore(slot, v)
        }
    }

    function _unlocked() private view returns (bool v) {
        uint256 slot = _UNLOCKED_SLOT;
        assembly ("memory-safe") {
            v := tload(slot)
        }
    }

    function _setUnlocked(bool v) private {
        uint256 slot = _UNLOCKED_SLOT;
        assembly ("memory-safe") {
            tstore(slot, v)
        }
    }

    modifier onlyUnlocked() {
        if (!_unlocked()) revert NotUnlocked();
        _;
    }

    // ---------------------------------------------------------------- unlock session
    /// @notice open a flash-accounting session; `msg.sender` must implement IUnlockCallback.
    /// @dev reverts unless every currency delta netted to zero before the session closes.
    function unlock(bytes calldata data) external returns (bytes memory result) {
        if (_unlocked()) revert AlreadyUnlocked();
        _setUnlocked(true);
        result = IUnlockCallback(msg.sender).unlockCallback(data);

        // flash accounting: every touched currency must have a zero delta before we release
        uint256 n = _touched.length;
        for (uint256 i = 0; i < n; i++) {
            currency c = _touched[i];
            if (_getDelta(c) != 0) revert UnsettledDelta();
            delete _isTouched[c]; // reset the flag for the next session
        }
        delete _touched;
        _setUnlocked(false);
    }

    /// @dev accumulate `delta` (caller-owes convention) for `c`, recording it as touched.
    function _accountDelta(currency c, int256 delta) private {
        if (delta == 0) return;
        _setDelta(c, _getDelta(c) + delta);
        if (!_isTouched[c]) {
            _isTouched[c] = true;
            _touched.push(c);
        }
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
        if (key.tickSpacing <= 0) revert InvalidTickSpacing();
        address h = key.hooks;
        if (h != address(0)) Hooks.validate(h);
        PoolId id = key.toPoolId();
        Pool storage pool = pools[id];
        if (pool.slot0.sqrtPriceX96 != 0) revert PoolAlreadyInitialized();

        if (h != address(0) && Hooks.hasPermission(h, Hooks.BEFORE_INITIALIZE_FLAG)) {
            IHooks(h).beforeInitialize(key, sqrtPriceX96, hookData);
        }
        tick = TickMath.getTickAtSqrtRatio(sqrtPriceX96);
        pool.slot0 = Slot0({sqrtPriceX96: sqrtPriceX96, tick: tick});
        if (h != address(0) && Hooks.hasPermission(h, Hooks.AFTER_INITIALIZE_FLAG)) {
            IHooks(h).afterInitialize(key, sqrtPriceX96, tick, hookData);
        }
        emit Initialize(id, tick);
    }

    // ---------------------------------------------------------------- swap
    struct SwapState {
        int256 amountSpecifiedRemaining;
        int256 amountCalculated;
        uint160 sqrtPriceX96;
        int24 tick;
        uint256 feeGrowthGlobalX128; // growth of the input token
        uint128 liquidity;
    }

    struct StepComputations {
        uint160 sqrtPriceStartX96;
        int24 tickNext;
        bool initialized;
        uint160 sqrtPriceNextX96;
        uint256 amountIn;
        uint256 amountOut;
        uint256 feeAmount;
    }

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
            }
        }

        Slot0 memory slot0Start = pool.slot0;
        bool zeroForOne = params.zeroForOne;
        if (
            zeroForOne
                ? !(params.sqrtPriceLimitX96 < slot0Start.sqrtPriceX96 && params.sqrtPriceLimitX96 > TickMath.MIN_SQRT_RATIO)
                : !(params.sqrtPriceLimitX96 > slot0Start.sqrtPriceX96 && params.sqrtPriceLimitX96 < TickMath.MAX_SQRT_RATIO)
        ) revert InvalidPriceLimit();

        bool exactInput = params.amountSpecified > 0;
        SwapState memory state = SwapState({
            amountSpecifiedRemaining: params.amountSpecified,
            amountCalculated: 0,
            sqrtPriceX96: slot0Start.sqrtPriceX96,
            tick: slot0Start.tick,
            feeGrowthGlobalX128: zeroForOne ? pool.feeGrowthGlobal0X128 : pool.feeGrowthGlobal1X128,
            liquidity: pool.liquidity
        });

        while (state.amountSpecifiedRemaining != 0 && state.sqrtPriceX96 != params.sqrtPriceLimitX96) {
            StepComputations memory step;
            step.sqrtPriceStartX96 = state.sqrtPriceX96;

            (step.tickNext, step.initialized) =
                pool.tickBitmap.nextInitializedTickWithinOneWord(state.tick, key.tickSpacing, zeroForOne);

            // the bitmap does not know the global bounds
            if (step.tickNext < TickMath.MIN_TICK) step.tickNext = TickMath.MIN_TICK;
            else if (step.tickNext > TickMath.MAX_TICK) step.tickNext = TickMath.MAX_TICK;

            step.sqrtPriceNextX96 = TickMath.getSqrtRatioAtTick(step.tickNext);

            (state.sqrtPriceX96, step.amountIn, step.amountOut, step.feeAmount) = SwapMath.computeSwapStep(
                state.sqrtPriceX96,
                (zeroForOne ? step.sqrtPriceNextX96 < params.sqrtPriceLimitX96 : step.sqrtPriceNextX96 > params.sqrtPriceLimitX96)
                    ? params.sqrtPriceLimitX96
                    : step.sqrtPriceNextX96,
                state.liquidity,
                state.amountSpecifiedRemaining,
                lpFee
            );

            if (exactInput) {
                state.amountSpecifiedRemaining -= (step.amountIn + step.feeAmount).toInt256();
                state.amountCalculated -= step.amountOut.toInt256();
            } else {
                state.amountSpecifiedRemaining += step.amountOut.toInt256();
                state.amountCalculated += (step.amountIn + step.feeAmount).toInt256();
            }

            // fees only accrue to in-range liquidity; wrap-around is intended
            if (state.liquidity > 0) {
                unchecked {
                    state.feeGrowthGlobalX128 += FullMath.mulDiv(step.feeAmount, 1 << 128, state.liquidity);
                }
            }

            if (state.sqrtPriceX96 == step.sqrtPriceNextX96) {
                // reached the next tick: cross it if it is initialised
                if (step.initialized) {
                    int128 liquidityNet = pool.ticks.cross(
                        step.tickNext,
                        zeroForOne ? state.feeGrowthGlobalX128 : pool.feeGrowthGlobal0X128,
                        zeroForOne ? pool.feeGrowthGlobal1X128 : state.feeGrowthGlobalX128
                    );
                    // moving left removes what moving right would add
                    if (zeroForOne) liquidityNet = -liquidityNet;
                    state.liquidity = LiquidityMath.addDelta(state.liquidity, liquidityNet);
                }
                state.tick = zeroForOne ? step.tickNext - 1 : step.tickNext;
            } else if (state.sqrtPriceX96 != step.sqrtPriceStartX96) {
                // price moved inside the range: recompute the tick
                state.tick = TickMath.getTickAtSqrtRatio(state.sqrtPriceX96);
            }
        }

        // ---- effects
        pool.slot0.sqrtPriceX96 = state.sqrtPriceX96;
        if (state.tick != slot0Start.tick) pool.slot0.tick = state.tick;
        if (pool.liquidity != state.liquidity) pool.liquidity = state.liquidity;
        if (zeroForOne) pool.feeGrowthGlobal0X128 = state.feeGrowthGlobalX128;
        else pool.feeGrowthGlobal1X128 = state.feeGrowthGlobalX128;

        // V3-style amounts: positive = caller owes the pool, negative = pool owes the caller
        (int256 amount0Raw, int256 amount1Raw) = zeroForOne == exactInput
            ? (params.amountSpecified - state.amountSpecifiedRemaining, state.amountCalculated)
            : (state.amountCalculated, params.amountSpecified - state.amountSpecifiedRemaining);

        // flip to the caller-owes convention used by currencyDelta (positive = pool owes caller)
        callerDelta = toBalanceDelta(-amount0Raw, -amount1Raw);
        _accountDelta(key.currency0, -amount0Raw);
        _accountDelta(key.currency1, -amount1Raw);

        if (h != address(0) && Hooks.hasPermission(h, Hooks.AFTER_SWAP_FLAG)) {
            IHooks(h).afterSwap(key, params, callerDelta, hookData);
        }

        emit Swap(id, -amount0Raw, -amount1Raw, state.sqrtPriceX96, state.liquidity, state.tick);
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
        _accountDelta(key.currency0, -principal0 + fees0);
        _accountDelta(key.currency1, -principal1 + fees1);

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
        address owner,
        PoolKey memory key,
        ModifyLiquidityParams memory params,
        int128 ld,
        int24 tick
    ) private returns (int256 fees0, int256 fees1) {
        Position.Info storage position = pool.positions.get(owner, params.tickLower, params.tickUpper);
        uint256 fg0 = pool.feeGrowthGlobal0X128;
        uint256 fg1 = pool.feeGrowthGlobal1X128;
        uint128 maxLiqPerTick = Tick.tickSpacingToMaxLiquidityPerTick(key.tickSpacing);

        bool flippedLower;
        bool flippedUpper;
        if (ld != 0) {
            flippedLower = pool.ticks.update(params.tickLower, tick, ld, fg0, fg1, false, maxLiqPerTick);
            flippedUpper = pool.ticks.update(params.tickUpper, tick, ld, fg0, fg1, true, maxLiqPerTick);
            if (flippedLower) pool.tickBitmap.flipTick(params.tickLower, key.tickSpacing);
            if (flippedUpper) pool.tickBitmap.flipTick(params.tickUpper, key.tickSpacing);
        }

        (uint256 inside0, uint256 inside1) = pool.ticks.getFeeGrowthInside(params.tickLower, params.tickUpper, tick, fg0, fg1);

        // capture the fees this update credits to the position (tokensOwed delta)
        uint128 owed0Before = position.tokensOwed0;
        uint128 owed1Before = position.tokensOwed1;
        position.update(ld, inside0, inside1);
        // tokensOwed only ever grows here (fees are added, never subtracted), so the delta is a
        // non-negative uint128; widen through uint256 before the signed cast
        fees0 = int256(uint256(position.tokensOwed0 - owed0Before));
        fees1 = int256(uint256(position.tokensOwed1 - owed1Before));

        // a removed boundary tick no longer needs its storage
        if (ld < 0) {
            if (flippedLower) pool.ticks.clear(params.tickLower);
            if (flippedUpper) pool.ticks.clear(params.tickUpper);
        }
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
    /// @notice pay the amount owed for `c` and clear the delta. For an ERC-20 this pulls the
    ///         tokens from the caller via `transferFrom`; for the native currency the caller must
    ///         send exactly the owed amount as `msg.value` with this call (the ETH is already in
    ///         the manager when the body runs).
    function settle(currency c) external payable onlyUnlocked returns (uint256 amount) {
        int256 delta = _getDelta(c);
        if (delta >= 0) revert DeltaNotNegative();
        amount = uint256(-delta);
        if (c.isNative()) {
            if (msg.value != amount) revert NativeSettleAmountMismatch();
        } else {
            if (msg.value != 0) revert UnexpectedEth();
            c.transferFrom(msg.sender, address(this), amount);
        }
        reserves[c] += amount;
        _setDelta(c, 0);
    }

    /// @notice withdraw `amount` of `c` that the pool owes the caller; reduces the positive delta.
    ///         Sends ETH when `c` is the native currency. Effects are applied before the transfer
    ///         (checks-effects-interactions), so a re-entering recipient sees the updated state.
    function take(currency c, address to, uint256 amount) external onlyUnlocked {
        int256 delta = _getDelta(c);
        if (delta < int256(amount)) revert InsufficientTake();
        reserves[c] -= amount;
        unchecked {
            // delta >= amount > 0 was checked above, so the subtraction cannot go negative
            _setDelta(c, delta - int256(amount));
        }
        c.transfer(to, amount);
    }

    // ---------------------------------------------------------------- views
    function getSlot0(PoolKey memory key) external view returns (uint160 sqrtPriceX96, int24 tick) {
        Pool storage pool = pools[key.toPoolId()];
        return (pool.slot0.sqrtPriceX96, pool.slot0.tick);
    }

    function getLiquidity(PoolKey memory key) external view returns (uint128) {
        return pools[key.toPoolId()].liquidity;
    }

    function getCurrencyDelta(currency c) external view returns (int256) {
        return _getDelta(c);
    }
}
