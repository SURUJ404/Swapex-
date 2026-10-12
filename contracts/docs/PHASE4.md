# Phase 4 — Swapex V4-style: deferred protocol features + fuzz/invariant suite

Phase 4 lands the protocol features that were deferred from Phases 2–3 (V4_DESIGN milestones 7–8)
and adds the property-based confidence layer. The V4 `PoolManager` gains an owner-gated protocol
fee, direct LP donations, an ERC-6909 claims ledger for gas-efficient settlement, and an opt-in
hook donation path — plus a fuzz + invariant suite and a formal spec of the core invariants. All
108 tests pass; the Phase 2/3 reference model (`reference/v4model.py`) is unchanged and the
golden-vector differential still matches bit-for-bit (protocol fee defaults to 0).

## What Phase 4 covers

| Item | Artifact | Status |
| --- | --- | --- |
| P4.1 Protocol fee | `PoolManager`: `Slot0.protocolFee`, `Pool.protocolFees0/1`, `owner`/`onlyOwner`, `setProtocolFee`/`collectProtocol`/`getProtocolFee(s)`, carve-out in `_swap` | `test/v4/ProtocolFee.t.sol` (4) |
| P4.2 Donate | `PoolManager.donate` (credit to `feeGrowthGlobal`), `getFeeGrowthGlobals` | `test/v4/Donate.t.sol` (6) |
| P4.3 ERC-6909 claims | `PoolManager`: `claims` ledger, `mint`/`burn`, `settleViaClaim`/`takeViaClaim` | `test/v4/Claims.t.sol` (6) |
| P4.4 Hook return-delta | `Hooks.BEFORE_SWAP_DELTA_FLAG` (bit 12), `IHooks.beforeSwapDelta`, donation fold in `_swap`, `DonateHook` | `test/v4/HookDelta.t.sol` (3) |
| P4.5 Fuzz + invariant + spec | `test/v4/{Fuzz,Invariant}.t.sol`, `docs/SPEC.md` | 2 fuzz (512 runs) + 2 invariants (64 runs) |
| P4.6 Docs / analysis | this file, `DECISIONS.md` (D20–D23), `SECURITY.md` Phase 4 section | Slither clean (no new real findings) |

`sync` was intentionally omitted (D20 — superseded by D16's `msg.value` native settle).

## Design

### Protocol fee (P4.1)
`protocolFee` (in 1e6) is the share of the lp fee routed to the protocol. It is stored in `Slot0`
and defaults to 0, so existing pools and the golden vectors are unaffected. In `_swap` the fee is
read once; when non-zero, the protocol's cut `fee * protocolFee / 1e6` is subtracted from
`step.feeAmount` **before** the `feeGrowthGlobal` update, so the trader pays the same total and only
the LP/protocol split changes (D23). The cut accrues per-currency (input token) to
`protocolFees0/1`. `setProtocolFee` and `collectProtocol` are `onlyOwner` (owner set in the
constructor); `collectProtocol` transfers the accrued tokens out of `reserves` and zeroes them.

### Donate (P4.2)
`donate(key, amount0, amount1)` (onlyUnlocked) credits `amount_i * 2^128 / L` to `FG_i` for each
non-zero amount (requires `L > 0`, else `NoLiquidityToAccrue`) and drives the donor's delta
negative — the donor settles as usual. Donations go to in-range LPs, not the protocol.

### ERC-6909 claims (P4.3)
`claims[c][a]` is account `a`'s ownership of tokens the manager already holds (`reserves`). `mint`
(deposit) pulls real tokens and mints claims; `burn` (redeem) burns claims and sends tokens out.
`settleViaClaim` burns the caller's claims to clear a negative delta; `takeViaClaim` mints claims to
clear a positive delta — neither moves tokens. Solvency `reserves[c] >= claims[c] + positiveDeltas[c]`
is maintained inductively (D22; see `docs/SPEC.md` §2).

### Hook return-delta (P4.4)
A hook flagged `BEFORE_SWAP_DELTA` (bit 12; the flag region expands to bits 0..12) may return a
**non-positive** `BalanceDelta` from `beforeSwapDelta`. The manager burns the hook's ERC-6909 claims
to fund it and credits the donation to the swap caller (who settles less). A positive component
would mint unbacked value and reverts `InvalidHookDelta`; an under-funded donation reverts
`InsufficientClaim` (D21). The fold is gated by the new flag, so existing swaps are byte-for-byte
unaffected. Because the delta ledger is keyed by currency only (no per-account deltas), a hook
cannot settle independently — donation-only, claims-funded is the sound subset.

### Fuzz + invariant + spec (P4.5)
- `Fuzz.t.sol`: liquidity round-trip and `A→B→A` swap round-trip create no value (512 runs each).
- `Invariant.t.sol`: a Foundry handler performs bounded add/remove/swap/donate; two invariants are
  checked after every call — **solvency** (manager token balance ≥ `reserves` per currency) and
  **fee-growth monotonicity** (`FG0`/`FG1` never decrease).
- `docs/SPEC.md`: formal statement of net-zero delta conservation, solvency, the swap/fee invariant,
  donation, untrusted-hook safety, and the protocol-fee carve-out, mapped to the tests that check
  each.

## Testing

108 tests across 22 suites. The four Python oracle checks (`check_refmath`, `check_pool`,
`check_oracle`, `check_v4`) pass. `.gas-snapshot` regenerated.

## Security

See `SECURITY.md` for the Phase 4 Slither triage. No new real findings: the only code-quality hit
introduced (a local `owner` in `_updatePosition` shadowing the new state `owner`) was fixed by
renaming the local to `positionOwner`. Remaining findings are false-positives or by-design (untrusted
hooks, bounded loops, transient-storage assembly, native low-level transfers).
