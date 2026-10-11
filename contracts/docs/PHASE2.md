# Phase 2 — Swapex V4-style PoolManager: singleton + flash accounting

Phase 2 adds a V4-style singleton `PoolManager` (`contracts/src/v4/`) on top of the
reference-checked V3 math. One contract holds every pool; token movement is *deferred* to the
end of an `unlock` session via **flash accounting**, so multi-hop swaps across pools net out
and move no tokens until the session closes. All per-pool concentrated-liquidity math is
**reused verbatim** from the Phase 1 libraries (`Tick`, `TickBitmap`, `Position`,
`SqrtPriceMath`, `SwapMath`, `FullMath`, …); nothing was re-implemented. The V4-style code is
written from scratch (concepts only — see the BUSL note in `V4_DESIGN.md`).

## Reference-model-first workflow (continued)

- `contracts/reference/v4model.py` — a `PoolManagerModel` that wraps the validated single-pool
  `Pool` and layers the singleton + flash-accounting behaviour on top: per-currency deltas in
  the caller-owes convention, `unlock` sessions, `settle`/`take`, and the end-of-session
  net-zero rule.
- `check_v4.py` — self-checks: multi-hop/multi-pool swap nets every delta to zero, liquidity
  round-trip keeps a rounding surplus (never a deficit), overdraw `take` and nested `unlock`
  revert.
- `gen_v4_vectors.py` — emits `test/v4/V4Golden.t.sol` from the model: a deterministic op
  sequence (mint → exact-in/exact-out/tick-crossing swaps → burn → poke → burn) whose every
  returned `BalanceDelta` the Solidity manager must match **bit-for-bit**.

## What Phase 2 covers

| Item | Artifact | Status |
| --- | --- | --- |
| P2.1 Reference model | `reference/v4model.py`, `check_v4.py` | 12 checks pass |
| P2.2 Core types | `src/v4/types/{Currency,BalanceDelta,PoolKey}.sol` | packed signed deltas, `PoolId` |
| P2.3 PoolManager core | `src/v4/PoolManager.sol` (`initialize`/`swap`/`modifyLiquidity`) | reuses V3 math libs |
| P2.4 Flash accounting | transient-storage deltas, `unlock`, `settle`/`take`, net-zero sweep | cancun `tstore`/`tload` |
| P2.5 Tests | `test/v4/{Types,PoolManager,V4Golden}.t.sol` | 7 + 5 + 1, differential vs model |
| P2.6 Docs / analysis | this file, `DECISIONS.md` (D12–D15), `SECURITY.md` Phase 2 section | Slither clean (no new real findings) |

## Design

- **Types.** `currency` (user-defined value type over `address`), `BalanceDelta` (a packed
  `int256` of two `int128`, amount0 high / amount1 low), and `PoolKey`/`PoolId` (keccak of the
  sorted currencies + fee + tick spacing + hooks). The delta sign convention is
  **caller-owes**: positive = the pool owes the caller (may `take`), negative = the caller owes
  the pool (must `settle`).
- **Flash accounting.** Inside `unlock`, `swap`/`modifyLiquidity` accumulate signed
  per-currency deltas in **transient storage** (`tstore`/`tload` at keccak-derived slots — solc
  0.8.26 has no high-level `transient` mapping/keyword, so it is done in inline assembly). The
  callback `settle`s negative deltas (pulling tokens via `transferFrom`) and `take`s positive
  deltas (pushing via `transfer`). When the session closes, a sweep over the currencies touched
  requires every delta to be exactly zero, else it reverts `UnsettledDelta`. Nested `unlock`
  reverts `AlreadyUnlocked`.
- **Per-pool state** lives in a `mapping(PoolId => Pool)` where `Pool` embeds the tick,
  tick-bitmap, and position mappings; the Phase 1 libraries operate on those nested mappings
  unchanged.

## Verification status (end of Phase 2)

- `forge test` — **72/72 passing** across 13 suites (59 Phase 1 + 13 Phase 2: 5 types,
  7 pool-manager, 1 golden-vector).
- `py check_refmath.py && py check_pool.py && py check_oracle.py && py check_v4.py` — all pass.
- Golden-vector differential (`V4GoldenTest`) matches the reference model bit-for-bit across
  mint, exact-in, exact-out, tick-crossing swap, burn, and fee-poke.
- `.gas-snapshot` regenerated and committed.

## Notable engineering decisions (see `docs/DECISIONS.md` for full rationale)

1. **Reuse the V3 math libraries, don't rewrite them.** The per-pool state is re-keyed under
   `PoolId`, but `Tick`/`TickBitmap`/`Position`/`SqrtPriceMath`/`SwapMath` are called
   unchanged. The correctness proven in Phase 1 carries over directly.
2. **Transient storage via assembly.** solc 0.8.26 predates the high-level `transient`
   keyword/mapping support (0.8.28), so deltas and the reentrancy lock use inline
   `tstore`/`tload`. Deltas are cleared automatically at tx end; the lock is a fixed slot.
3. **Net-zero sweep over touched currencies.** A persistent touched-list (reset each session)
   lets `unlock` verify every currency delta is zero before releasing, so a callback cannot
   leave an unsettled (negative) delta and steal value. This is the core flash-accounting
   safety property.
4. **Scope: ERC-20 only, no hooks, no native ETH, no protocol fee.** The `PoolKey` carries a
   `hooks` field (unused, `address(0)`) for forward-compat; hooks, native-ETH plumbing, and the
   Router are Phase 3+ per `V4_DESIGN.md`.

## Known limitations / follow-ups

- Hooks, native ETH (`address(0)` currency), and the Router/periphery are **Phase 3+**; the
  `Currency.ADDRESS_ZERO()` sentinel is defined but not yet wired.
- Protocol fee is omitted from the manager (lp fee only), matching the V3 pool with
  `protocolFeeDenominator == 0`.
- `settle` always settles the full owed amount (pulls `-delta`); partial settlement is not
  exposed. `take` allows partial amounts.

## Phase 2 is complete when

All of the above hold: full green suite, Python checks green, golden-vector differential
matching the model, gas snapshot committed, and these docs present. Hooks, native ETH, and the
Router are out of scope here and scheduled for Phase 3.
