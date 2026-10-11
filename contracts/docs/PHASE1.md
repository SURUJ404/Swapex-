# Phase 1 — Swapex V3 Core: correctness, hardening, TWAP

Phase 1 delivered a self-consistent, reference-checked concentrated-liquidity pool core
(`contracts/src/v3/`) plus the TWAP oracle, with every number cross-validated against a
from-scratch Python model (`contracts/reference/`) that acts as the math oracle. Nothing
here was copied from Uniswap; the Python model is the source of truth and the Solidity is
proven to match it.

## Reference-model-first workflow

- `contracts/reference/refmath.py` — exact integer ports of tick math, `mulDiv`, the swap
  step, and the tick bitmap.
- `contracts/reference/poolmodel.py` — a full pool (ticks, positions, fee growth, the TWAP
  observation ring buffer). Solidity must reproduce it operation-for-operation.
- `check_refmath.py`, `check_pool.py`, `check_oracle.py` — self-checks; the oracle check
  validates `observe()` against brute-force `tick * time` integration and proves
  manipulation resistance.
- `gen_vectors.py` / `gen_oracle_vectors.py` — emit golden-vector Solidity tests
  (`GoldenVectors.t.sol`, `OracleGolden.t.sol`) directly from the model, so expected values
  are never hand-written.

## What Phase 1 covers

| Item | Artifact | Status |
| --- | --- | --- |
| P1.1–4 Core correctness | `forge test` green; Python checks pass | done |
| P1.5a Invariants | `test/invariant/PoolHandler.sol`, `PoolInvariants.t.sol` | 5 invariants, 64×30 |
| P1.5b Token quirks | `test/mocks/*.sol`, `test/tokens/Quirks.t.sol` | FoT / no-return / reverting / reentrant |
| P1.5c Static analysis | Slither triage in `docs/SECURITY.md`; `setOwner` zero-address fix | Aderyn CI-only (Windows gap) |
| P1.5d Gas baseline | `.gas-snapshot` | committed, regenerated each phase |
| P1.6 Fast `getTickAtSqrtRatio` | `src/libraries/TickMath.sol` (log2 + bounded snap) | differential-tested vs binary-search oracle |
| P1.7 TWAP oracle | `src/libraries/Observations.sol`, `SwapexPool` integration | golden + behavioural tests |

## Verification status (end of Phase 1)

- `forge test` — **59/59 passing** across 10 suites (unit, golden vectors, quirks,
  invariants, oracle).
- `py check_refmath.py && py check_pool.py && py check_oracle.py` — all pass.
- `.gas-snapshot` regenerated and committed.

## Notable engineering decisions (see `docs/DECISIONS.md` for full rationale)

1. **`getTickAtSqrtRatio` via log2.** Candidate tick derived from a Q96 `log2` of the
   sqrt-price, then snapped with at most one correction up/down. A Python prototype proved
   the candidate is always within 1 of the exact tick, so the snap loop is bounded. The old
   binary search is retained as `_tickAtSqrtRatioBinarySearch` (test-only oracle, not in pool
   bytecode). Saves ~1–1.5k gas per call; pool scenario −28k gas.
2. **TWAP oracle written from scratch.** Observations record `(blockTimestamp,
   tickCumulative, secondsPerLiquidityCumulativeX128)`. Every swap/mint/burn appends one at
   the *pre-operation* tick and liquidity, so each inter-observation interval has constant
   tick/liquidity and `observe()` interpolation of `tickCumulative` is exact.
3. **Truncation semantics.** A window older than the oldest retained observation returns the
   oldest cumulative instead of reverting (matches the Python model). This also guards the
   `target - beforeOrAt.blockTimestamp` subtraction from underflowing — a real bug caught by
   the manipulation-resistance test.
4. **`secondsPerLiquidityCumulative` wraps (unchecked)** like fee growth, so a low-liquidity
   pool can never brick `observe()`. The Python model uses unbounded ints and matches
   bit-for-bit until such a wrap (never reached in tests).

## Known limitations / follow-ups

- **Aderyn** has no Windows binary and its crates.io build is broken by an upstream `svm-rs`
  dependency; it is wired for CI (Linux) only. Documented in `docs/SECURITY.md`.
- `uint32(block.timestamp)` truncation in the oracle is intentional (standard wrapping-time
  design); `forge lint` emits `unsafe-typecast` warnings for it. Left as-is.
- Foundry `vm.warp(block.timestamp + N)` did **not** accumulate in this environment (every
  call behaved as an absolute warp to the first value); oracle tests use absolute warps
  (`vm.warp(10 * (i + 1))`) to be robust.

## Phase 1 is complete when

All of the above hold: full green suite, Python checks green, gas snapshot committed, and
these docs present. Frontend integration, periphery (NonfungiblePositionManager, Router),
and multi-fee-tier deployment are Phase 4+ work and are out of scope here.
