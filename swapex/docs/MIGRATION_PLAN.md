# Migration plan — Swapex front end + architecture

Companion to `docs/ARCHITECTURE_AUDIT.md`. Ordered, small, reversible steps. **Nothing here runs until the
owner approves.** One step = one commit; the app must build and its tests must pass after every step.

## Rules that constrain the plan (from the owner)

- Keep the stack: Next 16 pages router, JavaScript, Tailwind v4 + CSS-var tokens, ethers v5, web3-react v6.
  Anything that changes the stack is listed under "Optional, needs explicit approval" and runs **last**.
- Contracts are read-only. Every gap goes to `docs/CONTRACT_GAPS.md`; the UI degrades gracefully.
- No hardcoded addresses (keep using `lib/deployments` → `lib/config`). No fake data. Testnet-only stays on.
- No Uniswap code/name/assets (GPL-3.0 license of this app stays untouched).
- Verify by running; never weaken a test. Decisions get one line in `docs/DECISIONS.md`.

## Standard verification block (run after every step unless a step says otherwise)

```bash
cd Swapex--main
npm ci                      # must pass once S1 re-syncs the lockfile
npm run lint && npm test && npm run build
npm audit --omit=dev --audit-level=high
cd ../swapex-contracts && forge test          # only when contracts-related files change
cd ../swapex-indexer && npm test && npm run typecheck   # only after Phase 5 starts
```

Manual smoke (when a step touches flows): `./dev.sh` → connect wallet on chain 31337 → swap → add/remove
position. Rollback of any step: `git revert <step-sha>` (or `git checkout -- <files>` before commit).
After S1, every step is an isolated commit, so rollback is always a single revert.

---

## Step 0 — Git baseline (needs owner's answer first)

The workspace is currently **untracked** inside the parent repo. Before "one step per commit" is real, the
tree needs a committed baseline. Options (owner picks in the Phase-0 review):
- **(a) recommended:** commit this tree as one baseline commit in the existing parent repo
  (`git add swapex && git commit`), then one commit per step under `swapex/…` paths;
- (b) `git init` a fresh repo inside `swapex/` (clean history, second .git on disk);
- (c) move `swapex/` out to its own repository first, then proceed.

Files: none (history only). Verify: `git status` clean after baseline. Rollback: not applicable.

## Phase 1 — Green baseline and hygiene (no behavior change beyond fixes)

### S1 — Make install, lint and audit pass
- Fix the three CI failures found in the audit:
  1. regenerate `package-lock.json` (`npm install`) so it matches `package.json` (lockfile currently has no
     vitest/typescript entries);
  2. add `typescript` to devDependencies (required at runtime by `eslint-config-next` → `typescript-eslint`);
  3. bump `@web3-react/walletconnect-connector` ^6.2.4 (npm's own remediation for the axios advisory chain);
     if the audit is still red, document the remaining advisory and its source path in `docs/DECISIONS.md`
     and bring it to the owner — **CI is not weakened**.
- Files: `Swapex--main/package.json`, `package-lock.json`, `docs/DECISIONS.md`.
- Verify: full standard block (all green, including `npm ci` and audit).
- Rollback: revert commit.

### S2 — Wallet/chain config fix (fixes likely-broken connect)
- `context/Web3Context.js`: build `supportedChainIds` from `CHAINS` in `lib/config.js` (all configured
  chains), replace the `mainnet.infura.io` placeholders in WalletConnect/WalletLink with per-chain RPC from
  `NEXT_PUBLIC_RPC_URL` or a documented public testnet RPC; note in `docs/DECISIONS.md` that the
  WalletConnect **v1** relay is sunset (connector may still be non-functional — the option stays visible but
  the modal notes it; removal happens in S4 or optional O1).
- Files: `Swapex--main/context/Web3Context.js`, `docs/DECISIONS.md`.
- Verify: standard block + manual: connect MetaMask on 31337 (dev stack) — this is the browser check the
  audit could not do.
- Rollback: revert.

### S3 — Stale mainnet leftovers
- Remove the unused mainnet USDT constant in `hooks/useApprove.js`, delete `pages/api/hello.js`, clean the
  CRA-era env vars in `netlify.toml`.
- Files: `hooks/useApprove.js`, `pages/api/hello.js`, `netlify.toml`.
- Verify: standard block. Rollback: revert.

### S4 — Dead weight and stale docs
- Remove unused deps `styled-components`, `@reach/tooltip`; delete dead `public/locales/` (contains a
  "Uniswap V1" string — branding rule); rewrite `Swapex--main/README.md` (current app, not V2/mainnet);
  refresh the "Honest status" section of `docs/UI_PARITY.md`; decide WalletConnect option visibility per S2.
- Files: `package.json`, `package-lock.json`, `public/locales/*`, `README.md`, `docs/UI_PARITY.md`.
- Verify: standard block. Rollback: revert.

### S5 — Docs scaffolding: CONTRACT_GAPS.md + DECISIONS.md
- Write `docs/CONTRACT_GAPS.md` (full text from the audit: limit orders, Permit2, quoter non-view, Swap
  event shape, TWAP/TickLens, ERC721Minimal, fee tiers) with the exact interface snippets the front end
  would need if the owner ever approves those contracts; create `docs/DECISIONS.md` with entries for S1–S4.
- Files: `docs/CONTRACT_GAPS.md`, `docs/DECISIONS.md`.
- Verify: files exist; nothing else. Rollback: delete files.

## Phase 2 — Architecture: adapter layer (no visual change)

### S6 — Create `lib/contracts/*` adapters
- New thin modules; the **only** place that constructs `ethers.Contract`:
  - `lib/contracts/client.js` — read/write contract factory from `(deployment, name, library|signer)`;
  - `erc20.js` (balanceOf/allowance/approve/symbol/decimals), `factory.js` (`getPool`),
    `quoter.js` (all four quote fns via `callStatic`), `router.js` (exact in/out single+multi, multicall,
    unwrap/sweep/refund encodings), `positionManager.js` (positions/ownerOf/mint/increase/decrease/collect/
    burn/createAndInitialize+multicall), `events.js` (Transfer-log scan with explicit `fromBlock`);
  - dedupe ABI error lists once (removes the `duplicate definition - InvalidPath()` ethers warnings).
- Files: new `Swapex--main/lib/contracts/*.js`, `tests/contracts.test.js` (encoding/decoding unit tests).
- Verify: standard block (nothing consumes the adapters yet). Rollback: revert.
- Note: `lib/errors.js` starts consuming ABIs from here too (one source for interfaces).

### S7 — Move swap flow onto adapters
- `components/SwapWidget.js` + `lib/swapRoute.js` call `lib/contracts/{quoter,factory,router}`; component
  keeps UI state only. No quote/tx behavior change.
- Files: `components/SwapWidget.js`, `lib/swapRoute.js`, `lib/contracts/*`.
- Verify: standard block + manual swap on 31337. Rollback: revert.

### S8 — Move liquidity flows onto adapters
- `components/NewPositionForm.js`, `components/PositionDetail.js`, `lib/liquidity.js` touch-points go
  through `positionManager.js`/`factory.js`.
- Files: as listed. Verify: standard block + manual add/remove/collect on 31337. Rollback: revert.

### S9 — Move hooks and remaining components; enforce the layer
- `hooks/useTokenBalance.js`, `useAllowance.js`, `useApprove.js`, `usePositions.js`,
  `components/WalletOverview.js`, `SendForm.js` use adapters; add a guard test
  (`tests/layering.test.js`) that fails if `components/` or `pages/` contain `new Contract(`/`ethers.Contract`.
- Files: as listed + test. Verify: standard block. Rollback: revert.

## Phase 3 — Swap UX

### S10 — Swap review / confirmation modal
- `components/ConfirmSwapModal.js` (new): amounts, rate, minimum received, price impact (+ extra confirm
  above 5%), route with fee tiers, slippage, deadline, fee estimate; opens on Swap click, then runs the
  existing `useTransact` flow (pending/success unchanged). Pure summary math in
  `lib/review.js` + `tests/review.test.js`.
- Files: `components/SwapWidget.js`, `components/ConfirmSwapModal.js`, `lib/review.js`,
  `tests/review.test.js`.
- Verify: standard block + manual swap through the modal. Rollback: revert.

### S11 — Token selector: address search + import with warning
- `components/TokenSelectModal.js`: match by symbol/name/**address**; unknown address → import step with an
  explicit warning (unknown token, no logo, possible fee-on-transfer note), then on-chain
  `symbol/decimals` via `lib/tokenMeta.js`; imported tokens persist per chain in `localStorage`
  (try/catch). New `lib/importedTokens.js` + tests.
- Files: `components/TokenSelectModal.js`, `lib/importedTokens.js`, `lib/tokens.js`,
  `tests/importedTokens.test.js`.
- Verify: standard block. Rollback: revert.

## Phase 4 — Shell, theme, quality

### S12 — Light theme from the same tokens
- Add a light palette (`[data-theme='light']` overrides of the existing CSS vars), a theme toggle in the
  header (persisted; default follows `prefers-color-scheme`, applied pre-hydration by a tiny inline script
  allowed by the current CSP).
- Files: `styles/globals.css`, `components/ThemeToggle.js` (new), `components/Layout.js`,
  `pages/_document.js`.
- Verify: standard block + visual check both themes. Rollback: revert.

### S13 — Network menu
- `components/NetworkMenu.js` (new): lists `CHAINS` with testnet badge and deployment status
  (`getDeployment(id)`), switches via existing `switchNetwork` / `wallet_switchEthereumChain`.
- Files: `components/NetworkMenu.js`, `components/Layout.js`, `context/Web3Context.js` (expose switcher).
- Verify: standard block + manual switch on 31337. Rollback: revert.

### S14 — Loading skeletons
- `components/Skeleton.js` (new, token-colored pulse); replace "Loading …" text in `PositionsList`,
  `PositionDetail`, `NewPositionForm`, `SwapWidget` (quote row), `WalletOverview`.
- Files: as listed. Verify: standard block + visual. Rollback: revert.

### S15 — Accessibility pass
- `WalletModal` and `Toast` onto `@reach/dialog` (Esc/focus-trap/restore) or add equivalent handlers; wire
  `<label htmlFor>` in all forms; `aria-hidden` on decorative SVGs; `role="status"/"alert"` on toasts and
  banners; visible focus styles on interactive elements.
- Files: `components/WalletModal.js`, `Toast.js`, `SwapWidget.js`, `NewPositionForm.js`,
  `PositionDetail.js`, `SendForm.js`, `SlippageSettings.js`, `styles/globals.css`.
- Verify: standard block + keyboard-only pass (Tab/Esc through modals and forms). Rollback: revert.

### S16 — Portfolio: positions + activity
- `pages/portfolio.js`: real positions via `usePositions` (link to `/pool/<id>`), activity from
  `lib/txHistory.js` plus indexer swaps when connected (S19), each section with skeleton/empty states.
- Files: `pages/portfolio.js`, `components/PortfolioPositions.js`, `components/ActivityList.js` (new).
- Verify: standard block + manual on 31337. Rollback: revert.

## Phase 5 — Indexer (`swapex-indexer/`, TypeScript + viem + better-sqlite3 + Fastify)

Each sub-step is one commit; the package already has zod config validation and 3 passing tests.
Manifests come from `swapex-contracts/deployments/<chainId>.json` (never hardcoded).

### S17 — Chain reader + event decoding + cursor
- viem public client from `CHAIN_ID`/`RPC_URL`; decode `PoolCreated`, `Initialize`, `Swap`, `Mint`, `Burn`,
  `Collect` (pool/factory), `Transfer` (position NFTs), `IncreaseLiquidity`/`DecreaseLiquidity`/`Collect`
  (position manager); block cursor table (last indexed block, resume on boot).
- Files: `src/chain/*`, `src/db/*` (schema + repository), `src/indexer/*`, tests (decode + cursor).
- Verify: `npm test`, `npm run typecheck` (+ integration against `anvil` + `e2e-local.sh` deploy when available).

### S18 — Reorg safety + idempotency
- Keep last `REORG_DEPTH` blocks unfinalized; parent-hash check with rollback; idempotent handlers
  (unique keys, upserts); replay test.
- Files: `src/indexer/reorg.ts` + tests. Verify: unit tests for rollback and double-replay.

### S19 — Derived data + HTTP API
- Aggregations: per-pool TVL, 24h volume/fees, hourly+daily candles, token USD price via the stable-coin
  reference pool rule (tUSDC/tDAI, documented in the README), 24h change.
- Fastify API: `/health`, `/tokens`, `/tokens/:address`, `/pools`, `/pools/:address`,
  `/pools/:address/candles?interval=`, `/pools/:address/swaps`, `/positions?owner=`; zod input validation,
  pagination, CORS allowlist from env (reject `*`), rate limiting.
- Files: `src/api/*`, `src/aggregate/*`, tests (candle/TVL math + API integration with a seeded DB).
- Verify: `npm test` + run the server against a local anvil deploy; `curl` each endpoint.

## Phase 6 — Explore + data client

### S20 — Indexer client + feature flags
- `lib/indexerApi.js` (new): fetch with timeout + response validation (**zod added to the app** for this —
  small, purpose-specific dep; noted in `docs/DECISIONS.md`), base URL from `NEXT_PUBLIC_INDEXER_URL`
  (unset → `null` → "indexer not connected"); `lib/features.js` (flags: `explore`, `limit=false`,
  `portfolio`, driven by env + deployment + indexer availability).
- Files: `lib/indexerApi.js`, `lib/features.js`, `package.json`, `tests/indexerApi.test.js`,
  `docs/DECISIONS.md`.
- Verify: standard block (unit tests mock fetch).

### S21 — Explore screens
- `/explore`: tokens + pools tables (sort, search, skeletons, empty/error); detail pages
  `/explore/tokens/[address]`, `/explore/pools/[address]`: stats, recent swaps, and a **hand-rolled SVG
  price chart** (1D/1W/1M from candles — no chart library), deep links to swap/add-liquidity. Honest
  "indexer not connected" when the flag is off.
- Files: `pages/explore.js`, `pages/explore/tokens/[address].js`, `pages/explore/pools/[address].js`,
  `components/ExploreTokensTable.js`, `ExplorePoolsTable.js`, `PriceChart.js` (new) +
  chart math tests.
- Verify: standard block + run indexer locally and click through both tables and detail pages.

### S22 — Positions via indexer + nav search
- `hooks/usePositions.js`: use `/positions?owner=` when the indexer is connected, keep the event-scan
  fallback; nav search box (token symbol/address → explore detail, pool → detail).
- Files: `hooks/usePositions.js`, `components/NavSearch.js`, `components/Layout.js`.
- Verify: standard block + manual on 31337 with indexer running.

## Phase 7 — Tests, CI, tooling, docs

### S23 — Component tests for the main flows
- Add dev deps `jsdom` + `@testing-library/react` (+ `@testing-library/user-event`); vitest config gains a
  jsdom project for `tests/components/*` (logic tests stay node). Cover: ConfirmSwapModal confirm/cancel,
  TokenSelectModal import-warning flow, NetworkGuard states, PositionsList empty/error states.
- Files: `package.json`, `vitest.config.js`, `tests/components/*`.
- Verify: `npm test` (all green), lint, build. Rollback: revert (deps included).

### S24 — Browser E2E against local anvil (Playwright)
- `playwright.config.js` + specs: connect (mock wallet), swap through modal, add position, remove position,
  explore-with-indexer smoke; script `npm run e2e` that expects `./dev.sh` running. If browsers cannot be
  downloaded in this environment, the step is reported as "config added, run in CI" — plainly, not skipped
  silently.
- Files: `playwright.config.js`, `e2e/*.spec.js`, `package.json`.
- Verify: `npm run e2e` (or state plainly why not). Rollback: revert.

### S25 — Scripts and CI refresh
- `setup.sh`/`dev.sh`/`export-abis.sh`: detect `python3` → fall back to `py` (Windows) with a clear error
  otherwise; CI (`Swapex--main/.github/workflows/ci.yml`) gets the final command set; add an indexer
  workflow (node matrix, `npm ci && npm test && npm run typecheck`); ensure the contracts CI unchanged.
- Files: `setup.sh`, `dev.sh`, `swapex-contracts/scripts/export-abis.sh`, workflow files,
  `swapex-indexer` workflow (new).
- Verify: run the scripts end-to-end on this machine (`./setup.sh`, `./dev.sh` through the swap check).
- Note: shell changes are only `python3`/`py` detection — no behavior change.

### S26 — Docs close-out
- Update root `README.md`/`AGENTS.md` if any command changed; add `format` script (prettier, no new config);
  write `docs/STATUS.md` (what works, how verified, what was not verified, known limits, next three steps —
  per the owner's reporting rule).
- Files: `README.md`, `AGENTS.md` (only if needed), `Swapex--main/package.json`, `docs/STATUS.md`.
- Verify: standard block one last time.

---

## Optional steps — do only after the owner says yes

- **O1 — viem + wagmi migration** (replaces ethers v5 + web3-react v6; reason: v6 unmaintained, WalletConnect
  v1 dead, axios advisory chain). Sequenced last, in its own small steps: wagmi config + connectors →
  adapter ports (one file per commit) → hooks → remove ethers/web3-react. NetworkGuard behavior and
  CONFIG_ERROR checks preserved. Every step keeps the standard block green.
- **O2 — Strict CSP without `'unsafe-inline'`** (nonce-based headers per request; Next pages-router needs a
  custom server or middleware — scope change, owner call).
- **O3 — Limit orders** (contract + keeper + UI, per `prompts/01-next-phase.md` §4) — contract work,
  needs explicit owner approval; until then `/limit` stays the honest disabled screen.

## What will never be done without the owner

- Contract edits of any kind (gaps are documented, UI degrades).
- License change; Uniswap names/assets/code; mainnet enablement; removal of the testnet guard.
- Weakening or skipping any test, or relaxing `npm audit --audit-level=high` in CI.
