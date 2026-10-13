# Swapex — cryptography hardening review (2026-10-13)

Scope: add cryptography only where it fixes a **named threat**; never implement a primitive by
hand; every signed message = domain separation + nonce + *signed* deadline; verify by running.

Companion documents (detail lives there, this is the index):

| Document | Contents |
|---|---|
| [`docs/CRYPTO_DECISIONS.md`](./CRYPTO_DECISIONS.md) | Threat-first decision log for each item (threat → primitive → rejected alternatives → assumptions → what breaks) |
| [`contracts/docs/SECURITY.md`](../contracts/docs/SECURITY.md) | Slither 0.11.6 (6 phases) + Aderyn 0.6.8 paper trail: every finding fixed / accepted-with-reason / false-positive |
| [`contracts/docs/DECISIONS.md`](../contracts/docs/DECISIONS.md) | D27 (signed per-spender allowances), D28 (`sigDeadline` is signed), D29 (two-step ownership + timelock), D30 (signed deployment manifests) |
| [`docs/TESTNET_SECURITY.md`](./TESTNET_SECURITY.md) | Testnet-only posture, admin ownership (§3), dependency pinning, pre-mainnet checklist |

## What shipped

1. **A.1 — Permit2-style signed allowances** (`AllowanceTransfer.sol`): EIP-712 domain
   "Swapex AllowanceTransfer" v1, `PermitDetails{amount, expiration, nonce}` on a per-(owner,
   token, spender) slot with a 256-bit nonce bitmap; `permit(...)` off-chain, `setAllowance(...)`
   on-chain, `invalidateNonce`, spender-gated `transferFrom`, EIP-2612 passthrough,
   EIP-5267 domain view. Grants are bounded and expiring instead of an eternal `approve`.
2. **A.2 — One verification path for EOAs and contract wallets**: OpenZeppelin
   `SignatureChecker` (EOA → `ECDSA.tryRecover`, contract → ERC-1271 via `signer.code.length`),
   canonical 65-byte encoding only, no hand-written recovery anywhere.
3. **Router integration**: `exactInputSingleWithPermit` submits grant + swap atomically,
   enforces `spender == router`, tolerates a front-run by skipping an already-spent nonce,
   and — after Aderyn H-2 — sweeps unconsumed native input back to `msg.sender`.
4. **A.3 — Signed limit orders** (`LimitOrders.sol`): EIP-712 "Swapex LimitOrders" v1 order
   `{maker, tokenIn, tokenOut, fee, amountIn, minAmountOut, receiver, nonce, deadline}` with
   first-fill digest binding, linear partial-fill accounting, cancel-by-nonce (msg.sender-scoped),
   and settlement strictly through the trusted Router (`fillOrder`, not a free-form call).
5. **F.1 — Two-step ownership + timelock admin** (D29): `PoolManager` and `SwapexFactory` on
   OpenZeppelin `Ownable2Step` with constructor-supplied initial owner; `Deploy.s.sol` deploys
   `TimelockController(2 days)` first and makes it the PoolManager's owner from genesis.
   `setProtocolFee`/`collectProtocol`/`enableFeeAmount` are now delayed and cancellable.
6. **F.2/F.3 — Signed deployment manifests + source verification** (D30):
   `deployments/<chainId>.json` (addresses, commit, foundry settings, init/artifact/onchain
   keccak256 hashes) signed EIP-191 into `<chainId>.json.sig`, verified in CI; `deploy.mjs` is
   the canonical broadcast flow and passes `forge script --verify` through on non-local chains.
7. **Web flow**: two-layer grants (one-time ERC-20 `approve` to `AllowanceTransfer`, then a
   bounded `permit`/`setAllowance` to the Router), regenerated ABI, addresses pointing at the
   current anvil deployment (rotation #5, matching the committed manifest).
8. **Browser end-to-end proof** (`apps/web/e2e/`): Playwright signs a real `PermitSingle`
   in the page via an injected EIP-1193 shim, cross-checks the digest in Node, lands the grant
   on-chain, and asserts the abuse cases against real revert selectors.

## What each piece protects against — and what it does not

| Piece | Protects against | Does **not** protect against |
|---|---|---|
| A.1/A.2 signed grants | Stale/unlimited ERC-20 approvals outliving the UI; one leaked approval reused across tokens/spenders; replayed, cross-chain, expired, high-`s` and wrong-contract signatures; EOA/1271 verification divergence | A compromised signer key (the attacker signs valid grants); a malicious/upgradeable token; someone tricking the user into signing a grant to an attacker-chosen spender — the wallet prompt is the last line |
| A.3 signed orders | Forged/replayed/extended-deadline orders; double-fills; fills beyond the signed rate; maker funds routed anywhere except the signed receiver via the trusted router | Maker's price risk while an order rests; filler choice of *when* to fill; the pool key's `hooks`/`tickSpacing` are **not** inside the signed struct (documented residual in `CRYPTO_DECISIONS.md` A.3 — tokens, fee, amounts, receiver, deadline, nonce are) |
| F.1 two-step + timelock | A single signed tx instantly moving protocol-fee admin (compromised admin key changing fees/fee tiers before anyone reacts); mistyped transfers stranding ownership | A fully compromised multisig/timelock role set (all signers collude or leak); governance-lite attacks needing no key (none exist here — no token, no flash-loanable vote); the local-anvil deployer being a public key (by design, §1 of TESTNET_SECURITY) |
| F.2/F.3 manifests | Undetected divergence between the repo's claimed addresses/settings and what a chain actually runs; byte-level tamper with a published manifest; bytecode that does not match the recorded build | Authorship on chainId 31337 (the signing key is public — integrity only); admin actions taken *after* deployment; explorer-source mismatches on chains we cannot reach from this environment |

## Findings and fixes (the part that matters)

| Finding | Source | Status |
|---|---|---|
| **H-2 — stranded native input**: all four payable Router entries forwarded only the owed delta out of `msg.value`; over-payments and price-limited partial fills were locked in a contract with no owner and no withdrawal path | Aderyn 0.6.8 (7 Highs triaged; other 6 re-hit already-adjudicated false-positive classes) | **Fixed** — `_refundNative()` sweeps after `pm.unlock` returns (post-settlement), rejected refund reverts `NativeRefundFailed()`; 2 tests pin refund = attached − consumed |
| **`sigDeadline` was not signed**: `permit()` took it as an unsigned parameter, so a submitter could pass `type(uint256).max` and ignore the signer's bound — a violation of this repo's own deadline rule | Self-review while writing D28 | **Fixed** — field moved inside `PermitSingle` + typehash + digest; `permit(owner, PermitSingle, sig)`; Router drops its unsigned deadline param; regression `test_permit_submitterCannotExtendTheSignedDeadline_reverts` |
| `missing-zero-check` on `setOwner(0)` → permanent unowned state | Slither 0.11.6 | **Superseded by F.1/D29** — `setOwner` is gone; two-step transfer makes a zero owner structurally impossible, regressions `test_factory_transferOwnershipIsTwoStepAndZeroSafe` + `test_ownership_zeroAddressCannotBecomeOwner` |
| 17 Slither findings in Phases 1–5 (reentrancy-no-eth/events/benign under `lock`, uninitialized-local, FullMath XOR, low-level calls, cyclomatic complexity, permit-path flag) | Slither 0.11.6 | Accepted or false-positive, each justified in `SECURITY.md`; reentrancy covered by `ReentrantTokenTest` |
| 3 Slither instances in the Phase 6 run (`LimitOrders.fillOrder` reentrancy-events, timestamp×2, complexity 15) + clean result on the Ownable2Step migration | Slither 0.11.6 re-run (52 contracts, 77 results filtered) | Accepted/false-positive with reasons in `SECURITY.md` Phase 6; **no** ownership finding on the migration |
| 18 Aderyn Lows (admin-only centrality, bounded loops, Uniswap-literal constants, struct shadowing, PUSH0/cancun, `isNonceUsed`/`hashPermitSingle` as external API, …) | Aderyn 0.6.8 | Grouped triage table in `SECURITY.md` |

## Verification (run on this repository)

| Command | Result |
|---|---|
| `forge build` | ok |
| `forge test` | **188 passed, 0 failed** |
| `forge test --fuzz-runs 5000 --match-contract 'AllowanceTransferTest\|LimitOrdersTest'` | **31 + 28 passed, 0 failed** (signature code × 5000 runs) |
| `forge script` broadcast (via `deploy.mjs --broadcast`) | rotation #5 on anvil; `pm.owner == timelock`, `pendingOwner == 0`, `getMinDelay == 2 days` read back over RPC |
| `node scripts/verify-manifest.mjs 31337 --rpc http://127.0.0.1:8545` | all PASS — EIP-191 signature, commit ancestry, settings match, 10 on-chain codehash rows; tampered manifest → FAIL (exit 1) |
| `npx playwright test` (apps/web, `npm run test:e2e`) | **1 passed** — sign → cross-verify → land → replay `NonceAlreadyUsed` → wrong-chain `InvalidSignature` → extended-deadline `InvalidSignature` |
| `node scripts/smoke.mjs` | PASS (quote + native swap + token swap) on rotation #5 |
| `node scripts/smokeLiquidity.mjs` | PASS (add + registry read + remove) on rotation #5 |
| `npm test` (apps/web) | 22 passed |
| `npm run lint` | 0 errors (18 pre-existing warnings) |
| `npm run build` | compiled, all routes prerendered |
| `.github/workflows/ci.yml` | OZ pinned `v5.2.0`, full forge suite + 5000-run signature fuzz, web lint/test/build + **manifest signature verification** |

**Coverage substitute:** `forge coverage` cannot instrument this codebase (5 approaches fail on
`PoolManager.sol`, which has zero diff against `HEAD` — details in `CRYPTO_DECISIONS.md`).
Substitute evidence: every conditional in `AllowanceTransfer.sol` and `LimitOrders.sol` mapped to
the test that exercises it, all green above.

## Open risks

* `PoolManager` exceeds EIP-170 (24,576 B) — fine on `anvil --code-size-limit`, impossible on a
  real chain until split; hard blocker in `TESTNET_SECURITY.md` §6.
* D26 fee attribution limitation (pooled per-position fee accounting) — architectural, documented.
* The A.3 signed order does not bind `hooks`/`tickSpacing` of the fill pool (tokens, fee, amounts,
  receiver, deadline, nonce are bound); accepted residual, `CRYPTO_DECISIONS.md` A.3.
* Manifest signature on chainId 31337 is integrity-only (public anvil key); real releases must
  sign with a maintained key (`PRIVATE_KEY` env, never committed).
* Source verification (F.3) could not be exercised against a real explorer from this environment
  (no API key, testnet-only scope) — wrapper's local path tested end-to-end instead.
* Aderyn 0.6.8 paper trail is historical: it cannot run on this Windows machine and is not wired
  into CI; Slither is re-run locally per phase.
* `forge coverage` substitute (above) — line-percentage target not measurable as stated.

## What an external auditor should look at first

1. `LimitOrders.fillOrder` — the newest signed path: CEI ordering, digest binding, partial-fill
   math (`Math.mulDiv` linear scaling), `_ensureSpendRights` grant handling.
2. The ownership boundary: `onlyOwner` call sites on `PoolManager`/`SwapexFactory`, the
   constructor-time timelock wiring, and `Admin.t.sol`'s delay/cancellation semantics.
3. `AllowanceTransfer.permit`/`transferFrom` (Phase 5 detail in `SECURITY.md`) and the
   `exactInputSingleWithPermit` front-run tolerance.
4. Router settlement + `_refundNative` (Aderyn H-2 fix) and the unlock-session net-zero sweep.
5. Cross-chain replay posture: EIP-712 domains (chainId + verifyingContract) on both signed types.

## Not done, on purpose or deferred

* **Items A and F of the original A–I hardening list are complete** (A.1–A.3, F.1–F.3; each with
  CRYPTO_DECISIONS/DECISIONS entries and verified-by notes above). **Remaining: B (MEV:
  deadline/amount bounds tests, optional commit-reveal, private-orderflow docs), C (Merkle
  allowlists — only if a feature needs one), D (TWAP oracle hardening: min window, cardinality,
  no-spot-read rule), E (hook-address permission tests + verified-hook registry), G (web: typed
  data everywhere, EIP-55 validation, SRI/CSP tightening), H (supply chain: npm provenance,
  SBOM, Sigstore, SHA-pinned Actions, double-build reproducibility), I (advanced crypto — proposal
  first).**
* **No primitives written by hand, no new dependencies added**: OZ v5.2.0 (pinned), ethers v5,
  Playwright for the browser test.
* **Nothing mainnet-shaped**: anvil chain 31337 only, public dev keys only, no secrets in the
  repository; `TESTNET_SECURITY.md` §6 holds the pre-mainnet checklist (EIP-170 size, D26 fee
  attribution, multisig handover, external audit, target-chain re-run of these same tests).
