# Decision log — Swapex V3 core

Append-only record of design decisions and their rationale. Newest last.

## D1 — Reference model is the source of truth
**Decision:** Build `contracts/reference/` (Python) first and treat it as the math oracle.
Solidity must match it operation-for-operation; golden vectors are *generated* from it.
**Rationale:** Concentrated-liquidity math is dense and easy to get subtly wrong. An
independent, exact-integer Python model lets us prove the Solidity rather than eyeball it.
We never edit expected values to make a test pass — if Solidity and Python disagree, one of
them has a bug and we find it.

## D2 — License stays GPL-2.0-or-later
**Decision:** Keep SPDX `GPL-2.0-or-later` on all contracts (ask before changing).
**Rationale:** Matches the intended licensing; changing it is a scope/legal decision, not an
engineering default.

## D3 — `getTickAtSqrtRatio` via log2 + bounded snap
**Decision:** Replace the binary search with a Q96 `log2`-based candidate plus a snap loop
bounded to one correction up/down. Keep the binary search as a test-only oracle
(`_tickAtSqrtRatioBinarySearch`).
**Rationale:** A Python prototype (`proto_log2.py`, since removed) proved over 40k samples
that the log2 candidate is always within 1 of the exact tick (max correction distance 1, 0
mismatches). So the snap loop provably terminates in ≤1 iteration and is bit-identical to
the oracle. Saves ~1–1.5k gas per call (the binary search did ~20 `getSqrtRatioAtTick`
calls; log2 does ~96 cheap muls + ≤2 of them), compounding across tick crossings (pool
scenario −28k gas). Differential fuzz (2 tests × 10k runs) plus round-trip, monotonic, and
golden-vector tests all pass.

## D4 — `unchecked` justification policy
**Decision:** Every `unchecked` block carries a comment explaining why overflow is
impossible or why wrap-around is intended. Default is checked math.
**Rationale:** Checked math silently documents bounds; `unchecked` is only for (a) proven-safe
hot paths and (b) intentional wrapping cumulatives (fee growth, seconds-per-liquidity).

## D5 — TWAP: write observations on every state change, at pre-operation state
**Decision:** `SwapexPool` appends an observation in `swap`, and in `_modifyPosition`
(shared by mint/burn), using the *current* (pre-op) tick and liquidity before mutating any
state.
**Rationale:** The interval since the last observation had constant tick and liquidity (any
change would itself have written an observation). Capturing the pre-op state makes each
inter-observation interval single-valued, so `observe()`'s linear interpolation of
`tickCumulative` is *exact*, not an approximation.

## D6 — `secondsPerLiquidityCumulativeX128` wraps; `tickCumulative` stays checked
**Decision:** The seconds-per-liquidity cumulative accumulates in `unchecked` (wraps like fee
growth). `tickCumulative` stays checked.
**Rationale:** seconds-per-liquidity can grow unboundedly for a low-liquidity pool over long
time; wrapping is the standard, DoS-safe behavior (users take *differences*, which remain
correct across a single wrap). `tickCumulative` is bounded by `|tick| ≤ 887272` and the
`uint32` time range, so checked math is safe and an out-of-range input reverts rather than
corrupting the oracle. The Python model uses unbounded ints and matches bit-for-bit until a
wrap (never reached in tests).

## D7 — Truncation over revert for out-of-window `observe`
**Decision:** If a requested target predates the oldest retained observation, return the
oldest cumulative instead of reverting.
**Rationale:** A ring buffer of finite cardinality cannot serve arbitrarily old windows.
Returning the oldest value (a documented truncation) is more usable than bricking a consumer
whose window slightly exceeds retained history, and it mirrors the Python model. This fix
also removed a real underflow: `target - beforeOrAt.blockTimestamp` (uint32) panicked when
`target` was older than `beforeOrAt`; the `target <= beforeOrAt.blockTimestamp` guard now
returns early. Regression test: `test_oracle_truncationReturnsOldestNotRevert`.

## D8 — `cardinalityNext` grows lazily; default 1
**Decision:** `observationCardinalityNext` starts at 1 and grows only via
`increaseObservationCardinalityNext`. `observationCardinality` (retained count) grows by one
per write, capped at `cardinalityNext`, as the buffer fills.
**Rationale:** Zero extra storage/gas until someone actually wants a TWAP window; keeps the
default swap path cheap. Consumers that need history call `increaseObservationCardinalityNext`
once and pay for it only as observations fill.

## D9 — Fixed `Observation[65535]` storage array (not a mapping)
**Decision:** `observations` is a fixed-size storage array `Observation[65535]`; the library
operates on an `Observation[65535] storage` pointer.
**Rationale:** Storage is sparse in the EVM, so the large fixed length costs nothing until
written. A storage pointer avoids copying the array to memory. `cardinalityNext ≤ 65535`.

## D10 — Slither over Aderyn for static analysis (Aderyn is CI-only here)
**Decision:** Use Slither locally; Aderyn is documented but only runnable in CI (Linux).
**Rationale:** Aderyn ships no Windows binary and its crates.io build fails on an upstream
`svm-rs` duplicate-const error. Slither 0.11.6 runs fine and its 20 findings were triaged in
`docs/SECURITY.md`. The one real issue found (factory `setOwner` missing a zero-address
check) was fixed with a regression test.

## D11 — Foundry `vm.warp` in oracle tests uses absolute timestamps
**Decision:** Oracle behavioural tests warp with absolute values (`vm.warp(10 * (i + 1))`)
rather than `vm.warp(block.timestamp + N)`.
**Rationale:** In this environment the relative form did not accumulate (every call behaved
as an absolute warp to the first computed value), which left `block.timestamp` stuck and
caused `time - secondsAgo` to underflow in `observe`. Absolute warps are unambiguous and
robust regardless of cheatcode behavior.
