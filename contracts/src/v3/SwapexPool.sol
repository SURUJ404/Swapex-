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
import {Observations} from "../libraries/Observations.sol";
import {IERC20Minimal} from "../interfaces/IERC20Minimal.sol";
import {ISwapexFactory} from "../interfaces/ISwapexFactory.sol";
import {ISwapexMintCallback, ISwapexSwapCallback, ISwapexFlashCallback} from "../interfaces/ICallbacks.sol";

/// @title SwapexPool: concentrated-liquidity pool for one (token0, token1, fee) triple.
/// @dev Positions are keyed by (owner, tickLower, tickUpper); LPs interact through a contract that
///      implements the callbacks. Mirrors reference/poolmodel.py operation for operation.
contract SwapexPool {
    using Tick for mapping(int24 => Tick.Info);
    using TickBitmap for mapping(int16 => uint256);
    using Position for mapping(bytes32 => Position.Info);
    using Position for Position.Info;
    using SafeCast for uint256;
    using Observations for Observations.Observation[65535];

    // ---------------------------------------------------------------- errors
    error Locked();
    error AlreadyInitialized();
    error TicksNotOrdered();
    error TickBelowMin();
    error TickAboveMax();
    error TickSpacingMismatch();
    error ZeroLiquidity();
    error ZeroAmount();
    error InvalidPriceLimit();
    error InsufficientPayment();
    error NoActiveLiquidity();
    error NotFactoryOwner();
    error InvalidProtocolFee();
    error TokenTransferFailed();
    error BalanceCheckFailed();

    // ---------------------------------------------------------------- events
    event Initialize(uint160 sqrtPriceX96, int24 tick);
    event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1);
    event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1);
    event Collect(address indexed owner, address recipient, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount0, uint128 amount1);
    event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick);
    event Flash(address indexed sender, address indexed recipient, uint256 amount0, uint256 amount1, uint256 paid0, uint256 paid1);
    event SetProtocolFee(uint8 oldDenominator, uint8 newDenominator);
    event CollectProtocol(address indexed sender, address indexed recipient, uint128 amount0, uint128 amount1);
    event IncreaseObservationCardinalityNext(uint16 observationCardinalityNextOld, uint16 observationCardinalityNextNew);

    // ---------------------------------------------------------------- immutables
    address public immutable factory;
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;
    int24 public immutable tickSpacing;
    uint128 public immutable maxLiquidityPerTick;

    // ---------------------------------------------------------------- state
    struct Slot0 {
        uint160 sqrtPriceX96;
        int24 tick;
        uint8 protocolFeeDenominator; // 0 = off, else 1/N of every swap fee goes to the protocol (N in 4..10)
        bool unlocked; // reentrancy lock; false until initialize
    }

    Slot0 public slot0;
    uint256 public feeGrowthGlobal0X128;
    uint256 public feeGrowthGlobal1X128;
    uint128 public protocolFees0;
    uint128 public protocolFees1;
    uint128 public liquidity;

    mapping(int24 => Tick.Info) public ticks;
    mapping(int16 => uint256) public tickBitmap;
    mapping(bytes32 => Position.Info) public positions;

    // ---------------------------------------------------------------- TWAP oracle
    Observations.Observation[65535] public observations;
    uint16 public observationIndex; // index of the newest written observation
    uint16 public observationCardinality; // number of retained observations (>= 1 after initialize)
    uint16 public observationCardinalityNext; // ring capacity; grows via increaseObservationCardinalityNext

    modifier lock() {
        if (!slot0.unlocked) revert Locked();
        slot0.unlocked = false;
        _;
        slot0.unlocked = true;
    }

    modifier onlyFactoryOwner() {
        if (msg.sender != ISwapexFactory(factory).owner()) revert NotFactoryOwner();
        _;
    }

    constructor() {
        (address f, address t0, address t1, uint24 fee_, int24 spacing) = ISwapexFactory(msg.sender).parameters();
        factory = f;
        token0 = t0;
        token1 = t1;
        fee = fee_;
        tickSpacing = spacing;
        maxLiquidityPerTick = Tick.tickSpacingToMaxLiquidityPerTick(spacing);
    }

    // ---------------------------------------------------------------- setup
    function initialize(uint160 sqrtPriceX96) external {
        if (slot0.sqrtPriceX96 != 0) revert AlreadyInitialized();
        int24 tick = TickMath.getTickAtSqrtRatio(sqrtPriceX96);
        slot0 = Slot0({sqrtPriceX96: sqrtPriceX96, tick: tick, protocolFeeDenominator: 0, unlocked: true});
        observations.initialize();
        observationIndex = 0;
        observationCardinality = 1;
        observationCardinalityNext = 1;
        emit Initialize(sqrtPriceX96, tick);
    }

    // ---------------------------------------------------------------- liquidity
    function mint(address recipient, int24 tickLower, int24 tickUpper, uint128 amount, bytes calldata data)
        external
        lock
        returns (uint256 amount0, uint256 amount1)
    {
        if (amount == 0) revert ZeroLiquidity();
        (, int256 a0, int256 a1) = _modifyPosition(recipient, tickLower, tickUpper, SafeCast.toInt128(amount));
        amount0 = uint256(a0);
        amount1 = uint256(a1);

        uint256 balance0Before;
        uint256 balance1Before;
        if (amount0 > 0) balance0Before = _balance(token0);
        if (amount1 > 0) balance1Before = _balance(token1);
        ISwapexMintCallback(msg.sender).swapexMintCallback(amount0, amount1, data);
        if (amount0 > 0 && balance0Before + amount0 > _balance(token0)) revert InsufficientPayment();
        if (amount1 > 0 && balance1Before + amount1 > _balance(token1)) revert InsufficientPayment();

        emit Mint(msg.sender, recipient, tickLower, tickUpper, amount, amount0, amount1);
    }

    /// @notice remove liquidity; tokens are credited to the position and withdrawn with `collect`.
    ///         `amount == 0` pokes the position so earned fees are credited.
    function burn(int24 tickLower, int24 tickUpper, uint128 amount)
        external
        lock
        returns (uint256 amount0, uint256 amount1)
    {
        (Position.Info storage position, int256 a0, int256 a1) =
            _modifyPosition(msg.sender, tickLower, tickUpper, -SafeCast.toInt128(amount));
        amount0 = uint256(-a0);
        amount1 = uint256(-a1);
        if (amount0 > 0 || amount1 > 0) {
            position.tokensOwed0 += amount0.toUint128();
            position.tokensOwed1 += amount1.toUint128();
        }
        emit Burn(msg.sender, tickLower, tickUpper, amount, amount0, amount1);
    }

    function collect(
        address recipient,
        int24 tickLower,
        int24 tickUpper,
        uint128 amount0Requested,
        uint128 amount1Requested
    ) external lock returns (uint128 amount0, uint128 amount1) {
        Position.Info storage position = positions.get(msg.sender, tickLower, tickUpper);
        amount0 = amount0Requested > position.tokensOwed0 ? position.tokensOwed0 : amount0Requested;
        amount1 = amount1Requested > position.tokensOwed1 ? position.tokensOwed1 : amount1Requested;
        if (amount0 > 0) {
            position.tokensOwed0 -= amount0;
            _safeTransfer(token0, recipient, amount0);
        }
        if (amount1 > 0) {
            position.tokensOwed1 -= amount1;
            _safeTransfer(token1, recipient, amount1);
        }
        emit Collect(msg.sender, recipient, tickLower, tickUpper, amount0, amount1);
    }

    function _checkTicks(int24 tickLower, int24 tickUpper) private view {
        if (tickLower >= tickUpper) revert TicksNotOrdered();
        if (tickLower < TickMath.MIN_TICK) revert TickBelowMin();
        if (tickUpper > TickMath.MAX_TICK) revert TickAboveMax();
        if (tickLower % tickSpacing != 0 || tickUpper % tickSpacing != 0) revert TickSpacingMismatch();
    }

    function _modifyPosition(address owner, int24 tickLower, int24 tickUpper, int128 liquidityDelta)
        private
        returns (Position.Info storage position, int256 amount0, int256 amount1)
    {
        _checkTicks(tickLower, tickUpper);
        Slot0 memory _slot0 = slot0;

        // liquidity changes affect the seconds-per-liquidity integral: capture the elapsed interval
        // at the pre-operation tick and liquidity before we mutate any state.
        (observationIndex, observationCardinality) = observations.write(
            observationIndex, uint32(block.timestamp), _slot0.tick, liquidity, observationCardinality, observationCardinalityNext
        );

        position = _updatePosition(owner, tickLower, tickUpper, liquidityDelta, _slot0.tick);

        if (liquidityDelta != 0) {
            if (_slot0.tick < tickLower) {
                // range is above the price: only token0 needed
                amount0 = SqrtPriceMath.getAmount0Delta(
                    TickMath.getSqrtRatioAtTick(tickLower), TickMath.getSqrtRatioAtTick(tickUpper), liquidityDelta
                );
            } else if (_slot0.tick < tickUpper) {
                // price inside the range: both tokens, and the position becomes active liquidity
                amount0 = SqrtPriceMath.getAmount0Delta(
                    _slot0.sqrtPriceX96, TickMath.getSqrtRatioAtTick(tickUpper), liquidityDelta
                );
                amount1 = SqrtPriceMath.getAmount1Delta(
                    TickMath.getSqrtRatioAtTick(tickLower), _slot0.sqrtPriceX96, liquidityDelta
                );
                liquidity = LiquidityMath.addDelta(liquidity, liquidityDelta);
            } else {
                // range is below the price: only token1 needed
                amount1 = SqrtPriceMath.getAmount1Delta(
                    TickMath.getSqrtRatioAtTick(tickLower), TickMath.getSqrtRatioAtTick(tickUpper), liquidityDelta
                );
            }
        }
    }

    function _updatePosition(address owner, int24 tickLower, int24 tickUpper, int128 liquidityDelta, int24 tick)
        private
        returns (Position.Info storage position)
    {
        position = positions.get(owner, tickLower, tickUpper);

        uint256 fg0 = feeGrowthGlobal0X128;
        uint256 fg1 = feeGrowthGlobal1X128;

        bool flippedLower;
        bool flippedUpper;
        if (liquidityDelta != 0) {
            flippedLower = ticks.update(tickLower, tick, liquidityDelta, fg0, fg1, false, maxLiquidityPerTick);
            flippedUpper = ticks.update(tickUpper, tick, liquidityDelta, fg0, fg1, true, maxLiquidityPerTick);
            if (flippedLower) tickBitmap.flipTick(tickLower, tickSpacing);
            if (flippedUpper) tickBitmap.flipTick(tickUpper, tickSpacing);
        }

        (uint256 inside0, uint256 inside1) = ticks.getFeeGrowthInside(tickLower, tickUpper, tick, fg0, fg1);
        position.update(liquidityDelta, inside0, inside1);

        // a removed boundary tick no longer needs its storage
        if (liquidityDelta < 0) {
            if (flippedLower) ticks.clear(tickLower);
            if (flippedUpper) ticks.clear(tickUpper);
        }
    }

    // ---------------------------------------------------------------- swap
    struct SwapCache {
        bool zeroForOne;
        bool exactInput;
        uint8 protocolFeeDenominator;
        uint160 sqrtPriceLimitX96;
    }

    struct SwapState {
        int256 amountSpecifiedRemaining;
        int256 amountCalculated;
        uint160 sqrtPriceX96;
        int24 tick;
        uint256 feeGrowthGlobalX128; // growth of the input token
        uint128 protocolFee;
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

    /// @param amountSpecified > 0: exact input, < 0: exact output
    /// @param sqrtPriceLimitX96 the swap stops here at the latest (slippage / price protection)
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external lock returns (int256 amount0, int256 amount1) {
        if (amountSpecified == 0) revert ZeroAmount();

        Slot0 memory slot0Start = slot0;
        if (
            zeroForOne
                ? !(sqrtPriceLimitX96 < slot0Start.sqrtPriceX96 && sqrtPriceLimitX96 > TickMath.MIN_SQRT_RATIO)
                : !(sqrtPriceLimitX96 > slot0Start.sqrtPriceX96 && sqrtPriceLimitX96 < TickMath.MAX_SQRT_RATIO)
        ) revert InvalidPriceLimit();

        // capture the elapsed interval at the pre-swap tick and liquidity for the TWAP oracle
        (observationIndex, observationCardinality) = observations.write(
            observationIndex, uint32(block.timestamp), slot0Start.tick, liquidity, observationCardinality, observationCardinalityNext
        );

        SwapCache memory cache = SwapCache({
            zeroForOne: zeroForOne,
            exactInput: amountSpecified > 0,
            protocolFeeDenominator: slot0Start.protocolFeeDenominator,
            sqrtPriceLimitX96: sqrtPriceLimitX96
        });

        SwapState memory state = SwapState({
            amountSpecifiedRemaining: amountSpecified,
            amountCalculated: 0,
            sqrtPriceX96: slot0Start.sqrtPriceX96,
            tick: slot0Start.tick,
            feeGrowthGlobalX128: zeroForOne ? feeGrowthGlobal0X128 : feeGrowthGlobal1X128,
            protocolFee: 0,
            liquidity: liquidity
        });

        while (state.amountSpecifiedRemaining != 0 && state.sqrtPriceX96 != cache.sqrtPriceLimitX96) {
            StepComputations memory step;
            step.sqrtPriceStartX96 = state.sqrtPriceX96;

            (step.tickNext, step.initialized) =
                tickBitmap.nextInitializedTickWithinOneWord(state.tick, tickSpacing, cache.zeroForOne);

            // the bitmap does not know the global bounds
            if (step.tickNext < TickMath.MIN_TICK) step.tickNext = TickMath.MIN_TICK;
            else if (step.tickNext > TickMath.MAX_TICK) step.tickNext = TickMath.MAX_TICK;

            step.sqrtPriceNextX96 = TickMath.getSqrtRatioAtTick(step.tickNext);

            (state.sqrtPriceX96, step.amountIn, step.amountOut, step.feeAmount) = SwapMath.computeSwapStep(
                state.sqrtPriceX96,
                (cache.zeroForOne ? step.sqrtPriceNextX96 < cache.sqrtPriceLimitX96 : step.sqrtPriceNextX96 > cache.sqrtPriceLimitX96)
                    ? cache.sqrtPriceLimitX96
                    : step.sqrtPriceNextX96,
                state.liquidity,
                state.amountSpecifiedRemaining,
                fee
            );

            if (cache.exactInput) {
                state.amountSpecifiedRemaining -= (step.amountIn + step.feeAmount).toInt256();
                state.amountCalculated -= step.amountOut.toInt256();
            } else {
                state.amountSpecifiedRemaining += step.amountOut.toInt256();
                state.amountCalculated += (step.amountIn + step.feeAmount).toInt256();
            }

            if (cache.protocolFeeDenominator > 0) {
                uint256 delta = step.feeAmount / cache.protocolFeeDenominator;
                step.feeAmount -= delta;
                state.protocolFee += uint128(delta);
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
                    int128 liquidityNet = ticks.cross(
                        step.tickNext,
                        cache.zeroForOne ? state.feeGrowthGlobalX128 : feeGrowthGlobal0X128,
                        cache.zeroForOne ? feeGrowthGlobal1X128 : state.feeGrowthGlobalX128
                    );
                    // moving left removes what moving right would add
                    if (cache.zeroForOne) liquidityNet = -liquidityNet;
                    state.liquidity = LiquidityMath.addDelta(state.liquidity, liquidityNet);
                }
                state.tick = cache.zeroForOne ? step.tickNext - 1 : step.tickNext;
            } else if (state.sqrtPriceX96 != step.sqrtPriceStartX96) {
                // price moved inside the range: recompute the tick
                state.tick = TickMath.getTickAtSqrtRatio(state.sqrtPriceX96);
            }
        }

        // ---- effects
        slot0.sqrtPriceX96 = state.sqrtPriceX96;
        if (state.tick != slot0Start.tick) slot0.tick = state.tick;
        if (liquidity != state.liquidity) liquidity = state.liquidity;

        if (cache.zeroForOne) {
            feeGrowthGlobal0X128 = state.feeGrowthGlobalX128;
            if (state.protocolFee > 0) protocolFees0 += state.protocolFee;
        } else {
            feeGrowthGlobal1X128 = state.feeGrowthGlobalX128;
            if (state.protocolFee > 0) protocolFees1 += state.protocolFee;
        }

        (amount0, amount1) = zeroForOne == cache.exactInput
            ? (amountSpecified - state.amountSpecifiedRemaining, state.amountCalculated)
            : (state.amountCalculated, amountSpecified - state.amountSpecifiedRemaining);

        // ---- interactions: pay out first, then require payment in the callback
        if (zeroForOne) {
            if (amount1 < 0) _safeTransfer(token1, recipient, uint256(-amount1));
            uint256 balance0Before = _balance(token0);
            ISwapexSwapCallback(msg.sender).swapexSwapCallback(amount0, amount1, data);
            if (balance0Before + uint256(amount0) > _balance(token0)) revert InsufficientPayment();
        } else {
            if (amount0 < 0) _safeTransfer(token0, recipient, uint256(-amount0));
            uint256 balance1Before = _balance(token1);
            ISwapexSwapCallback(msg.sender).swapexSwapCallback(amount0, amount1, data);
            if (balance1Before + uint256(amount1) > _balance(token1)) revert InsufficientPayment();
        }

        emit Swap(msg.sender, recipient, amount0, amount1, state.sqrtPriceX96, state.liquidity, state.tick);
    }

    // ---------------------------------------------------------------- flash loans
    function flash(address recipient, uint256 amount0, uint256 amount1, bytes calldata data) external lock {
        uint128 _liquidity = liquidity;
        if (_liquidity == 0) revert NoActiveLiquidity();

        uint256 fee0 = FullMath.mulDivRoundingUp(amount0, fee, 1e6);
        uint256 fee1 = FullMath.mulDivRoundingUp(amount1, fee, 1e6);
        uint256 balance0Before = _balance(token0);
        uint256 balance1Before = _balance(token1);

        if (amount0 > 0) _safeTransfer(token0, recipient, amount0);
        if (amount1 > 0) _safeTransfer(token1, recipient, amount1);

        ISwapexFlashCallback(msg.sender).swapexFlashCallback(fee0, fee1, data);

        uint256 balance0After = _balance(token0);
        uint256 balance1After = _balance(token1);
        if (balance0Before + fee0 > balance0After || balance1Before + fee1 > balance1After) revert InsufficientPayment();

        uint256 paid0 = balance0After - balance0Before;
        uint256 paid1 = balance1After - balance1Before;
        uint8 denom = slot0.protocolFeeDenominator;

        if (paid0 > 0) {
            uint128 pf0 = denom == 0 ? 0 : uint128(paid0 / denom);
            if (pf0 > 0) protocolFees0 += pf0;
            unchecked {
                feeGrowthGlobal0X128 += FullMath.mulDiv(paid0 - pf0, 1 << 128, _liquidity);
            }
        }
        if (paid1 > 0) {
            uint128 pf1 = denom == 0 ? 0 : uint128(paid1 / denom);
            if (pf1 > 0) protocolFees1 += pf1;
            unchecked {
                feeGrowthGlobal1X128 += FullMath.mulDiv(paid1 - pf1, 1 << 128, _liquidity);
            }
        }
        emit Flash(msg.sender, recipient, amount0, amount1, paid0, paid1);
    }

    // ---------------------------------------------------------------- protocol fee
    /// @param newDenominator 0 turns the protocol fee off, otherwise 4..10 (25% .. 10% of swap fees)
    function setProtocolFee(uint8 newDenominator) external lock onlyFactoryOwner {
        if (newDenominator != 0 && (newDenominator < 4 || newDenominator > 10)) revert InvalidProtocolFee();
        uint8 old = slot0.protocolFeeDenominator;
        slot0.protocolFeeDenominator = newDenominator;
        emit SetProtocolFee(old, newDenominator);
    }

    function collectProtocol(address recipient, uint128 amount0Requested, uint128 amount1Requested)
        external
        lock
        onlyFactoryOwner
        returns (uint128 amount0, uint128 amount1)
    {
        amount0 = amount0Requested > protocolFees0 ? protocolFees0 : amount0Requested;
        amount1 = amount1Requested > protocolFees1 ? protocolFees1 : amount1Requested;
        if (amount0 > 0) {
            protocolFees0 -= amount0;
            _safeTransfer(token0, recipient, amount0);
        }
        if (amount1 > 0) {
            protocolFees1 -= amount1;
            _safeTransfer(token1, recipient, amount1);
        }
        emit CollectProtocol(msg.sender, recipient, amount0, amount1);
    }

    // ---------------------------------------------------------------- TWAP oracle
    /// @notice grow the ring-buffer capacity. Takes effect as writes fill the buffer; the retained
    ///         observation count (`observationCardinality`) only increases up to this value.
    function increaseObservationCardinalityNext(uint16 cardinalityNext) external {
        uint16 cardNext = observationCardinalityNext;
        if (cardinalityNext > cardNext) {
            observationCardinalityNext = cardinalityNext;
            emit IncreaseObservationCardinalityNext(cardNext, cardinalityNext);
        }
    }

    /// @notice cumulative tick and seconds-per-liquidity at `block.timestamp - secondsAgo[i]` for each entry.
    /// @dev TWAP over [now - w, now] = (tickCumulatives[last] - tickCumulatives[first]) / w.
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativesX128)
    {
        return observations.observe(
            uint32(block.timestamp),
            secondsAgos,
            slot0.tick,
            liquidity,
            observationIndex,
            observationCardinality,
            observationCardinalityNext
        );
    }

    /// @notice convenience single-window read of the cumulative values `secondsAgo` seconds ago.
    function observeSingle(uint32 secondsAgo)
        external
        view
        returns (int56 tickCumulative, uint160 secondsPerLiquidityCumulativeX128)
    {
        return observations.observeSingle(
            uint32(block.timestamp),
            secondsAgo,
            slot0.tick,
            liquidity,
            observationIndex,
            observationCardinality,
            observationCardinalityNext
        );
    }

    // ---------------------------------------------------------------- token helpers
    function _balance(address token) private view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(IERC20Minimal.balanceOf.selector, address(this)));
        if (!ok || ret.length < 32) revert BalanceCheckFailed();
        return abi.decode(ret, (uint256));
    }

    /// @dev tolerates tokens that return nothing (USDT-style) and reverts on `false`
    function _safeTransfer(address token, address to, uint256 value) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20Minimal.transfer.selector, to, value));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TokenTransferFailed();
    }
}
