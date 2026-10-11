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
| `missing-zero-check` | `SwapexFactory.setOwner` (`src/v3/SwapexFactory.sol:74`) | **Fixed.** `setOwner(address(0))` would silently renounce ownership to an unowned state that can never be recovered (the `onlyOwner` modifier can never pass again). Added `if (newOwner == address(0)) revert ZeroAddress();` plus regression test `test_factory_setOwnerRevertsOnZeroAddress`. |

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


**Status: not run in this environment (Windows).** Aderyn ships no Windows prebuilt binary
(the GitHub releases contain only `*-apple-darwin` artifacts), and building from source fails:
the crates.io release (`aderyn 0.1.9`) depends on `svm-rs-builds`, which currently fails to
compile with duplicate `SOLC_VERSION_*_CHECKSUM` const definitions (an upstream crate bug, not
something this repo can patch). This was verified by attempting `cargo install aderyn --locked`.

Aderyn should run in CI (Linux). The command to reproduce there:

    aderyn contracts/src

Record the output and triage any findings into this file the same way as the Slither results
above. Because Aderyn and Slither use different heuristics, a clean Aderyn run adds independent
confidence but is not a substitute for the manual review notes below.

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
