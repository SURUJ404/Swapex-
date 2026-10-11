# Phase 3 — Swapex V4-style: native ETH, hooks, and the Router

Phase 3 completes the V4-style stack on top of the Phase 2 `PoolManager`: native ETH becomes a
first-class currency, an address-permissioned hook system lets external contracts run at defined
points of a pool's life, and a periphery `Router` becomes the single `unlock`-caller users
interact with. No per-pool math changed — the Phase 2 reference model (`reference/v4model.py`)
remains the correctness oracle, and the golden-vector differential still passes bit-for-bit.

## What Phase 3 covers

| Item | Artifact | Status |
| --- | --- | --- |
| P3.1 Native ETH | `src/v4/types/Currency.sol` (`CurrencyLibrary`), payable `settle` + native `take` in `PoolManager` | `test/v4/NativeETH.t.sol` (5) |
| P3.2 Hooks | `src/v4/libraries/Hooks.sol`, `src/v4/interfaces/IHooks.sol`, manager integration, `src/v4/hooks/{Block,DynamicFee,Oracle}Hook.sol` | `test/v4/Hooks.t.sol` (5) |
| P3.3 Router | `src/v4/periphery/Router.sol` | `test/v4/Router.t.sol` (4) |
| P3.4 Docs / analysis | this file, `DECISIONS.md` (D16–D19), `SECURITY.md` Phase 3 section | Slither clean (no new real findings) |

## Design

### Native ETH (P3.1)
`currency` wraps `address`, and `address(0)` is the native sentinel (`ADDRESS_ZERO()`). A
`CurrencyLibrary` (internal, inlined into the caller) provides `isNative`, `balanceOf`,
`transfer`, `transferFrom`, and `approve`, each branching on native-vs-ERC-20. Settlement was
reworked to be currency-agnostic: `settle` is now `payable` — for an ERC-20 it `transferFrom`s
the caller, for native it requires `msg.value == amount` owed (the ETH is already in the manager
when the body runs). `take` uses `currency.transfer`, sending ETH for native. Because a native
pool sorts `address(0)` as `currency0`, the delta/settle/take math is unchanged; only the transfer
mechanism differs.

### Hooks (P3.2)
Permissions live in the low bits of the hook contract's address (the deployer mines a CREATE2
salt so the address carries the desired flags). `Hooks` defines the flag constants
(`BEFORE/AFTER_INITIALIZE`, `BEFORE/AFTER_ADD_LIQUIDITY`, `BEFORE/AFTER_REMOVE_LIQUIDITY`,
`BEFORE/AFTER_SWAP`, `DYNAMIC_FEE`) and `hasPermission`. The manager calls a hook function **only
when the matching bit is set**, so a hook need implement only what it flags. `initialize` runs
`Hooks.validate` to reject non-mined addresses (a stray bit in the reserved low 3 bits). Three
reference hooks exercise the system: `BlockSwapHook` (vetoes swaps by reverting),
`DynamicFeeHook` (manager charges `getSwapFee` instead of `key.fee` when `DYNAMIC_FEE` is set),
and `OracleHook` (records the post-swap price by `PoolId` in `afterSwap`).

**Hooks are untrusted.** Value safety never depends on a hook being honest: `swap`/`modifyLiquidity`
are `onlyUnlocked`, so a re-entering hook acts inside the same flash-accounting session, and the
end-of-session net-zero sweep guarantees no delta can be left non-zero. A hook can observe and can
revert to block an action, but cannot extract value it did not settle.

### Router (P3.3)
`Router` is the periphery `unlock`-caller. Users never write a callback or manage deltas. It
exposes `exactInputSingle` (one pool), `exactInput` (a path of pools, chained by reading each
hop's intermediate delta so intermediate currencies net to zero), and `modifyLiquidity`. For an
ERC-20 input the user approves the router (it pulls the input, approves the manager, and settles);
for a native-ETH input the user sends `msg.value` and the router settles ETH. Output always goes
to a chosen recipient.

## Verification status (end of Phase 3)

- `forge test` — **86/86 passing** across 16 suites (72 Phase 1–2 + 14 Phase 3: 5 native, 5
  hooks, 4 router).
- The Phase 2 golden-vector differential (`V4GoldenTest`) still matches the reference model
  bit-for-bit — Phase 3 introduced no new pool math.
- Python checks (`check_refmath`, `check_pool`, `check_oracle`, `check_v4`) all pass.
- `.gas-snapshot` regenerated and committed.

## Notable engineering decisions (see `docs/DECISIONS.md` for full rationale)

1. **Native settle via `msg.value`, not a sync/balance-diff dance.** `settle` is `payable` and
   for native requires `msg.value == amount` owed. This is simple, exact (no over/under-pay), and
   keeps a single settlement path for both currency kinds.
2. **Hooks gated by mined address bits, called only when flagged.** A hook implements just the
   functions it flags; the manager skips unflagged points. Address mining is an off-chain concern;
   on-chain `validate` only rejects obviously-unmined addresses.
3. **Dynamic fee via a dedicated `getSwapFee` getter** (queried when `DYNAMIC_FEE` is set) rather
   than a return-delta hook. Simpler and correct; the V4-style return-delta fee is a documented
   follow-up.
4. **Router settles by holding tokens momentarily** (pull input → approve manager → settle), the
   standard periphery pattern, so users approve the router rather than the manager.

## Known limitations / follow-ups

- **Hook return-delta** (a hook donating/taking tokens as part of a swap) is not wired; the
  `beforeSwap`/`afterSwap` hooks observe and can veto, but do not adjust settlement. Deferred.
- **Protocol fee**, **ERC-6909 claims**, **`sync`/`donate`** remain Phase 4 scope per
  `V4_DESIGN.md`.
- The Router does not refund leftover `msg.value` on a native operation (a small over-payment
  stays with the router). A production router would refund; noted here.
- Permit2 integration for gasless approvals is not included.

## Phase 3 is complete when

All of the above hold: full green suite (86/86), golden-vector differential unchanged, Python
checks green, gas snapshot committed, and these docs present. Hook return-delta, protocol fee,
ERC-6909, and `sync`/`donate` are out of scope and scheduled for Phase 4.
