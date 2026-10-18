# Next phase: indexer, Explore, confirmation modal, limit orders, viem + wagmi, hardening

Paste this into opencode from the workspace root (or just tell it: "Follow prompts/01-next-phase.md").
AGENTS.md at the root already gives it the project context and rules.

## Work, in this order

### 1. Indexer (swapex-indexer/, skeleton already there)
- TypeScript + viem. Read deployment manifests from swapex-contracts/deployments/<chainId>.json. Store in SQLite
  (better-sqlite3) behind a small repository layer so Postgres can replace it later.
- Index PoolCreated, Initialize, Swap, Mint, Burn, Collect (pools/factory) and Transfer (position NFTs).
  Reorg-safe: keep the last N blocks unfinalized, roll back on a parent-hash mismatch. Idempotent handlers. Resume from the last block.
- Derived data: per-pool TVL, 24h volume and fees, hourly and daily candles, token USD price via a stable-coin
  reference pool (document the rule), 24h change.
- Fastify API: GET /health, /tokens, /tokens/:address, /pools, /pools/:address, /pools/:address/candles?interval=,
  /pools/:address/swaps, /positions?owner=. Validate inputs with zod. Paginate. CORS allowlist from env (never "*"). Rate-limit.
- Tests (vitest): event decoding, candle aggregation, TVL math, reorg rollback, idempotent replay. Integration test:
  anvil + scripts/e2e-local.sh + indexer, assert the API matches on-chain state.

### 2. Explore screens (Swapex--main)
- /explore tokens and pools tables (sort, search, sparklines, skeletons, empty/error states).
- /explore/tokens/[address] and /explore/pools/[address]: candle chart (1D/1W/1M), stats, swaps, deep links to swap and add liquidity.
- Data through lib/indexerApi.js with timeouts and response validation. NEXT_PUBLIC_INDEXER_URL unset -> "indexer not connected".
- Replace the event scan in hooks/usePositions.js with /positions?owner= when available (keep the fallback). Nav search.

### 3. Swap confirmation modal and token safety
- Review modal (amounts, rate, minimum received, impact, route + fee tiers, fee estimate, slippage, deadline). Extra
  confirmation above the high-impact threshold.
- Import tokens by address with a warning, remembered per chain (localStorage in try/catch). Warn about fee-on-transfer tokens where detectable.

### 4. Limit orders (contract + UI)
- SwapexLimitOrders: EIP-712 signed orders (maker, tokenIn, tokenOut, amountIn, minAmountOut, expiry, nonce, receiver),
  anyone can fill, partial fills, cancel by nonce, chainId + verifyingContract in the domain, ERC-1271 via OpenZeppelin
  SignatureChecker, never custody funds (pull at fill time through an exact approval).
- Tests: wrong signer, wrong chain, replay, expired, malleable signature, partial fills, cancel, reentrancy, ERC-1271. Fuzz
  the fill math. Slither clean or justified.
- Keeper script, order storage in the indexer (re-verify signatures on submit), /limit UI with signTypedData, open orders, cancel.
- Wire into Deploy.s.sol, the manifest, scripts/export-abis.sh and the e2e scripts.

### 5. Migrate to viem + wagmi
- Replace ethers v5 and web3-react v6 (injected, WalletConnect, Coinbase). Small steps, tests green at each step. Keep
  NetworkGuard and the CONFIG_ERROR checks.

### 6. Hardening and release
- Playwright against local anvil: connect (mock wallet), swap, add a position, remove it, place and cancel a limit order.
- CI for contracts, web, indexer, gitleaks; pin actions by commit SHA. Update READMEs and docs/UI_PARITY.md honestly.

## Reporting
After each section run and show: forge test, the section's unit tests, lint, build, the relevant e2e script.
At the end write docs/STATUS.md: what works, what was verified and how, what was not, known limits, next three steps.

Start with section 1, step 1: event decoding and tests in swapex-indexer/, run them, commit, continue in order.
