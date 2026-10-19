import { defineConfig, devices } from '@playwright/test'

// Browser E2E against the local dev stack. Expects `./dev.sh` (or the manual
// equivalent) already running: anvil on :8545, indexer on :4000, and the web
// app built with NEXT_PUBLIC_CHAIN_ID=31337 + NEXT_PUBLIC_INDEXER_URL on :3000.
// Each spec's global-setup style check lives in e2e/support.js so failures
// name the missing service instead of timing out silently.
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1, // shared local chain state: keep runs deterministic
  retries: 0,
  reporter: [['list']],
  use: {
    // localhost (not 127.0.0.1): the indexer's default CORS allowlist is
  // http://localhost:3000, and the browser must be able to read /api responses
  baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
