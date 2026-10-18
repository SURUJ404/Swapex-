// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {FullMath} from "./FullMath.sol";
import {LiquidityMath} from "./LiquidityMath.sol";
import {SafeCast} from "./SafeCast.sol";

library Position {
    error NoLiquidityToPoke();

    uint256 internal constant Q128 = 1 << 128;

    struct Info {
        uint128 liquidity;
        uint256 feeGrowthInside0LastX128;
        uint256 feeGrowthInside1LastX128;
        uint128 tokensOwed0;
        uint128 tokensOwed1;
    }

    function get(mapping(bytes32 => Info) storage self, address owner, int24 tickLower, int24 tickUpper)
        internal
        view
        returns (Info storage position)
    {
        position = self[keccak256(abi.encodePacked(owner, tickLower, tickUpper))];
    }

    /// @notice credit fees earned since the last update and apply a liquidity change
    function update(Info storage self, int128 liquidityDelta, uint256 feeGrowthInside0X128, uint256 feeGrowthInside1X128)
        internal
    {
        Info memory _self = self;

        uint128 liquidityNext;
        if (liquidityDelta == 0) {
            if (_self.liquidity == 0) revert NoLiquidityToPoke(); // poking an empty position is a mistake
            liquidityNext = _self.liquidity;
        } else {
            liquidityNext = LiquidityMath.addDelta(_self.liquidity, liquidityDelta);
        }

        uint128 owed0;
        uint128 owed1;
        unchecked {
            // growth differences wrap; the product with liquidity is the exact fee amount
            owed0 = SafeCast.toUint128(
                FullMath.mulDiv(feeGrowthInside0X128 - _self.feeGrowthInside0LastX128, _self.liquidity, Q128)
            );
            owed1 = SafeCast.toUint128(
                FullMath.mulDiv(feeGrowthInside1X128 - _self.feeGrowthInside1LastX128, _self.liquidity, Q128)
            );
        }

        if (liquidityDelta != 0) self.liquidity = liquidityNext;
        self.feeGrowthInside0LastX128 = feeGrowthInside0X128;
        self.feeGrowthInside1LastX128 = feeGrowthInside1X128;
        if (owed0 > 0 || owed1 > 0) {
            self.tokensOwed0 += owed0;
            self.tokensOwed1 += owed1;
        }
    }
}
