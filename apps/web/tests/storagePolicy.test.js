import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { addTransaction, setTransactionStatus, getTransactions } from '../lib/txHistory'

// Crypto G.2 tail: "Never store signatures or approvals in localStorage."
// The app's only storage writers are lib/txHistory.js (tx hashes + labels) and the legacy
// src/contexts/LocalStorage.js (UI prefs). This suite enforces that from two directions:
//   1. runtime: what txHistory actually writes contains only {hash,label,status,addedAt}
//   2. policy:  no other shipped source file may call localStorage.setItem, and no
//               storage writer may mention signature material at all
// (tests/ and e2e/ are not shipped app code and are excluded from the static scan — the
// test files themselves necessarily mention the forbidden identifiers.)

const WEB_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const ALLOWED_SETITEM = new Set([
  join('lib', 'txHistory.js'),
  join('src', 'contexts', 'LocalStorage.js'),
])
const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  'test-results',
  'playwright-report',
  '.merkle-build',
  '.git',
  'tests',
  'e2e',
])

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(js|jsx|ts|tsx|mjs)$/.test(name)) out.push(full)
  }
  return out
}

describe('txHistory stores no signature or approval material', () => {
  const store = new Map()
  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    })
    vi.stubGlobal('window', { dispatchEvent: () => {} })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('writes exactly {hash,label,status,addedAt} per entry', () => {
    addTransaction(31337, '0xabc', { hash: '0xdead', label: 'Swap SWA->SWB' })
    setTransactionStatus(31337, '0xabc', '0xdead', 'confirmed')
    const entries = getTransactions(31337, '0xabc')
    expect(entries).toHaveLength(1)
    expect(Object.keys(entries[0]).sort()).toEqual(['addedAt', 'hash', 'label', 'status'])
    const raw = [...store.values()].join('')
    expect(raw).not.toMatch(/sig|signature|permit|private/i)
  })
})

describe('storage-write policy across the web app', () => {
  const files = walk(WEB_ROOT)

  it('only the two audited writers ever touch localStorage', () => {
    const offenders = []
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      if (/localStorage\s*\.\s*setItem/.test(source)) {
        const rel = file.slice(WEB_ROOT.length + 1)
        if (!ALLOWED_SETITEM.has(rel)) offenders.push(rel)
      }
    }
    expect(offenders).toEqual([])
  })

  it('no source mentions sessionStorage at all', () => {
    const offenders = files.filter((f) => /sessionStorage/.test(readFileSync(f, 'utf8')))
    expect(offenders.map((f) => f.slice(WEB_ROOT.length + 1))).toEqual([])
  })

  it('the audited writers never mention signatures, permits, keys or seeds', () => {
    for (const rel of ALLOWED_SETITEM) {
      const source = readFileSync(join(WEB_ROOT, rel), 'utf8')
      expect(source, rel).not.toMatch(/signature|sigDeadline|privateKey|private_key|mnemonic|seed phrase/i)
    }
  })
})
