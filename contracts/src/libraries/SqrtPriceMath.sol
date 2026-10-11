// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {FullMath} from "./FullMath.sol";
import {SafeCast} from "./SafeCast.sol";

/// Amount <-> sqrt price relations for concentrated liquidity (Q64.96 prices).
/// Mirrors reference/refmath.py function for function.
///   amount0 = L * (1/sqrtA - 1/sqrtB)      amount1 = L * (sqrtB - sqrtA)
library SqrtPriceMath {
    error PriceZero();
    error LiquidityZero();
    error PriceOverflow();
    error PriceUnderflow();
    error AmountTooLarge();

    uint256 internal constant Q96 = 1 << 96;

    /// @notice token0 amount between two prices for liquidity L
    function getAmount0Delta(uint160 sqrtAX96, uint160 sqrtBX96, uint128 liquidity, bool roundUp)
        internal
        pure
        returns (uint256 amount0)
    {
        if (sqrtAX96 > sqrtBX96) (sqrtAX96, sqrtBX96) = (sqrtBX96, sqrtAX96);
        if (sqrtAX96 == 0) revert PriceZero();

        uint256 numerator1 = uint256(liquidity) << 96;
        uint256 numerator2 = sqrtBX96 - sqrtAX96;

        amount0 = roundUp
            ? FullMath.divRoundingUp(FullMath.mulDivRoundingUp(numerator1, numerator2, sqrtBX96), sqrtAX96)
            : FullMath.mulDiv(numerator1, numerator2, sqrtBX96) / sqrtAX96;
    }

    /// @notice token1 amount between two prices for liquidity L
    function getAmount1Delta(uint160 sqrtAX96, uint160 sqrtBX96, uint128 liquidity, bool roundUp)
        internal
        pure
        returns (uint256 amount1)
    {
        if (sqrtAX96 > sqrtBX96) (sqrtAX96, sqrtBX96) = (sqrtBX96, sqrtAX96);
        amount1 = roundUp
            ? FullMath.mulDivRoundingUp(liquidity, sqrtBX96 - sqrtAX96, Q96)
            : FullMath.mulDiv(liquidity, sqrtBX96 - sqrtAX96, Q96);
    }

    /// @notice signed token0 amount for a liquidity change: positive (owed to pool) rounds up, negative rounds down
    function getAmount0Delta(uint160 sqrtAX96, uint160 sqrtBX96, int128 liquidity) internal pure returns (int256) {
        return liquidity < 0
            ? -SafeCast.toInt256(getAmount0Delta(sqrtAX96, sqrtBX96, uint128(-liquidity), false))
            : SafeCast.toInt256(getAmount0Delta(sqrtAX96, sqrtBX96, uint128(liquidity), true));
    }

    /// @notice signed token1 amount for a liquidity change
    function getAmount1Delta(uint160 sqrtAX96, uint160 sqrtBX96, int128 liquidity) internal pure returns (int256) {
        return liquidity < 0
            ? -SafeCast.toInt256(getAmount1Delta(sqrtAX96, sqrtBX96, uint128(-liquidity), false))
            : SafeCast.toInt256(getAmount1Delta(sqrtAX96, sqrtBX96, uint128(liquidity), true));
    }

    /// @dev always rounds the new price up (token0 in: price falls less; token0 out: price rises more)
    function getNextSqrtPriceFromAmount0RoundingUp(uint160 sqrtPX96, uint128 liquidity, uint256 amount, bool add)
        internal
        pure
        returns (uint160)
    {
        if (amount == 0) return sqrtPX96;
        uint256 numerator1 = uint256(liquidity) << 96;

        unchecked {
            uint256 product = amount * sqrtPX96;
            bool productFits = product / amount == sqrtPX96;
            if (add) {
                if (productFits) {
                    uint256 denominator = numerator1 + product;
                    if (denominator >= numerator1) {
                        return SafeCast.toUint160(FullMath.mulDivRoundingUp(numerator1, sqrtPX96, denominator));
                    }
                }
                return SafeCast.toUint160(FullMath.divRoundingUp(numerator1, numerator1 / sqrtPX96 + amount));
            } else {
                if (!productFits || numerator1 <= product) revert PriceUnderflow();
                return SafeCast.toUint160(FullMath.mulDivRoundingUp(numerator1, sqrtPX96, numerator1 - product));
            }
        }
    }

    /// @dev always rounds the new price down
    function getNextSqrtPriceFromAmount1RoundingDown(uint160 sqrtPX96, uint128 liquidity, uint256 amount, bool add)
        internal
        pure
        returns (uint160)
    {
        if (add) {
            uint256 quotient =
                amount <= type(uint160).max ? (amount << 96) / liquidity : FullMath.mulDiv(amount, Q96, liquidity);
            return SafeCast.toUint160(uint256(sqrtPX96) + quotient);
        } else {
            uint256 quotient = amount <= type(uint160).max
                ? FullMath.divRoundingUp(amount << 96, liquidity)
                : FullMath.mulDivRoundingUp(amount, Q96, liquidity);
            if (sqrtPX96 <= quotient) revert PriceUnderflow();
            return uint160(sqrtPX96 - quotient);
        }
    }

    function getNextSqrtPriceFromInput(uint160 sqrtPX96, uint128 liquidity, uint256 amountIn, bool zeroForOne)
        internal
        pure
        returns (uint160)
    {
        if (sqrtPX96 == 0) revert PriceZero();
        if (liquidity == 0) revert LiquidityZero();
        return zeroForOne
            ? getNextSqrtPriceFromAmount0RoundingUp(sqrtPX96, liquidity, amountIn, true)
            : getNextSqrtPriceFromAmount1RoundingDown(sqrtPX96, liquidity, amountIn, true);
    }

    function getNextSqrtPriceFromOutput(uint160 sqrtPX96, uint128 liquidity, uint256 amountOut, bool zeroForOne)
        internal
        pure
        returns (uint160)
    {
        if (sqrtPX96 == 0) revert PriceZero();
        if (liquidity == 0) revert LiquidityZero();
        return zeroForOne
            ? getNextSqrtPriceFromAmount1RoundingDown(sqrtPX96, liquidity, amountOut, false)
            : getNextSqrtPriceFromAmount0RoundingUp(sqrtPX96, liquidity, amountOut, false);
    }
}
