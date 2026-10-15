// Shared helpers for the F.2 signed-deployment-manifest tooling
// (build-manifest.mjs / sign-manifest.mjs / verify-manifest.mjs).
//
// Manifest = `deployments/<chainId>.json`: the addresses a Deploy.s.sol broadcast produced, the
// commit + compiler settings the bytecode was built with, and keccak256 hashes of the init code,
// the local artifact's deployed code, and the *live on-chain* code per contract (the on-chain
// hash is the ground truth the verifier re-checks over RPC — artifact deployed code alone can
// never match for contracts with immutables, whose slots are zero in the artifact).
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { ethers } from 'ethers'

export const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = join(SCRIPT_DIR, '..', '..', '..')
export const CONTRACTS_DIR = join(REPO_ROOT, 'contracts')
export const DEPLOYMENTS_DIR = join(REPO_ROOT, 'deployments')

export const ANVIL_KEY0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

export const keccak = (hex) => ethers.utils.keccak256(hex)

/** Top-level CREATE transactions of a forge broadcast run, in deployment order. */
export function readBroadcastCreates(chainId) {
  const path = join(CONTRACTS_DIR, 'broadcast', 'Deploy.s.sol', String(chainId), 'run-latest.json')
  const run = JSON.parse(readFileSync(path, 'utf8'))
  const creates = (run.transactions || [])
    // CREATE2 too: Deploy.s.sol deploys the linked SwapLogic library with CREATE2 before the
    // contracts that reference it, and it belongs in the manifest like everything else.
    .filter((tx) => ['CREATE', 'CREATE2'].includes(tx.transactionType) && tx.contractName && tx.contractAddress)
    .map((tx) => ({ name: tx.contractName, address: ethers.utils.getAddress(tx.contractAddress) }))
  if (creates.length === 0) throw new Error(`no CREATE transactions in ${path}`)
  return creates
}

/** Map contractName -> forge artifact JSON (contracts/out/<Name>.sol/<Name>.json). */
export function loadArtifacts(names) {
  const found = new Map()
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        if (entry === 'lib') continue // forge-std / OZ artifacts are not deployed by us
        walk(full)
      } else if (entry.endsWith('.json') && names.has(entry.slice(0, -'.json'.length))) {
        const name = entry.slice(0, -'.json'.length)
        if (!found.has(name)) found.set(name, full) // first match wins (name is the file stem)
      }
    }
  }
  walk(join(CONTRACTS_DIR, 'out'))
  const artifacts = new Map()
  for (const name of names) {
    const path = found.get(name)
    if (!path) throw new Error(`no artifact for ${name} under contracts/out`)
    artifacts.set(name, JSON.parse(readFileSync(path, 'utf8')))
  }
  return artifacts
}

/** The compiler settings block from foundry.toml — the single source of truth for builds. */
export function readFoundrySettings() {
  const text = readFileSync(join(CONTRACTS_DIR, 'foundry.toml'), 'utf8')
  const section = text.split(/^\[/m).find((s) => s.startsWith('profile.default]')) || ''
  const str = (k, d = null) => (section.match(new RegExp(`^${k}\\s*=\\s*"([^"]+)"`, 'm')) || [])[1] ?? d
  const bool = (k, d = null) => {
    const m = section.match(new RegExp(`^${k}\\s*=\\s*(true|false)`, 'm'))
    return m ? m[1] === 'true' : d
  }
  const num = (k, d = null) => {
    const m = section.match(new RegExp(`^${k}\\s*=\\s*(\\d+)`, 'm'))
    return m ? Number(m[1]) : d
  }
  return {
    solc: str('solc_version'),
    optimizer: bool('optimizer'),
    optimizerRuns: num('optimizer_runs'),
    bytecodeHash: str('bytecode_hash'),
    cborMetadata: bool('cbor_metadata'),
    evmVersion: str('evm_version'),
    viaIr: bool('via_ir'),
  }
}

export function gitCommit() {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git rev-parse HEAD failed: ${r.stderr}`)
  return r.stdout.trim()
}

/** true/false when git can answer, null when it cannot (shallow clone, not a repo, ...). */
export function gitIsAncestor(commit) {
  const r = spawnSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
  if (r.error || r.status === 128 || r.status === 129) return null // git could not decide
  return r.status === 0
}

export async function rpcGetCode(rpcUrl, address) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [address, 'latest'] }),
  })
  if (!res.ok) throw new Error(`eth_getCode HTTP ${res.status} for ${address}`)
  const body = await res.json()
  if (body.error) throw new Error(`eth_getCode error for ${address}: ${JSON.stringify(body.error)}`)
  return body.result
}

export function manifestPath(chainId) {
  return join(DEPLOYMENTS_DIR, `${chainId}.json`)
}

export const readText = (p) => readFileSync(p, 'utf8')
