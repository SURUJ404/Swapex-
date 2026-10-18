# Swapex

An open-source, testnet-only DEX built from scratch: concentrated-liquidity pools, a router with an exact-price quoter,
NFT liquidity positions, and a web app.

| Folder | What it is |
|---|---|
| `swapex-contracts/` | Solidity (Foundry): pools, factory, router, quoter, position manager, scripts, tests |
| `Swapex--main/` | Next.js web app: swap, positions, wallet, testnet guard |
| `swapex-indexer/` | Event indexer and HTTP API (skeleton: next phase) |
| `prompts/` | Task prompts for a coding agent (`AGENTS.md` holds its standing rules) |

## Quick start
```bash
./setup.sh   # checks tools, runs contract tests, syncs ABIs, runs web tests
./dev.sh     # local chain + deploy + seed + web app on http://localhost:3000
```
Then add a "Local" network (chain id 31337, RPC `http://127.0.0.1:8545`) to your wallet and import an anvil test account.

## Using a coding agent (opencode)
Open this folder in opencode. It reads `AGENTS.md` automatically. Then say:
`Follow prompts/01-next-phase.md`

## Safety
Testnet only. Mainnet is refused by the deploy script and the web app. No keys in the repo. See
`swapex-contracts/docs/TESTNET_SECURITY.md` and `Swapex--main/docs/TESTNET_SECURITY.md`.
