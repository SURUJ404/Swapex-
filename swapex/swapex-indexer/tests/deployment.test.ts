import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadManifest } from '../src/deployment'

const CHAIN = 31337
const dirs: string[] = []

const manifest = (extra: Record<string, unknown> = {}) => ({
  chainId: CHAIN,
  blockNumber: 0,
  factory: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  positionManager: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0',
  ...extra,
})

const token = (address: string, symbol: string) => ({ address, symbol, name: `Test ${symbol}`, decimals: 18 })

function writeManifest(files: Record<string, unknown>): { path: string; env: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), 'swapex-manifest-'))
  dirs.push(dir)
  for (const [name, data] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(data))
  const path = join(dir, `${CHAIN}.json`)
  return { path, env: { DEPLOYMENT_PATH: path } }
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('loadManifest', () => {
  it('merges seed tokens when the manifest lists none', () => {
    const usdc = '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707'
    const { env } = writeManifest({
      [`${CHAIN}.json`]: manifest(),
      [`${CHAIN}.seed.json`]: { tokens: [token(usdc, 'tUSDC')], fee: 3000 },
    })
    const m = loadManifest(CHAIN, env)
    expect(m.tokens).toHaveLength(1)
    expect(m.tokens[0]?.symbol).toBe('tUSDC')
  })

  it('keeps manifest tokens and dedupes seed tokens by address', () => {
    const weth = '0x5FbDB2315678afecb367f032d93F642f64180aa3'
    const dai = '0x0165878A594ca255338adfa4d48449f69242Eb8F'
    const { env } = writeManifest({
      [`${CHAIN}.json`]: manifest({ tokens: [token(weth, 'WETH')] }),
      [`${CHAIN}.seed.json`]: { tokens: [token(weth.toLowerCase(), 'WETH'), token(dai, 'tDAI')] },
    })
    const m = loadManifest(CHAIN, env)
    expect(m.tokens.map((t) => t.symbol)).toEqual(['WETH', 'tDAI'])
  })

  it('works with no seed file at all', () => {
    const { env } = writeManifest({ [`${CHAIN}.json`]: manifest() })
    expect(loadManifest(CHAIN, env).tokens).toEqual([])
  })

  it('rejects a malformed seed manifest instead of silently dropping anchors', () => {
    const { env } = writeManifest({
      [`${CHAIN}.json`]: manifest(),
      [`${CHAIN}.seed.json`]: { tokens: [{ address: 'not-an-address' }] },
    })
    expect(() => loadManifest(CHAIN, env)).toThrow(/seed manifest/)
  })

  it('still validates the main manifest', () => {
    const { env } = writeManifest({ [`${CHAIN}.json`]: { ...manifest(), chainId: 1 } })
    expect(() => loadManifest(CHAIN, env)).toThrow(/is for chain/)
  })
})
