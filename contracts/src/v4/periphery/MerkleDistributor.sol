// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title MerkleDistributor - allowlisted token claims behind a timelocked Merkle root
/// @notice Pays out `token` to addresses that appear in a Merkle-committed allowlist
///         (testnet rewards, incentivized distributions - crypto item C in
///         docs/CRYPTO_DECISIONS.md). Threat model, in order:
///
///         1. Second-preimage attacks - a proof is a list of internal tree nodes; a naive
///            `keccak256(abi.encode(index, account, amount))` leaf can equal an internal
///            node of another tree, letting an attacker claim "as" that node. The leaf is
///            therefore DOUBLE-hashed: `keccak256(bytes.concat(keccak256(...)))`, so a
///            32-byte internal node can never be reinterpreted as a leaf. The convention
///            lives in one place (`leafOf`), and the JS generator
///            (apps/web/scripts/merkle.ts) must reproduce it bit-for-bit.
///         2. Forged proofs - proof verification uses OpenZeppelin's audited `MerkleProof`
///            (commutative/standard-typed tree, the same shape the generator emits); no
///            hand-rolled hashing anywhere. Every claim re-derives the leaf from
///            (index, account, amount), so a proof valid for one entry cannot pay another.
///         3. Double spends - claims are keyed by `index`, tracked in a 256-per-word
///            bitmap (`isClaimed`/`_setClaimed`, the OZ ERC20Permit pattern); a second
///            `claim` for a used index reverts with `AlreadyClaimed(index)`. State is
///            marked before the transfer (checks-effects-interactions), so a reentrant
///            token cannot claim twice.
///         4. Root rotation - the root decides who gets paid, so `setRoot` is
///            `onlyOwner` and deployments set the owner to the OZ `TimelockController`
///            (docs/DECISIONS.md D29): an update is schedule -> delay -> execute, and it
///            can be cancelled during the delay. A stolen EOA key cannot silently swap
///            the allowlist.
///
///         `claim` is permissionless on purpose: anyone may relay a claim, but `amount`
///         always goes to the `account` embedded in the leaf - a relayer can neither
///         redirect nor inflate a payout. Verification assumes nothing about `msg.sender`.
///
/// @dev The companion test (test/v4/MerkleDistributor.t.sol) consumes a fixture generated
///      by the TypeScript generator, and additionally proves that tampered claims,
///      single-hashed leaves, empty proofs, and duplicate claims all fail.
contract MerkleDistributor is Ownable2Step {
    using SafeERC20 for IERC20;

    error ZeroToken();
    error ZeroRoot();
    error ZeroAccount();
    error ZeroAmount();
    error AlreadyClaimed(uint256 index);
    error InvalidProof();

    /// @notice The token this distributor pays out.
    IERC20 public immutable token;

    /// @notice Root of the allowlist tree; zero only before construction sets it.
    bytes32 public merkleRoot;

    /// @notice claim bitmap: word `index / 256`, bit `index % 256`.
    mapping(uint256 => uint256) private claimedBitMap;

    event Claimed(uint256 indexed index, address indexed account, uint256 amount);
    event RootUpdated(bytes32 previousRoot, bytes32 newRoot);

    /// @param token_ ERC-20 paid out on claim (immutable - a mutable token would let the
    ///        owner swap what claimants receive).
    /// @param root_ Initial allowlist root; must be non-zero (a zero root would make every
    ///        claim fail while looking "unset").
    /// @param initialOwner Root-rotation authority - pass the TimelockController address in
    ///        real deployments (Ownable2Step also allows a later two-step handover).
    constructor(IERC20 token_, bytes32 root_, address initialOwner) Ownable(initialOwner) {
        if (address(token_) == address(0)) revert ZeroToken();
        if (root_ == bytes32(0)) revert ZeroRoot();
        token = token_;
        merkleRoot = root_;
    }

    /// @notice Whether the allowlist slot `index` has already been paid.
    function isClaimed(uint256 index) public view returns (bool) {
        uint256 word = index / 256;
        uint256 bit = index % 256;
        return claimedBitMap[word] & (uint256(1) << bit) != 0;
    }

    /// @notice The canonical double-hashed leaf for one allowlist entry.
    /// @dev Public pure so deploy scripts, tests, and reviewers can all derive leaves from
    ///      a single implementation instead of re-encoding the convention by hand.
    function leafOf(uint256 index, address account, uint256 amount) public pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(index, account, amount))));
    }

    /// @notice Rotate the allowlist root (timelocked: only the owner, which deployments
    ///         point at the TimelockController, can call this - see the contract-level
    ///         threat model for rotation semantics).
    /// @dev The claimed bitmap is keyed by leaf `index` and is NOT reset when the root rotates. A new
    ///      root must therefore use indices that were never claimed under any earlier root (e.g. continue
    ///      numbering from the previous tree's size); reusing an index whose bit is already set makes that
    ///      leaf permanently unclaimable (`AlreadyClaimed`) even though it is valid under the new root.
    function setRoot(bytes32 newRoot) external onlyOwner {
        if (newRoot == bytes32(0)) revert ZeroRoot();
        emit RootUpdated(merkleRoot, newRoot);
        merkleRoot = newRoot;
    }

    /// @notice Claim `amount` of `token` for `account` at allowlist slot `index`.
    /// @dev Permissionless relay: funds always go to the leaf's `account`. Reverts with
    ///      `AlreadyClaimed(index)` before any proof work if the slot is spent, and marks
    ///      the slot claimed before transferring (CEI - a reentrant token sees the slot
    ///      spent on its way back in).
    function claim(uint256 index, address account, uint256 amount, bytes32[] calldata proof) external {
        if (account == address(0)) revert ZeroAccount();
        if (amount == 0) revert ZeroAmount();
        if (isClaimed(index)) revert AlreadyClaimed(index);
        bytes32 leaf = leafOf(index, account, amount);
        if (!MerkleProof.verify(proof, merkleRoot, leaf)) revert InvalidProof();
        _setClaimed(index);
        emit Claimed(index, account, amount);
        token.safeTransfer(account, amount);
    }

    function _setClaimed(uint256 index) private {
        uint256 word = index / 256;
        uint256 bit = index % 256;
        claimedBitMap[word] |= (uint256(1) << bit);
    }
}
