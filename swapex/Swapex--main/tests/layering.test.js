// Layering guard: contract construction happens only in lib/contracts/client.js.
// Components, pages, hooks, context and the rest of lib/ must go through the adapters,
// so chain calls stay reviewable in one place and testable without a provider.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const APP_ROOT = join(process.cwd())
// the one directory allowed to construct ethers.Contract
const ADAPTER_DIR = join(APP_ROOT, 'lib', 'contracts')
const GUARDED_DIRS = ['components', 'pages', 'hooks', 'context', 'lib']

const FORBIDDEN = /new\s+(?:ethers\.)?Contract\s*\(/

function jsFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) jsFiles(p, out)
    else if (p.endsWith('.js')) out.push(p)
  }
  return out
}

describe('layering', () => {
  it('never constructs ethers.Contract outside lib/contracts/client.js', () => {
    const offenders = []
    for (const root of GUARDED_DIRS) {
      for (const file of jsFiles(join(APP_ROOT, root))) {
        if (file.startsWith(ADAPTER_DIR)) continue
        if (FORBIDDEN.test(readFileSync(file, 'utf8'))) offenders.push(file.slice(APP_ROOT.length + 1))
      }
    }
    expect(offenders).toEqual([])
  })
})
