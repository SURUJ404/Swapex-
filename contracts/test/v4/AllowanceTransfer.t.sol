// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {AllowanceTransfer} from "../../src/v4/periphery/AllowanceTransfer.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockERC20Permit} from "../mocks/MockERC20Permit.sol";
import {MockERC1271Wallet} from "../mocks/MockERC1271Wallet.sol";

/// @notice A.1 (signed, bounded allowances) + A.2 (OpenZeppelin SignatureChecker) coverage: every
///         way a signature can be wrong must be rejected, and the one way it is right must apply
///         exactly the grant that was signed.
contract AllowanceTransferTest is Test {
    /// secp256k1 group order — used to construct the malleable (s, v) twin of a signature.
    uint256 internal constant N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    /// EIP-2612 typehash (token-side permit, used by permitERC20).
    bytes32 internal constant ERC2612_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    uint256 internal constant ALICE_PK = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    uint256 internal constant MALLORY_PK = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;

    AllowanceTransfer at;
    MockERC20 token;
    MockERC20Permit permitToken;
    address alice;
    address mallory;
    address spender; // the account the grant authorises (stands in for the router)
    address bob;

    function setUp() public {
        at = new AllowanceTransfer();
        token = new MockERC20("T", "T", 18);
        permitToken = new MockERC20Permit();
        alice = vm.addr(ALICE_PK);
        mallory = vm.addr(MALLORY_PK);
        spender = makeAddr("spender");
        bob = makeAddr("bob");

        token.mint(alice, 1_000e18);
        permitToken.mint(alice, 1_000e18);

        // alice's one-time ERC-20 approval to the allowance contract (the always-on outer layer).
        vm.startPrank(alice);
        token.approve(address(at), type(uint256).max);
        permitToken.approve(address(at), type(uint256).max);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- helpers

    function _permit(uint48 nonce) internal view returns (AllowanceTransfer.PermitSingle memory) {
        return _permitFor(nonce, 100e18, uint48(block.timestamp + 1 days));
    }

    function _permitFor(uint48 nonce, uint160 amount, uint48 expiration)
        internal
        view
        returns (AllowanceTransfer.PermitSingle memory)
    {
        return AllowanceTransfer.PermitSingle({
            details: AllowanceTransfer.PermitDetails({
                token: address(token),
                amount: amount,
                expiration: expiration,
                nonce: nonce
            }),
            spender: spender,
            sigDeadline: _deadline()
        });
    }

    function _deadline() internal view returns (uint256) {
        return block.timestamp + 1 hours;
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (uint8 v, bytes32 r, bytes32 s) {
        return vm.sign(pk, digest);
    }

    /// @dev a ready-to-submit 65-byte signature pinned to the canonical low-s branch.
    function _sigLow(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return _lowS(v, r, s);
    }

    /// @dev the malleable twin of the same signature: recovers to the same signer, high s.
    function _sigHigh(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return _highS(v, r, s);
    }

    /// @dev the 65-byte (r, s, v) form of a signature forced onto the canonical low-s branch, so
    ///      the acceptance test and the malleability test are independent of whether `vm.sign`
    ///      hands back low or high s.
    function _lowS(uint8 v, bytes32 r, bytes32 s) internal pure returns (bytes memory) {
        uint256 sU = uint256(s);
        if (sU > N / 2) return abi.encodePacked(r, bytes32(N - sU), v == 27 ? uint8(28) : uint8(27));
        return abi.encodePacked(r, s, v);
    }

    /// @dev the malleable twin: recovers to the same signer, but with high s.
    function _highS(uint8 v, bytes32 r, bytes32 s) internal pure returns (bytes memory) {
        uint256 sU = uint256(s);
        if (sU > N / 2) return abi.encodePacked(r, s, v);
        return abi.encodePacked(r, bytes32(N - sU), v == 27 ? uint8(28) : uint8(27));
    }

    function _expectInvalid(address expectedSigner) internal {
        vm.expectRevert(abi.encodeWithSelector(AllowanceTransfer.InvalidSignature.selector, expectedSigner));
    }

    // ================================================================ accepting a correct signature

    function test_permit_validSignature_appliesExactlyTheSignedGrant() public {
        AllowanceTransfer.PermitSingle memory p = _permit(7);
        (uint8 v, bytes32 r, bytes32 s) = _sign(ALICE_PK, at.hashPermitSingle(p));

        at.permit(alice, p, _lowS(v, r, s));

        (uint160 amount, uint48 expiration) = at.allowanceOf(alice, address(token), spender);
        assertEq(uint256(amount), 100e18, "signed amount applied");
        assertEq(uint256(expiration), p.details.expiration, "signed expiration applied");
        assertTrue(at.isNonceUsed(alice, 7), "nonce burned");
    }

    function test_permit_acceptsThe65ByteFormAndRejectsThe64ByteCompactForm() public {
        AllowanceTransfer.PermitSingle memory p = _permit(0);
        bytes32 digest = at.hashPermitSingle(p);
        (uint8 v, bytes32 r, bytes32 s) = _sign(ALICE_PK, digest);

        // canonicalise onto the low-s branch, then derive *both* encodings of that one signature.
        (bytes32 sC, uint8 vC) = uint256(s) > N / 2
            ? (bytes32(N - uint256(s)), v == 27 ? uint8(28) : uint8(27))
            : (s, v);
        bytes memory canonical65 = abi.encodePacked(r, sC, vC);
        bytes memory compact64 = abi.encodePacked(r, bytes32(uint256(sC) | ((uint256(vC) - 27) << 255)));
        assertEq(canonical65.length, 65, "65-byte form");
        assertEq(compact64.length, 64, "EIP-2098 is 64 bytes");

        // OpenZeppelin's SignatureChecker -> ECDSA.tryRecover(bytes) dispatches purely on length and
        // only accepts the canonical 65-byte (r, s, v) encoding; a 64-byte EIP-2098 signature is
        // InvalidSignatureLength, hence a rejection rather than acceptance. Accepting it would mean
        // hand-rolling (r, vs) unpacking inside our own signature path, and every mainstream client
        // (ethers, viem) emits 65 bytes. Recorded in docs/CRYPTO_DECISIONS.md.
        _expectInvalid(alice);
        at.permit(alice, p, compact64);

        // the identical signer + digest in the canonical encoding succeeds, so the rejection above
        // is about the encoding only -- not the signer, the domain or the grant.
        at.permit(alice, p, canonical65);
        (uint160 amount,) = at.allowanceOf(alice, address(token), spender);
        assertEq(uint256(amount), 100e18, "65-byte form accepted");
    }
    function test_setAllowance_grantIsScopedToTheCaller() public {
        vm.prank(alice);
        at.setAllowance(address(token), spender, 42e18, uint48(block.timestamp + 1 days));

        (uint160 amount, uint48 expiration) = at.allowanceOf(alice, address(token), spender);
        assertEq(uint256(amount), 42e18, "amount recorded");
        assertGt(uint256(expiration), block.timestamp, "expiry in the future");
        // nobody else gained anything
        (uint160 malloryAmount,) = at.allowanceOf(mallory, address(token), spender);
        assertEq(uint256(malloryAmount), 0, "unrelated owner untouched");
    }

    // ================================================================ rejecting a wrong signature

    function test_permit_wrongSigner_reverts() public {
        AllowanceTransfer.PermitSingle memory p = _permit(0);
        // mallory signs, but alice is named as the owner: must not apply.
        (uint8 v, bytes32 r, bytes32 s) = _sign(MALLORY_PK, at.hashPermitSingle(p));
        _expectInvalid(alice);
        at.permit(alice, p, _lowS(v, r, s));
    }

    function test_permit_replayedSignature_reverts() public {
        AllowanceTransfer.PermitSingle memory p = _permit(0);
        bytes memory sig = _sigLow(ALICE_PK, at.hashPermitSingle(p));

        at.permit(alice, p, sig);

        // the signature itself is still perfectly valid — only the nonce is spent. This is what
        // makes a front-run harmless: the grant it created is already in place.
        vm.expectRevert(abi.encodeWithSelector(AllowanceTransfer.NonceAlreadyUsed.selector, alice, uint48(0)));
        at.permit(alice, p, sig);
    }

    function test_permit_tamperedNonce_reverts() public {
        AllowanceTransfer.PermitSingle memory signed = _permit(0);
        bytes memory sig = _sigLow(ALICE_PK, at.hashPermitSingle(signed));

        // same signer, same token, same everything except the nonce: a different struct is a
        // different EIP-712 digest, so the signature no longer authorises it.
        AllowanceTransfer.PermitSingle memory tampered = _permit(1);
        _expectInvalid(alice);
        at.permit(alice, tampered, sig);
    }

    function test_permit_wrongChainId_reverts() public {
        AllowanceTransfer.PermitSingle memory p = _permit(0);

        // mint the signature while pretending to be on one chain ...
        vm.chainId(1);
        bytes32 digestOnChain1 = at.hashPermitSingle(p);
        bytes memory sig = _sigLow(ALICE_PK, digestOnChain1);

        // ... then verify on another: the domain separator must differ, which is the whole point
        // of binding chainId into EIP-712 (otherwise a signature is replayable across chains).
        vm.chainId(31337);
        assertTrue(digestOnChain1 != at.hashPermitSingle(p), "chainId is part of the domain separator");

        _expectInvalid(alice);
        at.permit(alice, p, sig);
    }
    function test_permit_wrongVerifyingContract_reverts() public {
        // a permit signed against a *different* deployment of AllowanceTransfer must be useless
        // here: the domain's verifyingContract is part of the digest.
        AllowanceTransfer atElsewhere = new AllowanceTransfer();
        AllowanceTransfer.PermitSingle memory p = _permit(0);
        bytes memory sig = _sigLow(ALICE_PK, atElsewhere.hashPermitSingle(p));

        _expectInvalid(alice);
        at.permit(alice, p, sig);
    }

    function test_permit_expiredSignatureDeadline_reverts() public {
        AllowanceTransfer.PermitSingle memory p = _permit(0);
        bytes memory sig = _sigLow(ALICE_PK, at.hashPermitSingle(p));

        vm.warp(block.timestamp + 2 hours);

        vm.expectRevert(abi.encodeWithSelector(AllowanceTransfer.SignatureExpired.selector, p.sigDeadline));
        at.permit(alice, p, sig);
    }

    function test_permit_submitterCannotExtendTheSignedDeadline_reverts() public {
        // sigDeadline lives inside the signed struct (and its typehash): submitting the same
        // grant with a later deadline changes the digest, so the signature no longer verifies.
        // Before the fix the deadline was an unsigned parameter a submitter could set to
        // type(uint256).max and ignore the bound the signer chose.
        AllowanceTransfer.PermitSingle memory signed = _permit(0);
        bytes memory sig = _sigLow(ALICE_PK, at.hashPermitSingle(signed));

        AllowanceTransfer.PermitSingle memory extended = _permit(0);
        extended.sigDeadline = signed.sigDeadline + 30 days;

        vm.expectRevert(abi.encodeWithSelector(AllowanceTransfer.InvalidSignature.selector, alice));
        at.permit(alice, extended, sig);
    }

    function test_permit_grantAlreadyExpired_reverts() public {
        // a permit whose *allowance* window has already closed is useless and must be refused
        // outright, even though the signature and the submission deadline are both fine.
        uint48 pastExpiry = uint48(block.timestamp + 1 hours);
        AllowanceTransfer.PermitSingle memory p = _permitFor(0, 100e18, pastExpiry);
        p.sigDeadline = block.timestamp + 1 days; // stays valid across the warp below
        bytes memory sig = _sigLow(ALICE_PK, at.hashPermitSingle(p));

        vm.warp(uint256(pastExpiry) + 1);

        vm.expectRevert(abi.encodeWithSelector(AllowanceTransfer.AllowanceAlreadyExpired.selector, pastExpiry));
        at.permit(alice, p, sig);
    }

    function test_permit_malleableHighS_twinReverts() public {
        AllowanceTransfer.PermitSingle memory p = _permit(0);
        (uint8 v, bytes32 r, bytes32 s) = _sign(ALICE_PK, at.hashPermitSingle(p));

        // (r, N - s, flip(v)) recovers to alice under raw ECDSA, so without OpenZeppelin's low-s
        // rule two different byte strings would mean one grant — malleable signatures.
        _expectInvalid(alice);
        at.permit(alice, p, _highS(v, r, s));
    }

    function test_permit_canonicalLowSSucceeds_whereHighSFails() public {
        AllowanceTransfer.PermitSingle memory p = _permit(0);
        (uint8 v, bytes32 r, bytes32 s) = _sign(ALICE_PK, at.hashPermitSingle(p));
        at.permit(alice, p, _lowS(v, r, s));
        (uint160 amount,) = at.allowanceOf(alice, address(token), spender);
        assertEq(uint256(amount), 100e18, "low-s form accepted");
    }

    // ================================================================ EIP-5267 domain disclosure

    function test_eip712Domain_exposesNameVersionChainAndVerifier() public {
        (, string memory name, string memory version, uint256 chainId, address verifier,,) = at.eip712Domain();
        assertEq(name, "Swapex AllowanceTransfer", "domain name");
        assertEq(version, "1", "domain version");
        assertEq(chainId, block.chainid, "domain chainId pins this chain");
        assertEq(verifier, address(at), "domain verifyingContract pins this contract");
    }

    // ================================================================ nonce management

    function test_invalidateNonce_blocksAPendingSignedGrant() public {
        // alice signs a grant but decides to revoke it before anyone submits it.
        AllowanceTransfer.PermitSingle memory p = _permit(5);
        bytes memory sig = _sigLow(ALICE_PK, at.hashPermitSingle(p));

        vm.prank(alice);
        at.invalidateNonce(5);
        assertTrue(at.isNonceUsed(alice, 5), "nonce marked used");

        vm.expectRevert(abi.encodeWithSelector(AllowanceTransfer.NonceAlreadyUsed.selector, alice, uint48(5)));
        at.permit(alice, p, sig);
    }

    function test_invalidateNonce_cannotBeCalledTwice() public {
        vm.startPrank(alice);
        at.invalidateNonce(9);
        vm.expectRevert(abi.encodeWithSelector(AllowanceTransfer.NonceAlreadyUsed.selector, alice, uint48(9)));
        at.invalidateNonce(9);
        vm.stopPrank();
    }

    // ================================================================ bounded spending

    function test_transferFrom_decrementsABoundedAllowance() public {
        vm.prank(alice);
        at.setAllowance(address(token), spender, 100e18, uint48(block.timestamp + 1 days));

        vm.prank(spender);
        at.transferFrom(alice, bob, 60e18, address(token));

        (uint160 remaining,) = at.allowanceOf(alice, address(token), spender);
        assertEq(uint256(remaining), 40e18, "allowance decremented");
        assertEq(token.balanceOf(bob), 60e18, "tokens moved");
    }

    function test_transferFrom_unlimitedAllowanceIsNeverDecremented() public {
        vm.prank(alice);
        at.setAllowance(address(token), spender, type(uint160).max, uint48(block.timestamp + 1 days));

        vm.prank(spender);
        at.transferFrom(alice, bob, 1e18, address(token));

        (uint160 remaining,) = at.allowanceOf(alice, address(token), spender);
        assertEq(uint256(remaining), type(uint160).max, "infinite grant stays infinite until expiry");
    }

    function test_transferFrom_afterExpiry_reverts() public {
        uint48 expiry = uint48(block.timestamp + 1 hours);
        vm.prank(alice);
        at.setAllowance(address(token), spender, 100e18, expiry);

        vm.warp(uint256(expiry) + 1);

        vm.prank(spender);
        vm.expectRevert(abi.encodeWithSelector(AllowanceTransfer.AllowanceExpired.selector, expiry));
        at.transferFrom(alice, bob, 1e18, address(token));
    }

    function test_transferFrom_beyondTheGrant_reverts() public {
        vm.prank(alice);
        at.setAllowance(address(token), spender, 50e18, uint48(block.timestamp + 1 days));

        vm.prank(spender);
        vm.expectRevert(abi.encodeWithSelector(AllowanceTransfer.InsufficientAllowance.selector, uint160(50e18), 50e18 + 1));
        at.transferFrom(alice, bob, 50e18 + 1, address(token));
    }

    function test_transferFrom_callerWithoutAGrant_reverts() public {
        vm.prank(alice);
        at.setAllowance(address(token), spender, 100e18, uint48(block.timestamp + 1 days));

        // a third party holds no grant from alice, so it can pull nothing.
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(AllowanceTransfer.InsufficientAllowance.selector, uint160(0), 1e18));
        at.transferFrom(alice, mallory, 1e18, address(token));
    }

    function test_setAllowance_inThePast_reverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AllowanceTransfer.AllowanceAlreadyExpired.selector, uint48(1)));
        at.setAllowance(address(token), spender, 1e18, 1);
    }

    // ================================================================ ERC-2612 token approval

    function _erc2612Digest(address owner, address spenderAddr, uint256 value, uint256 deadline)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash =
            keccak256(abi.encode(ERC2612_TYPEHASH, owner, spenderAddr, value, permitToken.nonces(owner), deadline));
        return keccak256(abi.encodePacked("\x19\x01", permitToken.DOMAIN_SEPARATOR(), structHash));
    }

    function test_permitERC20_signsTheTokenApprovalInsteadOfSendingApprove() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = _erc2612Digest(alice, address(at), 250e18, deadline);
        (uint8 v, bytes32 r, bytes32 s) = _sign(ALICE_PK, digest);

        at.permitERC20(address(permitToken), alice, 250e18, deadline, v, r, s);

        assertEq(permitToken.allowance(alice, address(at)), 250e18, "token approval set by signature");
    }

    function test_permitERC20_unsupportedToken_reverts() public {
        // MockERC20 has no permit at all: empty revert data => our own typed error.
        vm.expectRevert(abi.encodeWithSelector(AllowanceTransfer.TokenDoesNotSupportPermit.selector, address(token)));
        at.permitERC20(address(token), alice, 1e18, block.timestamp + 1 hours, 27, bytes32(0), bytes32(0));
    }

    function test_permitERC20_bubblesTheTokensOwnError() public {
        // an expired EIP-2612 deadline makes the *token* revert; we must surface its reason rather
        // than swallow it (otherwise a caller cannot tell "unsupported" from "rejected").
        uint256 expired = block.timestamp - 1;
        (uint8 v, bytes32 r, bytes32 s) = _sign(ALICE_PK, keccak256("anything"));

        vm.expectRevert(abi.encodeWithSelector(ERC20Permit.ERC2612ExpiredSignature.selector, expired));
        at.permitERC20(address(permitToken), alice, 1e18, expired, v, r, s);
    }

    // ================================================================ ERC-1271 contract wallets

    function _wallet() internal returns (MockERC1271Wallet w) {
        w = new MockERC1271Wallet(alice); // alice's smart-contract wallet
        token.mint(address(w), 1_000e18);
        vm.prank(address(w)); // the wallet itself grants the outer ERC-20 approval
        token.approve(address(at), type(uint256).max);
    }

    function test_permit_erc1271Wallet_validSignature() public {
        MockERC1271Wallet w = _wallet();
        AllowanceTransfer.PermitSingle memory p = _permit(0);
        bytes memory sig = _sigLow(ALICE_PK, at.hashPermitSingle(p)); // the wallet's owner signs

        at.permit(address(w), p, sig);

        (uint160 amount,) = at.allowanceOf(address(w), address(token), spender);
        assertEq(uint256(amount), 100e18, "contract wallet accepted");
    }

    function test_permit_erc1271Wallet_invalidReply_reverts() public {
        MockERC1271Wallet w = _wallet();
        w.setMode(1); // wallet answers "not valid"
        AllowanceTransfer.PermitSingle memory p = _permit(0);
        bytes memory sig = _sigLow(ALICE_PK, at.hashPermitSingle(p));

        _expectInvalid(address(w));
        at.permit(address(w), p, sig);
    }

    function test_permit_erc1271Wallet_revertingWallet_revertsAsInvalid() public {
        MockERC1271Wallet w = _wallet();
        w.setMode(2); // wallet throws instead of answering
        AllowanceTransfer.PermitSingle memory p = _permit(0);
        bytes memory sig = _sigLow(ALICE_PK, at.hashPermitSingle(p));

        // a reverting ERC-1271 check must read as *invalid* — never as approval, never a crash.
        _expectInvalid(address(w));
        at.permit(address(w), p, sig);
    }
    // ================================================================ fuzz (run with --fuzz-runs 5000)

    function testFuzz_permit_signedGrantAppliesExactly(uint160 amount, uint48 nonce) public {
        AllowanceTransfer.PermitSingle memory p = _permitFor(nonce, amount, uint48(block.timestamp + 1 days));
        bytes memory sig = _sigLow(ALICE_PK, at.hashPermitSingle(p));

        at.permit(alice, p, sig);

        (uint160 recorded,) = at.allowanceOf(alice, address(token), spender);
        assertEq(uint256(recorded), uint256(amount), "recorded == signed");
        assertTrue(at.isNonceUsed(alice, nonce), "nonce burned");
    }

    function testFuzz_permit_tamperingWithTheSignedStructBreaksTheSignature(uint160 signedAmount, uint160 otherAmount)
        public
    {
        vm.assume(signedAmount != otherAmount);
        AllowanceTransfer.PermitSingle memory signed = _permitFor(0, signedAmount, uint48(block.timestamp + 1 days));
        bytes memory sig = _sigLow(ALICE_PK, at.hashPermitSingle(signed));

        AllowanceTransfer.PermitSingle memory tampered =
            _permitFor(0, otherAmount, uint48(block.timestamp + 1 days));

        _expectInvalid(alice);
        at.permit(alice, tampered, sig);
    }

    function testFuzz_transferFrom_spendsExactlyWhatWasGranted(uint256 g, uint256 spend) public {
        uint160 grant = uint160(bound(g, 1, 1_000e18));
        uint256 use = bound(spend, 0, uint256(grant));

        vm.prank(alice);
        at.setAllowance(address(token), spender, grant, uint48(block.timestamp + 1 days));

        vm.prank(spender);
        at.transferFrom(alice, bob, use, address(token));

        (uint160 remaining,) = at.allowanceOf(alice, address(token), spender);
        assertEq(uint256(remaining), uint256(grant) - use, "remaining == grant - use");
        assertEq(token.balanceOf(bob), use, "recipient got exactly the spend");
    }
}
