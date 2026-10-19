# Swapex status

Close-out snapshot of the migration plan (S1-S26), 2026-10-19. Per-step detail is in
[`DECISIONS.md`](DECISIONS.md); web UI coverage is in
[`../Swapex--main/docs/UI_PARITY.md`](../Swapex--main/docs/UI_PARITY.md); standing agent
rules are in [`../AGENTS.md`](../AGENTS.md).

## What works

- **Contracts** (Foundry, testnet-only): concentrated-liquidity `SwapexPool`/`SwapexFactory`,
  `SwapexRouter` (reverts `PartialFill`/`InsufficientLiquidity` instead of partial fills),
  `SwapexQuoter` (non-view, call with `eth_call`), `SwapexPositionManager` (ERC-721 shares,
  pool position key `keccak(owner, tickLower, tickUpper)`), deploy + seed scripts, custom
  errors decoded in the web app.
- **Web app** (`Swapex--main/`, Next.js pages router): swap with on-chain quoting and
  impact-gated confirm modal, add/remove liquidity positions, explore tables (tokens and
  pools from the indexer), injected-wallet connect, testnet/local network guard, honest
  empty/error/not-connected states everywhere (no fake data), toasts and aria roles.
  Contract access is layered behind `lib/contracts` (layering guard: no `new Contract(`
  outside it).
- **Indexer** (`swapex-indexer/`): log sync into SQLite with reorg depth and candles,
  REST API (health, tokens, pools, candles) with a CORS allowlist and rate limit, config
  validated with zod, deployment manifest read from `../swapex-contracts/deployments/`.
- **Scripts**: `setup.sh` (tool checks, forge tests, ABI sync, web + indexer tests),
  `dev.sh` (anvil, deploy, seed, ABI export, web app), `export-abis.sh` (ABIs + manifests;
  `python3` with `py` fallback, each candidate verified by running it).
- **Tests**: contracts forge suite 80/80, web vitest 150 (node + component), Playwright
  browser e2e 5 specs against the local stack, indexer vitest 40 + `tsc --noEmit`.

## How verified (on this machine, 2026-10-19)

- `./setup.sh` end-to-end exit 0 (Git Bash; forge 80/80, ABI sync, web 150 tests,
  indexer 40 tests).
- `./dev.sh` from a clean slate: fresh canonical anvil deploy (regenerated
  `lib/deployments/31337.json` identical to HEAD), `next dev` serving on :3000, fresh
  indexer synced to the new chain (cursor 4), and the swap e2e spec passed against that
  stack.
- `npm run e2e` 5/5 (connect, swap, add position, remove position, explore) - twice on
  reused state and twice on a fully fresh canonical stack.
- Web: `npm test` 150 passed, `npm run lint` 0 errors (16 pre-existing `<img>` warnings),
  plain `npm run build` and the local-env build both succeed.
- Indexer: `npm test` 40 passed, `npm run typecheck` exit 0.
- Web CI command set run locally: `npm ci`, lint, test, build,
  `npm audit --omit=dev --audit-level=high`.

## What was not verified

- **GitHub Actions execution**: the per-package workflows (web, contracts, new indexer
  matrix) live under `swapex/*/.github/workflows/`, which GitHub does not scan - only the
  repo root `.github/workflows/` runs, and that one targets the legacy root-level
  `apps/web` + `contracts/` layout. Every CI job's commands were run locally instead;
  re-placing the workflows is an owner decision (noted in `DECISIONS.md`).
- **Real wallets**: e2e uses an injected `window.ethereum` shim against anvil's unlocked
  accounts; no MetaMask extension or WalletConnect session was exercised here.
- **Non-local networks**: everything ran against local anvil (chain id 31337); no external
  testnet RPC or deployment was used. Mainnet is refused by design.
- **Contract shell e2e scripts**: `swapex-contracts/scripts/e2e-local.sh` and
  `e2e-positions.sh` were not re-run during this close-out (they deploy against a node;
  run them with the dev stack stopped).
- **Browsers/form factors**: chromium only, desktop viewport; no Firefox/WebKit, mobile
  or visual regression runs.
- Playwright e2e is not wired into CI (it needs anvil + forge + indexer + a built app).

## Known limits

- Web stack is still ethers v5 + web3-react v6 (migration is owner-gated **O1**).
- CSP still allows `'unsafe-inline'`; strict nonce-based CSP is owner-gated **O2**.
- `/limit` order entry stays an honest disabled screen; limit orders on the contracts are
  owner-gated **O3**.
- `Swapex--main` still ships the in-repo `ERC721Minimal.sol`; it must be replaced by a
  reviewed library before any real-value use (see `AGENTS.md` known facts).
- A full `npm audit` (dev tooling included) still reports advisories; the CI gate covers
  production dependencies only (`--omit=dev --audit-level=high`), as agreed in S1.
- ABI/deployment exports are text files whose CRLF/LF noise normalizes on `git add`.

## Next three steps

1. **O1 - viem + wagmi migration** (replace ethers v5 + web3-react v6), sequenced small,
   every step keeping the standard block green - needs the owner's yes.
2. **O2 - strict CSP without `'unsafe-inline'`** (nonce-based headers per request) -
   needs the owner's yes.
3. **O3 - limit orders UI** backed by the existing contracts (until then `/limit` stays
   the disabled screen) - needs the owner's yes.

Smaller candidates already flagged as owner decisions: let the GitHub workflows actually
execute (repo-root placement) and wire the Playwright suite into CI.
