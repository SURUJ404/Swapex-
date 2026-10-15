// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SwapParams} from "../PoolManager.sol";
import {BalanceDelta, amount0, amount1} from "../types/BalanceDelta.sol";
import {currency} from "../types/Currency.sol";
import {PoolKey} from "../types/PoolKey.sol";
import {TickMath} from "../../libraries/TickMath.sol";
import {AllowanceTransfer} from "./AllowanceTransfer.sol";
import {Router} from "./Router.sol";

/// @title  LimitOrders — signed, partially-fillable swap orders (EIP-712)
/// @notice A maker signs an order off-chain — "swap exactly `amountIn` of `tokenIn` for at least
///         `minAmountOut` of `tokenOut` on the pool identified by `(tokenIn, tokenOut, fee,
///         tickSpacing, hooks)`, pay the output to `receiver`, valid until `deadline`, identified
///         by `nonce`" — and anyone (a filler, a relayer, the maker themselves) may execute it
///         on-chain through the router. No order ever moves a token without the maker's signature;
///         fills are bounded by what was signed, in full or in part, and the maker can kill any
///         nonce with `cancel`.
///
///         Threat model (see docs/CRYPTO_DECISIONS.md A.3): a filled order must never be replayed
///         (nonce + per-(maker,nonce) digest binding + signed deadline + EIP-712 domain with
///         chainId and this contract as verifyingContract), a filler must never be able to take
///         more input than signed or deliver less output than the signed rate, and a canceled
///         order must stay dead. Funds move only through `AllowanceTransfer` grants and the
///         router's own settlement — this contract never holds a user's tokens outside a fill.
contract LimitOrders is EIP712 {
    using SafeERC20 for IERC20;
    // ------------------------------------------------------------------ typed-data structs
    struct Order {
        address maker;
        address tokenIn;
        address tokenOut;
        uint24 fee;
        /// @dev the pool's tick spacing. Part of the signed pool identity: without it a filler
        ///      could route the fill through a same-pair, same-fee pool whose spacing the maker
        ///      never chose (D41).
        int24 tickSpacing;
        /// @dev the pool's hook address (`address(0)` for a hookless pool). Part of the signed
        ///      pool identity: a hook can skim, re-enter or gate a swap, so a maker must not have
        ///      to trust whichever hook a filler picks (D41).
        address hooks;
        uint256 amountIn;
        uint256 minAmountOut;
        address receiver;
        uint48 nonce;
        /// @dev latest time the order may be filled. Covered by the signature — the filler cannot
        ///      extend it (D28 applies to every signed message in this repo).
        uint48 deadline;
    }

    // ------------------------------------------------------------------ state
    /// @dev maker => nonce => the digest of the first order bound to that nonce. A second, byte-
    ///      different order on the same nonce is refused, so "filled" always means "filled of
    ///      *this* order" and two orders can never share fill accounting.
    mapping(address => mapping(uint48 => bytes32)) public orderDigest;
    /// @dev maker => nonce => `amountIn` filled so far (partial-fill accounting).
    mapping(address => mapping(uint48 => uint256)) public filled;
    /// @dev maker => nonce => canceled. Scoped by maker, so canceling one account's nonce can
    ///      never touch another's.
    mapping(address => mapping(uint48 => bool)) public canceled;

    Router public immutable router;
    AllowanceTransfer public immutable at;

    // ------------------------------------------------------------------ typehashes
    // The signed payload now names the *whole* pool key (fee + tickSpacing + hooks), not just the
    // pair and fee, so a filler cannot substitute a pool the maker never chose (D41).
    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "Order(address maker,address tokenIn,address tokenOut,uint24 fee,int24 tickSpacing,"
        "address hooks,uint256 amountIn,uint256 minAmountOut,address receiver,uint48 nonce,"
        "uint48 deadline)"
    );

    // ------------------------------------------------------------------ events
    event OrderFilled(
        address indexed maker,
        uint48 indexed nonce,
        address indexed filler,
        uint256 amountInFilled,
        uint256 amountOut,
        address receiver
    );
    event OrderCanceled(address indexed maker, uint48 indexed nonce);

    // ------------------------------------------------------------------ errors
    error OrderExpired(uint48 deadline);
    error OrderCanceledError(address maker, uint48 nonce);
    error NonceReusedForDifferentOrder(address maker, uint48 nonce);
    error InvalidSignature(address signer);
    error ZeroAmountIn();
    error ZeroFill();
    error FillExceedsRemaining(uint256 requested, uint256 remaining);
    error NativeInputNotSupported();
    error PoolMismatch();

    /// @dev version "2": D41 added `tickSpacing` and `hooks` to the signed struct. The domain
    ///      version is bumped alongside the typehash so a v1 digest can never collide with a v2
    ///      one even for an order whose other fields are identical.
    constructor(Router _router, AllowanceTransfer _at) EIP712("Swapex LimitOrders", "2") {
        router = _router;
        at = _at;
    }

    // ------------------------------------------------------------------ signed order
    /// @notice the full EIP-712 digest of `order`, so clients and tests can `sign` it directly.
    function hashOrder(Order calldata order) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    ORDER_TYPEHASH,
                    order.maker,
                    order.tokenIn,
                    order.tokenOut,
                    order.fee,
                    order.tickSpacing,
                    order.hooks,
                    order.amountIn,
                    order.minAmountOut,
                    order.receiver,
                    order.nonce,
                    order.deadline
                )
            )
        );
    }

    /// @notice the maker's cancellation of their own nonce: a pending (or partially filled) order
    ///         can never be filled again. Idempotent; scoped to `msg.sender`'s nonces only.
    function cancel(uint48 nonce) external {
        canceled[msg.sender][nonce] = true;
        emit OrderCanceled(msg.sender, nonce);
    }

    /// @notice fill `fillAmount` (base units of `tokenIn`) of `order`, authorised by the maker's
    ///         signature. Callable by anyone; the output is paid straight to `order.receiver`.
    /// @param key   the pool to fill against. Its currencies, fee, `tickSpacing` and `hooks` must
    ///               all equal the signed values — the whole pool identity is covered by the
    ///               signature (D41), so a filler can never route the fill through a pool the
    ///               maker did not choose.
    /// @param fillAmount how much of `amountIn` to execute now; may be less than `amountIn`
    ///               (partial fill), never more than what remains.
    function fillOrder(Order calldata order, PoolKey calldata key, uint256 fillAmount, bytes calldata signature)
        external
        returns (uint256 amountOut)
    {
        if (block.timestamp > order.deadline) revert OrderExpired(order.deadline);
        if (canceled[order.maker][order.nonce]) revert OrderCanceledError(order.maker, order.nonce);
        if (order.amountIn == 0) revert ZeroAmountIn();
        if (fillAmount == 0) revert ZeroFill();
        // input is pulled through AllowanceTransfer, which moves ERC-20s only; an order that
        // "spends" native ETH has no pull path and would fail confusingly later.
        if (order.tokenIn == address(0)) revert NativeInputNotSupported();

        // the pool must be exactly the signed one: both currencies (either direction), the signed
        // fee, and — since D41 — the signed tickSpacing and hooks.
        address k0 = currency.unwrap(key.currency0);
        address k1 = currency.unwrap(key.currency1);
        if (
            key.fee != order.fee || key.tickSpacing != order.tickSpacing || key.hooks != order.hooks
                || !((k0 == order.tokenIn && k1 == order.tokenOut) || (k0 == order.tokenOut && k1 == order.tokenIn))
        ) revert PoolMismatch();

        bytes32 digest = hashOrder(order);
        if (!SignatureChecker.isValidSignatureNow(order.maker, digest, signature)) {
            revert InvalidSignature(order.maker);
        }

        // bind this nonce to exactly this order (checked after the signature so only a valid
        // maker can bind their own nonce), then enforce partial-fill accounting.
        bytes32 prev = orderDigest[order.maker][order.nonce];
        if (prev == bytes32(0)) {
            orderDigest[order.maker][order.nonce] = digest;
        } else if (prev != digest) {
            revert NonceReusedForDifferentOrder(order.maker, order.nonce);
        }

        uint256 already = filled[order.maker][order.nonce];
        if (already >= order.amountIn) {
            revert FillExceedsRemaining(fillAmount, 0);
        }
        uint256 remaining = order.amountIn - already;
        if (fillAmount > remaining) revert FillExceedsRemaining(fillAmount, remaining);

        // effects before interactions: a re-entrant fill sees the updated remaining and can only
        // execute what this call did not already consume (CEI; no reentrancy guard needed).
        filled[order.maker][order.nonce] = already + fillAmount;

        // the maker granted *this contract* a bounded allowance (permit/setAllowance with
        // spender = LimitOrders); spend it exactly as signed.
        at.transferFrom(order.maker, address(this), fillAmount, order.tokenIn);

        _ensureSpendRights(order.tokenIn, fillAmount);

        // signed floor for *this* partial fill: the order's rate (minAmountOut per amountIn),
        // scaled linearly by fillAmount, computed in 512-bit precision (OZ Math, no overflow).
        uint256 minOut = Math.mulDiv(order.minAmountOut, fillAmount, order.amountIn, Math.Rounding.Ceil);
        bool zeroForOne = k0 == order.tokenIn;
        SwapParams memory sp = SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: int256(fillAmount),
            sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1
        });
        // the signed deadline was already checked above, and is reused as the router's tx-level
        // deadline: a fill can never execute later than the maker permitted (B.1).
        BalanceDelta d = router.exactInputSingle(key, sp, order.receiver, minOut, order.deadline);
        // the output currency is the positive side of an exact-input delta; floor at zero so a
        // degenerate no-fill (price limit hit immediately) reports 0 rather than wrapping.
        int256 out = zeroForOne ? amount1(d) : amount0(d);
        amountOut = out > 0 ? uint256(out) : 0;

        emit OrderFilled(order.maker, order.nonce, msg.sender, fillAmount, amountOut, order.receiver);
    }

    /// @dev the two approval layers this contract itself must hold before the router can pull its
    ///      input out of us: (1) the one-time outer ERC-20 approve to `AllowanceTransfer`
    ///      (`forceApprove` so non-standard tokens like USDT work), and (2) the per-spender grant
    ///      the router spends. Both are granted at max/never for convenience, but between fills
    ///      this contract holds zero balance, so they cover nothing at rest. Cheap to check, so
    ///      re-checked on every fill rather than tracked.
    function _ensureSpendRights(address token, uint256 fillAmount) private {
        if (IERC20(token).allowance(address(this), address(at)) < fillAmount) {
            IERC20(token).forceApprove(address(at), type(uint256).max);
        }
        (uint160 allowed, uint48 expiry) = at.allowanceOf(address(this), token, address(router));
        if (allowed < fillAmount || expiry <= block.timestamp) {
            at.setAllowance(token, address(router), type(uint160).max, type(uint48).max);
        }
    }
}
