import { defineConfig } from 'vitest/config'

// Chain integration suite: starts anvil, runs swapex-contracts/scripts/e2e-local.sh
// and asserts the HTTP API against on-chain state. Run with `npm run test:integration`.
export default defineConfig({
  test: {
    include: ['tests/integration.test.ts'],
    testTimeout: 300000,
    hookTimeout: 300000,
    fileParallelism: false,
  },
})
