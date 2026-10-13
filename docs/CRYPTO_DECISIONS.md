# Swapex — cryptography decisions (threat-first log)

Every entry follows the same shape: **named threat → primitive used → rejected alternatives →
assumptions → what breaks**. If an item has no named threat it gets *no* code and *no* entry —
that absence is intentional, not an oversight.

## Rules this log enforces

1. **Never implement a primitive by hand.** Signatures, hashing, EIP-712, Merkle proofs and nonce
   handling come from OpenZeppelin (pinned below) or from `ethers`/`viem` on the web side.
2. **Standards only.** EIP-712, EIP-2612, ERC-1271, EIP-5267. ERC-191 only where unavoidable.
3. **Every signed message carries domain separation** (`name`/`version`/`chainId`/`verifyingContract`)
   **plus a nonce (or unique id) plus a deadline.**
4. **Verify by running.** Each entry ends with the exact commands and their results.

## Dependency pin

| Layer | Dependency | Version | Where |
|---|---|---|---|
| Contracts | `OpenZeppelin/openzeppelin-contracts` | **v5.2.0** | `forge install …@v5.2.0 --no-git`, pinned in `.github/workflows/ci.yml` |
| Contracts | `foundry-rs/forge-std` | tagless (Foundry toolchain) | installed in CI |
| Web | `ethers` | v5 | `apps/web/package.json` |

`contracts/lib/` is gitignored, so CI installs dependencies fresh — **every dependency is installed
by explicit tag**, which is what makes the build reproducible.

---

## A.1 — Permit2-style signed allowances (`AllowanceTransfer`)

**Threat.** The classic ERC-20 UX forces a wallet to publish an on-chain `approve(spender, 2²⁵⁶−1)`
*before* it can swap. That approval (a) costs a separate transaction, (b) normally stays live forever,
and (c) lets any spender — including a spender whose front end has since been abandoned or
compromised — pull the user's whole balance at some later date. The mitigation people reach for
hand-writing is a bespoke "signed approval" scheme, which is where the real bugs come from
(missing domain separation → cross-contract replay; no nonce → replay; no deadline → indefinite
validity).

**Threat model for the primitive.** A user signs *off-chain*, over a struct that names exactly one
spender, one token, one amount, one expiry and one nonce, and a relayer (or the user's own swap tx)
submits it. The grant is **bounded** (`uint160` amount, `uint48` expiration) and **uniquely counted**
(per-(owner, token, spender) nonce bitmap).

**Primitive used (never hand-written):**

* `SignatureChecker.isValidSignatureNow` (OpenZeppelin) for verification,
* `EIP712` (OpenZeppelin) for the domain separator and typed-data digest,
* a 256-bit **nonce bitmap** (one bit per nonce) for replay protection — same structure Permit2 uses,
* `SafeERC20` for every transfer.

**Contract:** `contracts/src/v4/periphery/AllowanceTransfer.sol`
— domain `name = "Swapex AllowanceTransfer"`, `version = "1"`, plus `block.chainid` and
`address(this)`.

**API:**

| Function | Auth | Notes |
|---|---|---|
| `permit(owner, PermitSingle, sig)` | off-chain sig | `sigDeadline` is a *signed* field of `PermitSingle` (see correction below); verified with `SignatureChecker` |
| `setAllowance(token, spender, amount, expiration)` | `msg.sender` | the *same* grant with no signature at all |
| `invalidateNonce(nonce)` | `msg.sender` | burn one of your own nonces proactively |
| `transferFrom(from, to, amount, token)` | `msg.sender` must be the grant's spender | skips the decrement at `type(uint160).max` |
| `permitERC20(owner, token, spender, value, deadline, v, r, s)` | EIP-2612 passthrough | `try/catch`, reverts `TokenDoesNotSupportPermit` |

**Correction (2026-10-13):** A.1 originally shipped `sigDeadline` as a `permit()` *parameter*
outside the typed struct — the signature did not cover it, so a submitter could pass
`type(uint256).max` and ignore the bound the signer chose, breaking this document's own deadline
rule for signed messages. The field now lives inside `PermitSingle` (and its typehash),
`permit()` takes three arguments, and both directions are pinned by tests: a past *signed*
deadline reverts `SignatureExpired`, a *submitter-extended* deadline reverts `InvalidSignature`
(digest changed). See D28 in `contracts/docs/DECISIONS.md`.

**Rejected alternatives:**

* *Approve the Router directly per swap.* The threat above — nothing is bounded or expiring.
* *A raw `ecrecover` over a packed struct.* This is exactly what rule 1 forbids; `ecrecover`
  returns `address(0)` on failure, accepts malleable high-`s` values, and any packing error is a
  silent replay vector. `SignatureChecker`/`EIP712` are used instead.
* *ERC-191 `personal_sign` (`"\x19Ethereum Signed Message:\n" + hash`).* No chain id, no
  verifying-contract: a signature made against a local anvil deployment replays on any other
  deployment. Rejected for all grant signing.
* *Permit2 (`0x000000000022D473030F116dDEE9F6B43aC78BA3`).* The shape is copied deliberately;
  the address is not, because routing user funds through a third-party singleton we do not pin,
  audit or control would make *our* trust assumptions a function of theirs.

**Assumptions:**

* Grant signing uses the **canonical 65-byte `(r, s, v)` encoding only** — see A.2 for why.
* A grant's spender must be checked by the *caller* contract. `AllowanceTransfer` cannot know which
  contract the user intended, so `Router.exactInputSingleWithPermit` enforces
  `permitSingle.spender == address(this)` (`InvalidPermitSpender`) before touching the pool.
* `expiration == type(uint48).max` means "never expires" (Permit2 convention) and the grant must be
  rejected *before* its expiry, not at spend time.

**What breaks:**

* A 64-byte EIP-2098 compact signature is **rejected** (A.2). Wallets/extensions that emit compact
  form must send 65 bytes; ethers `signTypedData` and viem `signTypedDataAsync` both do.
* Submitting `setAllowance`/`permit` with an `expiration` already in the past reverts with
  `AllowanceAlreadyExpired` rather than silently storing a dead grant.
* **The Router's constructor now takes `AllowanceTransfer`,** which shifts every `CREATE` address
  after it. Recorded below under "address shift".
* Callers must now perform **two grants** instead of one: a one-time ERC-20
  `approve(allowanceTransfer, …)` (outer layer) and then a bounded
  `setAllowance/permit` for the actual spend. Existing front-end code that calls
  `token.approve(router, …)` will fail with `InsufficientAllowance` until updated.

### Front-run tolerance (why `exactInputSingleWithPermit` skips spent nonces)

Submitting a signed grant is **permissionless**, so anyone can relay it first. If the router
re-submitted the same grant after a front-run it would revert `NonceAlreadyUsed` and the user's swap
would fail through no fault of their own. The router therefore checks
`at.isNonceUsed(msg.sender, nonce)` and **skips** the permit when it is already spent, then settles
against the allowance the front-run established. Tests:
`RouterTest.test_exactInputSingleWithPermit_toleratesAFrontRun` and
`…_rejectsAGrantTargetingAnotherSpender`.

The pre-check and a `try/catch` around the permit submission are *behaviourally identical* for this
case (both end in "permit not applied"), so the cheaper pre-check is used — no signature comparison
is skipped, because `isNonceUsed` reads the bitmap that `permit` itself is about to set.

### Address shift decision (Option X)

Adding `AllowanceTransfer` to `Deploy.s.sol` before the Router shifts the Router/Quoter/token
`CREATE` addresses (PoolManager stays index 0 / `0x5FbDB…`).

* **Chosen — Option X:** keep an explicit `new AllowanceTransfer()` deployed before the Router and
  **update the recorded addresses** (`apps/web/constants/index.js`, `.env.local`,
  `.env.local.example`, smoke-script fallbacks). The Router takes it as a constructor dependency,
  which keeps the dependency explicit and injectable and matches how the PoolManager is injected.
* **Rejected — Option Y:** Router self-deploys the AllowanceTransfer with `new X()` at a
  `CREATE2`/computed `address(this)+1` and exposes it as `at`. This preserves today's addresses but
  hides a hard dependency inside the Router, makes the AllowanceTransfer unmockable, and quietly
  couples two contracts that should stay separately upgradeable/replaceable.

---

## A.3 — Signed limit orders with partial fills (`LimitOrders`)

**Threat.** A maker wants to trade at a price they chose without watching the market. The naive
versions each break something: signing a bare "swap my tokens" message that a relayer fills on
*any* pool at *any* price (no rate bound); an off-chain order book where the maker's funds stay
spendable by nothing but honesty (no on-chain enforcement); or an order that can be executed
twice (replay) or re-executed after the maker changed their mind (no cancel), or after the chain
moved (no chain separation). A filler — anyone, since filling is permissionless — must never be
able to take more input than signed, deliver less output than the signed rate, redirect the
payout, or keep executing a dead order.

**Threat model for the primitive.** The maker signs exactly one structure, off-chain, once:
`Order{maker, tokenIn, tokenOut, fee, amountIn, minAmountOut, receiver, nonce, deadline}` under
the EIP-712 domain `Swapex LimitOrders` v1 (`chainId`, `verifyingContract = this`). A filler
submits it on-chain with a chosen partial `fillAmount`. Protections, each mapped to a test:

| Threat | Mechanism | Test |
|---|---|---|
| replay of a filled order | `filled[ maker ][ nonce ]` accounting vs the signed `amountIn` | `test_fillOrder_partialFills_accumulateUpToAmountIn` |
| two different orders sharing one nonce's accounting | first fill binds `orderDigest[maker][nonce]`; a byte-different order on the same nonce reverts | `test_fillOrder_nonceReusedForDifferentOrder_reverts` |
| cross-contract / cross-chain replay | EIP-712 domain (verifyingContract, chainId) | `…_wrongVerifyingContract_reverts`, `…_crossChainReplay_reverts` (fork-free, `vm.chainId`) |
| filler takes more input than signed | `fillAmount ≤ amountIn − filled`, maker's grant is per-fill bounded by the signed flow | `…_overfillRevertsWhileRemainderStands` |
| filler delivers less than the signed rate | `minAmountOut` scaled by `fillAmount / amountIn` (linear ⇒ the rate holds for every partial), enforced by the Router as `amountOutMinimum` | `…_unreachableSignedRate_reverts`, per-split `assertGe` in the fuzz test |
| filler re-routes to another pool | signed `fee` + both signed currencies must match the supplied `PoolKey` | `…_poolFeeMismatch_reverts`, `…_wrongTokenPair_reverts` |
| stale order executed late | `deadline` is *inside* the struct (D28 — the filler cannot extend it) | `…_expired_reverts` |
| maker changes their mind | `cancel(nonce)`, scoped to `msg.sender`'s own nonces | `test_cancel_*` (pending, remainder, scoping) |
| wrong signer / tampered struct / high-s twin / 64-byte compact / ERC-1271 outcomes | same OZ `SignatureChecker` path as A.2, unchanged rules | the `wrongSigner`, `tamperedReceiver`, `malleableHighS`, `65Byte…`, `erc1271Wallet_*` tests |

**Primitive used (never hand-written):** OpenZeppelin `EIP712` (domain + digest),
`SignatureChecker` (EOA/1271, low-s, length), `Math.mulDiv` (512-bit floor scaling — a raw
`a * b / c` could overflow), `SafeERC20.forceApprove` for the outer approval. Settlement reuses
`AllowanceTransfer` + `Router.exactInputSingle`; this contract never transfers a token itself and
holds **zero balance between fills**, so its standing max approvals to the router cover nothing
at rest (both layers re-checked per fill in `_ensureSpendRights`).

**Rejected alternatives:**

* *Off-chain order book / signed message filled by a trusted party.* No on-chain enforcement of
  the rate or the replay guard — exactly the hand-rolled scheme rule 1 exists to prevent.
* *EIP-2612/permit-style "order"* (reuse the allowance domain).* Orders are not allowances: they
  carry amounts, a rate, a receiver and partial-fill state. Forcing them into `PermitSingle` would
  mean inventing semantics on top of a standard — rejected; the order gets its own typed struct.
* *Signing the full `PoolKey` (tickSpacing, hooks).* Opaque in wallets for near-zero gain: pools
  are permissionless, the filler may legitimately pick *any* pool, and the maker's real protection
  is the signed rate, which travels with the order. Residual risk (filler picks a weird pool for
  the signed pair and executes *at or worse than* the maker's floor) is bounded by `minAmountOut`
  and documented here rather than hidden in an unreadable struct.
* *Unscaled `minAmountOut` for partial fills* (check the full floor on each piece) — would reject
  legitimate partials. Linear scaling preserves the signed **rate** per piece; dust fills below
  ~1e3 base units can lose to fee+integer rounding and revert (maker loses nothing; the fuzz test
  documents the boundary).

**Assumptions:**

* The maker's ERC-20 `approve(AllowanceTransfer)` (outer layer) and grant to `LimitOrders`
  (spender = this contract) are in place — the same two-layer setup the web app already performs
  for swaps; a missing grant reverts `InsufficientAllowance`, never a silent partial pull.
* Input is ERC-20 only: `tokenIn == address(0)` reverts `NativeInputNotSupported` (there is no
  pull path for native input). Native *output* works (the Router takes straight to the receiver).
* Cancelling a nonce is permanent for that `(maker, nonce)` pair — a maker who cancels must use a
  fresh nonce for a new order.

**What breaks:**

* A 64-byte EIP-2098 signature is rejected (A.2 rule carried over).
* If the maker revokes the outer approval or the grant mid-flight, fills revert until restored.
* Fee-on-transfer tokens would break the "exactly `fillAmount` arrives" accounting — unsupported,
  same as the Router (documented in TESTNET_SECURITY: mock tokens only).

**Verified by:** `forge test --match-contract LimitOrdersTest` → **28 passed, 0 failed** (2 fuzz
tests at `--fuzz-runs 5000`); `forge test` full suite → **204 passed, 0 failed** (the suite grows
with each subsequent item; F.1 added 10, B.1 added 9, D added 7).

---

## A.2 — One verification path for EOAs *and* contract wallets (`SignatureChecker`)

**Threat.** Three separate failure modes land in the same code path:

1. **Contract wallets cannot sign at all.** A Safe (or any smart account) has no secp256k1 private
   key on-chain; a naive `ecrecover`-based `permit` permanently excludes it. The standard answer is
   ERC-1271 (`isValidSignature(bytes32, bytes4)`), and hand-rolling the EOA/contract branch is where
   off-by-one bugs live (e.g. treating a *reverting* wallet as valid).
2. **Signature malleability.** For every valid `(r, s, v)` there is a second `s' = n − s` with
   `v'` flipped that recovers to the *same* address. If both encodings count, a signature's identity
   is not unique — anything that keys state off "the signature" (replay guards, uniqueness checks)
   can be bypassed. `ecrecover` itself does **not** reject high-`s`.
3. **Malformed input.** `ecrecover` returns `address(0)` on bad input instead of reverting, so a
   `require(recovered == owner)` written as `address(0) == address(0)`… or any path that forgets to
   check for zero — accepts garbage.

**Primitive used (never hand-written):** OpenZeppelin `SignatureChecker.isValidSignatureNow(signer,
digest, signature)`, which is:

* **EOA branch** → `ECDSA.tryRecover` — requires `err == NoError && recovered == signer`. That single
  line gives low-`s` enforcement, `address(0)` rejection, and length checks for free.
* **contract branch** (`signer.code.length > 0`) → `staticcall IERC1271.isValidSignature` and
  requires success **and** a decoded return equal to `IERC1271.isValidSignature.selector`
  (`0x1626ba7e`). A wallet that reverts, returns the wrong magic value, or returns nothing ⇒
  `false`.

Because the branch is chosen by `signer.code.length`, the *same* `permit` call works for an EOA and
for a Safe with no `if` in our own code.

**Rejected alternatives:**

* *Our own EOA/1271 branch* (`if (isContract(w) … else ecrecover`). Rule 1, plus issue 1 above:
  every subtle difference (revert vs. false, magic-value check, returndata size) is a bug waiting.
* *`ecrecover` directly.* Issues 2 and 3 unmitigated.
* *Custom EIP-2098 `(r, vs)` unpacking before recovery.* Rejected explicitly — see the encoding
  decision below. Rejections are expected here and documented, not worked around.

### Encoding decision: canonical 65 bytes only

OZ's `ECDSA.tryRecover(bytes32, bytes)` **only accepts `signature.length == 65`**. A 64-byte
EIP-2098 compact signature hits `InvalidSignatureLength` and is therefore rejected by
`SignatureChecker`. Accepting it would mean writing our own `(r, vs)` split inside the verification
path — precisely the "implement the primitive yourself" rule this document exists to prevent — for a
format that ethers and viem do not emit anyway.

**Test that pins this:** `AllowanceTransferTest
.test_permit_acceptsThe65ByteFormAndRejectsThe64ByteCompactForm` asserts the *same* canonical
`(r, s, v)` is rejected as 64 bytes and accepted as 65, so the assertion is about encoding only.

**What breaks:** a signer producing compact 64-byte signatures must be reconfigured to emit 65 bytes;
nothing else changes, and grant verification still rejects high-`s`, zero-address, replayed,
wrong-chain, wrong-contract, tampered-struct and expired signatures.

**Assumptions:** OZ v5.2.0's behaviour is treated as the specification — pinned by tag, asserted by
tests rather than re-derived in comments.

---

## B - MEV and front-running resistance (B.1 done, B.2 rejected, B.3 documented)

### Threat

Four named, concrete attacks against users of this DEX:

1. **Stale/cross-block execution.** A signed swap sits in the public mempool and executes in a
   later block than the user priced for — nobody even needs to attack; the price simply moved, and
   the user's tx ran anyway. Before B.1 *nothing on-chain* enforced a deadline: the web UI
   collected a deadline and never sent it (`lib/config.js`: "the V4 router has no deadline").
2. **Sandwiching an unbounded trade.** A searcher sees a pending swap, front-runs it to move the
   price, lets the victim fill at the worse price, and back-runs. `minAmountOut` makes the victim's
   tx *revert* instead of filling worse. The single-pool path had this floor; **the multi-hop
   `exactInput` had no output bound at all** — the worst offender.
3. **Manipulated liquidity entry/exit.** A deposit or removal executed at a manipulated price:
   paying more than intended to add, or receiving less than quoted to remove. `modifyLiquidity`
   had neither a max nor a min nor a deadline.
4. **Intent-hiding for large orders** (B.2's target): searchers pre-positioning around a trade
   they can observe before it lands.

### Primitive / decision

No new cryptographic primitive is involved — this item is *validation*, done with plain checks
(never hand-rolled crypto): an absolute `deadline` per transaction (Uniswap-style
`block.timestamp > deadline` guard as the first statement of every Router entry), a `minAmountOut`
floor on **every** swap path (multi-hop included), and a sign-aware
`LiquidityBounds{amount0Min, amount1Min, amount0Max, amount1Max}` on liquidity operations checked
against the caller's net delta before settlement. Full rationale, caller updates and verification
in `contracts/docs/DECISIONS.md` **D31**.

### Rejected alternatives

* *Commit-reveal for large swaps (B.2 as originally listed).* On a public mempool the **reveal**
  tx is exactly as visible as a plain swap, so searchers sandwich the reveal just the same — the
  commit only delays visibility, it does not remove it. Hiding intent actually requires a private
  relay for the reveal (B.3), at which point the relay, not the commit, does the work. Building it
  would also add escrow custody (new contract holding user funds) or a second grant, plus bond
  mechanics whose only griefing target is the committer. Evaluated honestly, not built — full
  write-up in `contracts/docs/DECISIONS.md` **D32** and `docs/MEV.md`.
* *Banning `minAmountOut == 0`.* Rejected: it is the caller's explicit opt-out (Uniswap's
  semantics too), the Quoter-parity test depends on it, and a deadline cannot be opted out of
  (deadline `0` is simply already expired) so there is always a non-bypassable bound on every tx.
* *Private-orderflow infrastructure (relayer service, encrypted mempool).* Out of scope for this
  repo — B.3 documents how to *use* existing protected RPCs instead of building one.
* *Per-hop bounds on multi-hop paths.* Rejected: a floor on the final output subsumes them
  (intermediate hops only move into the next pool's input), and a single floor is what the user
  actually prices.

### Assumptions

* Front-ends always pass a real floor and a sane deadline (the web app does: slippage-settings
  derived, default 20 minutes); integrators who pass `minAmountOut == 0` are explicitly accepting
  any price, at their own user's expense.
* Block timestamps are monotonic and reasonably sane on target chains (standard AMM assumption;
  deadline granularity is seconds, not blocks).
* Deadlines protect against *time*, not against validators ordering same-block MEV — that is the
  private-orderflow part (B.3), documented as a non-goal here.

### What breaks

* **ABI break:** every Router entry gained parameters — old calldata fails, so deployments rotate
  (rotation #6) and integrators must re-encode. `LimitOrders` and `Deploy.s.sol` were updated in
  the same change; the web ABI was regenerated.
* A deadline that is too tight turns a slow mempool wait into a failed tx (UI default: 20 min);
  bounds that are too tight turn price movement into a revert. Both failures are safe (nothing
  executed) and recoverable (resubmit), unlike the unfunded failures they replace.

## D - TWAP oracle hardening (creation-stamped bootstrap + TwapGuard read policy)

### Threat

1. **Spot mistaken for an oracle.** V4's `OracleHook` advertised a "TWAP-style feed" while
   storing only the latest post-swap price: one swap - or a flash-style slam-and-return inside
   a single block - moves it. A liquidation, fill or UI price consuming it is attacker-settable.
2. **Silent window truncation.** The ring returns its oldest cumulative for windows it does not
   cover (D7: truncate, do not revert - reference-model parity). A consumer dividing by the
   *requested* window length gets a wrong average with no error signal.
3. **Fake epoch history.** The bootstrap observation was stamped `blockTimestamp: 0`. On a live
   chain, a young pool's pre-creation window interpolated the initialization tick backwards to
   1970 instead of truncating at creation (D7's intent) - a second silent-wrong-value path that
   tests genesising at `vm.warp(0)` can never see.
4. **Sub-minimum windows.** A few-second "TWAP" is dominated by exactly the same-block
   manipulation a TWAP exists to resist.

### Primitive / decision

No cryptographic primitive: validation, on top of the existing observation ring. The
enforceable rule lives in a guarded reader - `src/v3/TwapGuard.sol::consult(pool, window)` -
which refuses `window < TWAP_MIN_WINDOW` (30 min), refuses windows reaching before the oldest
retained observation (reporting actual coverage), refuses uninitialized pools, and only then
time-weights via two `observeSingle` reads - never `slot0`. `Observations.initialize` now
stamps pool creation time so pre-creation windows truncate to the bootstrap instead of
interpolating fake history. `OracleHook` was renamed to what it is (`lastSwapSqrtPrice*`) and
documented as spot-only. Cardinality policy unchanged (D8): growth stays permissionless, and
"not grown enough" is now an explicit revert. Full rationale in `contracts/docs/DECISIONS.md`
**D33**.

### Rejected alternatives

* *Reverting inside `observe*` on uncovered windows.* Reopens D7 (recorded: truncation over
  revert, reference parity, golden vectors) and breaks benign raw reads; the hazard exists only
  for value decisions, so the policy binds the value-decision reader instead.
* *Raising the default cardinality (reopening D8).* Growth is permissionless and cheap; a
  larger default taxes every pool for a consumer that may not exist, and still cannot answer
  "is *this* window covered?" - coverage is per read.
* *A full V4 ring-oracle hook.* V4 core deliberately has no observations (hooks would carry
  that burden); no in-repo consumer exists, and a hook-side ring would re-introduce exactly the
  cardinality/truncation questions just settled on V3. Deferred until something needs it.
* *OracleLibrary-style tick-to-quote conversion inside the guard.* No consumer prices from the
  oracle today; quote math in the guard would be speculative surface (web quotes are
  spot-by-design and settle through D31 bounds).

### Assumptions

* Anything that moves money on a price uses `TwapGuard.consult` (or an equivalent
  coverage-checked reader); raw `observe*` stays available for benign/analytic reads (D7).
* 30 minutes is a policy floor, not a theorem: long enough that same-block/same-minute
  manipulation carries negligible weight in the average; call sites may require more.
* Consumers grow cardinality first when they need more history; the revert tells them when.

### What breaks

* `Observations.initialize` gained a parameter (library-internal; only `SwapexPool` calls it).
  Raw `observe*` results for *pre-creation* windows changed from fake interpolation to
  truncation - that is the fix; golden vectors genesis at `vm.warp(0)` and are unaffected.
* A pool younger than 30 minutes, or one whose ring never grew past bootstrap, cannot be
  consulted (`OracleWindowTooShort` / `OracleWindowNotCovered`) - by design.
* `OracleHook`'s public names changed (`priceAtPoolId`/`lastPrice` ->
  `lastSwapSqrtPriceAtPoolId`/`lastSwapSqrtPrice`): an ABI break for anyone who treated the
  spot recorder as an oracle (nothing in-repo did; tests updated).

## H - Supply chain integrity (SHA-pinned CI, committed SBOM, reproducible build)

### Threat

1. **Poisoned CI actions.** The workflow's `uses:` were moving tags; anyone who can re-point
   `actions/checkout@v4` (account compromise, insider, upstream mistake) executes arbitrary
   code in a job that sees the repo, the npm registry and — in any future release flow — the
   signing material.
2. **Silent dependency drift.** Without an SBOM, "what is in this build" has to be re-derived
   from the lockfile by whoever asks; a transitive compromise stays invisible in review.
3. **Non-reproducible artifacts.** If two builds of one checkout differ (timestamps, absolute
   paths, compiler drift), byte comparison can never prove that what was reviewed is what was
   built — every artifact-hash claim (F.2 manifests) rests on build determinism.

### Primitive / decision

Validation, no crypto: (a) every GitHub Action pinned to a full commit SHA, resolved from the
GitHub API against the current major-tag targets (tags kept as comments); (b) a committed
CycloneDX SBOM (`apps/web/sbom.cdx.json`, 620 components) generated by npm's built-in
`npm sbom` — which ships with the pinned toolchain and therefore adds **no new package to the
trusted set** — regenerated and uploaded by CI on every run; (c) a CI double-build gate: hash
`out/**`, `forge build --force`, hash again, `diff` must be empty (locally verified:
154/154 artifacts byte-identical). Full rationale in `contracts/docs/DECISIONS.md` **D34**.

### Rejected alternatives

* *`@cyclonedx/cyclonedx-npm` (the usual generator).* Aborts when `npm ls` exits non-zero, and
  this tree has honest peer-range mismatches (`@reach/*` declares react `^16.8 || 17.x`, the
  app uses 19) — generation fails outright. `npm sbom` reads the lockfile, ignores that noise,
  and is maintained by npm itself.
* *Re-pinning every npm dependency beyond the lockfile's integrity hashes.* The lockfile already
  pins each entry by SHA-512 integrity; a hand-rolled resolution layer would diverge from npm
  for no gain.
* *Sigstore tag signing + npm provenance now.* Correct for a real release, not exercisable
  here: publishing to npm and GitHub's OIDC provenance both require credentials this
  environment deliberately lacks (no secrets in the repo — rule 6). Recorded below as exact
  commands rather than a checked box we cannot back.

### Assumptions

* GitHub itself stays in the TCB — SHA-pinning removes tag *mutability*, not a compromised
  GitHub or a malicious pinned commit.
* The committed SBOM is a reviewable baseline snapshot: `serialNumber`/`metadata.timestamp`
  differ per generation by design; compare the `components` array, not the raw bytes.
* `npm sbom` exists in the npm shipped with Node 20 (added in npm 9.7; CI's node 20 ships
  npm ≥ 10).

### What breaks

* SHA-pinned actions never auto-update: bumps are deliberate edits (the comment shows which
  tag a SHA corresponds to).
* The double-build gate fails loudly if anyone introduces nondeterminism into `forge build`.
* **Not built here — exact commands for a real release:**
  `npm publish --provenance --access public` from a workflow with `permissions: id-token: write`
  (then `npm audit signatures <pkg>@<version>` to verify), and for tag/bundle signatures
  `gh attestation sign --repo <org>/<repo> <tag>` or
  `cosign sign-blob --yes --bundle release.sig <artifact>`. Both belong in the release
  workflow that does not exist yet — TESTNET_SECURITY §6 checklist carries the reminder.

---

## C - Merkle allowlist distributions (`MerkleDistributor` + TypeScript generator)

### Threat

1. **Second-preimage forgery.** In a naive tree, leaves are `keccak256(abi.encode(index,
   account, amount))` - a single hash of 96 bytes. Internal nodes are a single hash of 64
   bytes... but nothing stops a node of one tree from being *presented* as membership of a
   class where it preimage-collides with a leaf encoding: with both sides hashed exactly once,
   a 32-byte internal node and a 32-byte leaf are indistinguishable by construction. A crafted
   entry whose leaf equals an internal node pays out "as the tree itself".
2. **Forged proofs.** Hand-rolled verification (own hashing, own pairing order, own fold) is
   where audit-bypass bugs live; a wrong pairing convention silently rejects valid claims or -
   worse - accepts a sibling list that does not fold to the committed root.
3. **Duplicate claims.** A claim that is not recorded can be replayed until the pot drains;
   a record that can be rolled back by a reentrant token can be double-paid.
4. **Silent root swap.** The root *is* the payout policy. A single compromised key rotating it
   redirects every remaining claim with no delay for review or cancellation.
5. **Generator/chain drift.** The tree is built off-chain; if the JS artifact and the Solidity
   verifier disagree about leaf encoding, pairing order, or tree shape, one side's "valid" is
   the other side's forgery - or claims are simply unclaimable with no diagnostic.

### Primitive / decision

* `contracts/src/v4/periphery/MerkleDistributor.sol`, verification delegated entirely to
  OpenZeppelin `MerkleProof` v5.2 (audited, sorted-pair `commutativeKeccak256` - the standard
  tooling convention; no primitive written by hand). Leaf encoding is fixed in one place,
  `leafOf(index, account, amount) = keccak256(bytes.concat(keccak256(abi.encode(...))))` -
  double-hashed per the item, so an internal node (32 raw bytes) can never equal a leaf
  (hash of 32 bytes). `claim` re-derives the leaf from its arguments, so a proof valid for one
  entry cannot pay another.
* Duplicate-claim defense: 256-per-word claimed bitmap keyed by `index`, set **before** the
  token transfer (checks-effects-interactions); a second `claim` for a used index reverts
  `AlreadyClaimed(index)` even mid-reentry. The test proves this with a token that re-enters
  during `transfer` and must fail (`reentrySuccesses == 0`).
* Root-update timelock: `setRoot` is `onlyOwner`; deployments construct with the
  OZ `TimelockController` as owner (D29) - updates are schedule -> 2-day delay -> execute,
  cancellable throughout the delay (tested end-to-end including the cancel path).
  `claim` is permissionless: anyone may relay, funds always go to the leaf's `account`.
* Generator: `apps/web/scripts/merkle.ts` (TypeScript as specified) - zero new dependencies,
  keccak via the pinned ethers v5, built-in `typescript` devDep compiles the CLI
  (`npm run merkle`). Output committed at `contracts/test/fixtures/merkle.json`; `foundry.toml`
  grants read-only `fs_permissions` on `./test/fixtures`, and the forge suite parses the SAME
  file: JS-built roots/proofs must satisfy the Solidity verifier, `tests/merkle.test.ts` folds
  them with a third, independent implementation - three-way cross-check. Full rationale in
  `contracts/docs/DECISIONS.md` **D35**.

### Rejected alternatives

* *Hand-rolled Merkle verify in Solidity (sorted-pair fold).* Rule 1: never write the
  primitive. `MerkleProof.verify` is audited, ubiquitous, and its commutative hashing IS the
  convention the generator matches - nothing to prove about correctness.
* *Third-party JS Merkle library (e.g. merkletreejs / OZ's `StandardMerkleTree`).* Adds a
  dependency for ~60 lines of tree-shaping code whose output is anyway verified by the audited
  Solidity side and double-checked by an independent fold test; OZ's JS tooling would also
  change the leaf ABI shape (typed arrays vs `abi.encode`) away from the item's exact wording.
  The hand-written builder is the *untrusted* half of the cross-check - by design.
* *Allowlist check inside `claim` per feature, without a distributor.* Re-implements the same
  question (is this account a member?) at every call site, with whatever hashing each site
  picks - the drift threat, multiplied.
* *Signature-per-claim (signed vouchers instead of a tree).* N signatures to distribute N
  payouts vs one root + N cheap proofs; signers' key material exists for the whole campaign
  instead of once at tree-published time; and it reintroduces nonce/deadline bookkeeping the
  item deliberately routes through a Merkle commitment. Revisit only if claims are retroactive
  (tree must be committed before eligibility is known).
* *Bitmap as a mapping `index => bool`.* Functionally identical, costs 20k gas/slot vs ~2k
  for the bitmap word; the bitmap is the OZ ERC20Permit pattern already familiar to reviewers.
* *Non-zero `msg.sender` binding (only the account itself may claim).* Blocks the useful
  relayer/gasless flow; unnecessary because `account` is inside the leaf - the relayer gains
  nothing by relaying.

### Assumptions

* The tree generator runs on the user's machine (or CI) at tree-publication time; the fixture
  committed here is test data - a real campaign would regenerate from its own allowlist input
  with the same `npm run merkle` and publish the root on-chain via the timelock.
* Sorted-pair (`a < b` byte order) hashing matches OZ v5's `Hashes.commutativeKeccak256`
  exactly - asserted by the generator tests and by every forge claim succeeding against
  JS-built proofs.
* `index` uniqueness within a tree is the generator's responsibility (two entries at one
  index would share a bitmap slot); the committed input uses 0,1,2,256 and the forge suite
  pins that layout.
* The distributor's token balance is funded once (mint/transfer); no `withdraw` exists for a
  leftover balance - if that becomes needed it belongs behind the same timelocked owner (or
  should be a re-root to an empty tree + sweep), not a new hot path.

### What breaks

* A tree built with a *different* leaf convention or pairing order than `merkle.ts` will be
  rejected (`InvalidProof`) for every entry - fail-closed, but claims freeze; the fixture
  cross-check exists so this cannot ship silently.
* Re-`npm run merkle` after editing `allowlist.json` changes the committed fixture; the forge
  suite consumes it, so an un-regenerated or hand-edited fixture fails immediately.
* Root rotation with claims outstanding invalidates not-yet-claimed proofs (by design - that
  is what a revocable allowlist means); already-claimed slots stay claimed across rotations
  (the bitmap is independent of the root).
* `setRoot` from a non-owner (including a direct EOA call once the owner is the timelock)
  reverts `OwnableUnauthorizedAccount`; `claim` on a zero-amount/zero-account leaf reverts
  even if such an entry were committed (`ZeroAmount` / `ZeroAccount`).

## Verification (commands + results, run on this repository)

| Command | Result |
|---|---|
| `forge build` | ok |
| `forge test` | **204 passed, 0 failed** (107 other tests + 31 `AllowanceTransferTest` + 21 `RouterTest` (12 + 9 new B.1) + 28 `LimitOrdersTest` + 10 `AdminTest`, incl. the H-2 refund tests, the D28 deadline regression, the F.1 timelock/two-step tests and the B.1 deadline/bounds sweep, + 7 new `TwapGuardTest` (D33)) |
| `forge test --match-contract AllowanceTransferTest --fuzz-runs 5000` | **31 passed, 0 failed**, 3 fuzz tests × 5000 runs |
| `forge test --match-contract LimitOrdersTest --fuzz-runs 5000` | **28 passed, 0 failed**, 2 fuzz tests × 5000 runs |
| `npx playwright test` (apps/web) | **1 passed** — browser-signed `PermitSingle`: lands, replay → `NonceAlreadyUsed`, wrong chain → `InvalidSignature`, extended `sigDeadline` → `InvalidSignature` |
| `.github/workflows/ci.yml` | installs `forge-std` + `OpenZeppelin/openzeppelin-contracts@v5.2.0 --no-git`, runs the suite and the 5000-run signature fuzz |

### Tooling note — `forge coverage` cannot instrument this codebase

The ≥95 %-lines target for the new signature/permit contracts could not be measured with
`forge coverage`, because compilation fails on `src/v4/core/PoolManager.sol` (a file with **zero
diff** against `HEAD` — the failure predates this work). Five approaches were tried and all fail:

1. default codegen → `Compiler error … LValue.cpp:51: Stack too deep`
2. `--ir-minimum` → `Yul exception: Cannot swap Variable … with Variable var_callerDelta … too deep by 2 slots`
3. `[profile.coverage]` with `via_ir = true` + `optimizer_runs = 800` → `forge coverage` force-disables `via_ir` (it only honours it under `--ir-minimum`)
4. profile **+** `--ir-minimum` → same Yul exception
5. `--no-match-coverage "PoolManager|src/v4/core"` → filter affects reporting only, instrumentation still compiles PoolManager → same Yul exception

The dead `[profile.coverage]` was removed rather than left in `foundry.toml` as misleading config.

**Substitute evidence:** branch-by-branch mapping of every conditional in
`AllowanceTransfer.sol` (all 31 in `contracts/test/v4/AllowanceTransfer.t.sol`) and in the A.3
`LimitOrders.sol` (all 28 in `contracts/test/v4/LimitOrders.t.sol`), each confirmed green by the
commands above.
