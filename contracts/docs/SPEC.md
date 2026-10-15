# Swapex V4 — Formal Specification

This document states the core invariants of the V4-style `PoolManager` precisely. It is the
reference the tests (unit, differential, fuzz, invariant) check against. Notation:

- `Δ[a][c]` — the transient *delta* of account `a` for currency `c` during an unlock session, in the
  **caller-owes** convention: `Δ[a][c] > 0` means the pool owes `a` `Δ[a][c]` of `c` (take);
  `Δ[a][c] < 0` means `a` owes the pool `-Δ[a][c]` of `c` (settle). Deltas are keyed by the
  account that performed the operation (`msg.sender` at the manager), never pooled per currency:
  a hook that re-enters the manager has its own `Δ[hook][·]` and cannot touch the locker's.
- `R[c]` — `reserves[c]`, the manager's tracked holdings of `c` (persistent).
- `C[c][a]` — `claims[c][a]`, account `a`'s ERC-6909 claim on `c` (persistent).
- `FG0, FG1` — `feeGrowthGlobal0X128 / feeGrowthGlobal1X128` for a pool (Q128 fixed point).
- `L` — the pool's in-range `liquidity`.

## 1. Flash accounting / delta conservation

`unlock(f)` sets the unlocked flag, runs `f` (via `msg.sender.unlockCallback`), then **reverts
unless `Δ[a][c] = 0` for every account `a` and currency `c`** before releasing (tracked as a count of
non-zero entries in transient storage, so the check is O(1)). Transient storage (EIP-1153) holds
`Δ` and is cleared automatically at transaction end.

**Invariant (net-zero).** At the end of a successful `unlock`, `Δ[a][c] = 0` for all `a`, `c`.

**Invariant (delta isolation).** An operation performed by `a` changes only `Δ[a][·]`. In particular a
hook callback can neither `take` what the locker is owed nor `settle` against what the locker owes;
anything a hook does on its own account must be settled by the hook itself or the session reverts
`UnsettledDelta`. Tested in `test/v4/HookIsolation.t.sol`.

**Invariant (settle is balance-checked).** `settle`/`mint` of an ERC-20 credit only the amount the
manager's balance actually grew by; a fee-on-transfer or rebasing short-delivery reverts
`TransferShortfall` instead of creating an unbacked credit.
Every state-changing pool operation (`swap`, `modifyLiquidity`, `donate`) accounts its effect on
`Δ` and is `onlyUnlocked`, so no operation can leave the session unbalanced. Settlement
(`settle`/`take`, and their claim variants) is what drives `Δ` back to zero.

## 2. Solvency

`R[c]` is updated in lockstep with real token movement on `settle` (`+=`), `take` (`-=`), `mint`
(`+=`), `burn` (`-=`), and `collectProtocol` (`-=`). ERC-6909 claim settlement moves a delta into
(or out of) the claims ledger without moving tokens, so `R` is unchanged and still covers the
reclassified obligation.

**Invariant (solvency).** For every currency `c` and at all times:

```
balanceOf(manager, c) >= R[c] >= C[c][*] + (positive deltas settled against c)
```

The left inequality holds because every token the manager receives increments `R` and every token
it sends decrements `R` (no path creates an unbacked balance). The right inequality is maintained
because: `mint`/`burn` move `R` and `C` together; `settleViaClaim` decreases `C` and clears a
negative `Δ` (the claim's backing becomes pool-owned); `takeViaClaim` increases `C` and decreases a
positive `Δ` by the same amount (obligation shifts from delta to claim, `R` unchanged).

## 3. Swap invariant

A swap walks initialized ticks, computing each step with the GPL V3 math (`SqrtPriceMath`,
`TickMath`, `LiquidityMath`), identical to Phase 1. Within a step with liquidity `L > 0`:

- The price moves along the constant-product curve for `L` (subject to `sqrtPriceLimitX96`).
- The input is split: the fee `fee = input * lpFee / 1e6` accrues; the rest moves the price.
- `FG` (of the **input** token) grows by `fee * 2^128 / L`. If a protocol fee is set, the protocol
  carve-out `protocolPortion = fee * protocolFee / 1e6` is subtracted first, so only
  `fee - protocolPortion` reaches `FG` (the trader's cost is unchanged; the LP accrues less).
- A `DYNAMIC_FEE` hook overrides `lpFee` via `getSwapFee`.

**Invariant (fee monotonicity).** `FG0` and `FG1` are non-decreasing: they are only ever increased
(`+=`), by swap fee accrual and by `donate`.

**Invariant (no free tokens).** Because each step is the constant-product move plus a non-negative
fee, a swap never outputs more value than the input it consumes (modulo rounding). A round-trip
`A→B→A` cannot return more `A` than it started (fuzzed in `Fuzz.t.sol`).

## 4. Donation

`donate(key, amount0, amount1)` (onlyUnlocked) credits `amount_i * 2^128 / L` to `FG_i` for each
non-zero `amount_i` (requires `L > 0`), and drives the donor's `Δ` negative by `amount0`/`amount1`
(the donor then settles as usual). Donations go to in-range LPs, not the protocol.

## 5. Hooks are untrusted

A hook's permissions are mined into its address bits (region bits 0..12; bits 0..2 reserved). The
manager calls a hook function only when the matching flag is set. Value safety never depends on
hook honesty:

- Hooks run inside the unlocked session, so any re-entrant pool call is subject to the same
  `onlyUnlocked` gating and the net-zero sweep.
- The only hook that moves value is `beforeSwapDelta` (flag `BEFORE_SWAP_DELTA`), and it is
  **donation-only**: a non-positive `BalanceDelta` funded by burning the hook's own ERC-6909
  claims (which are backed 1:1 by `R`). A positive component would mint free value and reverts
  `InvalidHookDelta`; an under-funded donation reverts `InsufficientClaim`. The donation is credited
  to the caller, so `Δ` still nets to zero and `R` still covers every claim.

## 6. Protocol fee

`protocolFee` (in 1e6) is the share of the lp fee carved out to the protocol per swap. It does not
change the trader's cost; it reduces the LP's accrual. The carve-out accrues per-currency (input
token) to `protocolFees0/1` and is withdrawable by the owner via `collectProtocol`.

## 7. Checked by

- **Unit tests** (`test/v4/*.t.sol`): each surface and its guards.
- **Differential** (`V4Golden.t.sol` + `reference/v4model.py`): swap/liquidity math matches the
  Python oracle bit-for-bit.
- **Fuzz** (`Fuzz.t.sol`): liquidity and swap round-trips create no value.
- **Invariant** (`Invariant.t.sol`): over random op sequences, solvency and fee-growth monotonicity
  always hold.
