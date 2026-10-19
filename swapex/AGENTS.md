# Swapex workspace: instructions for coding agents

Open-source, testnet-only DEX built from scratch (Uniswap-style V3 pools; V4-style manager planned).

## Layout
- swapex-contracts/  Foundry. SwapexFactory, SwapexPool, SwapexRouter, SwapexQuoter, SwapexPositionManager, scripts, tests.
- Swapex--main/      Next.js (pages router) web app. ethers v5 + web3-react v6 today, viem + wagmi planned.
- swapex-indexer/    Event indexer + HTTP API (log sync into SQLite, REST endpoints, vitest + tsc tests).
- prompts/           Task prompts. Current: prompts/01-next-phase.md
- setup.sh, dev.sh   One-command setup and local dev stack.

## Commands
- Setup everything: ./setup.sh
- Local stack (anvil + deploy + seed + export ABIs + web): ./dev.sh
- Contracts: cd swapex-contracts && forge test; scripts/e2e-local.sh; scripts/e2e-positions.sh
- After any contract change: swapex-contracts/scripts/export-abis.sh ../Swapex--main
- Web: cd Swapex--main && npm ci && npm run lint && npm test && npm run build
- Browser e2e (local stack must be running): cd Swapex--main && npm run e2e
- Format: cd Swapex--main && npm run format
- Indexer: cd swapex-indexer && npm test && npm run typecheck

## Rules
1. Testnet only. No mainnet. No secrets or private keys in the repo (the public anvil dev key is allowed in local scripts only).
2. Never copy code from github.com/Uniswap/* (GPL-3.0). Imitate flows, write code fresh. No Uniswap name, logo or assets.
   Do not change a license without asking the owner.
3. Verify by running; show commands and output. Never weaken or skip a test to make it pass.
4. No fake data in the UI. Missing backend -> honest empty or "not connected" state.
5. Contract addresses come from deployments/<chainId>.json via lib/deployments. Never hardcode addresses.
6. Custom contract errors are decoded in Swapex--main/lib/errors.js; add new ones there.
7. Ask the owner only for irreversible or scope-changing decisions; otherwise decide and note it in docs/DECISIONS.md.
8. Every commit message is exactly `latest release` (owner's standing instruction). Step detail lives in
   docs/DECISIONS.md and the docs, not in commit subjects; the release point is the `latest-release` tag.

## Known facts
- Pool position key is keccak(owner, tickLower, tickUpper); the position manager owns all pool positions and tracks NFT shares.
- Router/quoter revert (PartialFill / InsufficientLiquidity) rather than silently fill part of an order.
- Quoter functions are not view: call them with eth_call / callStatic.
- The ERC-721 in swapex-contracts/src/periphery/ERC721Minimal.sol must be replaced by a reviewed library before real-value use.
