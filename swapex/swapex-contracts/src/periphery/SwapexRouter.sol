// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {ISwapexSwapCallback} from "../interfaces/ICallbacks.sol";
import {ISwapexFactoryPeriphery, ISwapexPoolActions} from "../interfaces/IPeriphery.sol";
import {PeripheryBase} from "./PeripheryBase.sol";
import {Path} from "../libraries/Path.sol";
import {SafeCast} from "../libraries/SafeCast.sol";
import {TickMath} from "../libraries/TickMath.sol";

/// Swaps across one or more Swapex pools. Every swap takes a deadline and a minimum output (or maximum input).
contract SwapexRouter is ISwapexSwapCallback, PeripheryBase {
    using Path for bytes;
    using SafeCast for uint256;

    error InvalidPath();
    error PoolNotFound();
    error InvalidCaller();
    error TooLittleReceived();
    error TooMuchRequested();
    error ZeroAmount();
    error PartialFill();
    error EmptyDelta();

    /// @dev sentinel for "no exact-output swap in flight"
    uint256 private constant DEFAULT_AMOUNT_IN = type(uint256).max;
    uint256 private amountInCached = DEFAULT_AMOUNT_IN;

    struct CallbackData {
        bytes path;
        address payer;
        bool exactInput;
    }

    constructor(address factory_, address weth9_) PeripheryBase(factory_, weth9_) {}

    // ---------------------------------------------------------------- params
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    struct ExactOutputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountOut;
        uint256 amountInMaximum;
        uint160 sqrtPriceLimitX96;
    }

    struct ExactOutputParams {
        bytes path; // reversed: tokenOut first
        address recipient;
        uint256 deadline;
        uint256 amountOut;
        uint256 amountInMaximum;
    }

    // ---------------------------------------------------------------- exact input
    function exactInputSingle(ExactInputSingleParams calldata p)
        external
        payable
        checkDeadline(p.deadline)
        returns (uint256 amountOut)
    {
        amountOut = _exactInputInternal(
            p.amountIn,
            _resolve(p.recipient),
            p.sqrtPriceLimitX96,
            CallbackData({path: abi.encodePacked(p.tokenIn, p.fee, p.tokenOut), payer: msg.sender, exactInput: true})
        );
        if (amountOut < p.amountOutMinimum) revert TooLittleReceived();
    }

    function exactInput(ExactInputParams memory p) external payable checkDeadline(p.deadline) returns (uint256 amountOut) {
        if (!p.path.isValid()) revert InvalidPath();
        address recipient = _resolve(p.recipient);
        address payer = msg.sender;
        uint256 amountIn = p.amountIn;
        bytes memory path = p.path;

        while (true) {
            bool multiple = path.hasMultiplePools();
            amountIn = _exactInputInternal(
                amountIn,
                multiple ? address(this) : recipient, // intermediate output stays here for the next hop
                0,
                CallbackData({path: _firstPool(path), payer: payer, exactInput: true})
            );
            if (multiple) {
                payer = address(this);
                path = path.skipToken();
            } else {
                amountOut = amountIn;
                break;
            }
        }
        if (amountOut < p.amountOutMinimum) revert TooLittleReceived();
    }

    // ---------------------------------------------------------------- exact output
    function exactOutputSingle(ExactOutputSingleParams calldata p)
        external
        payable
        checkDeadline(p.deadline)
        returns (uint256 amountIn)
    {
        amountIn = _exactOutputInternal(
            p.amountOut,
            _resolve(p.recipient),
            p.sqrtPriceLimitX96,
            CallbackData({path: abi.encodePacked(p.tokenOut, p.fee, p.tokenIn), payer: msg.sender, exactInput: false})
        );
        if (amountIn > p.amountInMaximum) revert TooMuchRequested();
        amountInCached = DEFAULT_AMOUNT_IN;
    }

    function exactOutput(ExactOutputParams calldata p) external payable checkDeadline(p.deadline) returns (uint256 amountIn) {
        if (!p.path.isValid()) revert InvalidPath();
        _exactOutputInternal(
            p.amountOut, _resolve(p.recipient), 0, CallbackData({path: p.path, payer: msg.sender, exactInput: false})
        );
        amountIn = amountInCached;
        if (amountIn > p.amountInMaximum) revert TooMuchRequested();
        amountInCached = DEFAULT_AMOUNT_IN;
    }

    // ---------------------------------------------------------------- internals
    function _firstPool(bytes memory path) private pure returns (bytes memory out) {
        out = new bytes(Path.POOL);
        for (uint256 i = 0; i < Path.POOL; i++) {
            out[i] = path[i];
        }
    }

    function _pool(address a, address b, uint24 fee) private view returns (address pool) {
        pool = ISwapexFactoryPeriphery(factory).getPool(a, b, fee);
        if (pool == address(0)) revert PoolNotFound();
    }

    function _exactInputInternal(uint256 amountIn, address recipient, uint160 sqrtPriceLimitX96, CallbackData memory data)
        private
        returns (uint256 amountOut)
    {
        if (amountIn == 0) revert ZeroAmount();
        (address tokenIn, address tokenOut, uint24 fee) = data.path.decodeFirstPool();
        bool zeroForOne = tokenIn < tokenOut;

        (int256 a0, int256 a1) = ISwapexPoolActions(_pool(tokenIn, tokenOut, fee)).swap(
            recipient, zeroForOne, amountIn.toInt256(), _limit(zeroForOne, sqrtPriceLimitX96), abi.encode(data)
        );
        uint256 used = uint256(zeroForOne ? a0 : a1);
        // without a user price limit the whole input must be swapped; never silently trade only part of it
        if (sqrtPriceLimitX96 == 0 && used != amountIn) revert PartialFill();
        amountOut = uint256(-(zeroForOne ? a1 : a0));
    }

    function _exactOutputInternal(uint256 amountOut, address recipient, uint160 sqrtPriceLimitX96, CallbackData memory data)
        private
        returns (uint256 amountIn)
    {
        if (amountOut == 0) revert ZeroAmount();
        // reversed path: first pool is (tokenOut, fee, tokenIn)
        (address tokenOut, address tokenIn, uint24 fee) = data.path.decodeFirstPool();
        bool zeroForOne = tokenIn < tokenOut;

        (int256 a0, int256 a1) = ISwapexPoolActions(_pool(tokenIn, tokenOut, fee)).swap(
            recipient, zeroForOne, -amountOut.toInt256(), _limit(zeroForOne, sqrtPriceLimitX96), abi.encode(data)
        );
        uint256 received;
        (amountIn, received) = zeroForOne ? (uint256(a0), uint256(-a1)) : (uint256(a1), uint256(-a0));
        // without a user price limit the swap must deliver exactly what was asked for
        if (sqrtPriceLimitX96 == 0 && received != amountOut) revert PartialFill();
    }

    function _limit(bool zeroForOne, uint160 userLimit) private pure returns (uint160) {
        if (userLimit != 0) return userLimit;
        return zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1;
    }

    // ---------------------------------------------------------------- pool callback
    function swapexSwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata raw) external override {
        if (amount0Delta <= 0 && amount1Delta <= 0) revert EmptyDelta();
        CallbackData memory data = abi.decode(raw, (CallbackData));
        (address tokenA, address tokenB, uint24 fee) = data.path.decodeFirstPool();

        // only the real pool for this hop may call back; the pool is derived from the factory, not from calldata
        if (msg.sender != ISwapexFactoryPeriphery(factory).getPool(tokenA, tokenB, fee) || msg.sender == address(0)) {
            revert InvalidCaller();
        }

        // the token the pool is owed is the hop's input token
        (address tokenIn, uint256 amountToPay) = amount0Delta > 0
            ? (tokenA < tokenB ? tokenA : tokenB, uint256(amount0Delta))
            : (tokenA < tokenB ? tokenB : tokenA, uint256(amount1Delta));

        if (data.exactInput) {
            _pay(tokenIn, data.payer, msg.sender, amountToPay);
        } else if (data.path.hasMultiplePools()) {
            // this hop's input is the previous hop's output: swap for it, paying this pool from that swap's output
            CallbackData memory next =
                CallbackData({path: data.path.skipToken(), payer: data.payer, exactInput: false});
            _exactOutputInternal(amountToPay, msg.sender, 0, next);
        } else {
            amountInCached = amountToPay;
            _pay(tokenIn, data.payer, msg.sender, amountToPay);
        }
    }
}
