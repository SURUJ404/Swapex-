# Swapex V4-style design (written from scratch)

Licence boundary: Uniswap V4's code is BUSL (converts to MIT on 2027-06-15). Do **not** copy or
closely transcribe V4 source; write the code yourself from the concepts below. The math libraries in
`src/libraries/` are this repo's own, so the V4-style manager reuses them directly and the licence of
the repo is your choice (the files are currently marked GPL-2.0-or-later; change the SPDX headers
if you want something else before publishing).

## Goals
1. One `PoolManager` holds every pool, so multi-hop swaps move no tokens between pools.
2. Flash accounting: inside one `unlock` session, balance changes accumulate as per-currency deltas;
   tokens move only when the session ends and all deltas must be zero.
3. Hooks: external contracts that run at defined points of a pool's life.
4. Native ETH as a first-class currency.

## Core types
- `Currency` (user-defined value type over `address`, `address(0)` = native).
- `PoolKey { currency0, currency1, fee, tickSpacing, hooks }`, `PoolId = keccak256(abi.encode(key))`.
- `BalanceDelta` (two packed `int128`).
- Pool state per `PoolId`: `slot0 (sqrtPriceX96, tick, protocolFee, lpFee)`, `liquidity`,
  `feeGrowthGlobal0/1`, `ticks`, `tickBitmap`, `positions`.

## PoolManager surface (names are yours to choose)
- `unlock(bytes data) -> bytes`: sets the locked flag, calls `msg.sender.unlockCallback(data)`,
  then reverts if any non-zero delta remains.
- `initialize(key, sqrtPriceX96)`.
- `modifyLiquidity(key, params, hookData) -> (callerDelta, feesAccrued)`.
- `swap(key, params, hookData) -> BalanceDelta`.
- `donate(key, amount0, amount1, hookData)`.
- `take(currency, to, amount)`, `settle()`, `sync(currency)`, `mint/burn` for ERC-6909-style claims.
- Delta storage: transient storage (`tstore`/`tload`, EIP-1153). Needs solc 0.8.24+, `evm_version = cancun`
  (the `v4` profile in `foundry.toml`).

## Hooks
- Permissions are encoded in the low bits of the hook contract address (mine a CREATE2 salt).
- Points: before/after initialize, before/after add liquidity, before/after remove liquidity,
  before/after swap, before/after donate, plus return-delta variants.
- The manager must treat hooks as untrusted: reentrancy through the manager is only allowed
  while unlocked, and a hook may never be able to remove another account's funds.

## Milestones
1. Types + libraries (Currency, BalanceDelta, PoolKey) with unit tests.
2. `PoolManager` without hooks: initialize, swap, modifyLiquidity over the GPL V3 math.
3. Flash accounting + `unlock`, with an invariant test that all deltas net to zero.
4. Native ETH support.
5. Hook plumbing and the address-permission scheme, then 2-3 reference hooks
   (e.g. dynamic fee, TWAP oracle, limit order).
6. Router (`unlock` caller): single and multi-hop swaps, liquidity ops, Permit2.
7. Fuzz + invariant suite, Slither/Aderyn, formal spec of the swap invariant.
8. External audit and bug bounty before mainnet.

## Test must-haves
- Delta conservation: sum of all currency deltas after any call sequence equals token balances moved.
- No hook can make `unlock` finish with a non-zero delta.
- Fee growth monotonic; liquidity net across ticks sums to zero.
- Fork tests against fee-on-transfer, rebasing and no-return-value tokens.
