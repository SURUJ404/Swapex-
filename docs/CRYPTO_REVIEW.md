# Swapex — cryptography hardening review (2026-10-13)

Scope: add cryptography only where it fixes a **named threat**; never implement a primitive by
hand; every signed message = domain separation + nonce + *signed* deadline; verify by running.

Companion documents (detail lives there, this is the index):

| Document | Contents |
|---|---|
| [`docs/CRYPTO_DECISIONS.md`](./CRYPTO_DECISIONS.md) | Threat-first decision log for each item (threat → primitive → rejected alternatives → assumptions → what breaks) |
| [`contracts/docs/SECURITY.md`](../contracts/docs/SECURITY.md) | Slither 0.11.6 (5 phases) + Aderyn 0.6.8 paper trail: every finding fixed / accepted-with-reason / false-positive |
| [`contracts/docs/DECISIONS.md`](../contracts/docs/DECISIONS.md) | D27 (signed per-spender allowances), D28 (`sigDeadline` is signed) |
| [`docs/TESTNET_SECURITY.md`](./TESTNET_SECURITY.md) | Testnet-only posture, dependency pinning, pre-mainnet checklist |

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
4. **Web flow**: two-layer grants (one-time ERC-20 `approve` to `AllowanceTransfer`, then a
   bounded `permit`/`setAllowance` to the Router), regenerated ABI, addresses pointing at the
   current anvil deployment.
5. **Browser end-to-end proof** (`apps/web/e2e/`): Playwright signs a real `PermitSingle`
   in the page via an injected EIP-1193 shim, cross-checks the digest in Node, lands the grant
   on-chain, and asserts the abuse cases against real revert selectors.

## Findings and fixes (the part that matters)

| Finding | Source | Status |
|---|---|---|
| **H-2 — stranded native input**: all four payable Router entries forwarded only the owed delta out of `msg.value`; over-payments and price-limited partial fills were locked in a contract with no owner and no withdrawal path | Aderyn 0.6.8 (7 Highs triaged; other 6 re-hit already-adjudicated false-positive classes) | **Fixed** — `_refundNative()` sweeps after `pm.unlock` returns (post-settlement), rejected refund reverts `NativeRefundFailed()`; 2 tests pin refund = attached − consumed |
| **`sigDeadline` was not signed**: `permit()` took it as an unsigned parameter, so a submitter could pass `type(uint256).max` and ignore the signer's bound — a violation of this repo's own deadline rule | Self-review while writing D28 | **Fixed** — field moved inside `PermitSingle` + typehash + digest; `permit(owner, PermitSingle, sig)`; Router drops its unsigned deadline param; regression `test_permit_submitterCannotExtendTheSignedDeadline_reverts` |
| `missing-zero-check` on `setOwner(0)` → permanent unowned state | Slither 0.11.6 | **Fixed** + regression test |
| 17 Slither findings in Phases 1–5 (reentrancy-no-eth/events/benign under `lock`, uninitialized-local, FullMath XOR, low-level calls, cyclomatic complexity, permit-path flag) | Slither 0.11.6 | Accepted or false-positive, each justified in `SECURITY.md`; reentrancy covered by `ReentrantTokenTest` |
| 18 Aderyn Lows (admin-only centrality, bounded loops, Uniswap-literal constants, struct shadowing, PUSH0/cancun, `isNonceUsed`/`hashPermitSingle` as external API, …) | Aderyn 0.6.8 | Grouped triage table in `SECURITY.md` |

## Verification (run on this repository)

| Command | Result |
|---|---|
| `forge build` | ok |
| `forge test` | **150 passed, 0 failed** |
| `forge test --match-contract AllowanceTransferTest --fuzz-runs 5000` | **31 passed, 0 failed** (3 fuzz tests × 5000 runs) |
| `npx playwright test` (apps/web, `npm run test:e2e`) | **1 passed (5.9s)** — sign → cross-verify → land → replay `NonceAlreadyUsed` → wrong-chain `InvalidSignature` → extended-deadline `InvalidSignature` |
| `node scripts/smoke.mjs` | PASS (quote + native swap + token swap) |
| `node scripts/smokeLiquidity.mjs` | PASS (add + registry read + remove) |
| `npm test` (apps/web) | 22 passed |
| `npm run lint` | 0 errors (18 pre-existing warnings) |
| `npm run build` | compiled, all routes prerendered |
| `.github/workflows/ci.yml` | OZ pinned `v5.2.0`, full forge suite + 5000-run signature fuzz, web lint/test/build |

**Coverage substitute:** `forge coverage` cannot instrument this codebase (5 approaches fail on
`PoolManager.sol`, which has zero diff against `HEAD` — details in `CRYPTO_DECISIONS.md`).
Substitute evidence: every conditional in `AllowanceTransfer.sol` mapped to the test that
exercises it, all green above.

## Not done, on purpose or deferred

* **Remaining items from the original A–I hardening list** beyond A.1/A.2 — the list was not
  preserved in-repo; re-supply it to continue (anything without a named threat gets no code).
* **No primitives written by hand, no new dependencies added**: OZ v5.2.0 (pinned), ethers v5,
  Playwright for the browser test.
* **Nothing mainnet-shaped**: anvil chain 31337 only, public dev keys only, no secrets in the
  repository; `TESTNET_SECURITY.md` §5 holds the pre-mainnet checklist (EIP-170 size, D26 fee
  attribution, external audit, target-chain re-run of these same tests).
