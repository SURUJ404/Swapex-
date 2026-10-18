// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {ISwapexMintCallback} from "../interfaces/ICallbacks.sol";
import {ISwapexFactoryPeriphery, ISwapexPoolActions, ISwapexPoolView} from "../interfaces/IPeriphery.sol";
import {ERC721Minimal} from "./ERC721Minimal.sol";
import {PeripheryBase} from "./PeripheryBase.sol";
import {FullMath} from "../libraries/FullMath.sol";
import {LiquidityAmounts} from "../libraries/LiquidityAmounts.sol";
import {SafeCast} from "../libraries/SafeCast.sol";
import {TickMath} from "../libraries/TickMath.sol";

/// Liquidity positions as NFTs. The pool sees this contract as the only LP (position key = this contract + range);
/// the contract keeps each NFT's own liquidity and fee accounting, so many NFTs can share one range.
contract SwapexPositionManager is ERC721Minimal, ISwapexMintCallback, PeripheryBase {
    using SafeCast for uint256;

    error InvalidCaller();
    error PoolNotFound();
    error TokensNotSorted();
    error PriceSlippage();
    error ZeroLiquidity();
    error InsufficientLiquidity();
    error NotCleared();
    error NotAuthorized();
    error InvalidRecipient();
    error ZeroCollect();

    uint256 private constant Q128 = 1 << 128;

    event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
    event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
    event Collect(uint256 indexed tokenId, address recipient, uint256 amount0, uint256 amount1);

    struct PositionData {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint256 feeGrowthInside0LastX128;
        uint256 feeGrowthInside1LastX128;
        uint128 tokensOwed0;
        uint128 tokensOwed1;
    }

    struct MintCallbackData {
        address token0;
        address token1;
        uint24 fee;
        address payer;
    }

    uint256 public nextTokenId = 1;
    mapping(uint256 => PositionData) private _positions;

    constructor(address factory_, address weth9_) PeripheryBase(factory_, weth9_) {}

    // ---------------------------------------------------------------- metadata
    function name() external pure returns (string memory) {
        return "Swapex Positions";
    }

    function symbol() external pure returns (string memory) {
        return "SWPX-POS";
    }

    function positions(uint256 tokenId) external view returns (PositionData memory) {
        ownerOf(tokenId); // reverts for unknown ids
        return _positions[tokenId];
    }

    // ---------------------------------------------------------------- pool creation
    /// @notice create and initialise a pool if it does not exist yet. Tokens must be passed sorted so the price
    ///         is unambiguous (price = token1 per token0, Q64.96 square root).
    function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96)
        external
        payable
        returns (address pool)
    {
        if (token0 >= token1) revert TokensNotSorted();
        pool = ISwapexFactoryPeriphery(factory).getPool(token0, token1, fee);
        if (pool == address(0)) {
            pool = ISwapexFactoryPeriphery(factory).createPool(token0, token1, fee);
            ISwapexPoolActions(pool).initialize(sqrtPriceX96);
        } else {
            (uint160 current,,,) = ISwapexPoolView(pool).slot0();
            if (current == 0) ISwapexPoolActions(pool).initialize(sqrtPriceX96);
        }
    }

    // ---------------------------------------------------------------- mint
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    function mint(MintParams calldata p)
        external
        payable
        checkDeadline(p.deadline)
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        if (p.token0 >= p.token1) revert TokensNotSorted();
        if (p.recipient == address(0) || p.recipient == ADDRESS_THIS) revert InvalidRecipient();
        address pool = _pool(p.token0, p.token1, p.fee);

        (liquidity, amount0, amount1) = _addLiquidity(
            pool, p.token0, p.token1, p.fee, p.tickLower, p.tickUpper, p.amount0Desired, p.amount1Desired, p.amount0Min, p.amount1Min
        );

        (uint256 fg0, uint256 fg1) = _feeGrowthInside(pool, p.tickLower, p.tickUpper);
        tokenId = nextTokenId++;
        _mint(p.recipient, tokenId);
        _positions[tokenId] = PositionData({
            token0: p.token0,
            token1: p.token1,
            fee: p.fee,
            tickLower: p.tickLower,
            tickUpper: p.tickUpper,
            liquidity: liquidity,
            feeGrowthInside0LastX128: fg0,
            feeGrowthInside1LastX128: fg1,
            tokensOwed0: 0,
            tokensOwed1: 0
        });
        emit IncreaseLiquidity(tokenId, liquidity, amount0, amount1);
    }

    // ---------------------------------------------------------------- increase
    struct IncreaseParams {
        uint256 tokenId;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    /// @dev anyone may top up any position; the payer is the caller
    function increaseLiquidity(IncreaseParams calldata p)
        external
        payable
        checkDeadline(p.deadline)
        returns (uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        PositionData storage pos = _positions[p.tokenId];
        if (_ownerOf[p.tokenId] == address(0)) revert NonexistentToken();
        address pool = _pool(pos.token0, pos.token1, pos.fee);

        (liquidity, amount0, amount1) = _addLiquidity(
            pool, pos.token0, pos.token1, pos.fee, pos.tickLower, pos.tickUpper, p.amount0Desired, p.amount1Desired, p.amount0Min, p.amount1Min
        );

        _settleFees(pos, pool);
        pos.liquidity += liquidity;
        emit IncreaseLiquidity(p.tokenId, liquidity, amount0, amount1);
    }

    // ---------------------------------------------------------------- decrease
    struct DecreaseParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    /// @notice withdraw liquidity into the position's owed balance; call `collect` to receive the tokens
    function decreaseLiquidity(DecreaseParams calldata p)
        external
        payable
        checkDeadline(p.deadline)
        returns (uint256 amount0, uint256 amount1)
    {
        _requireAuthorized(p.tokenId);
        if (p.liquidity == 0) revert ZeroLiquidity();
        PositionData storage pos = _positions[p.tokenId];
        uint128 current = pos.liquidity;
        if (p.liquidity > current) revert InsufficientLiquidity();

        address pool = _pool(pos.token0, pos.token1, pos.fee);
        (amount0, amount1) = ISwapexPoolActions(pool).burn(pos.tickLower, pos.tickUpper, p.liquidity);
        if (amount0 < p.amount0Min || amount1 < p.amount1Min) revert PriceSlippage();

        _settleFees(pos, pool);
        pos.tokensOwed0 += amount0.toUint128();
        pos.tokensOwed1 += amount1.toUint128();
        pos.liquidity = current - p.liquidity;
        emit DecreaseLiquidity(p.tokenId, p.liquidity, amount0, amount1);
    }

    // ---------------------------------------------------------------- collect
    struct CollectParams {
        uint256 tokenId;
        address recipient; // ADDRESS_THIS keeps it here so it can be unwrapped to ETH with multicall
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function collect(CollectParams calldata p) external payable returns (uint256 amount0, uint256 amount1) {
        _requireAuthorized(p.tokenId);
        if (p.amount0Max == 0 && p.amount1Max == 0) revert ZeroCollect();
        address recipient = _resolve(p.recipient);

        PositionData storage pos = _positions[p.tokenId];
        address pool = _pool(pos.token0, pos.token1, pos.fee);

        // credit fees earned so far, then pay out from the owed balance
        if (pos.liquidity > 0) {
            ISwapexPoolActions(pool).burn(pos.tickLower, pos.tickUpper, 0);
            _settleFees(pos, pool);
        }

        uint128 owed0 = pos.tokensOwed0;
        uint128 owed1 = pos.tokensOwed1;
        uint128 want0 = p.amount0Max > owed0 ? owed0 : p.amount0Max;
        uint128 want1 = p.amount1Max > owed1 ? owed1 : p.amount1Max;

        // effects first
        pos.tokensOwed0 = owed0 - want0;
        pos.tokensOwed1 = owed1 - want1;

        (amount0, amount1) = ISwapexPoolActions(pool).collect(recipient, pos.tickLower, pos.tickUpper, want0, want1);
        // if the pool paid less than requested, leave the difference owed instead of losing it
        if (amount0 < want0) pos.tokensOwed0 += uint128(want0 - amount0);
        if (amount1 < want1) pos.tokensOwed1 += uint128(want1 - amount1);
        emit Collect(p.tokenId, recipient, amount0, amount1);
    }

    // ---------------------------------------------------------------- burn
    function burn(uint256 tokenId) external payable {
        _requireAuthorized(tokenId);
        PositionData storage pos = _positions[tokenId];
        if (pos.liquidity != 0 || pos.tokensOwed0 != 0 || pos.tokensOwed1 != 0) revert NotCleared();
        delete _positions[tokenId];
        _burn(tokenId);
    }

    // ---------------------------------------------------------------- pool callback
    function swapexMintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata raw) external override {
        MintCallbackData memory d = abi.decode(raw, (MintCallbackData));
        address pool = ISwapexFactoryPeriphery(factory).getPool(d.token0, d.token1, d.fee);
        if (msg.sender != pool || pool == address(0)) revert InvalidCaller();

        if (amount0Owed > 0) _pay(d.token0, d.payer, msg.sender, amount0Owed);
        if (amount1Owed > 0) _pay(d.token1, d.payer, msg.sender, amount1Owed);
    }

    // ---------------------------------------------------------------- internals
    function _pool(address a, address b, uint24 fee) private view returns (address pool) {
        pool = ISwapexFactoryPeriphery(factory).getPool(a, b, fee);
        if (pool == address(0)) revert PoolNotFound();
    }

    function _requireAuthorized(uint256 tokenId) private view {
        if (!_isApprovedOrOwner(msg.sender, tokenId)) revert NotAuthorized();
    }

    function _addLiquidity(
        address pool,
        address token0,
        address token1,
        uint24 fee,
        int24 tickLower,
        int24 tickUpper,
        uint256 amount0Desired,
        uint256 amount1Desired,
        uint256 amount0Min,
        uint256 amount1Min
    ) private returns (uint128 liquidity, uint256 amount0, uint256 amount1) {
        (uint160 sqrtP,,,) = ISwapexPoolView(pool).slot0();
        liquidity = LiquidityAmounts.liquidityForAmounts(
            sqrtP,
            TickMath.getSqrtRatioAtTick(tickLower),
            TickMath.getSqrtRatioAtTick(tickUpper),
            amount0Desired,
            amount1Desired
        );
        if (liquidity == 0) revert ZeroLiquidity();

        (amount0, amount1) = ISwapexPoolActions(pool).mint(
            address(this),
            tickLower,
            tickUpper,
            liquidity,
            abi.encode(MintCallbackData({token0: token0, token1: token1, fee: fee, payer: msg.sender}))
        );
        if (amount0 < amount0Min || amount1 < amount1Min) revert PriceSlippage();
    }

    function _feeGrowthInside(address pool, int24 tickLower, int24 tickUpper) private view returns (uint256 fg0, uint256 fg1) {
        bytes32 key = keccak256(abi.encodePacked(address(this), tickLower, tickUpper));
        (, fg0, fg1,,) = ISwapexPoolView(pool).positions(key);
    }

    /// @dev move fees earned since this NFT's last update into its owed balance
    function _settleFees(PositionData storage pos, address pool) private {
        (uint256 fg0, uint256 fg1) = _feeGrowthInside(pool, pos.tickLower, pos.tickUpper);
        uint128 liq = pos.liquidity;
        if (liq > 0) {
            uint256 d0;
            uint256 d1;
            unchecked {
                // growth differences wrap by design
                d0 = fg0 - pos.feeGrowthInside0LastX128;
                d1 = fg1 - pos.feeGrowthInside1LastX128;
            }
            pos.tokensOwed0 += FullMath.mulDiv(d0, liq, Q128).toUint128();
            pos.tokensOwed1 += FullMath.mulDiv(d1, liq, Q128).toUint128();
        }
        pos.feeGrowthInside0LastX128 = fg0;
        pos.feeGrowthInside1LastX128 = fg1;
    }
}
