import { defineConfig } from 'vitest/config'

// Default suite: fast unit + API tests only. The chain integration test lives in
// its own config because it starts anvil and runs the contracts e2e script.
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/integration.test.ts'],
  },
})
