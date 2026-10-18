# SwapEx

Next.js frontend for Swapex, an open-source concentrated-liquidity (V3-style) DEX.
It talks to the Swapex contracts (Factory, Pool, Router, Quoter, PositionManager) on
testnets and on a local anvil node. Testnet-only: mainnet is refused unless
`NEXT_PUBLIC_ALLOW_MAINNET=true`, and contracts are not deployed to mainnet.

## Run

    npm install
    npm run dev      # http://localhost:3000
    npm test         # unit tests for the math / error helpers
    npm run lint
    npm run build

## Layout

- `lib/` pure logic: amount parsing, slippage (integer basis points), ticks and range
  math, contract error decoding, deployment manifest loading
- `lib/config.js` single source of truth for chains, RPCs, fee tiers, slippage defaults;
  contract addresses come from `lib/deployments/<chainId>.json`, never hardcoded
- `hooks/` balances, allowances, approvals, positions, transaction runner
- `components/` forms (Swap, positions list/create/detail, Send, Explore) and shared UI
- `context/Web3Context.js` wallet + network state (wrong-network detection and switching)

## Config

- `NEXT_PUBLIC_CHAIN_ID` (default `11155111`, Sepolia). Supported chains and their
  public RPCs are listed in `lib/config.js`.
- `NEXT_PUBLIC_ALLOW_MAINNET` must be `true` to transact on a mainnet chain id.

## Run it locally against the Swapex contracts

1. In `swapex-contracts`: `scripts/e2e-local.sh` starts anvil (if none is running), deploys the contracts,
   seeds three test tokens and pools, and does a real swap. It needs Foundry.
2. `scripts/export-abis.sh ../Swapex--main` copies ABIs and manifests into this app.
3. Here: `NEXT_PUBLIC_CHAIN_ID=31337 npm run dev`, then add the local network (chain id 31337,
   RPC http://127.0.0.1:8545) to your wallet and use test account funds from anvil.
4. For a public testnet: run `Deploy.s.sol` and `SeedTestnet.s.sol` there, re-run the export script, and set
   `NEXT_PUBLIC_CHAIN_ID`. The test tokens have a public `faucet()` (once per hour per address).

## Status and roadmap

Current status and the UI parity plan live in `docs/UI_PARITY.md`; architecture audit and
the step-by-step migration plan are in `../docs/` at the repo root. Contracts are
testnet-grade and unaudited; do not use with real value.
