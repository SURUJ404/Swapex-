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
