# Swapex status

Close-out snapshot of the migration plan (S1-S26) plus the phase-2 gap closure
(prompt sections 4-6), 2026-10-22. Per-step detail is in
[`DECISIONS.md`](DECISIONS.md); web UI coverage is in
[`../Swapex--main/docs/UI_PARITY.md`](../Swapex--main/docs/UI_PARITY.md); standing agent
rules are in [`../AGENTS.md`](../AGENTS.md).

## What works

- **Contracts** (Foundry, testnet-only): concentrated-liquidity `SwapexPool`/`SwapexFactory`,
  `SwapexRouter` (reverts `PartialFill`/`InsufficientLiquidity` instead of partial fills),
  `SwapexQuoter` (non-view, call with `eth_call`), `SwapexPositionManager` (ERC-721 shares,
  pool position key `keccak(owner, tickLower, tickUpper)`), `SwapexLimitOrders` (EIP-712
  orders verified with OpenZeppelin `SignatureChecker`, cancel by nonce, keeper script),
  deploy + seed scripts, custom errors decoded in the web app, and independent Python
  reference models (`reference/check_refmath.py`, `reference/check_pool.py`) that must
  keep agreeing with the Solidity.
- **Web app** (`Swapex--main/`, Next.js pages router, **viem + wagmi v2** - the old
  ethers v5 + web3-react stack is gone): swap with on-chain quoting and impact-gated
  confirm modal, add/remove liquidity positions, explore tables (tokens and pools from
  the indexer), injected-wallet connect, testnet/local network guard, honest
  empty/error/not-connected states everywhere (no fake data), toasts and aria roles.
  `/limit` is a real screen: ERC-20 pair, amount + limit price ("Use market" pulls the
  quoter), duration presets, approve-then-place, EIP-712 signing through the wallet,
  my/open orders tabs with live status, cancel by nonce with the tx hash shown, and a
  fee-on-transfer notice (the token import modal warns about transfer fees too).
  Contract access is layered behind `lib/contracts` (layering guard: no `new Contract(`
  outside it).
- **Indexer** (`swapex-indexer/`): log sync into SQLite with reorg depth and candles,
  REST API (health, tokens, pools, candles, **orders**) with a CORS allowlist and rate
  limit, EIP-712 order verification on submit, event-derived order status
  (`open|filled|cancelled|expired`), config validated with zod, deployment manifest read
  from `../swapex-contracts/deployments/`.
- **Scripts**: `setup.sh` (tool checks, forge tests, ABI sync, web + indexer tests),
  `dev.sh` (anvil, deploy, seed, ABI export, web app), `export-abis.sh` (ABIs + manifests;
  `python3` with `py` fallback, each candidate verified by running it),
  `swapex-contracts/scripts/keeper-limit.sh` (fills settled orders).
- **CI** (repo-root `.github/workflows/ci.yml`, every action pinned to a commit SHA with
  the tag in a comment): legacy `web` + `contracts` jobs for the root demo dirs, plus
  `swapex-contracts` (pinned deps, reproducibility diff, sizes gate, `forge test`, a
  5000-run limit-order fuzz, the Python reference models), `swapex-web` (node 24, SBOM
  artifact, lint, vitest, build, prod-dependency audit gate), `swapex-indexer`
  (node 24, vitest, `tsc --noEmit`, and the self-contained anvil integration suite), and
  `gitleaks` over the full history against `.gitleaks.toml` (public Anvil test keys and
  public token addresses allowlisted by value; 103 commits scan clean). Workflow-wide
  `permissions: contents: read` + `concurrency`; the gitleaks job widens
  `pull-requests: write` for PR annotations only.
- **Deployments**: Vercel serves the migrated app (root `vercel-build` compiles
  `swapex/Swapex--main`; commit status `Vercel: success` verified on `e7d976e`, alias
  swapex-zeta.vercel.app). Canonical manifests live in
  `swapex-contracts/deployments/` (31337 includes `limitOrders`); `export-abis.sh` copies
  per-chain manifests into `Swapex--main/lib/deployments/`, where Sepolia, Base Sepolia and
  Arbitrum Sepolia are honest not-deployed placeholders (empty addresses -> the app gates
  off those chains).
- **Tests**: contracts forge **104/104** (6 suites), web vitest **190** (19 files, node +
  component), Playwright browser e2e **6 specs** against the local stack (connect, swap,
  add position, remove position, explore, **limit order place + cancel**), indexer vitest
  **63** + integration **9** + `tsc --noEmit`.

## How verified (on this machine, 2026-10-22)

- Contracts: `forge test` 104 passed / 0 failed (6 suites); `forge build --sizes` every
  contract inside EIP-170 (largest `SwapexFactory` 18,374 B of 24,576); the two Python
  reference scripts exit 0 (`py -3`, Python 3.14.4).
- Web: `npm run lint` 0 errors (17 pre-existing `<img>` warnings); `npm test` 190 passed
  across 19 files (four consecutive runs after the deterministic-nonce fix, no flakes);
  plain `npm run build` and the local-env build both exit 0 (13 pages);
  `npm audit --omit=dev --audit-level=high` exit 0; `npm run e2e` **6/6** against the
  running stack (anvil + deploy/seed + export-abis + indexer + web built with
  `NEXT_PUBLIC_CHAIN_ID=31337` / `NEXT_PUBLIC_INDEXER_URL=http://localhost:4000`) -
  the new `limitOrder.spec.js` places an order (approve, sign, POST), cancels it, and
  asserts the decorated `cancelled` row within 15s.
- Indexer: `npm test` 63 passed (9 files), `npm run typecheck` exit 0,
  `npm run test:integration` 9 passed (fresh anvil + `e2e-local.sh` + API-vs-chain,
  including submit/fill/cancel order equality).
- Security: gitleaks 8.30.1 over all 103 commits - 18 raw findings that are exactly the
  two public Anvil keys (sanctioned by `AGENTS.md` rule 1) and four public token
  addresses; with `.gitleaks.toml`: 0 findings at `--exit-code=1`.
- CI wiring: the root workflow YAML parses (6 jobs, all step counts as written); every
  step's command was executed locally first (this file's list). The one thing never
  observed is GitHub actually executing the file - that lands on the next push.

## What was not verified

- **GitHub Actions execution**: the four new jobs (plus permissions/concurrency and the
  gitleaks job) are validated by a local command-for-command run and a YAML parse; the
  workflow file itself only executes on GitHub after a push (owner action).
- **Real wallets**: e2e uses an injected `window.ethereum` shim against anvil's unlocked
  accounts; no MetaMask extension or WalletConnect session was exercised here.
- **Non-local networks**: everything ran against local anvil (chain id 31337); no external
  testnet RPC or deployment was used. Mainnet is refused by design. The web ships honest
  not-deployed manifests for Sepolia (11155111), Base Sepolia (84532) and Arbitrum Sepolia
  (421614) — empty addresses, so `getDeployment()` returns null and the whole app gates off
  those chains until a real deploy + `export-abis.sh` run happens there.
- **Browsers/form factors**: chromium only, desktop viewport; no Firefox/WebKit, mobile
  or visual regression runs.
- Playwright e2e is not wired into CI (it needs anvil + forge + indexer + a built app);
  CI runs the unit/component suites and the indexer's self-spawning integration suite.

## Known limits

- CSP still allows `'unsafe-inline'`; strict nonce-based CSP is owner-gated **O2**.
- `Swapex--main` still ships the in-repo `ERC721Minimal.sol`; it must be replaced by a
  reviewed library before any real-value use (see `AGENTS.md` known facts).
- Limit orders fill only when someone runs the keeper (`scripts/keeper-limit.sh` or the
  integration test's filler); there is no scheduled/automated filler service yet.
- A full `npm audit` (dev tooling included) still reports advisories; the CI gate covers
  production dependencies only (`--omit=dev --audit-level=high`), as agreed in S1.
- ABI/deployment exports are text files whose CRLF/LF noise normalizes on `git add`.

## Next three steps

1. **Push this batch and watch the 6-job root CI run on GitHub** - every step command is
   already verified locally; the run itself is the last unverified link.
2. **O2 - strict CSP without `'unsafe-inline'`** (nonce-based headers per request) -
   needs the owner's yes.
3. **Automate limit-order filling** (scheduled keeper run or CI cron) so open orders
   settle without a manual script - needs the owner's yes on where it should live.

Smaller candidates already flagged: wire the Playwright suite into CI behind service
containers (anvil + indexer), and promote a scheduled gitleaks cron alongside the
push/PR scans.
