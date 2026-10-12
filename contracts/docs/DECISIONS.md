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

## D12 — PoolManager reuses the V3 math libraries verbatim
**Decision:** The V4-style singleton re-keys per-pool state under `PoolId` but calls the
Phase 1 libraries (`Tick`, `TickBitmap`, `Position`, `SqrtPriceMath`, `SwapMath`, `FullMath`,
`LiquidityMath`, `SafeCast`) unchanged.
**Rationale:** Those libraries are the reference-checked core of Phase 1 (golden vectors +
differential tests). Re-writing them for the manager would duplicate ~1000 lines of dense
math and risk divergence for zero benefit. Only the *orchestration* (flash-accounting deltas,
singleton storage layout) is new.

## D13 — Transient storage via inline `tstore`/`tload` (solc 0.8.26 has no `transient` keyword)
**Decision:** The per-currency delta and the `unlocked` reentrancy lock live in transient
storage, addressed with inline-assembly `tstore`/`tload` at keccak-derived / fixed slots.
**Rationale:** Flash-accounting deltas are hot (read/written many times per swap) and are
guaranteed zero at the end of every `unlock`, so transient storage avoids repeated cold
SSTOREs and is cleared automatically at tx end. solc 0.8.26 supports the `tstore`/`tload`
opcodes (cancun) but not the high-level `transient` state-variable keyword or `transient`
mappings (those arrived in 0.8.28), so the accessors are hand-written assembly with a salt to
avoid cross-contract slot collisions.

## D14 — Flash-accounting safety: net-zero sweep over touched currencies
**Decision:** `unlock` records every currency whose delta becomes non-zero and, before
releasing the lock, iterates them and reverts `UnsettledDelta` unless each delta is exactly
zero.
**Rationale:** This is the core flash-accounting invariant. Without it, a callback could
`take` tokens and leave the corresponding negative (owed) delta unsettled, effectively
stealing from the pool. Checking only the *sum* is insufficient (a +X on one currency and −X
on another would net to zero while both are wrong), so the sweep is per-currency. The
touched-list is persistent only for the duration of the session and is reset each time; the
deltas themselves are transient. Verified by `test_unsettledDelta_reverts` and the
`check_v4.py` multihop net-to-zero check.

## D15 — `BalanceDelta` / `currencyDelta` use the caller-owes sign convention
**Decision:** A positive delta means the pool owes the caller (the caller may `take`); a
negative delta means the caller owes the pool (the caller must `settle`). The V3-style swap
amounts (positive = caller owes) are negated once when folded into `currencyDelta`.
**Rationale:** This matches the reference model (`v4model.py`), the V4 design doc, and the
golden-vector differential, so the Solidity and Python agree bit-for-bit. Keeping a single
convention end-to-end (rather than switching between "pool-receives" and "caller-owes") avoids
the classic sign bugs in multi-hop settlement; the one place V3's convention appears (the swap
loop's raw amounts) is isolated and negated exactly once with a comment.

## D16 — Native settle uses payable `msg.value`, not a sync/balance-diff
**Decision:** `PoolManager.settle` is `payable`. For an ERC-20 it `transferFrom`s the caller as
before; for the native currency (`address(0)`) it requires `msg.value == amount` owed and treats
the ETH as already received. `take` sends ETH via the currency helper for native.
**Rationale:** The V4-style `sync`/balance-diff pattern (snapshot balance, send ETH, settle the
delta) needs extra state and is easier to get wrong. Requiring an exact `msg.value` is simpler,
cannot be under- or over-paid (mismatch reverts `NativeSettleAmountMismatch`), and keeps a single
settlement code path for both currency kinds. A native pool always sorts `address(0)` as
`currency0`, so the delta/settle/take math is identical to ERC-20 — only the transfer mechanism
branches.

## D17 — Hooks are gated by mined address bits and are untrusted
**Decision:** A hook's permissions are the low bits of its contract address (deployer mines a
CREATE2 salt). The manager calls a hook function only when the matching flag is set, so a hook
implements only what it flags. `initialize` runs `Hooks.validate` to reject non-mined addresses.
**Rationale:** Encoding permissions in the address (rather than an on-chain registry or a flag on
the pool) makes "does this pool have hook X at point Y" a pure address check with no storage
read, and it is the scheme the V4 design doc calls for. The manager treats hooks as untrusted:
value safety never depends on hook honesty — `swap`/`modifyLiquidity` are `onlyUnlocked`, so a
re-entering hook acts inside the same flash-accounting session, and the net-zero sweep guarantees
no delta is left non-zero. Address mining is an off-chain concern; on-chain validation only
rejects obviously-unmined addresses (a stray bit in the reserved low 3 bits).

## D18 — Dynamic fee via a dedicated `getSwapFee` getter (return-delta deferred)
**Decision:** When a hook's address carries the `DYNAMIC_FEE` flag, the manager queries
`IHooks.getSwapFee(key)` and charges that lp fee for the swap instead of `key.fee`. The V4-style
"beforeSwap returns a BalanceDelta that adjusts settlement" (hook donates/takes tokens) is **not**
wired and is a documented follow-up.
**Rationale:** A dedicated getter is simple, testable (the dynamic-fee hook test asserts a higher
fee reduces output), and cannot accidentally entangle hook accounting with the caller's delta.
Return-delta settlement touches the core flash-accounting path and deserves its own
reference-checked increment rather than being bolted on; deferring it keeps Phase 3 correct.

## D19 — Router holds input tokens momentarily (pull → approve → settle)
**Decision:** For an ERC-20 input the user approves the **Router**. Inside the unlock callback the
Router pulls the input from the user, approves the manager, and calls `settle` (which pulls
Router→manager). Native input is sent as `msg.value` and settled from the Router's balance.
**Rationale:** The manager's `settle` pulls from `msg.sender` (the Router), so the Router must
momentarily hold the tokens. This is the standard periphery pattern (Uniswap V2/V3/V4 routers all
do this) and means users approve one trusted Router rather than the core manager. Multi-hop is
chained by reading each hop's intermediate delta after it executes, so intermediate currencies net
to zero and only the first input / last output move.

## D20 — `sync` is intentionally omitted (superseded by D16)
**Decision:** The V4-style `sync(currency)` balance-snapshot is **not** implemented. Native settle
uses the payable-`msg.value` path from D16, which makes the balance-diff mechanism `sync` exists to
serve unnecessary.
**Rationale:** `sync` only adds value as the companion to a balance-diff `settle`. Since D16 chose
`msg.value == amount` (a single, simpler settlement path for both currency kinds), a balance snapshot
would be dead state. The design surface listed `sync`, but D16 is a later, deliberate choice that
supersedes it; adding an unused `sync` would be dead code.

## D21 — Hook return-delta is donation-only (`beforeSwapDelta`)
**Decision:** A hook flagged `BEFORE_SWAP_DELTA` (bit 12) may return a **non-positive** `BalanceDelta`
from `beforeSwapDelta`. The manager burns the hook's ERC-6909 claims to fund it and credits the
donation to the swap caller (who settles less). A positive component reverts `InvalidHookDelta`; an
under-funded donation reverts `InsufficientClaim`.
**Rationale:** The transient delta ledger is keyed by **currency only**, so a hook cannot settle an
independent delta. Folding a hook delta into the caller's settlement is only sound when the hook's
contribution is pre-funded — here via claims (backed 1:1 by `reserves`). Restricting to donations
(negative deltas) means a hook can only put value in, never take it out: a positive delta would mint
unbacked claims and is rejected. Net-zero and solvency are preserved because the hook's claims are
already backed by real tokens; burning them frees those tokens to the pool and the caller's
obligation shrinks by the same amount.

## D22 — ERC-6909 claims are backed 1:1 by `reserves`; claim settle/take reclassify deltas
**Decision:** `claims[c][a]` is `a`'s ownership of tokens the manager already holds (`reserves`).
`mint` (deposit) pulls real tokens (`reserves +=`, `claims +=`); `burn` (redeem) sends them out
(`reserves -=`, `claims -=`). `settleViaClaim` burns the caller's claims to clear a negative delta
and `takeViaClaim` mints claims to clear a positive delta — neither moves tokens, so `reserves` is
unchanged and still covers the reclassified obligation.
**Rationale:** Tying every claim to real tokens in `reserves` keeps the solvency invariant
`reserves[c] >= claims[c] + positiveDeltas[c]` inductively maintainable: `mint`/`burn` move both
sides together; the claim variants shift an obligation between the delta ledger and the claims
ledger by equal amounts. This lets the manager support gas-efficient claim-based settlement without
ever issuing an unbacked IOU.

## D23 — Protocol fee is a carve-out of the lp fee, not an extra charge on the trader
**Decision:** `protocolFee` (in 1e6) is the share of the lp fee routed to the protocol per swap. The
trader pays the same total (the fee is still `input * lpFee / 1e6`); only the split between LP
accrual and protocol accrual changes. The protocol cut accrues per-currency (input token) to
`protocolFees0/1` and is owner-withdrawable via `collectProtocol`.
**Rationale:** Making the protocol fee a carve-out (rather than a surcharge) means enabling it never
changes execution price for traders, so it can be turned on for live pools without surprising users.
It is read once per swap and applied in the existing fee-accrual block, so the swap loop and the
`FG` accounting are untouched apart from subtracting the protocol portion before the LP update.
