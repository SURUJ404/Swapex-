const isProd = process.env.NODE_ENV === 'production'

// Content-Security-Policy. Next.js needs inline scripts/styles; dev mode also needs eval.
// connect-src is broad (https/wss) because wallets and RPC providers vary: tighten it to your
// own RPC and WalletConnect hosts once they are fixed.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProd ? '' : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  // local anvil is plain http, so allow it in development only
  `connect-src 'self' https: wss:${isProd ? '' : ' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*'}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ')

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
]

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async redirects() {
    // the old V2 screens: liquidity now lives under /pool (positions) and /add (new position)
    return [
      { source: '/remove', destination: '/pool', permanent: false },
      { source: '/create', destination: '/add', permanent: false },
    ]
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }]
  },
}

export default nextConfig
