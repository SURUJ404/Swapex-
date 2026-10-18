# Architecture audit — Swapex workspace

Date: 2026-10-18. Phase 0 of the front-end / architecture upgrade. **No code was changed for this audit**
(the only new files are this document and `docs/MIGRATION_PLAN.md`).

## 0. Scope and assumptions

- The project audited is the workspace rooted at this folder (`swapex/`): `Swapex--main/` (web app),
  `swapex-contracts/` (Foundry), `swapex-indexer/` (skeleton), plus `setup.sh`, `dev.sh`, `prompts/`,
  `AGENTS.md`. This is the tree `AGENTS.md` and `prompts/01-next-phase.md` describe, and it is the
  working directory the agent was opened in.
- **Note for the owner:** this folder is **untracked inside a parent git repository**
  (`C:\Users\mrsur\Documents\swapex\swap`, remote `github.com/SURUJ404/Swapex-`), which tracks a
  *sibling, different* DEX variant (`apps/web/` + V4-style `contracts/`, last commit 2026-10-15).
  The two trees are independent (the parent's git history never contained these paths). The parent
  tree was used only as a cross-reference and is out of scope unless the owner says otherwise.
  Commit strategy for this workspace is an open question — see `docs/MIGRATION_PLAN.md` step 0.
- Everything below was verified by running the commands shown, on this machine (Windows, Node v24.12.0,
  npm 11.17.0, Foundry forge 1.8.5), except where explicitly marked "not verified here".

## 1. Inventory: what is here

### 1.1 Web app — `Swapex--main/`

| Aspect | Finding |
|---|---|
| Framework | Next.js **16.2.6**, React **19.2.4** (`Swapex--main/package.json`) |
| Language | Plain **JavaScript** (`jsconfig.json` alias `@/*`, used once). Prettier config present (`.prettierrc`), no format script |
| Router | **Pages router** (`pages/`, `_app.js`, `_document.js`). No `app/` dir |
| Styling | **Tailwind CSS v4** (`@tailwindcss/postcss`, `styles/globals.css` imports tailwind) + **CSS custom properties as design tokens** (`--bg-*`, `--text-*`, `--accent` …). Components use `var(--token)` arbitrary values. **Dark theme only** — no light palette, no toggle. `styled-components` and `@reach/tooltip` are declared dependencies but imported nowhere |
| State / data libs | **None** (no react-query/SWR/redux/zustand). Raw `useState`/`useEffect` + two contexts: `context/Web3Context.js`, `components/Toast.js`. Live refresh via `library.on('block')`; a module-level `Map` cache in `lib/tokenMeta.js` |
| Wallet | **web3-react v6** (injected, WalletConnect v6-connector, WalletLink/Coinbase) + **ethers v5** (`context/Web3Context.js`) |
| i18n | `public/locales/` holds 10 languages of **dead** legacy strings (no i18n library, nothing imports them; `en.json` still mentions "Uniswap V1") |
| Tests | **Vitest 3** (installed 3.2.7), logic-only, 3 files / **25 tests pass** (`tests/amounts.test.js`, `path.test.js`, `ticks.test.js`). No component tests, no jsdom, no Playwright |
| Lint | ESLint 9 flat config, `eslint-config-next/core-web-vitals` (`eslint.config.mjs`) — **currently fails**, see §4 |
| CI | `Swapex--main/.github/workflows/ci.yml`: `npm ci` → lint → test → build → `npm audit --omit=dev --audit-level=high`; plus gitleaks job. **Not running anywhere today** — the workspace is not a git repo (see §0); would be red if it ran (§4) |
| Env | `.env.example`: `NEXT_PUBLIC_CHAIN_ID=11155111`, `NEXT_PUBLIC_RPC_URL=` (empty), `NEXT_PUBLIC_ALLOW_MAINNET=false`. No `.env.local` present |
| Security headers | `next.config.mjs`: strict-ish CSP (`script-src 'self' 'unsafe-inline'`, `unsafe-eval` dev-only), X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy, HSTS. `frame-ancestors 'none'`, `base-uri`, `form-action` set |
| License | `Swapex--main/LICENSE` is **GPL-3.0**. Left untouched per rules (change requires owner) |
| Deploy config | `netlify.toml` (geo-block page for 10 countries; leftover CRA-era `REACT_APP_*` env vars) |

### 1.2 Folder structure

```
swapex/
├── Swapex--main/        Next.js app (pages/, components/, hooks/, lib/, context/, tests/, docs/)
├── swapex-contracts/    Foundry: src/v3 (core), src/periphery (router, quoter, position manager),
│                        src/libraries, src/interfaces, src/testnet, script/, scripts/, test/, deployments/
├── swapex-indexer/      Skeleton: package.json, src/config.ts (zod env), src/index.ts (log-only stub), 3 tests
├── prompts/             01-next-phase.md (owner's standing next-phase spec)
├── setup.sh, dev.sh     One-command setup / local stack (anvil + deploy + seed + web)
├── AGENTS.md, README.md, .gitignore
└── docs/                (created by this audit: ARCHITECTURE_AUDIT.md, MIGRATION_PLAN.md)
```

### 1.3 Scripts / commands

| Command | Purpose | State on this machine |
|---|---|---|
| `./setup.sh` | tool check → forge test → export ABIs → web npm install/test | **Fails here**: needs `python3` on PATH (Windows Store alias is a stub; only `py` exists) and bash |
| `./dev.sh` | anvil + `Deploy.s.sol` + `SeedTestnet.s.sol` + export ABIs + `npm run dev` | same `python3`/bash dependency; not run here |
| `swapex-contracts/scripts/export-abis.sh <app>` | `forge inspect … abi` → `lib/abi/*.json`; merges `deployments/<id>.json` + `.seed.json` via a **python3 heredoc** → `lib/deployments/<id>.json` | not run here (python3 missing) |
| `swapex-contracts/scripts/e2e-local.sh` | deploy+seed, then cast-based swap round-trip checks | not run here |
| `swapex-contracts/scripts/e2e-positions.sh` | cast+python position lifecycle checks (mint → decrease → collect → burn) | not run here |
| `Swapex--main`: `npm run dev/build/start/lint/test` | app lifecycle | `test` and `build` verified; `lint` broken (§4) |
| `swapex-indexer`: `npm run dev/start/test/typecheck` | indexer lifecycle | `test` and `typecheck` verified |

### 1.4 Environment limitations of this audit (stated plainly)

- **`python3` is not available** on this machine (Store stub); `py` → Python 3.14.4 works. Shell scripts
  that call `python3` fail as-is. Fix planned (migration step S26).
- Foundry is installed at `~\.foundry\bin` but **not on PATH** in this shell; invoked by full path.
- No browser here: wallet-connection behavior was assessed **by code inspection only** (see §4.1).
- The shell scripts (`setup.sh`, `dev.sh`, `e2e-*.sh`) were **not executed** here (need bash + python3);
  their contract-level behavior is covered by `forge test` instead.

## 2. Contracts and how the app talks to them

### 2.1 Contracts (`swapex-contracts/`) — read-only per rules

- **V3-style concentrated liquidity**: `SwapexFactory` (CREATE2 pools, fee tiers **500/3000/10000** →
  tickSpacing 10/60/200), `SwapexPool` (mint/burn/collect/swap/flash, no TWAP), periphery:
  - `SwapexRouter`: `exactInputSingle/exactInput/exactOutputSingle/exactOutput`, **packed `bytes` paths**
    (token|fee|token…, max 4 hops), deadline, `amountOutMinimum`/`amountInMaximum`, partial fills refused
    (`PartialFill`) unless a price limit is supplied.
  - `SwapexQuoter`: same surfaces, **non-view** (reverting `eth_call` pattern, `QuoteResult` error) —
    the app correctly calls it via `callStatic` (`lib/swapRoute.js:49`).
  - `SwapexPositionManager`: ERC-721 positions (via unaudited `ERC721Minimal`), `mint`, `increaseLiquidity`,
    `decreaseLiquidity`, `collect`, `burn`, `createAndInitializePoolIfNecessary`, `multicall`; the pool's
    position key is `keccak(positionManager, tickLower, tickUpper)` and the manager tracks per-NFT shares.
  - `PeripheryBase`: `multicall`, `unwrapWETH9`, `sweepToken`, `refundETH`, `selfPermit` (EIP-2612).
- **No** limit orders, **no** Permit2, **no** TickLens, **no** TWAP oracle (design doc only:
  `swapex-contracts/docs/V4_DESIGN.md`). Testnet `TestToken` has a 1/hour `faucet()`.
- Tests: **80 Foundry tests pass** here (verified, §5). `lib/forge-std` was absent and is installed on
  demand by `setup.sh` / CI (`forge install … --no-git`); done for this audit.

### 2.2 ABI / address flow (what works today)

- Addresses: **one place** — `Swapex--main/lib/deployments/<chainId>.json`, loaded by
  `lib/deployments/index.js` (validates `weth9, factory, router, positionManager, quoter` are 0x40-hex,
  else returns null) and consumed through `lib/config.js` (`DEPLOYMENT`, `CONFIG_ERROR`). **No component
  hardcodes a Swapex address** (checked by grep; only intentional sentinels `0x…0002`/zero-address and
  a stale mainnet USDT constant, §4.5).
- Manifests: `31337.json` is real (anvil: factory/router/positionManager/quoter/weth9 + tUSDC/tDAI/tWBTC);
  `11155111`, `84532`, `421614` are honest "not deployed yet" placeholders (all-null). The contracts repo
  keeps `deployments/` empty (`.gitkeep` only, 31337 gitignored) — **the web app currently owns the only
  copy of the local manifest**; re-running `dev.sh`/`e2e-local.sh` regenerates it.
- ABIs: `Swapex--main/lib/abi/*.json` (6 files), generated by `swapex-contracts/scripts/export-abis.sh`.

### 2.3 Call path today

`component or hook` → `new ethers.Contract(DEPLOYMENT.x, abi, library|signer)` → writes wrapped by
`hooks/useTransact.js` (pending/confirmed/failed → toast + `lib/txHistory.js` localStorage).
Error mapping centralised in `lib/errors.js` (14 custom errors decoded over 5 candidate `data` paths).
There is **no services/adapter layer** — components construct contracts directly
(`components/SwapWidget.js`, `NewPositionForm.js`, `PositionDetail.js`, `WalletOverview.js`,
`SendForm.js`, `hooks/*`). This is the main architectural gap (target: UI → hooks → adapters → clients).

### 2.4 Chains and safety

- Configured chains (`lib/config.js`): **1** (mainnet, refused), **11155111** Sepolia, **84532** Base
  Sepolia, **421614** Arbitrum Sepolia, **31337** anvil. Deploy script `script/Deploy.s.sol` allow-lists
  exactly the four testnets and reverts `UnsupportedChain` otherwise (proved by `test/Deploy.t.sol`).
- Testnet-only enforced twice: web (`CONFIG_ERROR` unless `NEXT_PUBLIC_ALLOW_MAINNET=true`) and contracts.
  `TestnetBanner` is always visible. No secrets in the repo; `.env*` gitignored.

## 3. Target-feature matrix

Status: **exists** = works as the target describes; **partial** = present but incomplete; **missing** = absent.

### 3.1 Front end

| Target feature | Status | File(s) |
|---|---|---|
| Top nav: Swap, Explore, Pool/Positions, Portfolio | exists | `components/Layout.js` (NAV), mobile bottom bar at `Layout.js:106` |
| Network + wallet menu | partial | wallet: `WalletModal.js`, connect/disconnect in `Layout.js`; network switching only via `NetworkGuard`/`Web3Context.switchNetwork` — **no network menu listing chains** |
| Mobile bottom bar | exists | `Layout.js` |
| Testnet banner | exists | `components/TestnetBanner.js` (also surfaces `CONFIG_ERROR`) |
| Footer | exists (1 line) | `components/Footer.js` |
| Dark + light theme from design tokens | partial | tokens exist (`styles/globals.css` `:root`); **dark only**, no toggle, no `prefers-color-scheme` |
| Swap: token inputs with balance and MAX | exists | `components/SwapWidget.js` (MAX keeps 0.01 ETH gas reserve) |
| Flip | exists | `SwapWidget.js` (`aria-label="Switch tokens"`) |
| Token selector with search | partial | `components/TokenSelectModal.js` — searches **symbol/name only**; no address search |
| Import-by-address + warning | **missing** | — |
| Best-route quote (direct + multi-hop, fee tiers) | exists | `lib/swapRoute.js` (direct × {500,3000,10000} + via-WETH, quotes all via `quoter.callStatic`, picks max out) |
| Slippage in basis points | exists | `components/SlippageSettings.js`, `lib/amounts.js` (`percentToBps`, 50% cap) |
| Deadline | exists | `SlippageSettings.js` (minutes), `deadlineFromNow` |
| Price impact | exists | `lib/swapRoute.js` (`routeImpact`, fees excluded), warn/confirm > 5% in `SwapWidget.js` |
| Route display | exists | `SwapWidget.js` hop list + min-received |
| Review / confirm modal | **missing** | Swap sends immediately on click (listed in `docs/UI_PARITY.md:62`) |
| Pending + success states | exists | `hooks/useTransact.js`, button state machine in `SwapWidget.js`, `Toast.js` |
| Decoded contract errors | exists | `lib/errors.js` (+ tests only for string fallbacks; noisy `duplicate definition - InvalidPath()` ethers warnings) |
| Exact-amount approvals (no unlimited) | exists | `hooks/useApprove.js` (zero-reset first, USDT-style) |
| Liquidity: positions list | exists | `components/PositionsList.js` + `hooks/usePositions.js` (Transfer-log scan) |
| New position (pair, fee tier, range, deposits follow range) | exists | `components/NewPositionForm.js` (359 lines; new-pool init, ETH wrap/refund, single multicall) |
| Position detail: collect / add / remove | exists | `components/PositionDetail.js` (remove 25/50/75/100 + slider, receive-ETH, burn) |
| Explore: tokens + pools tables (sort, search) | exists (S21) | `pages/explore.js` + `ExploreTokensTable.js` / `ExplorePoolsTable.js` (live indexer data, skeletons, empty/error, per-column sort + search) |
| Explore: detail pages with charts | exists (S21) | `pages/explore/tokens/[address].js`, `pages/explore/pools/[address].js` + hand-rolled SVG `PriceChart.js` (1D/1W/1M candles, no chart lib); no per-row sparklines (N+1 fetches — decision in `docs/DECISIONS.md`) |
| Indexer API client (timeout + validation) | exists (S20) | `lib/indexerApi.js` (zod-validated, timeout, `isNotFound` / `indexerErrorMessage`) |
| Portfolio: balances | exists | `components/WalletOverview.js` |
| Portfolio: positions | partial | `pages/portfolio.js` shows `DataUnavailable` although `/pool` already has the data |
| Portfolio: activity | partial | `components/TransactionHistory.js` (localStorage only) |
| Limit orders | disabled screen + message (correct degradation) | `pages/limit.js` — no limit contract exists (gap → `docs/CONTRACT_GAPS.md`) |
| Send | exists | `components/SendForm.js` (recipient validation, MAX with gas reserve) |
| Loading skeletons | **missing** | plain "Loading …" text everywhere; no Skeleton/spinner component |
| Empty and error states | exists | `DataUnavailable.js`, per-list states, toasts |
| Keyboard / screen-reader basics | partial | `aria-current`/`aria-label` on nav & controls; **WalletModal and Toast are hand-rolled (no Esc/focus trap)**; labels not wired with `htmlFor`; decorative svgs not always `aria-hidden` |
| Responsive layout | exists | `md:` breakpoints, bottom bar, wide/narrow route widths |
| Security headers + strict CSP | exists | `next.config.mjs` (CSP still needs `'unsafe-inline'` scripts — Next pages-router constraint; nonce-based strict CSP is a possible hardening, not required now) |

### 3.2 Architecture

| Target | Status | File(s) |
|---|---|---|
| Layers: UI → hooks → services/adapters → clients; no contract calls in components | **missing** (partial today) | contracts constructed in `components/*` and `hooks/*` (§2.3) |
| Single typed config module (chains, deployments, flags, fee tiers, defaults) | partial | `lib/config.js` is single-source but plain JS; **no feature-flag module** (screens branch on `DEPLOYMENT`/nothing) |
| Feature flags deciding live screens | exists (S20) | `lib/features.js` (`explore` needs deployment + indexer URL; `limit` false; `portfolio` deployment) + `DataUnavailable` on missing deployment |
| Deployments manifest per chain | exists | `lib/deployments/{31337,11155111,84532,421614}.json` + validating loader |
| ABIs generated from contracts source by one script | exists | `swapex-contracts/scripts/export-abis.sh` (needs `python3`, §1.4) |
| Typed indexer API client (timeouts, zod/equivalent validation) | exists (S20) | `lib/indexerApi.js` (zod schemas, 8s timeout, network vs HTTP error split) |
| Indexer package (events, reorg-safe, SQLite + repository, HTTP API) | exists (S19–S20) | `swapex-indexer/`: viem event decode, reorg rollback + cursor, better-sqlite3 repo, Fastify HTTP API (tokens/pools/candles/swaps/health); 40 tests + tsc clean; seed-token manifest merge in `src/deployment.ts` |
| One place mapping contract/wallet errors → messages | exists | `lib/errors.js` |
| Unit tests for pure logic | exists | 25 tests (amounts/slippage, path, ticks/liquidity) |
| Component tests for main flows | **missing** | — |
| E2E against local chain | **missing** (browser-level) | contract-level e2e exists as shell scripts only |
| Lint + format scripts | partial | lint script exists but **broken** (§4); `.prettierrc` present, **no format script** |
| Setup script / dev script | exists | `setup.sh`, `dev.sh` (python3-dependent) |
| README + AGENTS.md | partial | `AGENTS.md` accurate; `Swapex--main/README.md` **stale** (says V2 + mainnet, §4.5) |
| Wallet/chain upgrade (ethers v5 + web3-react v6 → viem + wagmi) | missing | optional, owner-gated (migration plan §O) |

## 4. What is broken or risky (ordered)

1. **Wallet connect is likely broken on every configured chain (critical, code inspection).**
   `context/Web3Context.js:9` creates `new InjectedConnector({ supportedChainIds: [1, 3, 4, 5, 42] })`.
   web3-react v6's `InjectedConnector.activate()` throws `UnsupportedChainIdError` when the wallet's chain
   is not in that list — and **none** of the configured chains (11155111, 84532, 421614, 31337) are in it.
   The catch in `connectWallet` swallows the error, so the UI would silently do nothing. *Not browser-verified
   in this environment (no browser)* — first thing to check in Phase 1. Fix is one line + config reuse.
2. **CI is red as configured** (not running today because the workspace is not a git repo, but would fail):
   - `npm ci` fails: `package-lock.json` is stale (lockfileVersion 3, **no vitest, no typescript entries** —
     generated from an older package.json). Verified: `npm ci` → EUSAGE "Missing: vitest@3.2.7 from lock file…".
   - `npm run lint` fails: `Cannot find module 'typescript'` required via `eslint-config-next` → `typescript-eslint`.
     `typescript` is not in `package.json` (the sibling `apps/web` has it). Verified: exit 2.
   - `npm audit --omit=dev --audit-level=high` fails: high advisories in **axios ≤ 0.32** pulled in by the
     `@web3-react/walletconnect-connector` v6 → WalletConnect v1 → `@json-rpc-tools` chain. Verified: exit 1.
3. **`package-lock.json` drift also means installs are not reproducible** (`npm install --package-lock=false`
   was used in this audit to avoid editing files; it resolved vitest 3.2.7).
4. **Mainnet placeholders left in wallet connectors**: WalletConnect `rpc: {1: 'https://mainnet.infura.io/v3/'}`,
   WalletLink `url: 'https://mainnet.infura.io/v3/'` (`Web3Context.js:11-18`). Incomplete URL, mainnet, no key.
   Also WalletConnect **v1 relay service is sunset** — this connector very likely cannot connect at all.
5. **Stale mainnet leftover**: `hooks/useApprove.js:7` hardcodes the mainnet USDT address (unused value but
   greppable and misleading in a testnet-only app).
6. **Stale docs**: `Swapex--main/README.md` lines 1–29 claim "Uniswap V2-style… canonical Uniswap V2 Factory
   and Router02 on Ethereum mainnet (addresses in `constants/index.js`)"; none of that exists anymore.
   `docs/UI_PARITY.md` "Honest status" says npm install/build/tests never happened — outdated (they do pass, §5).
7. **Dead weight with branding risk**: `public/locales/*` (10 languages, unused, contains "Uniswap V1" string),
   unused deps `styled-components` + `@reach/tooltip`, leftover `pages/api/hello.js`, CRA-era env vars in
   `netlify.toml`.
8. **Scripts assume `python3`** (`export-abis.sh:14`, and e2e scripts) and bash; on this Windows machine only
   `py` exists, so `setup.sh`/`dev.sh`/`export-abis.sh` fail here without a shim.
9. **Contract construction inside components** (§2.3) — violates the target layering, makes flows untestable
   without a provider, and hides chain calls from review. Planned adapter layer (S5–S8).
10. **Positions discovery scans `Transfer` logs from `blockNumber` (0 in the anvil manifest)** —
    `hooks/usePositions.js:61-62`. Works on anvil; on public testnets full-range `queryFilter` will hit RPC
    log-range limits as history grows. Indexer `/positions?owner=` is the intended fix —
    shipped in S22 (indexer-first with chain-checked health, cursor gap scan and `ownerOf`
    verification; the event scan remains the fallback).
11. **Test gaps**: no component or browser tests; `lib/errors.js` is never tested against real Swapex error
    selectors (tests cover only legacy string heuristics); ethers emits `duplicate definition - InvalidPath()`
    while building interfaces (duplicate error names across ABIs — cosmetic, should be deduped in one place).
12. **Out-of-box inert**: default `NEXT_PUBLIC_CHAIN_ID=11155111` but Sepolia manifest is null → every action
    screen shows "Unavailable / not deployed" until the user runs the local stack with `NEXT_PUBLIC_CHAIN_ID=31337`
    (safe by design; README should say this first).
13. **`WalletModal` / `Toast` accessibility**: hand-rolled overlays without Esc/focus-trap (only
    `TokenSelectModal` uses `@reach/dialog`).
14. **No light theme**; CSP keeps `'unsafe-inline'` for scripts (Next pages-router reality — documented, not a bug).
15. **Contracts-side known risks that the frontend must not paper over** (from `AGENTS.md`/contract README):
    `ERC721Minimal` is hand-rolled and must be replaced before real value; quoter is non-view (adapter must keep
    `callStatic`); router refuses partial fills via revert; no TWAP → charts can only come from indexer candles.

## 5. What was verified in this audit (commands + results)

| Command | Result |
|---|---|
| `cd Swapex--main && npm install --package-lock=false` | ok — 637 packages (lockfile untouched; mtime verified unchanged) |
| `npm test` | **PASS** — 3 files, 25 tests (1.3 s) |
| `npm run build` | **PASS** — clean; 11 routes prerendered (`/`, `/add`, `/explore`, `/limit`, `/pool`, `/pool/[id]`, `/portfolio`, `/send`, `/swap`, `/api/hello`, 404) |
| `npm run lint` | **FAIL** (exit 2) — `Cannot find module 'typescript'` |
| `npm ci` | **FAIL** (exit 1) — lockfile out of sync with package.json |
| `npm audit --omit=dev --audit-level=high` | **FAIL** (exit 1) — high advisories via axios ← WalletConnect v1 chain |
| `cd swapex-contracts && forge install foundry-rs/forge-std --no-git` | ok (`lib/` is gitignored) |
| `forge test` | **PASS** — 5 suites, **80 tests**, fuzz 512 runs (0 failures) |
| `cd swapex-indexer && npm install && npm test && npm run typecheck` | **PASS** — 3 tests, tsc clean |
| `./setup.sh`, `./dev.sh`, `e2e-*.sh`, browser run | **NOT run** (need bash+python3 / a browser in this environment) |

## 6. Contract gaps (summary; full text in `docs/CONTRACT_GAPS.md`, created in migration step S1)

| Gap | Impact on front end | Plan |
|---|---|---|
| No limit-order contract | `/limit` stays a disabled honest screen | keep degraded (target allows); contract is out of scope unless owner asks |
| No Permit2 | approvals are exact-amount ERC-20 + optional EIP-2612 `selfPermit` | fine for testnet; note in gaps |
| Quoter is non-view | adapter must use `callStatic`/eth_call | handled in adapter |
| Pool `Swap` event has no pool address in args | indexer takes pool from the log's `address` | indexer design note |
| No TWAP / TickLens | pool detail charts limited to indexer candles; no on-chain liquidity-by-tick histogram | Explore detail shows swaps/candles only |
| `ERC721Minimal` unaudited | OK for testnet-only; must be replaced before real value | recorded; contracts untouched |
| Factory fee tiers fixed (500/3000/10000) | UI `FEE_TIERS` in `lib/config.js` matches; no dynamic tier discovery needed | keep in sync via config |

## 7. Verdict

The contracts and the swap/liquidity flows are further along than the target assumes (real V3 periphery,
working routing, positions, honest empty states, security headers, deployments manifest discipline). The
gaps are concentrated in: **wallet activation config (likely broken)**, **CI/install health**, the missing
**adapter layer**, the missing **review modal and token-import safety**, **theme/network/a11y polish**, and
the entire **indexer → Explore → portfolio** data path. None of the gaps require contract changes.
Proceed to `docs/MIGRATION_PLAN.md`; stop for owner approval before Phase 1 execution.
