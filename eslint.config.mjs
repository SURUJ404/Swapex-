import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

const eslintConfig = defineConfig([
  ...nextVitals,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Legacy Uniswap interface kept for reference; not part of the Next.js app.
    "src/**",
  ]),
  {
    rules: {
      // Data-fetching effects set loading/pending state on mount; acceptable here.
      "react-hooks/set-state-in-effect": "warn",
    },
  },
]);

export default eslintConfig;
