# Swapex

Monorepo for **Swapex** — an open-source, **testnet-only** DEX written from scratch (not a
fork of any existing protocol): concentrated-liquidity pools, an exact-price quoter, NFT
liquidity positions, EIP-712 limit orders, a full web app, and an event indexer with a
REST API.

This repo holds two things: the **active workspace** (`swapex/`) where all new work lands,
and the earlier demo trees kept for reference.

## Direction

The monorepo exists to take one product from prototype to a production-shaped, testnet-proven
DEX in reviewable steps:

1. **Settle the current shape** — V3-style concentrated-liquidity core with a periphery
   layer (router, quoter, position manager, limit orders) that is tested, fuzzed, deployed
   to local anvil and wired end-to-end through the indexer to the web app.
2. **Harden it** — strict CSP, reviewed ERC-721 implementation, secret scanning and
   pinned CI on every push, honest feature gating driven by deployment manifests.
3. **Grow toward a V4-style manager** — the planned next contracts generation (noted in
   `AGENTS.md`), taking the lessons and libraries from the current core rather than
   rewriting the app.
4. **Operate it** — automated order filling, multi-testnet deployments, and an indexer
   that can move from SQLite to Postgres without touching the API surface.

Everything in `swapex/` is sequenced by `prompts/*.md` and recorded in
`swapex/docs/DECISIONS.md`; the running truth lives in `swapex/docs/STATUS.md`.

## Layout

| Path | Role |
|---|---|
| `swapex/swapex-contracts/` | **Active** — Solidity (Foundry): pool, factory, router, quoter, position manager, limit orders, scripts, tests, Python reference models |
| `swapex/Swapex--main/` | **Active** — Next.js web app: swap, positions, explore, limit orders, wallet connect, testnet guard |
| `swapex/swapex-indexer/` | **Active** — event indexer + HTTP API (log sync into SQLite, REST endpoints, tests) |
| `swapex/prompts/`, `swapex/docs/`, `swapex/AGENTS.md` | Task prompts, decision/status docs, standing rules for coding agents |
| `contracts/` | Earlier V3-style core demo (`src/v3`, reference model) — reference only |
| `apps/web/` | Earlier Next.js demo front end — kept only to serve the public demo |

CI lives at the repo root (`.github/workflows/ci.yml`) and covers both the active
workspace and the legacy trees; `.gitleaks.toml` at the root is its secret-scan config.

## Key tech stack

| Layer | Stack | Why it is here |
|---|---|---|
| Contracts | **Solidity 0.8.26**, **Foundry** (forge/anvil/cast), **OpenZeppelin v5.2.0**, via-IR optimizer (800 runs), fuzzing + reference models in Python | Reproducible builds (`bytecode_hash = "none"`), modern testing, audited primitives for signatures (EIP-712, ERC-1271) |
| Web | **Next.js 16** (pages router), **React 19**, **viem + wagmi v2**, TanStack Query, zod (ethers/web3-react fully removed) | Typed chain access, wallet-first transports, static prerender of every route |
| Indexer | **TypeScript**, **Fastify**, **better-sqlite3**, zod, tsx | Small, fast, config-validated API over reorg-safe log sync |
| Local dev | **anvil** + `setup.sh` / `dev.sh` (deploy → seed → ABI export → web) | One command to a full working stack |
| Tests | **forge test**, **vitest** (node + jsdom), **Playwright** e2e against the live stack, anvil-backed integration suite | Every layer has tests that run on this machine and in CI |
| Platform | **GitHub Actions** (actions pinned to commit SHAs), **gitleaks**, SBOM artifacts, **Vercel** for the web app | Supply-chain hygiene and cheap static hosting |
| Networks | Local anvil (31337, deployed today); Sepolia, Base Sepolia, Arbitrum Sepolia configured as targets (manifests ship "not deployed yet") | Testnet only — mainnet is refused by design in deploy scripts and the app |

## How the pieces fit

```
anvil / testnet RPC
   │  events (PoolCreated, Swap, Mint, Burn, Transfer, OrderCancelled…)
   ▼
swapex-contracts ──deployments/<chainId>.json──┐
   │  ABIs + manifests (export-abis.sh)        │ feature gates
   ▼                                           ▼
swapex-indexer  ── REST (tokens, pools,      Swapex--main
   │                 candles, orders)          │  viem/wagmi via lib/contracts
   ▼                                           ▼
SQLite (reorg-safe, idempotent,          deployed app (Vercel) / local :3000
         paginated, rate-limited)              │
                                               ▼
                                    keeper script fills settled limit orders
```

The web app reads chain state through `lib/contracts` adapters and indexer data through
`lib/indexerApi.js`; screens turn themselves off honestly when a manifest or the indexer
is missing — there is no fake data anywhere in the UI.

## Where it is today (honest snapshot)

Verified on this machine, 2026-10-22 (details and exact commands in
`swapex/docs/STATUS.md`):

- Contracts: **104/104** forge tests, all contracts inside the EIP-170 size gate, Python
  reference models agreeing with the Solidity.
- Web: **190** vitest tests, lint clean, production build green, **6** Playwright specs
  (connect, swap, add/remove position, explore, limit-order place + cancel).
- Indexer: **63** unit tests + **9** anvil-backed integration tests + `tsc` clean.
- CI: 6 SHA-pinned jobs — legacy `web` + `contracts`, active `swapex-contracts` /
  `swapex-web` / `swapex-indexer`, plus gitleaks over the full history — every step
  command proven locally before it was written into the workflow.
- Deployed: the web app builds on Vercel from the root `vercel-build` script
  (swapex-zeta.vercel.app).

## Future builds

Ordered, owner-gated where noted; see `swapex/docs/STATUS.md` "Next three steps":

- **Automated order filling** — schedule the keeper
  (`swapex-contracts/scripts/keeper-limit.sh`) so limit orders settle without a manual
  run.
- **Strict CSP (owner-gated O2)** — replace `'unsafe-inline'` with nonce-based headers.
- **Reviewed ERC-721** — replace the in-repo `ERC721Minimal.sol` before any real-value use.
- **Playwright in CI** — run the browser suite behind service containers (anvil + indexer).
- **More testnets** — Sepolia, Base Sepolia and Arbitrum Sepolia are wired end-to-end
  (RPC targets, web manifests that honestly report "not deployed yet"); what's missing is
  running the deploy + seed + export on them, which needs owner-funded testnet accounts.
- **Permit2-style single-tx approvals** and an on-chain **TWAP/oracle read path** (tracked
  as gaps in `swapex/docs/CONTRACT_GAPS.md`).
- **V4-style manager** — the next contracts generation (singleton / flash accounting).

## Scalability notes

- **Contracts**: one pool per pair+fee (factory-deployed), so load and risk are isolated
  per pool; concentrated liquidity keeps capital efficient at range; the router/quoter
  revert rather than partially filling, so growth never trades correctness for throughput.
- **Indexer**: incremental, reorg-safe sync (cursor resume, last-N blocks unfinalized,
  idempotent handlers) — backfilling history or adding chains is re-running the cursor;
  TVL/volume/candles/prices are precomputed aggregates, so API reads stay O(1) regardless
  of history size; REST endpoints paginate and rate-limit; storage is SQLite behind a
  single `db.ts` boundary today, with Postgres as the intended swap when write volume
  demands it — no API changes required.
- **Web**: every route prerenders statically; data is fetched client-side behind timeouts
  and schema validation, so a slow or missing backend degrades to an honest empty state
  instead of blocking the page; feature gates come from deployment manifests, so shipping
  a build to a new chain is config, not code.
- **CI/CD**: job-per-package with npm/forge caches, pinned actions, and a concurrency
  group per ref — adding the next package means adding the next job, not redesigning the
  pipeline.

## Development

Requires [Foundry](https://getfoundry.sh), Node 24, npm. Setup and dev scripts live in
the workspace folder:

```bash
cd swapex
./setup.sh   # tool checks, contract tests, ABI sync, web + indexer tests
./dev.sh     # anvil + deploy + seed + web app on http://localhost:3000

# browser e2e, with the stack running:
cd Swapex--main && npm run e2e

# per-package loops
cd swapex-contracts && forge test -vv
cd Swapex--main     && npm run lint && npm test && npm run build
cd swapex-indexer   && npm test && npm run typecheck
```

After any contract change: `swapex-contracts/scripts/export-abis.sh ../Swapex--main`.

## Safety

Testnet only — mainnet is refused by the deploy script and the web app; no secrets or
private keys live in this repo (the one well-known anvil dev key is allowed in local
scripts only and is allowlisted by value in `.gitleaks.toml`). Background:
`swapex/swapex-contracts/docs/TESTNET_SECURITY.md` and
`swapex/Swapex--main/docs/TESTNET_SECURITY.md`.

## Docs and agents

- Workspace overview: `swapex/README.md`
- Status / verification: `swapex/docs/STATUS.md`
- Per-step decisions: `swapex/docs/DECISIONS.md`
- Contract gaps: `swapex/docs/CONTRACT_GAPS.md`
- Coding-agent rules: `swapex/AGENTS.md` (opencode reads it automatically; start work
  with e.g. `Follow prompts/01-next-phase.md`)
