import { defineConfig } from 'vitest/config'

// JSX lives in .js files (matching the Next.js app convention), so the esbuild
// loader must be told to parse .js as jsx — Vite's default `js` loader rejects
// JSX. Two projects: logic tests run in plain node (fast, no DOM); component
// tests under tests/components/ get jsdom. Inline projects do not inherit
// root-level Vite options, so the esbuild override is repeated per project.
const jsxInJs = {
  esbuild: {
    jsx: 'automatic',
    loader: 'jsx',
    include: /\.[jt]sx?$/,
    exclude: /node_modules/,
  },
}

export default defineConfig({
  test: {
    projects: [
      {
        ...jsxInJs,
        test: {
          name: 'node',
          include: ['tests/**/*.test.js'],
          exclude: ['tests/components/**'],
        },
      },
      {
        ...jsxInJs,
        test: {
          name: 'components',
          include: ['tests/components/**/*.test.js'],
          environment: 'jsdom',
        },
      },
    ],
  },
})
