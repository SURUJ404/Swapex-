# Swapex Web

Frontend for Swapex, an original Uniswap-grade DEX. This app talks to the V4-style contracts in
`contracts/` (concentrated liquidity, native ETH, flash-accounting PoolManager) — not a V2 fork.

## Features

- **Swap** — single-hop via the on-chain `Quoter` (exact-in quote, matches the swap bit-for-bit),
  slippage floor (`amountOutMin`), native ETH and token→token.
- **Pool** — live view of every listed-token pair's on-chain state (V4 has no factory enumeration,
  so candidate pools are all token-pair combinations read via `getSlot0`/`getLiquidity`), plus your
  own positions.
- **Add / Remove liquidity** — full-range positions sized with JS math that mirrors the contracts
  (`getSqrtRatioAtTick`, amounts↔liquidity), submitted through `Router.modifyLiquidity` and tracked
  per-wallet in the Router's position registry (`getPositionLiquidity`).
- **Create pool** — `Router.initialize` at a chosen starting price (price → `sqrtPriceX96`).
- Wallet connection, network guard, transaction history.

## Getting Started

```bash
npm install
npm run dev      # http://localhost:3000
npm test         # unit tests: amounts, tickMath, liquidity, price, pool helpers
npm run lint
npm run build
```

### Against a local chain

The app targets **anvil (chain id 31337)** by default. Start a chain and deploy (from `contracts/`):

```bash
# foundry anvil, large code-size limit (PoolManager exceeds EIP-170)
anvil --chain-id 31337 --code-size-limit 131072
forge script script/Deploy.s.sol:Deploy --broadcast --rpc-url http://127.0.0.1:8545 --code-size-limit 131072
```

Address overrides (must match the deployment) go in `.env.local` — see `.env.local.example`.

### Smoke tests (require a running anvil + deployment)

```bash
node scripts/smoke.mjs           # quote + native swap + token swap
node scripts/smokeLiquidity.mjs  # full-range add -> registry read -> remove (JS math vs on-chain)
```

## Layout

- `constants/` chain config, token list, contract addresses and exported ABIs (`constants/abi/`)
- `lib/` pure logic:
  - `pool.js` — PoolKey building, currency sorting, pool reads, quoting
  - `tickMath.js` — `getSqrtRatioAtTick` + full-range tick bounds (ported from the Solidity)
  - `liquidity.js` — amounts↔liquidity, amount deltas, full-range helpers
  - `price.js` — BigInt sqrt + human price → `sqrtPriceX96`
  - `route.js` — best single-hop route (Quoter) and price impact
  - `amounts.js`, `config.js`, `errors.js`, `txHistory.js`
- `hooks/` balances, allowances, approvals, transaction runner
- `components/` forms (Swap, Add/Remove liquidity, Send, Create) and shared UI
- `context/Web3Context.js` wallet + network state (wrong-network detection and switching)
- `tests/` vitest unit tests for the math and helpers

## Config

- `NEXT_PUBLIC_CHAIN_ID` (default `31337`). Contract addresses (`NEXT_PUBLIC_POOL_MANAGER`,
  `NEXT_PUBLIC_ROUTER`, `NEXT_PUBLIC_QUOTER`, token addresses) must match the deployment.

## Vision

Simplify tokenization and decentralized trading through a fast, secure, and user-friendly platform.

## Roadmap

Indexer/subgraph, smart order router, Permit2, multi-chain, audits.
