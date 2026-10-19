# Decisions

Append-only log of decisions made by the agent where the owner was not consulted,
per AGENTS.md rule 7. Each entry: date, decision, rationale, reversal path.

## 2026-10-18 — Drop WalletConnect v1 connector (S1)

- **Decision:** Removed `@web3-react/walletconnect-connector` and the WalletConnect
  option from the connect-wallet modal. Injected (MetaMask) and Coinbase Wallet remain.
- **Rationale:** The connector pulls `@walletconnect/*` v1.x, which carries critical
  advisories (`request`, `form-data`) plus a large high-severity cluster (axios,
  `web3-provider-engine`, `ethereumjs-vm`, `semver`) that no in-range update fixes.
  WalletConnect v1's relay network is sunset, so the option cannot work in production
  regardless. npm's suggested "fix" (downgrade to 6.2.4) only swapped one rotten
  dependency tree for another.
- **Reversal:** Re-add the package and modal entry if/when the app migrates to a
  WalletConnect v2 connector (`@web3-react/walletconnect-connector` v8+ or wagmi).

## 2026-10-18 — Patch framework + ws via version bumps, not migration (S1)

- **Decision:** Bumped `next`/`eslint-config-next` 16.2.6 → 16.4.2 (same major,
  framework unchanged) and added `"overrides": { "ws": "^8.21.0" }` so ethers v5's
  pinned `ws@8.18.0` resolves to a patched 8.x. Kept ethers v5 and web3-react v6.
- **Rationale:** next 16.2.6 contains critical RCE advisories patched only in the
  16.3/16.4 line; ethers v5 pins ws exactly and only ethers 6 (the optional O1
  migration, which needs owner approval) would drop it. ws 8.18 → 8.22 is
  API-compatible within the same major and is only used server-side (never bundled
  to the browser).
- **Reversal:** Revert the two version pins and the `overrides` block; O1 (viem/wagmi)
  supersedes the ws override entirely.

## 2026-10-18 — Supported chains and RPCs come from lib/config (S2)

- **Decision:** `InjectedConnector` now accepts every chain in `CHAINS`
  (`Object.keys(CHAINS).map(Number)`); each `CHAINS` entry gained a public `rpc`
  URL; the Coinbase connector uses `CHAINS[REQUIRED_CHAIN_ID].rpc` instead of the
  dead `mainnet.infura.io/v3/` placeholder.
- **Rationale:** The previous hardcoded `[1, 3, 4, 5, 42]` list contained none of the
  app's configured chains, so connecting a Sepolia/Base/ArbSepolia/anvil wallet
  threw `UnsupportedChainIdError`. Mainnet stays gated by `CONFIG_ERROR` +
  `NetworkGuard` at the action layer, so allowing the connection itself is safe and
  gives a proper "wrong network → switch" UX instead of a thrown error.
- **Reversal:** Restore the old array and URL strings in `context/Web3Context.js`
  and drop `rpc` from `lib/config.js`.

## 2026-10-18 — netlify.toml SPA redirect removed with the env vars (S3)

- **Decision:** Alongside the plan's `REACT_APP_*` env-var cleanup, removed the
  `/* → /index.html` (status 200) redirect from `netlify.toml`. Kept the country-block
  redirect.
- **Rationale:** The redirect is CRA-era and targets a file Next.js never emits; if the
  site were deployed to Netlify as-is it would shadow every Next route. The plan said
  "env vars", but leaving a routing footgun contradicted the same cleanup intent.
- **Reversal:** Re-add the redirect block if a CRA-style host is ever used again (it
  should not be — this is a Next.js app).

## 2026-10-18 — S4 dead-weight removal (plan items, no judgment calls)

- Removed unused deps `styled-components` and `@reach/tooltip` (`@reach/dialog` stays —
  used by TokenSelectModal); deleted dead `public/locales/` (10 files, contained a
  "Uniswap V1" string, zero imports anywhere) and the now-unreferenced
  `public/images/wallets/walletconnect.svg`; rewrote `README.md` for the current app;
  refreshed the "Honest status" section of `docs/UI_PARITY.md`. All plan-literal;
  reversal is a plain `git revert` of the S4 commit.

## 2026-10-18 — Add zod to the web app for indexer response validation (S20)

- **Decision:** Installed `zod` (runtime dep) and added `lib/indexerApi.js`, which
  validates every indexer HTTP response before it reaches the UI. Base URL from
  `NEXT_PUBLIC_INDEXER_URL`; unset → `null` → honest "indexer not connected" state.
  `lib/features.js` exposes sync flags (`explore` needs deployment + indexer URL,
  `portfolio` needs deployment, `limit` reserved/false).
- **Rationale:** The plan (S20) calls for zod in the app for this purpose —
  the indexer returns data the UI must not trust blindly, and hand-written
  guards for six endpoint shapes are more error-prone than a schema. It is
  small, tree-shakeable, and does not affect the stack constraint (ethers v5,
  web3-react v6, pages router all unchanged).
- **Reversal:** Remove the dep and the two lib files; the UI layers that will
  consume them (S21/S22) fall back to "indexer not connected".

## 2026-10-18 — Explore screens (S21) build calls

- **No sparklines in the tokens/pools tables:** the UI-prompts file suggested
  sparklines, but each sparkline needs a candles request per row (N+1 fetches) and
  the pool detail page already ships the full chart. Deep-linked detail page instead.
- **`formatUsd`/`formatCompact` keep sub-1 precision** (0.00134, -0.000339 instead of
  collapsing to "0"), and every number/date goes through pinned `'en-US'` locale
  formatting — browsers with different locales rendered inconsistent tables.
- **Indexer `loadManifest` merges `<chainId>.seed.json`** (mirrors the contracts
  `export-abis.sh`): `deployments/31337.json` has no `tokens` array, so every USD
  price was null without the seed merge. Reversible by reverting
  `swapex-indexer/src/deployment.ts` + its test.
- **Explore 404s map to "Unknown token/pool", not "indexer unreachable":**
  `indexerApi.isNotFound()` distinguishes the two so a bad address doesn't read as an
  outage; table `error` prop drives "could not be loaded" vs "nothing indexed yet".
- **CSP `connect-src` gained exactly the configured indexer origin** (parsed from
  `NEXT_PUBLIC_INDEXER_URL` at config load). Production builds previously blocked
  http://127.0.0.1:4000 (connect-src was 'self' https: wss: only), so Explore could
  never load data behind `next start`; never a wildcard, and dev still allows local
  anvil ports.
- **`Web3Context` HMR guard:** module re-evaluation after an edit re-ran
  `createWeb3ReactRoot(NetworkContextName)` and crashed every page with
  "A root already exists for provided key NETWORK"; the root is stashed on
  `globalThis` and reused.



## 2026-10-19 - Positions via indexer + nav search (S22)

- **Position id discovery is indexer-first with three guards:** (1) `/health` must report the
  same `chainId` this build targets and a non-null cursor, else the full Transfer-log scan runs
  (a cross-chain or unsynced indexer must never feed ids); (2) ids from `/positions?owner=`
  are merged with a small Transfer scan starting at the cursor block (rows and cursor are
  written atomically, so rows + cursor->head is a complete union - no delayed recheck); (3)
  every id is re-verified on chain via `ownerOf` (`ownedTokenIds`) before it can surface a
  position, and hydration reuses the existing `loadPosition`. Indexer absent/failing/empty
  -> exactly the pre-indexer event scan. Reversible: `git revert` restores the old refetch.
- **Nav search never guesses a route:** addresses resolve through direct `/tokens/<addr>`
  then `/pools/<addr>` lookups (a paginated list could hide an address); 404/404 -> the
  filtered list `/explore?q=...`, and a transport failure lands there too, where the page's
  own banner reports the outage (the two expected 404 lookups appear as console
  "Failed to load resource" noise; the responses are caught by `isNotFound`).
- **Ambiguous queries fall to the list, never a pick:** exact single symbol -> token detail;
  unique pair (`sym0/sym1` or `sym0 - sym1`, either order) -> pool detail; duplicate symbols
  or multi-fee-tier pairs -> `/explore?q=...` where both tables filter. `?q=` prefills the
  table inputs via a key remount because `react-hooks/set-state-in-effect` forbids setState
  inside an effect.
- **Mobile search is a header toggle:** a `md:hidden` icon expands the same input into a row
  under the header; the bottom nav keeps its Explore entry, so no second mobile affordance.
- **Verified by running:** web 129 tests / lint 0 errors / prod build; CDP against the live
  stack (anvil + indexer + `next start`): `weth` -> token detail, `weth/tusdc` -> pool
  detail, unknown address and `zzz` -> `/explore?q=` with both tables filtered (deep-loaded
  `?q=` prefills both inputs), indexer stopped -> "Could not reach the indexer..." banner +
  table error states, 375px toggle -> search -> detail; indexer rows for anvil account 0
  (ids 1-3) match `ownerOf` on chain. Wallet-connected UI path not exercised headless -
  the id source is covered by unit tests + the chain cross-check above.

## 2026-10-19 - Component tests for the four interactive surfaces (S23)

- **Two vitest projects, one config:** logic tests keep running in plain node; the new
  `tests/components/*` suite runs in jsdom. Inline `test.projects` entries do not inherit
  root-level Vite options, so the esbuild override (see below) is repeated per project.
- **JSX lives in `.js` files (Next.js convention), and Vite's default `js` loader rejects
  JSX.** `@vitejs/plugin-react` only sets `jsx: 'automatic'` - the loader is still picked
  from the extension, so `.js` files with JSX fail to parse. The fix is the esbuild
  override `{ jsx: 'automatic', loader: 'jsx', include: /\.[jt]sx?$/ }` per project; the
  plugin was tried first and removed again (unneeded once the loader parses JSX).
- **RTL needs explicit `cleanup()`:** vitest globals are off, so auto-cleanup never
  registers and stale portals leak between tests ("found multiple elements"). Each
  component test file imports `afterEach(cleanup)`.
- **Mocks follow the established pattern:** mutable module state + `vi.mock` factories
  (`useWeb3`, `usePositions`, `lib/config` with live getters for `DEPLOYMENT`/
  `CONFIG_ERROR`, `next/link` as a plain `<a>`, `lib/tokenMeta`), never touching
  `lib/contracts` - the layering guard still forbids `new Contract(` outside it.
- **Covered flows:** ConfirmSwapModal summary rows + one-click confirm below 5% impact +
  two-step confirm at/above it + cancel + pending-disabled + ack reset on reopen;
  TokenSelectModal import-warning gate (disabled without wallet), successful import
  (meta read -> persist -> select -> close), honest on-chain read failure, previously
  imported address treated as known, no-match empty state; NetworkGuard all four
  branches; PositionsList unavailable / connect / error / loading / empty / listed
  positions with badges and detail links.
- **Verified by running:** web 150 tests (129 node + 21 component), lint 0 errors, prod
  build. Reversible: revert restores the old single-project config.

## 2026-10-19 - Browser e2e against the local stack (S24)

- **Playwright added:** `@playwright/test`, `playwright.config.js` (testDir `e2e`, baseURL
  `http://localhost:3000`, workers 1, chromium, trace on failure), script `npm run e2e` that
  expects the local stack running (anvil + deploy/seed + indexer + `next start` with
  `NEXT_PUBLIC_CHAIN_ID=31337` and `NEXT_PUBLIC_INDEXER_URL=http://127.0.0.1:4000`). Five
  specs: connect, swap through the confirm modal, add position, remove position,
  explore-with-indexer.
- **The browser cannot talk to anvil directly:** the app CSP allows
  `connect-src 'self' https: wss: http://127.0.0.1:4000`, so fetches to :8545 are blocked.
  The wallet fixture injects a `window.ethereum` shim that posts same-origin to
  `/__e2e-rpc`; a Playwright route forwards those to anvil server-side (which also sidesteps
  CORS). web3-react v6's InjectedConnector calls the **legacy `send('eth_requestAccounts')`
  API expecting `{result}`** (not `request()`), so the shim implements both, plus `enable`,
  `on`, `removeListener`, `isMetaMask`. Anvil's dev accounts are unlocked, so
  `eth_sendTransaction` signs locally - no wallet UI to fake.
- **Timing and selectors:** clicks before hydration land on inert SSR buttons, so
  `connectWallet` waits for `networkidle` first; the header account is a `<span>`, so the
  connected-state assertion is the `Disconnect` button. The nav searchbox ("Search tokens
  and pools") substring-collides with the explore table's "Search tokens" - table queries
  use `exact: true`.
- **Amounts must respect the seed:** `WETH_SEED_WEI = 0.02 ether` per pool, so a 1 ETH swap
  honestly returns "No liquidity for this pair" (quoter `InsufficientLiquidity`). Specs stay
  inside the seed (0.001 ETH). Pool pair labels are address-sorted token0/token1, i.e.
  "tUSDC / WETH" here, and token cells carry symbol + name - cell matches are anchored
  (`/^tUSDC\b/`) and scoped to their own table.
- **A drifted anvil clock fails every transaction quietly:** the long-running node had a
  +6.2h offset (leftover `evm_increaseTime`), so every browser-clock deadline was already
  past - `eth_estimateGas` reverted with custom error `0x203d82d8` = `Expired()`, the app
  showed a 4-second error toast and left the confirm dialog open. Fixed with
  `evm_setTime(<now>)` (a fresh anvil starts at wall time); custom errors were identified by
  brute-forcing `cast sig` over every `error` declaration in the contracts.
- **Stale indexer data after an anvil restart:** the DB cursor can equal the *new* chain's
  head height (same height, different blocks), so old addresses are served confidently with
  no reorg trigger. Fix: wipe `DATABASE_PATH` and restart - the indexer reloads
  `deployments/<chainId>.json` at startup. The explore failure in the browser was CORS: the
  indexer's default allowlist is `http://localhost:3000`, which is why the Playwright
  baseURL is `localhost` and not `127.0.0.1` (the `requireIndexer` fixture checks `/health`
  server-side so a down indexer fails plainly instead).
- **Lint:** `eslint.config.mjs` turns off `react-hooks/rules-of-hooks` only for `e2e/**`
  (Playwright fixture `use()` calls); everything else stays linted.
- **Fresh-stack discipline:** the stack was redeployed on a clean anvil so the committed
  `lib/deployments/31337.json` (canonical fresh-anvil addresses, identical to HEAD) matches
  the chain the specs run against.
- **Verified by running:** `npm run e2e` 5 passed - on reused state twice and on the fresh
  canonical stack twice (after the env rebuild); `npm test` 150 passed; `npm run lint`
  0 errors (16 pre-existing `<img>` warnings); plain `npm run build` and the local-env
  build both succeed. Reversible: revert removes the config, specs and script.

## 2026-10-19 - Scripts and CI refresh (S25)

- **python3/py detection in the three shell scripts:** `setup.sh`, `dev.sh` and
  `swapex-contracts/scripts/export-abis.sh` resolve an interpreter by *running* each
  candidate (`python3 -c "import sys"`, then `py`) instead of checking
  `command -v python3`: on this machine python3 resolves to the Windows App Execution
  alias, which always fails ("Python was not found", exit 9009), so a plain existence
  check would pick a dead interpreter. No other behavior change (per plan).
- **Web CI final command set:** `Swapex--main/.github/workflows/ci.yml` moves to Node 24
  (the version the whole stack is verified on) and gains an explicit
  `working-directory`/`cache-dependency-path` under `swapex/Swapex--main` so the job is
  correct even if the file is later moved to the repo root. Commands stay `npm ci`,
  lint, test, build and `npm audit --omit=dev --audit-level=high` - nothing relaxed.
  Playwright e2e is not wired into CI: it needs anvil + forge + indexer + a built app,
  so it runs locally with `npm run e2e`; wiring it into CI would be a follow-up.
- **New indexer workflow:** `swapex-indexer/.github/workflows/ci.yml` - node matrix
  [20, 24] running `npm ci && npm test && npm run typecheck`, scoped to the package.
  All 40 indexer tests + typecheck were run green on this machine first.
- **Contracts CI untouched** (plan: ensure unchanged) - verified via git status.
- **Note for the owner (no action taken):** GitHub Actions only scans workflows at the
  repo *root* `.github/workflows/`; the per-package workflow files (web, contracts and
  the new indexer one) sit under their packages and therefore do not execute on GitHub
  today, while the root `.github/workflows/ci.yml` targets the root-level `apps/web` +
  `contracts` layout (demo/legacy trees), not `swapex/`. Restructuring where CI runs is
  a scope change - left as an owner decision.
- **Verified by running:** `bash -n` on all three scripts; happy path picks `py` after
  the dead python3 alias and writes a manifest identical to HEAD; missing-python path
  prints `Missing: python3 (or py). Install Python 3.` and exits 1. `./setup.sh`
  end-to-end exit 0 (forge test 80/80, ABI sync, web 150 tests, indexer 40 tests).
  `./dev.sh` from a clean slate: fresh canonical deploy (manifest regenerated identical
  to HEAD), `next dev` serving, fresh indexer synced to the new chain (cursor 4), and
  the swap e2e spec passed against that stack (1 passed). Web `npm test` 150 passed,
  lint 0 errors (16 pre-existing warnings). Reversible: revert.
