# Swapex - MEV and front-running (item B of the hardening list)

Status: **B.1 done, B.2 evaluated and rejected, B.3 documented below.**
Decision records: `contracts/docs/DECISIONS.md` D31 (B.1), D32 (B.2); threat-first log entry in
`docs/CRYPTO_DECISIONS.md` section B.

## What B.1 actually protects (and what it does not)

Every Router entry - `exactInputSingle`, `exactInputSingleWithPermit`, `exactInput`,
`modifyLiquidity` - now takes:

* an **absolute deadline** (`block.timestamp > deadline` reverts `TransactionTooOld`, checked
  before any state write): a pending tx cannot execute later than the user allowed;
* a **`minAmountOut` floor** on both single and multi-hop swaps: a sandwich that moves the price
  beyond the user's slippage tolerance turns the victim tx into a *revert*, not a bad fill;
* **`LiquidityBounds{amount0Min, amount1Min, amount0Max, amount1Max}`** on liquidity operations:
  a deposit never pays more than the maxes, a removal never receives less than the mins.

| Protects against | Does **not** protect against |
|---|---|
| Stale / cross-block execution of a forgotten tx | Validators/searchers doing same-block MEV on your tx (ordering, back-running within the block) |
| Sandwiches that push the fill past your slippage tolerance (your tx reverts instead) | Price impact *inside* the tolerance you chose - that is what the tolerance means |
| Multi-hop swaps executing with no output bound at all (this path previously had none) | A caller who explicitly passes `minAmountOut == 0` (documented opt-out; the Swapex web UI never does) |
| Deposits paid above your typed amounts; removals landing below your quoted amounts | MEV against *quotes* you never submit; wallet-side display attacks |

A deadline is a **time** bound, not a **privacy** bound. It does not hide your transaction.

## B.2 - Commit-reveal for large swaps: what it does and does not stop (evaluated, not built)

A commit-reveal flow would look like: commit `keccak256(abi.encode(domain, sender, params, salt))`
(now), reveal the same params after N blocks, expiry, and a bond on commits.

What it **would** do:

* Force a delay between intent and execution, so a *co-located* searchers cannot pre-position
  against information that does not exist yet at commit time.
* Give griefers a cost (the bond) if commits without reveals were ever a spam vector.

What it **does not** do - and why that decides it:

* **On a public mempool, the reveal is as visible as a plain swap.** Searchers read the reveal in
  the mempool and sandwich *it* exactly as they would a normal tx. The commit delays visibility;
  it does not remove it. The only schemes that actually hide intent submit the reveal through a
  private relay or encrypted mempool - at which point the *relay* provides the protection and the
  commit is scaffolding.
* It does not remove the price bound problem: the revealed `minOut` still has to be enforced
  (D31 already does), or the reveal is the vulnerable moment.
* A commit contract needs custody: either escrow the user's funds between commit and reveal (a new
  contract holding real money, unaudited surface) or a second allowance grant to a new spender.
  The bond's only realistic target of grief is the committer's own funds.

**Decision (D32): not built.** Honest conclusion: for this repo, bounds + deadlines (B.1) plus
private submission (B.3, below) deliver the actual protection; commit-reveal on a public mempool
would add custody and UX cost for no measurable MEV reduction.

## B.3 - Private orderflow: using protected RPCs (documentation only)

No infrastructure is built here; the options that exist for real networks:

| Option | What it does | Notes |
|---|---|---|
| Flashbots Protect RPC (`rpc.flashbots.net`) | Transactions submitted to Flashbots are shared with block builders privately - they never hit the public mempool | Mainnet/Ethereum; simplest integration: point the wallet/provider `rpcUrl` at it. Does **not** guarantee inclusion (falls back is manual) |
| MEV Blocker (`rpc.mevblocker.org`) | Private mempool with builder competition + backrun payment to the sender | Ethereum; multiple builders compete, so inclusion chances are close to public |
| Builder-specific RPCs (e.g. Edenn, MEVShare-style HETS) | Private submission with refunds or bundle semantics | Ethereum ecosystem; check each builder's current policy |

How to use them in a dapp: make the write-provider URL configurable (env var, e.g.
`NEXT_PUBLIC_WRITE_RPC_URL`) and construct the signer provider from it, leaving reads on the
normal RPC. Wallet users can also set a custom network RPC themselves.

**Testnet caveat (this repo):** chain 31337/anvil is a local dev chain - there is no public
mempool, no searchers, and no private relay to talk to. B.1's deadline/bound tests are the
on-chain part and run here; B.3 is exercised on a real network only when Swapex is deployed to a
real testnet/mainnet, which the `TESTNET_SECURITY.md` checklist gates.

## Verification for item B

* `forge test`: **197 passed** (+9 in `Router.t.sol` - expired deadline on all four entries,
  `deadline == now` boundary, multi-hop impossible floor, add-above-max, remove-below-min,
  in-bounds success, documented `minOut == 0` opt-out).
* Fuzz x5000: AllowanceTransfer 31, LimitOrders 28 (fills now settle through the deadline+bound
  Router).
* `node scripts/smoke.mjs` + `smokeLiquidity.mjs`: PASS on rotation #6, sending the new
  deadline/bounds arguments (liquidity add with maxes, removal with mins).
* `npm test` 22, `npm run lint` 0 errors, `npm run build` ok, Playwright e2e 1 passed.
* Slither re-run (Phase 7): 52 contracts, 78 results - +1 vs Phase 6, the `timestamp` detector on
  `_enforceDeadline` itself, accepted for the reason stated in `contracts/docs/SECURITY.md`.
