# Hardening pass 1: what changed

Verified with Foundry (solc 0.8.26, optimized, via_ir): **248 tests pass**, including 5000-run fuzz and deeper
invariant runs on the accounting suites. Frontend helper checked with Node (vitest/npm was not reachable here).

## Contracts
| Change | Why | Where |
|---|---|---|
| Flash-accounting deltas are **per account** | A hook could `take` the swapper's output (exploit reproduced on the old code, then fixed) | `PoolManager.sol`, D37 |
| ERC-20 `settle`/`mint` are **balance-checked** (`TransferShortfall`) | Fee-on-transfer tokens created unbacked credit | `PoolManager.sol`, D38 |
| Fee `< 1e6` and `0 < tickSpacing < 16384` enforced (static and dynamic fee) | Unbounded values broke swap math | `PoolManager._initialize`, D38 |
| Router multi-hop walks the **current currency** | Ambiguous when adjacent pools share both currencies | `Router._doMulti`, D39 |
| Swap loop moved to linked library `SwapLogic` | PoolManager was 27,419 B, over EIP-170 (24,576 B); now 19,398 B | `libraries/SwapLogic.sol`, D39 |
| `AllowanceSet` event args emitted in wrong order | Indexers filtered the wrong topic | `AllowanceTransfer.sol`, D40 |
| LimitOrders partial-fill floor rounds **up** | Taker could shave 1 wei per fill | `LimitOrders.sol`, D40 |
| NatSpec: `setRoot` does not reset the claimed bitmap | Reused indices become unclaimable | `MerkleDistributor.sol` |

New tests: `HookIsolation`, `SettleAccounting`, `CodeSize` (EIP-170 guard), plus Router, allowance-event cases.

## Frontend
* Permit nonce chosen by reading the bitmap a word at a time (`lib/nonce.js`, `tests/nonce.test.js`).
* `PoolManager`/`Router` ABIs regenerated; default deployment addresses updated (library deploys first).

## Still open after pass 1
Resolved in hardening pass 2 below, except the two items that cannot be done from this
workspace: **Sepolia deployment** and an **independent audit**.

---

# Hardening pass 2: what changed

Verified with Foundry (solc 0.8.26, via_ir, 800 runs): **260 tests pass** — 248 from pass 1 plus
8 new fee-attribution tests (`PositionFees`) and 4 ownership-rehearsal tests. The same 260 pass
under the new `ci` profile (1000-run fuzz, 128×60 invariant). Frontend: `npm test` **70/70**,
`eslint` 0 errors, `next build` clean. Both smoke scripts pass against a fresh anvil deploy.

## Contracts

| Change | Why | Where |
|---|---|---|
| **Per-user fee ledger on the Router** (D41) | positions were merged per Router, so LPs could claim each other's fees | `Router.sol` (`FeePosition`, `feeReserve`, `collectFees`, `getUnclaimedFees`), `PoolManager.getFeeGrowthInside` |
| Fees stay with the account that **touched** the pool | a bare ledger read can't fund a payout; fees only exist once `feesAccrued` is booked, so `collectFees` is a `liquidityDelta == 0` poke through `pm.unlock` | `Router.collectFees` |
| `receive()` restricted to the PoolManager + `NativeInputShortfall` / `FeeReserveShortfall` / `ZeroRecipient` | anyone could push ETH into the router and skew native settlement | `Router.sol` |
| **LimitOrders bound to the full pool identity** (D42): `tickSpacing`, `hooks`, `PoolMismatch` | a signed order could be filled against a differently-configured pool | `LimitOrders.sol` (`Order`, `ORDER_TYPEHASH`, EIP-712 version `"2"`) |

`Router.modifyLiquidity` now returns `(callerDelta, feesAccrued)`; the frontend only awaits
transaction confirmation, so the ABI change is invisible to it. Sizes stay under EIP-170
(PoolManager 19,314 B, Router 11,232 B).

## CI and release

* `foundry.toml` gains `[profile.ci]` (fuzz 1000, invariant 128 runs × depth 60) — forge 1.8.5 has
  no `--invariant-runs` flag, so scaling lives in a profile. `ci.yml` runs the whole suite under
  `FOUNDRY_PROFILE=ci`, then re-runs the accounting suites at 5000 fuzz runs.
* `release.yaml` rewritten: SHA-pinned `checkout`/`setup-node`, Node 20 + npm (it invoked `yarn`,
  which is not installed), `permissions: contents: write`, zips `apps/web/.next`, verifies the
  manifest, then `gh release create`.

## Repo

* Deleted legacy `apps/web/src/` (78 files — the old Uniswap V1 interface) and dropped `src/**`
  from `eslint.config.mjs`; `tests/storagePolicy.test.js` now allows the tx-history key only.
* `deployments/31337.json` + `.sig` regenerated against a fresh anvil deploy and **verified over
  RPC** (signature, commit ancestry, compiler settings, live codehash for all 9 contracts —
  including the linked `SwapLogic` library, which forge leaves as a `__$…$__` placeholder in
  artifacts and links only at deploy time).
* `PoolManager.json` / `Router.json` ABIs regenerated.
* Docs: D26 marked superseded; **D41** (per-user fee ledger + reserve invariant) and **D42**
  (full pool identity in signed orders) added to `DECISIONS.md`; `SECURITY.md` gains a
  "hardening pass 2 — manual review" section.
* New/expanded tests: `PositionFees.t.sol` (8, incl. a fuzz asserting the reserve invariant holds
  across two LPs) and `Admin.t.sol` (4 rehearsal tests + a `MockMultisig`, covering deployer
  handover to the timelock, admin renounce with governance surviving, proposer ≠ executor role
  separation, and an M-of-N multisig driving the timelock).

## Still open

1. **Deploy to Sepolia** (needs a funded key/RPC — cannot be done from this workspace).
2. **Independent audit** (out of scope for this pass).

---

# Hardening pass 3: what changed

Adversarial follow-up on the pass-2 per-user fee ledger (D41), scoped to the Router —
PoolManager untouched. Verified with Foundry (solc 0.8.26, via_ir, 800 runs): **263 tests pass**
(260 from pass 2 plus 3 new), the 3 new tests fail on the pre-fix code (reproduced first), the
fee suite passes at 5000 fuzz runs, and the invariant suites pass under `FOUNDRY_PROFILE=ci`
(128 runs x depth 60). Sizes: Router 11,319 B, PoolManager 19,314 B (EIP-170: 24,576 B).

## Contracts

| Change | Why | Where |
|---|---|---|
| Fee-growth checkpoint is re-read **post-op always** (was: only when the position was empty) | a before-add-liquidity hook may swap/donate mid-op; the pre-hook read credited the joiner growth their new delta did not produce — paid from other LPs' backed fees | `Router._doModifyLiquidity`, D41 |
| Empty-ledger poke (`liquidity == 0 && liquidityDelta == 0`) **skips the shared slot** | anyone can poke any position id; each poke makes the manager floor that window against every other LP's un-floored span, wedging a wei-sized shortfall into the holder's collect | `Router._doModifyLiquidity` |
| Flush **partially releases**: `_releasePartial` pays what the reserve backs, remainder stays in `tokensOwed`; `FeeReserveShortfall` removed | the old `_release` reverted on the rounding wedge, and the flush pays fees before principal — so a 1-wei wedge froze the holder's fees *and* their removal | `Router._flushLiquidityOutflows`, D41 |

The reserve invariant `balanceOf(this) >= feeReserve[c]` is unchanged and still asserted in every
test; the weaker ledger-sum bound may transiently exceed the reserve by floor rounding alone and is
paid down by later touches.

## Tests and docs

* `PositionFees.t.sol` gains 3 tests (hook-window over-credit, dust-window DoS, empty-poke slot
  hygiene) plus a mined `DonateOnAddHook` (`BEFORE_ADD_LIQUIDITY_FLAG = 1 << 9`) and unlock-session
  donate helpers; all 3 reproduced as failures on the pre-fix code.
* Solc note: an early-`return` draft of the poke-skip branch hit a solc 0.8.26 via-ir internal
  compiler error ("Assembly exception for bytecode"); the shipped `if/else` join compiles cleanly.
* Docs: D41 consequences updated in `contracts/docs/DECISIONS.md`; `contracts/docs/SECURITY.md`
  gains a "hardening pass 3" section; `apps/web/constants/abi/Router.json` regenerated
  (`FeeReserveShortfall` gone).

## Still open

1. **Deploy to Sepolia** (needs a funded key/RPC — cannot be done from this workspace).
2. **Independent audit** (out of scope for this pass).

