# Running Swapex on testnets as an open-source project

Goal: anyone can read and run the code, nobody can lose real money, and no secret ever lands in git.

## 1. Keys and accounts
- [ ] Create a **fresh deployer account** used only for Swapex testnets. Fund it from faucets only.
- [ ] Keep the key in a Foundry keystore (`cast wallet import swapex-testnet-deployer --interactive`)
      or a hardware wallet. Deploy with `--account` / `--ledger`. Never put a key or mnemonic in `.env`,
      scripts, tests, CI, chat or screenshots.
- [ ] Never reuse a testnet key on mainnet, and never send mainnet funds to a testnet deployer.
- [ ] The factory owner is the deployer. That is fine on testnet. Before any mainnet use, move ownership
      to a multisig behind a timelock (`SwapexFactory.setOwner`).

## 2. What must never be committed
Private keys, mnemonics, keystore files, `.env*` (except `.env.example`), RPC URLs with embedded keys,
API tokens. `.gitignore` blocks the common files and `.gitleaks.toml` scans for the rest.
- [ ] Install the hook: `pip install pre-commit && pre-commit install`
- [ ] CI scans the full git history on every push (job `secrets`).
- If something leaks: **treat it as burned**. Rotate/replace it first, then (optionally) rewrite
  history with `git filter-repo`. Removing it from the latest commit does not remove it from history or forks.

## 3. Front end (public by design)
- Everything prefixed `NEXT_PUBLIC_` ships to the browser. Put only public values there.
- Use an RPC key restricted to your domain and to testnet chains in the provider dashboard, or a public RPC.
- The app defaults to Sepolia, refuses mainnet unless `NEXT_PUBLIC_ALLOW_MAINNET=true`, disables all
  actions on chains without Swapex contracts, and shows a testnet banner. Security headers (CSP,
  frame denial, nosniff, HSTS, referrer and permissions policy) are set in `next.config.mjs`.
- Tighten the CSP `connect-src` to your exact RPC / WalletConnect hosts once they are fixed.
- Token logos load from third-party URLs. For production, host them yourself.

## 4. Contracts
- `script/Deploy.s.sol` only runs on allow-listed testnets (and local anvil); `test/Deploy.t.sol` proves
  mainnets revert.
- CI runs build, all tests, the Python reference cross-check, and Slither (fails on medium and above).
- Only deploy commits whose CI is green. Record the commit hash with the deployment (`deployments/<chainId>.json`).
- State plainly in the README and the UI that the contracts are unaudited.

## 5. GitHub settings (do these once)
- [ ] Secret scanning and **push protection**: on.
- [ ] Private vulnerability reporting: on (Settings, Code security).
- [ ] Branch protection on `main`: PRs required, status checks (`test`, `slither`, `secrets`, `check`) required,
      code-owner review required, force-push and deletion blocked.
- [ ] 2FA for every maintainer; consider requiring signed commits.
- [ ] Dependabot alerts and updates: on (config included).
- [ ] Actions: restrict to GitHub-owned and verified creators; pin third-party actions to full commit SHAs
      (the workflows use version tags to stay readable; replace them with SHAs from each action's release page).
- [ ] Replace `@YOUR_GITHUB_USER` in `.github/CODEOWNERS` and the contact in `SECURITY.md`.

## 6. Threats worth keeping in mind (testnet)
| Threat | Mitigation here |
|---|---|
| Leaked deployer key | Burner account, keystore, scanning, rotate on leak |
| Phishing clones of the site | One canonical URL in the README; no mainnet mode; CSP |
| Malicious token (fee-on-transfer, reverting, reentrant) | Pool uses a reentrancy lock and balance-delta checks; add the quirk tests from Phase 1 |
| Price manipulation / oracle abuse | No on-chain oracle consumers yet; do not build lending on spot price |
| Supply-chain (npm / actions) | Lockfile, `npm ci`, `npm audit`, Dependabot, pinned actions |
| Users mistaking testnet for real | Banner, disclaimers, tokens without value |

## 7. Gates before any mainnet discussion
External audit with fixes verified, invariant and fuzz suites at high run counts, formal check of the
swap invariant, multisig + timelock ownership, a public bug bounty, monitoring and an incident runbook.
