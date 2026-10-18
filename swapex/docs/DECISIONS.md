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
