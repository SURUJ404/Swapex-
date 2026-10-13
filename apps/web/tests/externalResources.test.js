import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import nextConfig from '../next.config.mjs'
import { TOKEN_LIST } from '../constants/index.js'

// Crypto G.3: SRI for third-party scripts/styles, self-hosted token logos with content-hash
// filenames, and a strict CSP with a tightened connect-src. There are no third-party scripts
// or stylesheets to put SRI hashes on — this suite proves that stays true, and that the
// headers stay strict.

const WEB_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  'test-results',
  'playwright-report',
  '.merkle-build',
  '.git',
  'tests',
  'e2e',
  'scripts',
])

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(js|jsx|ts|tsx|mjs|css)$/.test(name)) out.push(full)
  }
  return out
}

describe('token logos are self-hosted with content-hash filenames', () => {
  it('every TOKEN_LIST logo is a local path and the file exists under public/', () => {
    expect(TOKEN_LIST.length).toBeGreaterThan(0)
    for (const token of TOKEN_LIST) {
      expect(token.logo.startsWith('/'), `${token.symbol} logo must be local`).toBe(true)
      const file = join(WEB_ROOT, 'public', token.logo)
      expect(statSync(file).isFile(), `${token.symbol}: ${token.logo}`).toBe(true)
    }
  })

  it('logo filenames carry a content hash (name.<8+ hex chars>.ext)', () => {
    for (const token of TOKEN_LIST) {
      expect(token.logo, token.symbol).toMatch(/^\/[\w-]+\/[\w-]+\.[0-9a-f]{8,64}\.(png|svg|jpg|webp)$/)
    }
  })
})

describe('Content-Security-Policy headers', () => {
  const cspValue = async () => {
    const routes = await nextConfig.headers()
    const entry = routes.flatMap((r) => r.headers).find((h) => h.key === 'Content-Security-Policy')
    expect(entry, 'CSP header missing from next.config.mjs').toBeTruthy()
    return entry.value
  }

  it('locks down framing, objects, base URIs and form posts', async () => {
    const csp = await cspValue()
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("base-uri 'self'")
    expect(csp).toContain("form-action 'self'")
  })

  it('connect-src names the real RPC and WalletConnect hosts, with only host-scoped wildcards', async () => {
    const csp = await cspValue()
    const connect = csp.split('; ').find((d) => d.startsWith('connect-src'))
    expect(connect).toBeTruthy()
    expect(connect).toContain('http://127.0.0.1:8545')
    expect(connect).toContain('https://*.walletconnect.com')
    // a wildcard may never stand alone as an origin — it must be scoped to a named host
    const wildcards = connect.split(' ').filter((s) => s.includes('*'))
    for (const w of wildcards) {
      const host = w.split('://')[1] || w
      expect(host, w).toMatch(/^\*\.[a-z0-9.-]+\.[a-z]{2,}$/i)
    }
  })

  it('ships nosniff, frame-deny and a strict referrer policy alongside the CSP', async () => {
    const routes = await nextConfig.headers()
    const all = routes.flatMap((r) => r.headers)
    expect(all.find((h) => h.key === 'X-Content-Type-Options')?.value).toBe('nosniff')
    expect(all.find((h) => h.key === 'X-Frame-Options')?.value).toBe('DENY')
    expect(all.find((h) => h.key === 'Referrer-Policy')?.value).toBe('strict-origin-when-cross-origin')
  })
})

describe('no third-party scripts or stylesheets (nothing for SRI to hash)', () => {
  const files = walk(WEB_ROOT)

  it('no shipped source loads a script or stylesheet from another origin', () => {
    const offenders = []
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      if (/<script[^>]+src=["']https?:/i.test(source) || /<link[^>]+href=["']https?:[^"']*(css|style)/i.test(source)) {
        offenders.push(file.slice(WEB_ROOT.length + 1))
      }
    }
    expect(offenders).toEqual([])
  })

  it('CSS imports nothing from the network', () => {
    for (const file of files.filter((f) => f.endsWith('.css'))) {
      const source = readFileSync(file, 'utf8')
      expect(source, file).not.toMatch(/@import\s+url\(\s*["']?https?:/i)
      expect(source, file).not.toMatch(/url\(\s*["']?https?:/i)
    }
  })
})
