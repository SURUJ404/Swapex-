# SwapEx

Next.js frontend for a Uniswap V2-style DEX. Today it talks to the canonical Uniswap V2
Factory and Router02 on Ethereum mainnet (addresses in `constants/index.js`). It has no
contracts of its own yet.

## Run

    npm install
    npm run dev      # http://localhost:3000
    npm test         # unit tests for the math / error helpers
    npm run lint
    npm run build

## Layout

- `lib/` pure logic: amount parsing, slippage (integer basis points), routing, errors, tx history
- `hooks/` balances, allowances, approvals, transaction runner
- `components/` forms (Swap, Add/Remove liquidity, Send, Create) and shared UI
- `context/Web3Context.js` wallet + network state (wrong-network detection and switching)

## Config

- `NEXT_PUBLIC_CHAIN_ID` (default `1`). Contract addresses must match the chain.

## Roadmap

See the Uniswap-parity plan: own contracts (Foundry), indexer/subgraph, smart order router,
Permit2, multi-chain, audits.


## Run it locally against the Swapex contracts

1. In `swapex-contracts`: `scripts/e2e-local.sh` starts anvil (if none is running), deploys the contracts,
   seeds three test tokens and pools, and does a real swap. It needs Foundry.
2. `scripts/export-abis.sh ../Swapex--main` copies ABIs and manifests into this app.
3. Here: `NEXT_PUBLIC_CHAIN_ID=31337 npm run dev`, then add the local network (chain id 31337,
   RPC http://127.0.0.1:8545) to your wallet and use test account funds from anvil.
4. For a public testnet: run `Deploy.s.sol` and `SeedTestnet.s.sol` there, re-run the export script, and set
   `NEXT_PUBLIC_CHAIN_ID`. The test tokens have a public `faucet()` (once per hour per address).
