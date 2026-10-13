# Security notes — Swapex core

This file records the output of automated static analysis and the reasoning for every
finding: fixed, accepted (with justification), or false positive. The goal is a paper trail,
not a green badge.

Tools run against `src/` (production contracts only; `test/`, `lib/`, `reference/` filtered out):

- **Slither** 0.11.6 (solc 0.8.26): see per-phase counts below.
- **Aderyn**: see below.

## Phase 1 — V3-style core (Slither)

### Fixed

| Detector | Location | Action |
|---|---|---|
| `missing-zero-check` | `SwapexFactory.setOwner` (`src/v3/SwapexFactory.sol:74`) | **Superseded by F.1 (D29).** The original issue (`setOwner(address(0))` bricking the factory) was first patched with an explicit zero check; `setOwner` has since been **removed entirely** in favour of OpenZeppelin `Ownable2Step`, where `transferOwnership(0)` merely cancels a pending transfer and `address(0)` can never accept — the brick case is structurally impossible. Regression tests: `test_factory_transferOwnershipIsTwoStepAndZeroSafe`, `test_ownership_zeroAddressCannotBecomeOwner`. |

### Accepted — protected by the `lock` reentrancy guard

The pool's state-mutating external functions (`mint`, `burn`, `collect`, `swap`, `flash`,
`setProtocolFee`, `collectProtocol`) all carry the `lock` modifier, which sets
`slot0.unlocked = false` for the duration of the call. Any reentrant call into another
`lock`-guarded function reverts with `Locked`. This is verified by the token-quirk test
suite (`test/tokens/Quirks.t.sol` → `ReentrantTokenTest`), which drives a malicious token
that attempts to re-enter `swap`/`collect` on every transfer and asserts
`reentrySuccesses == 0`.

| Detector | Count | Finding | Why it is safe |
|---|---|---|---|
| `reentrancy-no-eth` | 1 | `collectProtocol`: `protocolFees1` written after the `_safeTransfer(token0,…)` call | The `lock` modifier blocks reentrancy. Also, each fee bucket is decremented **before** its own transfer (`protocolFees0 -= amount0` then transfer token0; `protocolFees1 -= amount1` then transfer token1), so no fee can be double-spent even in a hypothetical reentrant scenario. Slither flags the cross-branch ordering (write to `protocolFees1` after the token0 call) which is a heuristic artifact. |
| `reentrancy-events` | 5 | Events (`Mint`, `Swap`, `Collect`, `Flash`, `CollectProtocol`) emitted after external token transfers / callbacks | Off-chain ordering caveat only. Because `lock` prevents any pool function from re-entering, no **pool** event can be interleaved. A token's own `Transfer` events may appear before the pool's event; indexers must key off the pool's events, which remain correctly ordered among themselves. Standard pattern (Uniswap V2/V3 behave identically). |
| `reentrancy-benign` | 1 | `flash`: `feeGrowthGlobal*` / `protocolFees*` written after the flash callback | `lock` blocks reentrancy. Balance accounting uses before/after snapshots (`balance0Before`/`balance1Before` captured before the transfer-out, compared after the callback), so repayment is verified against actual balances regardless of what the callback does. |

### False positives

| Detector | Count | Why |
|---|---|---|
| `uninitialized-local` | 5 | `flippedLower`/`flippedUpper` are assigned inside `if (liquidityDelta != 0)` and only read under the same/stricter condition; `balance0Before`/`balance1Before` are assigned and read under matching `amount>0` guards; `step` is a `memory` struct, which Solidity zero-initializes. No path reads an uninitialized value. |
| `too-many-digits` | 1 | `computePoolAddress` contains no multi-digit numeric literal; the flagged line is a `keccak256` of the creation code. Detector mis-fire. |

### Accepted — intentional design

| Detector | Count | Justification |
|---|---|---|
| `low-level-calls` | 2 | `_balance` (staticcall) and `_safeTransfer` (call) use low-level calls deliberately so the pool works with non-standard ERC-20s (no-return-value / USDT-style tokens). `_safeTransfer` treats `ret.length == 0` as success and reverts `TokenTransferFailed` on `false` or a failed call; `_balance` reverts `BalanceCheckFailed` on a failed/malformed `balanceOf`. Exercised by `NoReturnTokenTest` and `RevertingTokenTest`. |
| `cyclomatic-complexity` | 1 | `swap()` has complexity 30. The tick-crossing loop is inherently branchy (exact-in/out × zero-for-one × protocol-fee on/off × tick-cross vs price-move). Refactoring would obscure the 1:1 correspondence with the Python reference model (`reference/poolmodel.py`), which is the correctness oracle. Not worth the readability/maintenance cost. |

## Phase 2 — V4 PoolManager (Slither)

Re-ran Slither 0.11.6 over `src/` (now including `src/v4/`). **No new high/medium findings
specific to the PoolManager.** The detectors that fire on the V4 code are the same two
benign classes already triaged above:

| Detector | Location (v4) | Why it is safe |
|---|---|---|
| `uninitialized-local` | `PoolManager._updatePosition` `flippedLower`/`flippedUpper`; `PoolManager.swap` `step` | Same false positive as Phase 1: the bools are assigned inside `if (ld != 0)` and read under the same guard; `step` is a `memory` struct that Solidity zero-initializes. No path reads an uninitialized value. |
| `incorrect-exp` | `FullMath.mulDiv` (`inv = (3 * denominator) ^ 2`) | **Known false positive, pre-existing.** The `^` is a deliberate bitwise XOR, part of the Newton-Raphson modular-inverse refinement, *not* exponentiation. Identical to Uniswap V2/V3 `FullMath`. Not introduced by Phase 2. |

The V4-specific reentrancy surface (the `unlock` callback) is **by design**: nested `unlock`
reverts `AlreadyUnlocked`, and the end-of-session net-zero sweep (`UnsettledDelta`) guarantees
no currency delta can be left non-zero, so a callback cannot extract value it did not settle.
This is exercised by `test_unsettledDelta_reverts` and `test_nestedUnlock_reverts`
(`test/v4/PoolManager.t.sol`). Settlement uses `transferFrom`/`transfer` return values (revert
`TransferFailed` on `false`), matching the V3 `_safeTransfer` posture.

## Phase 3 — native ETH, hooks, Router (Slither)

Re-ran Slither 0.11.6 over `src/` (now including `src/v4/hooks/`, `src/v4/periphery/`, and the
native-ETH currency helpers). No new high/medium findings that represent a real defect. Triage:

| Detector | Location (v3/v4) | Why it is safe |
|---|---|---|
| `arbitrary-send-erc20` | `CurrencyLibrary.transferFrom` (`src/v4/types/Currency.sol`) | **False positive.** The library is a generic wrapper; every call site passes a trusted `from`: `PoolManager.settle` uses `msg.sender`, and `Router._settleOrTake` uses `_payer` (captured from `msg.sender` at entry). `from` is never attacker-controlled. A reentrant hook cannot corrupt `_payer` because a re-entrant `Router` entry that hits `AlreadyUnlocked` reverts, rolling back the storage write. |
| `reentrancy-no-eth` | `PoolManager._initialize` / `_modifyLiquidity` / `_swap` (hook callbacks followed by state writes) | **By design — hooks are untrusted.** `before*`/`after*` hooks may re-enter. Value safety does not rely on hooks being honest: (a) `swap`/`modifyLiquidity` are `onlyUnlocked`, so a re-entering hook acts inside the same flash-accounting session, and the end-of-session net-zero sweep (`UnsettledDelta`) guarantees no currency delta can be left non-zero — a hook cannot extract value it did not settle. (b) `initialize` moves no tokens, so the `beforeInitialize`→`slot0` write ordering carries no fund risk (worst case is a benign double-init of the same pool). Verified by the hook tests (`test/v4/Hooks.t.sol`) and the unsettled/nested-unlock tests. |
| `calls-loop` | `Router._doMulti` (loop over hop pools) | **By design.** The loop is bounded by the user-supplied path length; each `pm.swap` is atomic and the net-zero sweep still applies at session end. Not an unbounded or attacker-driven loop. |
| `uninitialized-local` | `PoolManager._updatePosition` `flippedLower`/`flippedUpper` | Same known false positive as Phase 1/2 (assigned inside `if (ld != 0)`, read under the same guard). |
| `low-level-calls` | `CurrencyLibrary.transfer` (native `to.call{value:}`) | **By design.** Sending native ETH requires a low-level call; failure reverts `NativeCurrencyTransferFailed`. The ERC-20 branches use the checked `IERC20Minimal` interface. |
| `cyclomatic-complexity` | `PoolManager._swap` (27) | **By design**, same rationale as the V3 `swap` above: the tick-crossing loop is inherently branchy and mirrors the reference model 1:1. |
| `reentrancy-benign` / `reentrancy-events` / `unused-return` / `missing-zero-check` / `assembly` / `costly-loop` / `dead-code` / `too-many-digits` | various | Informational / heuristics already triaged in Phase 1/2; the V4 additions (`tstore`/`tload` assembly, hook event ordering) follow the same accepted patterns. |

## Phase 4 — protocol fee, donate, claims, hook delta (Slither)

Re-ran Slither 0.11.6 over `src/` after the Phase 4 additions. The Phase 2/3 findings are unchanged
(see the tables above). One new code-quality hit was **fixed**; no new real defects. Triage of the
Phase 4-relevant detectors:

| Detector | Location | Why it is safe / action |
|---|---|---|
| `shadowing-local` | `PoolManager._updatePosition` local `owner` vs. new state `owner` | **Fixed.** Adding the protocol `owner` state in P4.1 shadowed the pre-existing `_updatePosition` parameter `owner` (the position owner — a different concept). Renamed the parameter to `positionOwner`. Benign either way, but shadowing is a known footgun, so it was removed. |
| `arbitrary-send-erc20` | `CurrencyLibrary.transferFrom` | Unchanged — **false positive** (see Phase 3: `from` is always trusted). Now also used by `mint` (pulls `msg.sender`). |
| `reentrancy-no-eth` / `reentrancy-benign` / `reentrancy-events` | `donate` / `mint` / `burn` / claim settlement | **By design — untrusted hooks / checks-effects-interactions.** `donate` is `onlyUnlocked` and net-zero-swept; `mint`/`burn` update `claims`/`reserves` before the token transfer (effects-before-interactions), so a re-entering token sees updated state. Hooks cannot extract unsettled value (net-zero sweep). |
| `uninitialized-local` | `_updatePosition` `flippedLower`/`flippedUpper` | Same known false positive (assigned under `if (ld != 0)`, read under the same guard). |
| `calls-loop` / `costly-loop` | unchanged | **By design**, bounded (see Phase 3). |
| `cyclomatic-complexity` | `PoolManager._swap` (34) | **By design**, same as Phase 3; the P4.4 donation fold is gated by a flag and adds one branch. |
| `unused-return` | `OracleHook.afterSwap` ignores `getSlot0`'s tick | **By design / informational.** The reference oracle hook only needs `sqrtPriceX96`; ignoring the tick is intentional. |
| `missing-zero-check` | `Router.exactInputSingle`/`exactInput`/`modifyLiquidity` `recipient` | **Accepted (Low, caller responsibility).** `recipient` is caller-supplied; sending to `address(0)` is a caller error that burns their own output, not an exploit. The manager's `take`/`burn` are only reachable with caller-chosen recipients. |
| `assembly` / `low-level-calls` / `dead-code` / `too-many-digits` / `immutable-states` | various | Informational / by-design (transient-storage `tstore`/`tload`, native ETH `call{value:}`), unchanged from Phase 2/3. |


## Phase 5 — signed allowances: `AllowanceTransfer` + Router permit path (Slither)

Re-ran Slither 0.11.6 over `src/` after adding `src/v4/periphery/AllowanceTransfer.sol` and
`Router.exactInputSingleWithPermit`. crytic-compile's Foundry backend shells out to `forge`, so
the toolchain has to be on `PATH`:

```powershell
$env:Path = "$env:USERPROFILE\.foundry\bin;$env:Path"
py -m slither . --foundry-out-directory out --exclude-dependencies --filter-paths "lib"
# analyzed (48 contracts with 102 detectors), 71 result(s) found
```

Almost all 71 are the Phase 1–4 findings already triaged above (hook-reentrancy classes,
`uninitialized-local` false positives, V3 `swap` complexity, `CostlyLoop`/`dead-code`
informational hits). Six detectors report instances **in the new code**; none is a defect.

| Detector | Location | Assessment |
|---|---|---|
| `arbitrary-send-erc20` | `AllowanceTransfer.transferFrom` (`AllowanceTransfer.sol#136-152`) | **False positive.** The grant is keyed by the *caller*: `transferFrom` reads `_allowances[from][token][msg.sender]` (`#137`) before moving anything, so a caller can pull only from an address that granted **that caller** an allowance over that token. This is exactly Permit2's design — the spender is pinned by the mapping key, so there is no "arbitrary from". Effects precede the interaction: amount and expiry are checked (`#140-141`), the bounded grant is decremented (`#146`) before `safeTransferFrom` (`#150`), so a re-entering token observes the already-reduced grant; the `type(uint160).max` infinite-grant branch is intentionally left untouched (`#143-148`). Covered by `test_transferFrom_*` (exact spend, expiry, missing grant, infinite grant, fuzz). |
| `reentrancy-benign` | `Router.exactInputSingleWithPermit` (`Router.sol#99-126`) | **False positive — verification is `staticcall`-only.** Detail below. |
| `timestamp` | `permit` (`#103`, `#107`), `setAllowance` (`#121`), `transferFrom` (`#141`) | **Accepted — inherent to the feature.** Deadline/expiry semantics are *defined* in wall-clock time; without them a grant would never expire and a signed grant would be replayable forever, which is the threat A.1 exists to remove. `block.timestamp` manipulation is bounded (~seconds per block) and irrelevant against hour-scale grant TTLs and signature deadlines — the identical trade-off Permit2 and every EIP-2612 token make. No ordering or amount depends on it: a ±15 s skew can at worst extend an owner-authorised, already-signed grant by seconds, and never turns a failing check into a profitable one. |
| `assembly` | `permitERC20` (`#173-175`) | **By design.** Solidity cannot forward arbitrary revert data out of a `catch (bytes memory reason)` without assembly; `revert(add(reason, 0x20), mload(reason))` is the standard bubbling idiom, annotated `("memory-safe")`. The alternative — always reporting `TokenDoesNotSupportPermit` — would mislabel a token's real error (e.g. OZ's `ERC2612InvalidSigner`) as "no permit support", which is worse than one flagged `assembly` block. `reason.length == 0` is precisely what classifies a contract with no `permit` at all. |
| `unused-return` | `pm.unlock()` (`Router.sol#124`), `pm.settle(...)` (`#275`, `#281`) | **By design.** `unlock` returns the callback's `bytes`, deliberately discarded: the observable outcome is `_swapDelta` plus manager state, and any failure inside the callback reverts the whole call. `settle` returns the `uint256 amount` it received, which equals `-pm.getCurrencyDelta(c)` by construction; correctness does not rely on the returned value because `settle` reverts internally on a failed transfer (`TransferFailed`) and the end-of-session net-zero sweep reverts `UnsettledDelta` if anything is left unsettled. Same pattern as every other Router entry point (Phase 3/4). |
| `missing-zero-check` | `exactInputSingleWithPermit.recipient` (`#118`) | **Accepted — same ruling as Phase 4.** `recipient` is caller-supplied; `address(0)` burns only that caller's own output, grants nothing to an attacker, and matches Uniswap's router behaviour. Already accepted for `exactInputSingle`/`exactInput`/`modifyLiquidity`. |

### Detail — why the `exactInputSingleWithPermit` reentrancy flag is a false positive

Slither sees the external call `at.permit(...)` (`#114`) followed by writes to `_payer`,
`_recipient`, `_singleKey`, `_singleParams`, `_minOut`, `_op` (`#117-123`) and reports
write-after-call. The call at `#114` cannot mutate anything:

1. **Signature verification reaches the outside world only through a `staticcall`.** OZ
   `SignatureChecker` calls a contract wallet via
   `signer.staticcall(abi.encodeCall(IERC1271.isValidSignature, (hash, signature)))`
   (`lib/openzeppelin-contracts/contracts/utils/cryptography/SignatureChecker.sol:43`). STATIC
   mode applies to the *entire* callee subtree: should the wallet — or anything it calls — attempt
   `SSTORE`/`TSTORE`/`LOG`/a value-bearing `CALL`, the sub-call reverts. So no re-entry capable of
   writing the Router's fields (or any other state) is reachable at `#114`. The EOA branch
   performs no external call at all (`ecrecover` only).
2. **`permit`'s own ordering is checks → effects with no external call between them**: expiry
   check (`#103`), signature verification (`#110`), then `_useNonce` (`#112`), then
   `_writeAllowance` (`#113`).
3. **Even a hypothetical re-entry could not settle twice.** The Router's fields are read only
   inside `unlockCallback`, and `PoolManager.unlock` opens with
   `if (_unlocked()) revert AlreadyUnlocked();`, so a nested session reverts instead of running a
   second settlement in the same transaction.
4. Throughout the flow the grant is written before any token moves (the pull is later, at
   `_settleOrTake` → `at.transferFrom`), i.e. effects-before-interactions.

`MissingInheritance` (Quoter does not declare `is IUnlockCallback` while Router does) is
**accepted as stylistic**: `PoolManager` invokes the callback through the
`IUnlockCallback(msg.sender)` interface, `Quoter.unlockCallback` already has the required
signature, and adding the inheritance clause would only chase a cosmetic detector — no call site,
ABI surface, or runtime behaviour differs. It is noted for a future cleanup pass rather than
fixed here, to avoid gratuitous bytecode churn in already-deployed, already-tested contracts.

## Phase 6 — crypto A.3 `LimitOrders` + F.1 two-step ownership (Slither re-run)

Re-ran Slither 0.11.6 after adding `src/v4/periphery/LimitOrders.sol` (A.3) and migrating
`PoolManager`/`SwapexFactory` to OpenZeppelin `Ownable2Step` + `TimelockController` (F.1, D29),
same invocation as Phase 5:

```
analyzed (52 contracts with 102 detectors), 77 result(s) found
```

The 77 are the Phase 1–5 findings above (line numbers shifted — earlier tables cite the builds
they were written against). Three detector instances land **in the new code**; none is a defect.
On the ownership migration specifically the run is **clean**: no `missing-zero-check`,
arbitrary-transfer or ownership finding on `Ownable2Step.transferOwnership`/`acceptOwnership` or
the constructor-supplied initial owner (the zero-address class of bug is structurally gone — D29).

| Detector | Location | Assessment |
|---|---|---|
| `reentrancy-events` | `LimitOrders.fillOrder` (`LimitOrders.sol#130-197`: `at.transferFrom` `#177`, `_ensureSpendRights` `#179`, `router.exactInputSingle` `#190`, `OrderFilled` `#196`) | **False positive — checks-effects-interactions is strict.** The digest binding, remaining-amount check and `filled`/`canceled` writes all happen *before* `at.transferFrom` moves anything, so a re-entering `tokenIn` observes already-updated accounting: re-filling the *same* order hits `FillExceedsRemaining`, and a different signed order is simply a nested legitimate fill (per-order, per-nonce state; nothing global is read-then-written). There is no ETH path (`NativeInputNotSupported`), and the Router settlement runs inside `PoolManager.unlock`, which rejects nested sessions (`AlreadyUnlocked`). The event is emitted after all state, so even log ordering is causal. |
| `timestamp` | `fillOrder` deadline (`#134`), `_ensureSpendRights` allowance expiry (`#210`) | **Accepted — identical ruling to Phase 5 `timestamp`.** Both bounds come from the *signed* order / on-chain grant (`uint48 deadline`, grant `expiration`); deadline semantics are wall-clock by definition and the threat they remove (unlimited-lifetime signed orders) is the one A.3 exists for. Minute-scale miner skew cannot turn an expired fill profitable — it only shifts a fill the maker already authorised into an adjacent block. |
| `cyclomatic-complexity` | `LimitOrders.fillOrder` (15) | **By design.** A sequential validation pipeline (order sanity → signature → digest binding → remaining → CEI writes → pull → rights → swap), each stage guarded by its own custom error for testability — strictly simpler than the already-accepted `SwapexPool.swap` (30) and `PoolManager._swap` (34). |


## Aderyn 0.6.8 — 7 High / 18 Low, all triaged (one fixed)

**How it ran.** Aderyn ships no Windows prebuilt binary (the GitHub releases contain only
`*-apple-darwin` / `*-linux-gnu` artifacts), and the npm wrapper (`@cyfrin/aderyn`) refuses to
install outright:

```
npm error Platform with type "Windows_NT" and architecture "x64" is not supported by @cyfrin/aderyn.
npm error Your system must be one of the following:
npm error aarch64-apple-darwin,aarch64-unknown-linux-gnu,x86_64-apple-darwin,x86_64-unknown-linux-gnu
```

Building from source also fails: `cargo install aderyn --locked` (crates.io `aderyn 0.1.9`) dies
compiling its `svm-rs-builds` dependency with `rustc --explain E0428` — 4 duplicate-definition
errors on `SOLC_VERSION_*_CHECKSUM` consts (`could not compile svm-rs-builds due to 4 previous
errors`). Upstream crate bug, unrelated to our contracts.

So it ran in this machine's **WSL Ubuntu** with the official prebuilt
`x86_64-unknown-linux-gnu` tarball (aderyn v0.6.8) plus a `forge` symlink to the Windows Foundry
binary for compilation interop:

```
cd /mnt/c/Users/mrsur/Documents/swapex/swap/contracts
aderyn .
# compiled 29 files (solc 0.8.26), ran 88 detectors
# → 7 High, 18 Low  (raw report written to contracts/report.md, deleted after triage;
#                    regenerate with the command above)
```

Detector overlap with Slither is large: 6 of the 7 Highs are false-positive classes already
adjudicated in Phase 5. The one genuine finding (**H-2**) is fixed.

### High (7)

- **H-2 — "Contract locks Ether without a withdraw function" (`Router`) — REAL, FIXED.**
  All four payable entries forwarded only the owed delta out of `msg.value`; the excess from an
  over-payment or a price-limited partial fill stayed in the Router forever (no owner, no
  withdrawal path). **Fix:** `_refundNative()` sweeps `address(this).balance` back to `msg.sender`
  immediately after `pm.unlock` returns — i.e. after settlement, outside the unlock session — in
  `exactInputSingle`, `exactInputSingleWithPermit`, `exactInput`, and `modifyLiquidity`; a failed
  refund reverts with `NativeRefundFailed()`. Re-entrancy note: a receiver that re-enters starts a
  fresh, self-contained call and can only touch the allowance and balance it brought itself.
  Tests: `test_exactInputSingle_overpaidNative_isRefunded` and
  `test_exactInputSingle_partialFill_refundsTheUnfilledRemainder` (assert refund =
  attached − consumed delta, and router balance 0 afterwards).
- **H-1 — arbitrary `from` (`AllowanceTransfer.sol:150`) — false positive.** Same class as the
  Slither `arbitrary-send-erc20`: `transferFrom` spends `grantOf(msg.sender, …)`, so a caller can
  only pull the grant *it* holds against this router.
- **H-3 — caret operator (`FullMath.sol:52`) — false positive.** XOR in the Newton–Raphson
  doubling step is intentional (Phase 2 ruling).
- **H-4 — reentrancy, state change after external call (6 instances) — false-positive class.**
  `SwapexPool.sol:103` (constructor — no external call), `SwapexPool.sol:436` (`lock` modifier,
  `AlreadyUnlocked`), `PoolManager.sol:186` (net-zero sweep + `AlreadyUnlocked`),
  `OracleHook.sol:17` (view-only call before own storage), and **`Router.sol:113` / `:114`**
  (`isNonceUsed` / `permit` are `staticcall`s — `SignatureChecker` cannot mutate state; the
  line-by-line justification is in "Detail — why the `exactInputSingleWithPermit` reentrancy flag
  is a false positive" above).
- **H-5 — contract name reused (`SafeCast.sol:4`) — tooling false positive.** Foundry resolves
  imports by path; the clash is with OpenZeppelin's `SafeCast` in `lib/`, which only bites
  Truffle/Hardhat-style resolvers.
- **H-6 — unprotected initializer (`Router.sol:65`) — false positive.** `initialize` is not a
  proxy initializer: it is the permissionless pool-price initializer passthrough (documented in
  Manual review notes below; matches Uniswap V2/V3 behavior).
- **H-7 — unsafe cast (`SwapexPool.sol:361`) — accepted, pre-existing V3 port.**
  `state.protocolFee += uint128(delta)` truncates only if a single swap's protocol-fee share
  exceeds `2^128` — i.e. an input of at least `2^128 × protocolFeeDenominator` in one swap — which
  is unreachable for any real ERC-20 and is verbatim Uniswap V3 core `Pool.swap`. Swapping in
  `SafeCast` would only turn an unreachable silent truncation into a revert at implausible
  amounts while diverging from the battle-tested reference; no change made.

### Low (18) — grouped triage

| Finding | Where | Verdict |
|---|---|---|
| L-1 centralization (3) | `SwapexFactory.enableFeeAmount`, `PoolManager.setProtocolFee/collectProtocol` | `setOwner` no longer exists (F.1: two-step + `TimelockController`, D29) — admin calls are delayed and cancellable; testnet keys and the multisig-handover rule documented in `docs/TESTNET_SECURITY.md` §3 |
| L-2 costly op in loop (4) | `SwapexPool:327`, `PoolManager:190/370`, `Router:142` | loops are O(touched currencies) / O(path length), bounded by caller-paid gas; the sweep is the net-zero check (D14) |
| L-3 empty block (1) | `DynamicFeeHook:17` | intentional no-op demo hook |
| L-4 internal fn used once (2) | `FullMath:11`, `Observations:95` | style; keeps the reference structure intact |
| L-5 large numeric literal (3) | `SwapexFactory:41/85`, `PoolManager:119` | fee constants (10000, 1e6) written as literals so the exact value is readable at the call site |
| L-6 literal instead of constant (64) | `BitMath/TickMath/SqrtPriceMath/SwapMath/Observations` | verbatim Uniswap library ports; extracting constants would diverge from the reference (D12) |
| L-7 local shadows state (1) | `SwapexPool:274` | `SwapState.liquidity` struct member mirrors the pool's state var — always accessed as `state.liquidity`; faithful to V3's swap loop, no ambiguity |
| L-8 missing inheritance (2) | `SwapexFactory:7`, `Quoter:13` | same stylistic note as the Slither `MissingInheritance` ruling (Phase 5) |
| L-9 PUSH0 opcode (29) | pragma lines across `src/` | `evm_version = "cancun"` is pinned in `foundry.toml`; every target (anvil, testnets) is post-Shanghai |
| L-10 loop contains require/revert (7) | `Observations:88`, `TickMath:79/80`, `SwapexPool:327`, `PoolManager:190/370`, `Router:241` | intended: bounded loops fail loudly (`UnsettledDelta`, per-hop `minAmountOut`) instead of silently mis-accounting |
| L-11 state change without event (11) | `Router` entries, `PoolManager.settle/take/donate`, `Quoter`, `OracleHook` | per-session / flash-accounting bookkeeping; the user-visible effects emit `Swap` / `ModifyLiquidity` at the manager (ownership changes emit OZ's `OwnershipTransferStarted`/`OwnershipTransferred`) |
| L-12 address set without checks (4) | `Router:78/118/139/158` (`_recipient = recipient`) | same ruling as Slither `missing-zero-check` (accepted in Phase 4) |
| L-13 state var could be immutable (1) | `PoolManager` owner (was `PoolManager:116`) | **Superseded by F.1 (D29).** The owner is now OpenZeppelin `Ownable`'s private `_owner`, intentionally mutable via the two-step transfer to the timelock/multisig — immutability would defeat the whole point |
| L-14 unchecked return (5) | `Router:84/124/147/162` (`pm.unlock`), `:281` (`pm.settle`) | same as Slither `unused-return`: `settle` reverts on failure and its return equals `-getCurrencyDelta`, which every caller already checks |
| L-15 unsafe ERC20 operation (9) | `SwapexPool:546`, `PoolManager:278/279/680/708`, `Router:280`, `Currency.sol:52/60/67` | transfers are balance-delta-checked (Manual review notes); `Router:280`'s approve is consumed exactly by the following `settle` (allowance returns to 0 — USDT-style zero-reset safe) |
| L-16 unspecific pragma (16) | `^0.8.26` across `src/` | `solc_version = "0.8.26"` is pinned in `foundry.toml`; caret is the repo convention |
| L-17 unused error (2) | `SqrtPriceMath:13/15` | dead declarations in the V3-faithful port; unreferenced errors emit no bytecode |
| L-18 public fn not used internally (2) | `AllowanceTransfer:191/198` | `isNonceUsed` is called cross-contract by `Router.exactInputSingleWithPermit`; `hashPermitSingle` is the off-chain EIP-712 digest helper for frontends/tests — both are external API by design |

Because Aderyn and Slither use different heuristics, this run adds independent confidence; it is
not a substitute for the manual review notes below.

## Manual review notes

- **Payment checks use balance deltas, not return values.** `mint`, `swap`, and `flash` snapshot
  `balanceOf` before the callback / transfer-out and re-read it after, requiring the pool's balance
  to have increased by at least the owed amount. This is robust against tokens that return `true`
  without moving funds, and against fee-on-transfer (rejected loudly, see `FeeOnTransferTest`).
- **`initialize` is permissionless.** Anyone can set the initial price of a freshly-created pool.
  This matches Uniswap V2/V3 and is a known front-running surface: an attacker can observe a
  pending `createPool` + `initialize` and race to set a hostile initial price. Mitigations live in
  the periphery (initialize in the same tx as first mint) and are documented as a Phase 2 concern.
- **No TWAP oracle yet.** Added in Phase 1 step 7.
- **`getTickAtSqrtRatio` is a binary search** (correct, ~30k gas). Replaced with a log2 version in
  Phase 1 step 6, with the original retained as a test oracle.
