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


## 2026-10-19 - Indexer <-> chain integration test (prompt section 1, last item)

- **Decision:** `swapex-indexer/tests/integration.test.ts` starts a fresh anvil on its own free
  port (foundry from `~/.foundry/bin`, prepended to PATH), runs
  `swapex-contracts/scripts/e2e-local.sh` (deploy + seed + two swaps), runs this package's own
  pipeline (`openDb` / `runOnce` / `buildServer`, wired exactly as `src/index.ts` wires it)
  against a temp database, serves the API on an ephemeral port and asserts it against the chain:
  health + cursor == head, pool set, token0/token1/fee/slot0/liquidity, swap history, volume,
  fees, txCount24h, reserves, candle sums, token metadata, the stable-reference USD price rule,
  TVL, position ownership via `ownerOf`, and the 400/404 validation paths.
- **Independent ledger check:** for both tokens of every pool the API reserves are cross-checked
  against `balanceOf(pool) == sum(Mint) - sum(Collect) + signed sum(Swap)` - Burn only marks
  amounts owed, so nothing leaves a pool until collect. A missed or double-counted event fails here.
- **Gating (why it is not in `npm test`):** the test needs foundry, Git Bash and a local chain -
  the same class of requirement as the Playwright suite. `vitest.config.ts` excludes it from the
  default run (still 40 tests); `npm run test:integration` uses `vitest.integration.config.ts`
  (300s hook/test timeouts, single file).
- **Fix on the way:** `swapex-contracts/scripts/e2e-local.sh` resolved `python3` directly, which is
  the dead Windows App Execution alias on this machine; it now uses the same run-it-to-verify
  `python3` -> `py` detection as `setup.sh`/`dev.sh`, so the script actually runs on Windows.
- **Verified by running:** `npm run test:integration` 8 passed (~15s); `npm test` 40 passed;
  `tsc --noEmit` exit 0; the e2e deploy regenerated `deployments/31337.json` identical to HEAD.
- **Reversal:** delete the two vitest configs, the test file and the package script; the
  `e2e-local.sh` python fix should stay either way.

## 2026-10-19 - Limit-order contract + test suite (planned C1)

- **Decision (shape):** `src/periphery/SwapexLimitOrders.sol` matches prompt section 4:
  EIP-712 `Order(maker, tokenIn, tokenOut, amountIn, minAmountOut, expiry, nonce, receiver)`
  with `chainId + verifyingContract` domain, anyone-may-fill, partial fills with a pro-rata
  floor (`mulDiv(minAmountOut, totalFilled, amountIn)`, rounded down), cancel by maker nonce,
  ERC-1271 via OpenZeppelin `SignatureChecker` (fresh install at `lib/openzeppelin-contracts`,
  remapping added to `remappings.txt`), `nonReentrant` on `fill`, zero custody (input pulled
  and swapped inside one call; the pool pays `receiver` directly).
- **Decision (TransferHelper):** `safeTransfer`/`safeTransferFrom` now *bubble* a token's own
  revert data instead of overwriting it with `TransferFailed`; only a bare revert or a
  `false` return still maps to `TransferFailed`. Rationale: `TransferHelper` was masking
  nested causes (e.g. the contract's own `Reentrancy()` from a hostile token's callback),
  which makes the guard untestable and token errors undebuggable. No test or UI contract
  depended on the masked form: `TransferFailed` remains in every ABI and still fires for the
  false/bare cases (web `lib/errors.js` keeps its entry).
- **Decision (fuzz floor buffer):** `testFuzz_partialFillsMeetTheProRataFloor` uses a
  realistic 0.1% maker buffer instead of `minAmountOut = quote` (exact). Measured on this
  pool (temporary probe, removed): quoter quote for a full trade equals a *single* execution
  exactly, but a *split* execution lands 1 wei less (intermediate sqrtPrice rounding), so a
  zero-buffer order's cumulative floor is unreachable after a chunked fill and the order
  strands. The contract stays strict (never delivers less than `minAmountOut` pro-rata -
  that is the maker's guarantee); a zero-buffer order being fragile is honest AMM rounding,
  so the UI (C4) must sign orders with a buffer.
- **Test expectations that encode real contract semantics** (do not "fix" these back):
  `fill` checks expiry *before* the filler deadline, and `OrderAlreadyFilled` *before*
  `InvalidSignature` (state-then-sig order); the EVM `ecrecover` precompile accepts
  high-s signatures (protocol-level malleability is real - OZ's low-s check is the defense);
  Solidity memory struct assignment aliases, so malformed-order cases rebuild the struct
  per case; `TransferHelper` bubbling as above.
- **Slither: clean-or-justified.** Run: `slither . --exclude-dependencies` (slither 0.11.6).
  Repo baseline: 97 findings / 39 contracts (13 High; the 5 non-limit-orders Highs are
  pre-existing in `PeripheryBase`/`FullMath`, untouched). `SwapexLimitOrders` findings,
  all reviewed: `arbitrary-send-erc20` (High/High) - false positive: the `from` is the
  EIP-712 signer, authorized at line 190 before any transfer, and the maker's ERC-20
  allowance is required; `reentrancy-balance` x7 (High/Medium) - external calls sit between
  balance reads, but the whole `fill` runs under `nonReentrant` and
  `test_reentrancyDuringTransferIsBlocked` proves a nested `fill` reverts with `Reentrancy()`;
  tests also assert the contract holds zero balance after every fill; `incorrect-equality`
  (Medium/High) - the `current == value` check in `_approve` is a redundant-approve
  short-circuit, a gas optimization rather than an invariant; `reentrancy-no-eth` (Medium) -
  the contract has no ETH paths and is nonReentrant anyway; `timestamp` x2 (Low) -
  expiry/deadline semantics are inherently block-based, +/-1 block is acceptable for orders;
  informational (`assembly`, `DOMAIN_SEPARATOR` naming, low-level calls, complexity, pragma)
  are intended as written.
- **Verified by running:** `forge test` 104/104 (80 baseline + 24 new); the previously
  failing fuzz seed with `--fuzz-runs 5000` green; full limit suite at `--fuzz-runs 5000`
  green; `forge fmt` clean for the C1 files (the 15 remaining `--check` diffs are
  pre-existing files, left untouched); `slither . --exclude-dependencies` runs and exits
  with the justified set above.
- **Reversal:** delete `SwapexLimitOrders.sol`, the mocks and `LimitOrders.t.sol`, revert
  `remappings.txt` + `TransferHelper.sol`, and drop this entry's buffer rule with the UI.

## 2026-10-19 - Limit-order wiring: deploy, manifests, ABIs, e2e (planned C2)

- **Decision:** `script/Deploy.s.sol` deploys `SwapexLimitOrders` (bound to the router) as the
  last contract and writes `limitOrders` + `limitOrdersCodehash` into `deployments/<id>.json`;
  `scripts/export-abis.sh` exports `SwapexLimitOrders.json` alongside the other ABIs. The
  CREATE-order prefix is preserved, so the first four addresses stay exactly as before and the
  new contract is a deterministic fifth; only the seed tokens shift one deployer nonce (both
  local manifests are gitignored dev artifacts and regenerate on every `dev.sh`/e2e run - the
  tracked file is the web's exported copy, which was regenerated to match).
- **Decision:** local e2e covers the limit-order round trip in a new `script/E2ELimitOrder.s.sol`
  wired into `scripts/e2e-local.sh`: chain-id guard (`31337` only), anvil public dev keys only,
  maker signs the EIP-712 order (quoter price minus the 0.1% buffer from the C1 decision), the
  keeper fills 60% then the remainder, and the script asserts the filled amounts, the stored
  state, the maker's floor, both balance deltas, zero contract custody and `canFill == false`.
  The order is 10e6 tUSDC (~$10): a first attempt at 1000e6 failed honestly with
  `InsufficientLiquidity()` because the seeded pool carries only ~$120 of the other side - the
  e2e amount must fit the seed.
- **Fixes on the way:** `scripts/e2e-positions.sh` called `python3` directly and died on the
  dead Windows App Execution alias; it now uses the same run-to-verify `python3` -> `py`
  detection as the other scripts. `scripts/e2e-local.sh`'s EXIT trap gained a `taskkill`
  fallback because a Windows anvil once survived `kill`, and a surviving node makes the next
  run *reuse* its state, so deployment addresses drift and the exported web manifest stops
  matching the local one (found by diffing the two manifests).
- **Verified by running:** `scripts/e2e-local.sh` (deploy + seed + swaps + limit-order round
  trip -> OK) and `scripts/e2e-positions.sh` (mint/decrease/collect/unwrap/burn -> OK) on one
  fresh node; no anvil process left after the run; `scripts/export-abis.sh ../Swapex--main`
  then manifest diff: `limitOrders` and token addresses match local; `forge test` 104/104;
  web `npm test` 150/150, `npm run lint` 0 errors (16 pre-existing warnings).
- **Reversal:** remove the deploy/log/manifest lines, the ABI spec line, the e2e script +
  its `e2e-local.sh` call, and revert the two script fixes.

## 2026-10-20 - Indexer limit orders: submit API, event-derived state, keeper (planned C3)

- **Decision:** the indexer stores submitted limit orders and derives everything else from
  events. New `src/eip712.ts` (shared order types/domain + ERC-1271 ABI), an `orders`
  table keyed by the EIP-712 hash (the payload is fully determined by the hash; the fee
  tier is the only unsigned field, so the only conflict possible is the same hash under a
  different fee -> 409), and `OrderFilled`/`OrderCancelled` fragments in `ALL_EVENTS` with
  `manifest.limitOrders` added to the indexer's known address set. `POST /orders`
  re-verifies everything the contract would check against *this* chain: payload shape,
  contract field rules in contract order (expiry before signature, so an expired order
  never consumes signature work), the EIP-712 hash computed server-side and verified as
  the maker EOA (viem `verifyTypedData`), then ERC-1271 for contract makers when an RPC
  client is wired, plus - with a live client - on-chain `orders`/`cancelled` state
  (already-filled / already-cancelled -> 409) and a pool-exists-for-pair+fee check (400).
  `GET /orders` returns stored rows decorated with fill/cancel/expiry state computed from
  events at read time, so status reorgs away with the events instead of living in a
  denormalized column. `limitOrders` is an optional manifest field: older manifests still
  load, and the orders endpoints then honestly report 503 (POST) / empty (GET).
- **Decision:** `scripts/keeper-limit.sh` closes the loop: it polls
  `GET /orders?status=open`, fills each order's remaining amount with `cast send`
  (FillParams floor = 0 - the contract itself enforces the maker's signed floor across
  fills, as `e2e-local.sh` proves), isolates per-order failures so one bad order does not
  stop the pass, and supports a `WATCH` seconds loop for a long-running bot.
- **Fix on the way:** viem caches `getBlockNumber()` by default - a head read taken after
  the keeper's receipt still returned the pre-tx value, so cursor-equality made catch-up
  loops declare "caught up" while the fill's block was skipped. Found as an empty
  `status=filled` response with the fill already final on chain; proven stale by an
  `eth_blockNumber` vs `getBlockNumber({cacheTime: 0})` experiment on a scratch anvil;
  fixed with `cacheTime: 0` on `createChainClient` (the daemon path) and the integration
  test's client.
- **Verified by running:** `npm run typecheck`; `npm test` 63/63 across 9 files (23 new:
  submit validation/EOA/ERC-1271/chain-state stubs, aggregation + reorg rollback,
  fragment round trips); `npm run test:integration` 9/9 on a fresh anvil with
  `e2e-local.sh`: POST the signed order (server hash == viem hash == contract
  `orderHash`), the keeper script fills it, reindex -> `status=filled` with amounts equal
  to chain `orders()`, re-POST -> 409, a second order cancelled on chain ->
  `status=cancelled`, no open orders left.
- **Reversal:** drop the two routes, `eip712.ts`, `aggregate/orders.ts`, the orders table
  and its functions, the keeper script and the `limitOrders` known-address line; the
  `cacheTime: 0` fix should survive any reversal.


## 2026-10-20 - viem + wagmi v2 migration finished: wallet-first transport, named multi-output reads (prompt section 5)

- **Decision:** the web app now runs on wagmi v2 + viem; ethers v5 / web3-react are gone.
  `Web3Context` wraps `WagmiProvider` + react-query and exposes `clients = { public, wallet,
  account }` (the replacement for ethers' `library`), null until connected. All chain I/0
  goes through `lib/contracts/*` adapters: viem `readContract` for reads, `writeContract`
  for writes (tx hash back), non-view quoter functions through plain `eth_call` exactly like
  the old `callStatic`. Chains/connectors come from `lib/config`; the required chain is
  first so wagmi's default matches the app's target network.
- **Decision:** transports are wallet-first: `custom(window.ethereum)` when an injected
  provider exists, else `http(<chain rpc>)`. This restores the ethers-era semantics (every
  read went through the wallet provider) and keeps the production CSP tight - `connect-src`
  stays `'self' https: wss:` with no http RPC exception, because wallet-provided reads are
  same-origin to the page. Direct `http://127.0.0.1:8545` reads from the bundle were blocked
  by that CSP, which is why the browser e2e quote/reads were silent no-ops before this
  change; the e2e shim's `/__e2e-rpc` proxy (same-origin) carries them instead.
- **Fix:** viem's `decodeFunctionResult` returns a *plain array* for functions with more
  than one output - the ABI's output names are dropped (ethers' `Result` kept them). After
  the migration `r.amountOut` / `r.gasEstimate` (quoter, 4 outputs) and `s0.sqrtPriceX96`
  (pool `slot0`, 4 outputs) were `undefined`: the confirm modal rendered empty amount rows
  with `n/a` impact/fee, and confirming threw on `amountOutMinimum: null` before any RPC -
  surfacing only as a `role="alert"` error toast, invisible to the spec's `role="status"`
  assertion, so the test failed with no visible reason. `readNamed` in
  `lib/contracts/client.js` re-attaches the ABI output names for multi-output reads (the
  quoter's four functions + `slot0`); single-output reads and tuple results (viem already
  decodes named tuples to objects, e.g. PM `positions`) pass through untouched. Three
  regression tests in `tests/contracts.test.js` encode/decode through viem's real path, so
  mocks can never mask this class of bug again.
- **Decision:** local transports set `retryCount: 0`: a `PoolNotFound` revert for a fee
  tier that does not exist is a valid answer, not a transient failure - the default 3
  retries tripled every quote's RPC traffic (wagmi's own wallet transport disables retries
  the same way). Unit-test fixtures caught up with viem (`parseGwei` instead of
  `parseUnits(v,'gwei')`, bigint liquidity in the PositionsList fixture).
- **Verified by running:** web - `npm run lint` (0 errors, 16 pre-existing warnings),
  `npm test` 153/153 across 16 files (+3 `readNamed`), `npm run build` (13 pages),
  `npm run e2e` 5/5 against the local stack (anvil + deploy/seed + export-abis + indexer +
  web built with `NEXT_PUBLIC_CHAIN_ID=31337` / `NEXT_PUBLIC_INDEXER_URL=http://localhost:4000`);
  indexer - `npm test` 63/63, `npm run typecheck`, `npm run test:integration` 9/9.
- **Reversal:** drop `readNamed` at the adapter call sites and the multi-output reads break
  silently again (undefined fields, no thrown error) - keep the three regression tests
  either way; revert `lib/wagmi.js` transports to `http()`-only and browser reads of an
  http RPC need a dev-only CSP exception once more (the e2e shim's wallet path keeps
  working regardless).

## 2026-10-22 - /limit order entry UI, root CI for the swapex projects, gitleaks (prompt section 6)

- **Decision:** `/limit` becomes a real screen (owner gate **O3** lifted by the phase
  prompt). `components/LimitOrderForm.js` + `components/LimitOrdersTable.js` on
  `pages/limit.js`, gated by `getFeatures().limit` (`deployment + indexer + limitOrders
  manifest`); ERC-20 tokens only (the contract fills with `transferFrom`, NATIVE is never
  offered), explicit approve-then-place (exact `amountIn` to the limit contract), EIP-712
  `SwapexLimitOrders/1` signing through the wallet transport, `POST /orders`, cancel via
  on-chain `cancel(nonce)` with the tx hash shown. Orders list = `GET /orders` with the
  indexer's decorated status; honest "indexer not connected" / error / empty states.
  Unfilled `minAmountOut` comes from `minAmountOutFor` in `lib/limitOrders.js` (the
  mirror of the contract math), with "Use market" pulling the quoter through `eth_call`.
- **Decision:** effects never set state synchronously (React 19 lint rule): derived-at-
  render keys (`poolInfo.key`, `allowanceInfo.key`, tab derived from `account` +
  selection) plus `Promise.resolve().then(...)` deferral for the load calls - the same
  pattern `useTokenBalance` already used. The one flaky unit test (nonce uniqueness with
  `Math.random()`, birthday-collision odds ~50% in a 1e6 space) was made deterministic
  by sampling the random tail positionally instead of weakening the assertion.
- **Decision:** CI now covers the active workspace: `.github/workflows/ci.yml` gained
  `swapex-contracts` (install pinned forge-std + OZ `@v5.2.0` - local lib verified
  byte-identical to v5.2.0 after CRLF normalization, build/reproducibility diff, sizes
  gate passes as-is, `forge test`, 5000-run `LimitOrdersTest` fuzz, the Python reference
  models `reference/check_refmath.py` + `check_pool.py`), `swapex-web` (node 24 = the
  locally verified version, npm ci, SBOM artifact, lint, vitest, build, prod audit gate),
  `swapex-indexer` (node 24, npm ci, vitest, `tsc --noEmit`, and `test:integration` which
  spawns its own anvil), plus workflow-wide `permissions: contents: read` + `concurrency`,
  with `pull-requests: write` widened only on the gitleaks job. The legacy `web` /
  `contracts` jobs (root `apps/web` + `contracts/`) are untouched. Still executed on
  GitHub only after a push - every step's command was verified locally first.
- **Decision:** `.gitleaks.toml` at the repo root: default rules plus a 6-regex allowlist
  for the two public Anvil test keys (AGENTS.md rule 1 sanctions them in local scripts)
  and four public token addresses the entropy rule misread as API keys. gitleaks 8.30.1
  over all 103 commits: 18 raw findings, all six allowlisted values, 0 findings with
  `--exit-code=1`. CI runs `gitleaks/gitleaks-action` pinned to v3.0.0's commit SHA
  (Node 24 runtime; personal account needs no license; `GITLEAKS_CONFIG` set explicitly).
- **Decision:** the staged `.github` dirs the old STATUS called an owner decision are
  removed now that the root workflow exists: `.github/worflows/` (9 dead typo-dir
  example files), `swapex/{Swapex--main,swapex-contracts,swapex-indexer}/.github/`
  (workflows GitHub never reads; templates already present at root; the two CODEOWNERS
  were `@YOUR_GITHUB_USER` placeholders on paths that do not exist). Their useful bits
  (permissions/concurrency, reference-model step, prod audit gate, node 24) were folded
  into the root workflow; everything deleted stays recoverable from git history.
- **Verified by running:** web - `npm run lint` 0 errors (17 pre-existing `<img>`
  warnings), `npm test` 190/190 across 19 files (4 consecutive runs, the fixed nonce test
  included), plain `npm run build` and the local-env build (13 pages), `npm run e2e` 6/6
  including `limitOrder.spec.js` (place -> approve -> sign -> POST -> cancel -> decorated
  `cancelled` row) against the running stack; gitleaks - full-history scan clean with
  the new config; `forge build --sizes` all contracts in margin (largest SwapexFactory
  18,374 B); reference models exit 0; `npm audit --omit=dev --audit-level=high` exit 0;
  workflow YAML parses (6 jobs) with actions/checkout@v4.4.0 + setup-node@v4.4.0 +
  foundry-toolchain@v1.9.1 + upload-artifact@v4.6.2 + gitleaks-action@v3.0.0 SHAs.
  Vercel provenance closed: commit status `Vercel: success` on `e7d976e`
  (dpl_Lh6Y5tsgSFgCMUNigZfGzJ9X2bU7, alias swapex-zeta.vercel.app); the root
  `vercel-build` script builds `swapex/Swapex--main` and serves it from `.next`, so
  production runs the migrated app.
- **Reversal:** move the four jobs back out of the root workflow and the active
  workspace is invisible to CI again (the exact gap section 6 called out); drop the
  `.gitleaks.toml` allowlist and CI goes red on the two public Anvil keys that AGENTS.md
  explicitly permits; delete the deferred-effect pattern and the React 19 lint rule
  flags the synchronous `setState` through any function the effect calls.
