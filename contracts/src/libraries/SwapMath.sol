// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {FullMath} from "./FullMath.sol";
import {SqrtPriceMath} from "./SqrtPriceMath.sol";

/// One swap step inside a single constant-liquidity range. Mirrors `swap_step` in reference/refmath.py.
library SwapMath {
    /// @param sqrtPriceCurrentX96 price before the step
    /// @param sqrtPriceTargetX96  price that must not be crossed (next tick or the user's limit)
    /// @param liquidity           active liquidity over the step
    /// @param amountRemaining     > 0: exact input still to spend (fee included); < 0: exact output still wanted
    /// @param feePips             fee in hundredths of a bip (3000 = 0.3%)
    function computeSwapStep(
        uint160 sqrtPriceCurrentX96,
        uint160 sqrtPriceTargetX96,
        uint128 liquidity,
        int256 amountRemaining,
        uint24 feePips
    ) internal pure returns (uint160 sqrtPriceNextX96, uint256 amountIn, uint256 amountOut, uint256 feeAmount) {
        bool zeroForOne = sqrtPriceCurrentX96 >= sqrtPriceTargetX96;
        bool exactIn = amountRemaining >= 0;

        if (exactIn) {
            uint256 remainingLessFee = FullMath.mulDiv(uint256(amountRemaining), 1e6 - feePips, 1e6);
            amountIn = zeroForOne
                ? SqrtPriceMath.getAmount0Delta(sqrtPriceTargetX96, sqrtPriceCurrentX96, liquidity, true)
                : SqrtPriceMath.getAmount1Delta(sqrtPriceCurrentX96, sqrtPriceTargetX96, liquidity, true);
            sqrtPriceNextX96 = remainingLessFee >= amountIn
                ? sqrtPriceTargetX96
                : SqrtPriceMath.getNextSqrtPriceFromInput(sqrtPriceCurrentX96, liquidity, remainingLessFee, zeroForOne);
        } else {
            amountOut = zeroForOne
                ? SqrtPriceMath.getAmount1Delta(sqrtPriceTargetX96, sqrtPriceCurrentX96, liquidity, false)
                : SqrtPriceMath.getAmount0Delta(sqrtPriceCurrentX96, sqrtPriceTargetX96, liquidity, false);
            sqrtPriceNextX96 = uint256(-amountRemaining) >= amountOut
                ? sqrtPriceTargetX96
                : SqrtPriceMath.getNextSqrtPriceFromOutput(
                    sqrtPriceCurrentX96, liquidity, uint256(-amountRemaining), zeroForOne
                );
        }

        bool reachedTarget = sqrtPriceNextX96 == sqrtPriceTargetX96;

        if (zeroForOne) {
            amountIn = reachedTarget && exactIn
                ? amountIn
                : SqrtPriceMath.getAmount0Delta(sqrtPriceNextX96, sqrtPriceCurrentX96, liquidity, true);
            amountOut = reachedTarget && !exactIn
                ? amountOut
                : SqrtPriceMath.getAmount1Delta(sqrtPriceNextX96, sqrtPriceCurrentX96, liquidity, false);
        } else {
            amountIn = reachedTarget && exactIn
                ? amountIn
                : SqrtPriceMath.getAmount1Delta(sqrtPriceCurrentX96, sqrtPriceNextX96, liquidity, true);
            amountOut = reachedTarget && !exactIn
                ? amountOut
                : SqrtPriceMath.getAmount0Delta(sqrtPriceCurrentX96, sqrtPriceNextX96, liquidity, false);
        }

        // never pay out more than the caller asked for
        if (!exactIn && amountOut > uint256(-amountRemaining)) amountOut = uint256(-amountRemaining);

        if (exactIn && !reachedTarget) {
            // the whole remainder is spent: whatever is not swapped input is fee
            feeAmount = uint256(amountRemaining) - amountIn;
        } else {
            feeAmount = FullMath.mulDivRoundingUp(amountIn, feePips, 1e6 - feePips);
        }
    }
}
