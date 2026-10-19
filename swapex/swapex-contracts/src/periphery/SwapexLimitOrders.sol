// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {TransferHelper} from "../libraries/TransferHelper.sol";
import {FullMath} from "../libraries/FullMath.sol";
import {IERC20Minimal} from "../interfaces/IERC20Minimal.sol";

interface ISwapexRouterExactInput {
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

    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256 amountOut);
}

interface IERC20Allowance {
    function allowance(address owner, address spender) external view returns (uint256);
}

/// @notice Non-custodial limit orders over Swapex pools.
///
/// A maker signs an EIP-712 `Order`; anyone (the keeper, a friend, a bot) can fill it against a
/// Swapex pool through the router. The contract never holds funds beyond a single transaction:
/// fill pulls exactly the maker's input (which the maker approved beforehand), swaps it, and the
/// pool pays `order.receiver` directly.
///
/// Partial fills are allowed. Each fill must earn at least its share of `minAmountOut`
/// (pro-rata, rounded down), and the filler supplies their own per-fill `minAmountOut` for
/// immediate slippage protection. Orders are cancelled by nonce. The EIP-712 domain binds the
/// chain id and this contract, so a signature is valid on exactly one chain and one deployment.
/// ERC-1271 makers (smart wallets) are supported through OpenZeppelin's SignatureChecker.
///
/// Known limit: fee-on-transfer input tokens are rejected (the pulled amount must equal the
/// requested amount); fee-on-transfer output tokens cannot be detected here - the UI warns.
contract SwapexLimitOrders {
    // ---------------------------------------------------------------- errors
    error InvalidRouter();
    error ZeroAmount();
    error SameToken();
    error ZeroMaker();
    error ZeroReceiver();
    error OrderExpired();
    error FillDeadlinePassed();
    error NonceAlreadyCancelled();
    error OrderAlreadyFilled();
    error InvalidSignature();
    error NothingToFill();
    error FeeOnTransferToken();
    error ProRataSlippage();
    error ApproveFailed();
    error Reentrancy();

    // ---------------------------------------------------------------- eip-712
    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "Order(address maker,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint256 expiry,uint256 nonce,address receiver)"
    );
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("SwapexLimitOrders");
    bytes32 private constant VERSION_HASH = keccak256("1");

    struct Order {
        address maker;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minAmountOut;
        uint256 expiry;
        uint256 nonce;
        address receiver;
    }

    struct FillParams {
        Order order;
        uint256 amountInMax; // cap on tokenIn for this fill; the rest of the order stays open
        uint256 minAmountOut; // this fill's own slippage floor, enforced by the router
        uint24 fee; // pool fee tier to fill against
        uint256 deadline; // router deadline for this transaction
        bytes signature; // the maker's EIP-712 signature over the order
    }

    struct OrderState {
        uint256 filled; // tokenIn filled so far
        uint256 amountOutReceived; // tokenOut delivered so far (sum of fills)
    }

    /// @dev the router every fill goes through; set once, never changed
    address public immutable router;

    /// order digest => how much of it has been filled
    mapping(bytes32 => OrderState) public orders;
    /// maker => nonce => cancelled (cancel by nonce; a reused nonce is cancelled for all its orders)
    mapping(address => mapping(uint256 => bool)) public cancelled;

    event OrderFilled(
        bytes32 indexed orderHash,
        address indexed maker,
        address indexed filler,
        address tokenIn,
        address tokenOut,
        uint256 amountInFilled,
        uint256 amountOutPaid
    );
    event OrderCancelled(address indexed maker, uint256 nonce);

    bool private locked;

    modifier nonReentrant() {
        if (locked) revert Reentrancy();
        locked = true;
        _;
        locked = false;
    }

    constructor(address router_) {
        if (router_ == address(0)) revert InvalidRouter();
        router = router_;
    }

    // ---------------------------------------------------------------- views
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    /// struct hash of an order (the EIP-712 payload before the domain is mixed in)
    function hashOrder(Order calldata order) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                ORDER_TYPEHASH,
                order.maker,
                order.tokenIn,
                order.tokenOut,
                order.amountIn,
                order.minAmountOut,
                order.expiry,
                order.nonce,
                order.receiver
            )
        );
    }

    /// the digest a wallet must sign (and the indexer must verify)
    function orderHash(Order calldata order) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), hashOrder(order)));
    }

    function remainingIn(Order calldata order) public view returns (uint256) {
        OrderState memory state = orders[orderHash(order)];
        return order.amountIn > state.filled ? order.amountIn - state.filled : 0;
    }

    /// honest fillability summary for keepers and the UI: nothing is hidden behind a revert
    function canFill(Order calldata order) external view returns (bool fillable, uint256 remaining) {
        remaining = remainingIn(order);
        fillable = remaining > 0 && block.timestamp <= order.expiry && !cancelled[order.maker][order.nonce];
    }

    // ---------------------------------------------------------------- cancel
    /// @notice cancel every order the caller signed with this nonce
    function cancel(uint256 nonce) external {
        cancelled[msg.sender][nonce] = true;
        emit OrderCancelled(msg.sender, nonce);
    }

    // ---------------------------------------------------------------- fill
    /// @notice fill an order (fully or partially) against a Swapex pool. Anyone may call this;
    ///         the input comes from the maker and the output goes to `order.receiver`.
    function fill(FillParams calldata p) external nonReentrant returns (uint256 amountInFilled, uint256 amountOutPaid) {
        Order calldata o = p.order;

        if (o.maker == address(0)) revert ZeroMaker();
        if (o.receiver == address(0)) revert ZeroReceiver();
        if (o.tokenIn == o.tokenOut) revert SameToken();
        if (o.amountIn == 0 || o.minAmountOut == 0) revert ZeroAmount();
        if (block.timestamp > o.expiry) revert OrderExpired();
        if (block.timestamp > p.deadline) revert FillDeadlinePassed();
        if (cancelled[o.maker][o.nonce]) revert NonceAlreadyCancelled();

        bytes32 hash = orderHash(o);
        OrderState memory state = orders[hash];
        if (o.amountIn <= state.filled) revert OrderAlreadyFilled();
        if (!SignatureChecker.isValidSignatureNow(o.maker, hash, p.signature)) revert InvalidSignature();

        uint256 remaining = o.amountIn - state.filled;
        amountInFilled = p.amountInMax < remaining ? p.amountInMax : remaining;
        if (amountInFilled == 0) revert NothingToFill();

        // pull the maker's input tokens; they leave again in this same transaction
        uint256 balanceBefore = IERC20Minimal(o.tokenIn).balanceOf(address(this));
        TransferHelper.safeTransferFrom(o.tokenIn, o.maker, address(this), amountInFilled);
        uint256 received = IERC20Minimal(o.tokenIn).balanceOf(address(this)) - balanceBefore;
        if (received != amountInFilled) revert FeeOnTransferToken();

        _approve(o.tokenIn, router, received);
        amountOutPaid = ISwapexRouterExactInput(router)
            .exactInputSingle(
                ISwapexRouterExactInput.ExactInputSingleParams({
                    tokenIn: o.tokenIn,
                    tokenOut: o.tokenOut,
                    fee: p.fee,
                    recipient: o.receiver, // the pool pays the receiver directly: no custody
                    deadline: p.deadline,
                    amountIn: received,
                    amountOutMinimum: p.minAmountOut,
                    sqrtPriceLimitX96: 0
                })
            );
        _approve(o.tokenIn, router, 0);

        // order-level economics: the running total must keep pace with the pro-rata share of
        // minAmountOut (floor, so the check never overstates what the maker was promised)
        uint256 totalFilled = state.filled + amountInFilled;
        uint256 totalOut = state.amountOutReceived + amountOutPaid;
        uint256 floorOut = FullMath.mulDiv(o.minAmountOut, totalFilled, o.amountIn);
        if (totalOut < floorOut) revert ProRataSlippage();

        orders[hash] = OrderState({filled: totalFilled, amountOutReceived: totalOut});
        emit OrderFilled(hash, o.maker, msg.sender, o.tokenIn, o.tokenOut, amountInFilled, amountOutPaid);
    }

    // ---------------------------------------------------------------- erc20 plumbing
    /// @dev approve with a zero-reset first, so USDT-style tokens that require it keep working
    function _approve(address token, address spender, uint256 value) private {
        uint256 current = IERC20Allowance(token).allowance(address(this), spender);
        if (current == value) return;
        if (current != 0) _rawApprove(token, spender, 0);
        if (value != 0) _rawApprove(token, spender, value);
    }

    function _rawApprove(address token, address spender, uint256 value) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0x095ea7b3, spender, value)); // approve(address,uint256)
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert ApproveFailed();
    }
}
