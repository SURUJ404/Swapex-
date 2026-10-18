// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {ISwapexSwapCallback} from "../interfaces/ICallbacks.sol";
import {ISwapexFactoryPeriphery, ISwapexPoolActions, ISwapexPoolView} from "../interfaces/IPeriphery.sol";
import {Path} from "../libraries/Path.sol";
import {SafeCast} from "../libraries/SafeCast.sol";
import {TickMath} from "../libraries/TickMath.sol";

/// Off-chain price quotes. It runs the real swap against the real pool and reverts inside the pool's payment
/// callback, so the numbers are exact and no state changes. The functions are not `view` (the swap writes, then
/// reverts); call them with eth_call / staticCall, never in a transaction.
contract SwapexQuoter is ISwapexSwapCallback {
    using Path for bytes;
    using SafeCast for uint256;

    error PoolNotFound();
    error InvalidPath();
    error UnexpectedCaller();
    error UnexpectedSuccess();
    error ZeroAmount();
    error InsufficientLiquidity();

    /// @dev thrown from the callback to carry the swap result out of the pool
    error QuoteResult(int256 amount0, int256 amount1, uint160 sqrtPriceX96After, int24 tickAfter);

    address public immutable factory;

    constructor(address factory_) {
        factory = factory_;
    }

    struct QuoteSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        uint256 amount; // amountIn for exact input, amountOut for exact output
        uint160 sqrtPriceLimitX96; // 0 = no limit
    }

    struct Quote {
        uint256 amount; // amountOut for exact input, amountIn for exact output
        uint160 sqrtPriceX96After;
        int24 tickAfter;
        uint256 gasEstimate;
    }

    function quoteExactInputSingle(QuoteSingleParams memory p) public returns (Quote memory q) {
        uint256 gasBefore = gasleft();
        (int256 a0, int256 a1, uint160 sqrtAfter, int24 tickAfter) = _quote(p.tokenIn, p.tokenOut, p.fee, p.amount.toInt256(), p.sqrtPriceLimitX96);
        bool zeroForOne = p.tokenIn < p.tokenOut;
        q.amount = uint256(-(zeroForOne ? a1 : a0));
        q.sqrtPriceX96After = sqrtAfter;
        q.tickAfter = tickAfter;
        q.gasEstimate = gasBefore - gasleft();
    }

    function quoteExactOutputSingle(QuoteSingleParams memory p) public returns (Quote memory q) {
        uint256 gasBefore = gasleft();
        (int256 a0, int256 a1, uint160 sqrtAfter, int24 tickAfter) = _quote(p.tokenIn, p.tokenOut, p.fee, -p.amount.toInt256(), p.sqrtPriceLimitX96);
        bool zeroForOne = p.tokenIn < p.tokenOut;
        q.amount = uint256(zeroForOne ? a0 : a1);
        q.sqrtPriceX96After = sqrtAfter;
        q.tickAfter = tickAfter;
        q.gasEstimate = gasBefore - gasleft();
    }

    /// @notice multi-hop exact input; path = tokenIn | fee | ... | tokenOut
    function quoteExactInput(bytes memory path, uint256 amountIn)
        external
        returns (uint256 amountOut, uint160[] memory sqrtPricesAfter, int24[] memory ticksAfter, uint256 gasEstimate)
    {
        if (!path.isValid()) revert InvalidPath();
        uint256 gasBefore = gasleft();
        uint256 n = path.numPools();
        sqrtPricesAfter = new uint160[](n);
        ticksAfter = new int24[](n);
        for (uint256 i = 0; i < n; i++) {
            (address tokenIn, address tokenOut, uint24 fee) = path.decodeFirstPool();
            Quote memory q = quoteExactInputSingle(
                QuoteSingleParams({tokenIn: tokenIn, tokenOut: tokenOut, fee: fee, amount: amountIn, sqrtPriceLimitX96: 0})
            );
            amountIn = q.amount;
            sqrtPricesAfter[i] = q.sqrtPriceX96After;
            ticksAfter[i] = q.tickAfter;
            if (i + 1 < n) path = path.skipToken();
        }
        amountOut = amountIn;
        gasEstimate = gasBefore - gasleft();
    }

    /// @notice multi-hop exact output; path is reversed: tokenOut | fee | ... | tokenIn
    function quoteExactOutput(bytes memory path, uint256 amountOut)
        external
        returns (uint256 amountIn, uint160[] memory sqrtPricesAfter, int24[] memory ticksAfter, uint256 gasEstimate)
    {
        if (!path.isValid()) revert InvalidPath();
        uint256 gasBefore = gasleft();
        uint256 n = path.numPools();
        sqrtPricesAfter = new uint160[](n);
        ticksAfter = new int24[](n);
        for (uint256 i = 0; i < n; i++) {
            (address tokenOut, address tokenIn, uint24 fee) = path.decodeFirstPool();
            Quote memory q = quoteExactOutputSingle(
                QuoteSingleParams({tokenIn: tokenIn, tokenOut: tokenOut, fee: fee, amount: amountOut, sqrtPriceLimitX96: 0})
            );
            amountOut = q.amount;
            sqrtPricesAfter[i] = q.sqrtPriceX96After;
            ticksAfter[i] = q.tickAfter;
            if (i + 1 < n) path = path.skipToken();
        }
        amountIn = amountOut;
        gasEstimate = gasBefore - gasleft();
    }

    // ---------------------------------------------------------------- internals
    function _quote(address tokenIn, address tokenOut, uint24 fee, int256 amountSpecified, uint160 limit)
        private
        returns (int256 a0, int256 a1, uint160 sqrtAfter, int24 tickAfter)
    {
        if (amountSpecified == 0) revert ZeroAmount();
        address pool = ISwapexFactoryPeriphery(factory).getPool(tokenIn, tokenOut, fee);
        if (pool == address(0)) revert PoolNotFound();

        bool zeroForOne = tokenIn < tokenOut;
        bool userLimit = limit != 0;
        if (!userLimit) limit = zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1;

        (bool ok, bytes memory reason) = pool.call(
            abi.encodeCall(ISwapexPoolActions.swap, (address(this), zeroForOne, amountSpecified, limit, abi.encode(tokenIn, tokenOut, fee)))
        );
        if (ok) revert UnexpectedSuccess(); // the callback always reverts
        (a0, a1, sqrtAfter, tickAfter) = _parse(reason);

        // a trade the pool cannot fill completely is not a quote the router would execute: report it as such
        if (!userLimit) {
            bool exactInput = amountSpecified > 0;
            uint256 requested = exactInput ? uint256(amountSpecified) : uint256(-amountSpecified);
            uint256 filled = exactInput ? uint256(zeroForOne ? a0 : a1) : uint256(-(zeroForOne ? a1 : a0));
            if (filled != requested) revert InsufficientLiquidity();
        }
    }

    function _parse(bytes memory reason) private pure returns (int256 a0, int256 a1, uint160 sqrtAfter, int24 tickAfter) {
        if (reason.length != 4 + 32 * 4 || bytes4(reason) != QuoteResult.selector) {
            // a real pool error (bad price limit, no liquidity, ...): pass it through unchanged
            assembly {
                revert(add(reason, 32), mload(reason))
            }
        }
        assembly {
            a0 := mload(add(reason, 36))
            a1 := mload(add(reason, 68))
            sqrtAfter := mload(add(reason, 100))
            tickAfter := mload(add(reason, 132))
        }
    }

    function swapexSwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external view override {
        (address tokenIn, address tokenOut, uint24 fee) = abi.decode(data, (address, address, uint24));
        if (msg.sender != ISwapexFactoryPeriphery(factory).getPool(tokenIn, tokenOut, fee)) revert UnexpectedCaller();
        (uint160 sqrtPriceX96,,,) = ISwapexPoolView(msg.sender).slot0();
        (, int24 tick,,) = ISwapexPoolView(msg.sender).slot0();
        revert QuoteResult(amount0Delta, amount1Delta, sqrtPriceX96, tick);
    }
}
