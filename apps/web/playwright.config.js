import { defineConfig } from '@playwright/test';

// E2E typed-data signing against local anvil: a real Chromium page gets an injected EIP-1193
// wallet (e2e/wallet-shim.js) and signs/submit a Swapex PermitSingle through it. Prerequisites
// (see docs/TESTNET_SECURITY.md): anvil on 127.0.0.1:8545 with a current deployment, addresses
// matching constants/index.js. Next 16 allows only one dev server per project, so reuse an
// already-running `next dev` when present and only start one otherwise.
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  workers: 1, // one shared chain: tests pick fresh nonces but run serially
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3000',
  },
  webServer: {
    command: 'npx next dev',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
