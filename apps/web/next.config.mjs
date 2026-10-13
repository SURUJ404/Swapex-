/** @type {import('next').NextConfig} */

// Strict CSP + security headers (crypto G.3). Every source is 'self' plus the EXACT RPC and
// WalletConnect/Infura hosts the connectors use — no bare origin wildcards. The app loads no
// third-party scripts or stylesheets at all (token logos are self-hosted under public/ with
// content-hashed filenames; enforced by tests/externalResources.test.js), so script-src only
// has to cover Next.js' own inline bootstrap and dev tooling. 'unsafe-inline' for scripts and
// styles is required by Next.js and styled-components; a nonce-based CSP would remove it but
// needs per-request middleware — the tradeoff is recorded in docs/CRYPTO_DECISIONS.md (## G).
const connectSrc = [
  "'self'",
  'http://127.0.0.1:8545',
  'http://localhost:8545',
  'ws://127.0.0.1:8545',
  'ws://localhost:8545',
  'https://*.infura.io',
  'wss://*.infura.io',
  'https://*.walletconnect.com',
  'wss://*.walletconnect.com',
  'https://*.walletconnect.org',
  'wss://*.walletconnect.org',
  'https://bridge.walletconnect.org',
  'https://explorer-api.walletconnect.com',
  // dev-only: next dev hot-reload websocket (production builds don't open it)
  'ws://localhost:3000',
  'ws://127.0.0.1:3000',
].join(' ')

const csp = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src ${connectSrc}`,
].join('; ')

const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ]
  },
}

export default nextConfig
