// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @title  AllowanceTransfer — bounded, signed ERC-20 allowances (Permit2-style, own implementation)
/// @notice A user grants a `spender` (the Swapex router) a *bounded* allowance over one token:
///         an `amount`, an `expiration`, identified by a `nonce` burned in a 256-bit bitmap. A
///         grant can be made two ways, both authorised by the owner:
///
///           1. `permit`     — an EIP-712 typed-data signature (EIP-712 domain = name, version,
///                             chainId, verifyingContract) so a relayer can submit it gaslessly.
///                             The nonce is consumed on use, so a signed grant can be executed at
///                             most once: a stale or front-run copy can never be replayed.
///           2. `setAllowance` — an on-chain call where `msg.sender` is the owner (the owner's own
///                             transaction signature is the authorisation), for callers that prefer
///                             a plain approval over signing typed data.
///
///         The owner still gives the *token* a single `approve(this)` once — either directly or
///         through the token's own EIP-2612 `permit` via `permitERC20`. Every *spend* is then
///         authorised by a bounded allowance rather than a standing, never-expiring ERC-20
///         approval to the router, and the router can only pull what a valid grant allows, until
///         it expires. Signature checks go through OpenZeppelin `SignatureChecker`, so EOAs and
///         ERC-1271 contract wallets both work.
contract AllowanceTransfer is EIP712 {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------ typed-data structs
    struct PermitDetails {
        address token;
        uint160 amount;
        uint48 expiration;
        uint48 nonce;
    }

    struct PermitSingle {
        PermitDetails details;
        address spender;
        /// @dev latest time the signature may be submitted on-chain. Inside the struct (and the
        ///      typehash), so a submitter cannot extend it — an unsigned parameter would let the
        ///      submitter pass type(uint256).max and ignore the bound the signer chose.
        uint256 sigDeadline;
    }

    // ------------------------------------------------------------------ state
    struct Allowance {
        uint160 amount;
        uint48 expiration;
    }

    /// @dev owner => token => spender => allowance. Scoped per spender so one spender's grant
    ///      never widens another's reach.
    mapping(address => mapping(address => mapping(address => Allowance))) private _allowances;

    /// @dev owner => word => bitmap of consumed nonces (each word holds 256 nonce bits).
    mapping(address => mapping(uint256 => uint256)) public nonceBitmap;

    // ------------------------------------------------------------------ typehashes
    bytes32 public constant PERMIT_DETAILS_TYPEHASH =
        keccak256("PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)");

    bytes32 public constant PERMIT_SINGLE_TYPEHASH = keccak256(
        "PermitSingle(PermitDetails details,address spender,uint256 sigDeadline)"
        "PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)"
    );

    // ------------------------------------------------------------------ events
    event PermitSet(
        address indexed owner,
        address indexed spender,
        address indexed token,
        uint160 amount,
        uint48 expiration,
        uint48 nonce
    );
    event AllowanceSet(address indexed owner, address indexed spender, address indexed token, uint160 amount, uint48 expiration);
    event NonceInvalidated(address indexed owner, uint48 nonce);
    event Pulled(address indexed owner, address indexed spender, address indexed to, address token, uint256 amount);

    // ------------------------------------------------------------------ errors
    error SignatureExpired(uint256 deadline);
    error InvalidSignature(address signer);
    error NonceAlreadyUsed(address owner, uint48 nonce);
    error AllowanceAlreadyExpired(uint48 expiration);
    error AllowanceExpired(uint48 expiration);
    error InsufficientAllowance(uint160 available, uint256 requested);
    error TokenDoesNotSupportPermit(address token);

    constructor() EIP712("Swapex AllowanceTransfer", "1") {}

    // ------------------------------------------------------------------ signed grant (meta-tx)
    /// @notice grant `permitSingle.spender` an allowance over `permitSingle.details.token`, authorised
    ///         by `owner`'s EIP-712 signature. Anyone may submit this (relayers welcome); only the
    ///         signature binds it to `owner`.
    /// @param owner      the token holder granting the allowance (must be the signer / ERC-1271 wallet)
    /// @param permitSingle the grant; `permitSingle.sigDeadline` is the latest time it may be
    ///                     submitted on-chain and is covered by the signature
    function permit(address owner, PermitSingle memory permitSingle, bytes calldata signature) external {
        if (block.timestamp > permitSingle.sigDeadline) revert SignatureExpired(permitSingle.sigDeadline);

        PermitDetails memory d = permitSingle.details;
        // a grant that is already expired is useless and almost certainly a client bug
        if (d.expiration <= block.timestamp) revert AllowanceAlreadyExpired(d.expiration);

        bytes32 digest = _hashTypedDataV4(_hashPermitSingle(permitSingle));
        if (!SignatureChecker.isValidSignatureNow(owner, digest, signature)) revert InvalidSignature(owner);

        _useNonce(owner, d.nonce);
        _writeAllowance(owner, d.token, permitSingle.spender, d.amount, d.expiration);
        emit PermitSet(owner, permitSingle.spender, d.token, d.amount, d.expiration, d.nonce);
    }

    // ------------------------------------------------------------------ on-chain grant (tx-signed)
    /// @notice grant `spender` an allowance over `token`, authorised by this transaction's own sender
    ///         signature (`msg.sender` is the owner). No typed-data signature needed.
    function setAllowance(address token, address spender, uint160 amount, uint48 expiration) external {
        if (expiration <= block.timestamp) revert AllowanceAlreadyExpired(expiration);
        _writeAllowance(msg.sender, token, spender, amount, expiration);
        emit AllowanceSet(msg.sender, spender, token, amount, expiration);
    }

    /// @notice burn `nonce` so any already-signed grant using it can never be submitted later
    ///         (revokes a pending, not-yet-used signature).
    function invalidateNonce(uint48 nonce) external {
        _useNonce(msg.sender, nonce);
        emit NonceInvalidated(msg.sender, nonce);
    }

    // ------------------------------------------------------------------ spend
    /// @notice pull `amount` of `token` from `from` to `to`, spending this caller's allowance.
    ///         Only the allowance's own spender (`msg.sender`) may call it.
    function transferFrom(address from, address to, uint256 amount, address token) external {
        Allowance memory allowed = _allowances[from][token][msg.sender];
        // amount first, so an account that never granted anything reports the missing grant
        // (InsufficientAllowance) rather than an expiry of the epoch-zero default.
        if (amount > allowed.amount) revert InsufficientAllowance(allowed.amount, amount);
        if (block.timestamp > allowed.expiration) revert AllowanceExpired(allowed.expiration);

        if (allowed.amount != type(uint160).max) {
            // bounded allowance: decrement. `amount <= allowed.amount` (checked above) and both fit
            // in uint160, so the subtraction cannot underflow and the cast cannot truncate.
            _allowances[from][token][msg.sender].amount = uint160(allowed.amount - amount);
        }
        // amount == uint160.max is the "unlimited until expiration" grant: leave it untouched.

        IERC20(token).safeTransferFrom(from, to, amount);
        emit Pulled(from, msg.sender, to, token, amount);
    }

    // ------------------------------------------------------------------ one-time token approval via EIP-2612
    /// @notice approve this contract to move `value` of `token` from `owner`, using the token's own
    ///         EIP-2612 `permit` so no `approve` transaction is ever sent. Reverts with
    ///         `TokenDoesNotSupportPermit` when the token has no `permit` (caller should fall back to
    ///         `token.approve(this, …)`), and bubbles the token's own error on a bad signature.
    function permitERC20(
        address token,
        address owner,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        try IERC20Permit(token).permit(owner, address(this), value, deadline, v, r, s) {
            // allowance owner->this contract is now set by the token
        } catch (bytes memory reason) {
            if (reason.length == 0) revert TokenDoesNotSupportPermit(token);
            // bubble the token's real error (bad signature, expired, …) so the caller sees why
            assembly ("memory-safe") {
                revert(add(reason, 0x20), mload(reason))
            }
        }
    }

    // ------------------------------------------------------------------ views
    /// @notice the current allowance `owner` granted `spender` over `token`.
    function allowanceOf(address owner, address token, address spender)
        external
        view
        returns (uint160 amount, uint48 expiration)
    {
        Allowance memory a = _allowances[owner][token][spender];
        return (a.amount, a.expiration);
    }

    /// @notice true once `nonce` has been consumed (used or invalidated) for `owner`.
    function isNonceUsed(address owner, uint48 nonce) public view returns (bool) {
        uint256 word = uint256(nonce) / 256;
        uint256 bit = 1 << (uint256(nonce) % 256);
        return nonceBitmap[owner][word] & bit != 0;
    }

    /// @notice the full EIP-712 digest of `permitSingle`, so clients and tests can `sign` it directly.
    function hashPermitSingle(PermitSingle memory permitSingle) public view returns (bytes32) {
        return _hashTypedDataV4(_hashPermitSingle(permitSingle));
    }

    // ------------------------------------------------------------------ internals
    function _hashPermitSingle(PermitSingle memory p) private pure returns (bytes32) {
        bytes32 detailsHash = keccak256(
            abi.encode(PERMIT_DETAILS_TYPEHASH, p.details.token, p.details.amount, p.details.expiration, p.details.nonce)
        );
        return keccak256(abi.encode(PERMIT_SINGLE_TYPEHASH, detailsHash, p.spender, p.sigDeadline));
    }

    /// @dev set the bit for `nonce` in `owner`'s bitmap, reverting if it is already set.
    function _useNonce(address owner, uint48 nonce) private {
        uint256 word = uint256(nonce) / 256;
        uint256 bit = 1 << (uint256(nonce) % 256);
        if (nonceBitmap[owner][word] & bit != 0) revert NonceAlreadyUsed(owner, nonce);
        // bitwise OR: cannot overflow, no checked-arithmetic risk
        nonceBitmap[owner][word] |= bit;
    }

    function _writeAllowance(address owner, address token, address spender, uint160 amount, uint48 expiration) private {
        _allowances[owner][token][spender] = Allowance({amount: amount, expiration: expiration});
    }
}
