// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

/// 512-bit multiply-then-divide. The algorithm (full 512-bit product, exact division by
/// factoring out powers of two and multiplying by the modular inverse) is verified against
/// exact big-int arithmetic by reference/check_refmath.py (`mul_div_512`).
library FullMath {
    error MulDivOverflow();

    /// @notice floor(a * b / denominator) with a full-precision intermediate product
    function mulDiv(uint256 a, uint256 b, uint256 denominator) internal pure returns (uint256 result) {
        unchecked {
            uint256 prod0; // low 256 bits of a * b
            uint256 prod1; // high 256 bits of a * b
            assembly {
                let mm := mulmod(a, b, not(0))
                prod0 := mul(a, b)
                prod1 := sub(sub(mm, prod0), lt(mm, prod0))
            }

            // result fits in 256 bits: plain division
            if (prod1 == 0) {
                if (denominator == 0) revert MulDivOverflow();
                assembly {
                    result := div(prod0, denominator)
                }
                return result;
            }

            // result would overflow 256 bits (also covers denominator == 0)
            if (denominator <= prod1) revert MulDivOverflow();

            // make the division exact by subtracting the remainder
            uint256 remainder;
            assembly {
                remainder := mulmod(a, b, denominator)
                prod1 := sub(prod1, gt(remainder, prod0))
                prod0 := sub(prod0, remainder)
            }

            // factor powers of two out of the denominator
            uint256 twos = denominator & (~denominator + 1);
            assembly {
                denominator := div(denominator, twos)
                prod0 := div(prod0, twos)
                // flip twos so that 2^256 / twos
                twos := add(div(sub(0, twos), twos), 1)
            }
            prod0 |= prod1 * twos;

            // modular inverse of the (now odd) denominator mod 2^256 by Newton-Raphson
            uint256 inv = (3 * denominator) ^ 2;
            inv *= 2 - denominator * inv; // 2^8
            inv *= 2 - denominator * inv; // 2^16
            inv *= 2 - denominator * inv; // 2^32
            inv *= 2 - denominator * inv; // 2^64
            inv *= 2 - denominator * inv; // 2^128
            inv *= 2 - denominator * inv; // 2^256

            result = prod0 * inv;
        }
    }

    /// @notice ceil(a * b / denominator)
    function mulDivRoundingUp(uint256 a, uint256 b, uint256 denominator) internal pure returns (uint256 result) {
        result = mulDiv(a, b, denominator);
        if (mulmod(a, b, denominator) != 0) {
            if (result == type(uint256).max) revert MulDivOverflow();
            unchecked {
                result++;
            }
        }
    }

    /// @notice ceil(a / b), b must be non-zero
    function divRoundingUp(uint256 a, uint256 b) internal pure returns (uint256 result) {
        assembly {
            result := add(div(a, b), gt(mod(a, b), 0))
        }
    }
}
