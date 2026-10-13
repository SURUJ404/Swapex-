// F.3 — the canonical deploy flow: broadcast Deploy.s.sol, optionally run `forge script
// --verify` source verification against a real explorer, then refresh the F.2 manifest.
//
//   node scripts/deploy.mjs                     # simulate only (no state changes)
//   node scripts/deploy.mjs --broadcast         # deploy to --rpc (default anvil) + manifest
//   node scripts/deploy.mjs --broadcast --verify
//       # non-local chains only: also runs forge's source verification against the explorer.
//       # Requires ETHERSCAN_API_KEY. Compiler settings come straight from foundry.toml
//       # (solc 0.8.26, runs 800, via_ir, cancun, bytecode_hash=none) — the same settings the
//       # F.2 manifest records, so explorer source must reproduce our bytecode.
//
// Source verification is skipped (loudly) on chainId 31337: anvil has no explorer.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { CONTRACTS_DIR, REPO_ROOT } from './manifest-lib.mjs'

const args = process.argv.slice(2)
const opt = (flag) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}
const has = (flag) => args.includes(flag)
const rpcUrl = opt('--rpc') || 'http://127.0.0.1:8545'
const doBroadcast = has('--broadcast')
const doVerify = has('--verify')
const skipManifest = has('--skip-manifest')

const fail = (msg) => {
  console.error(`error: ${msg}`)
  process.exit(1)
}

// locate forge (Windows dev machines keep it out of PATH)
function findForge() {
  const candidates = [
    process.env.FORGE_BIN,
    'forge',
    join(process.env.USERPROFILE || '', '.foundry', 'bin', 'forge.exe'),
  ].filter(Boolean)
  for (const c of candidates) {
    const probe = spawnSync(c, ['--version'], { encoding: 'utf8' })
    if (!probe.error && probe.status === 0) return c
  }
  return null
}
const forge = findForge()
if (!forge) fail('forge not found — set FORGE_BIN or add foundry to PATH')

const rpc = await fetch(rpcUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
}).catch(() => null)
if (!rpc || !rpc.ok) fail(`RPC unreachable at ${rpcUrl}`)
const chainHex = (await rpc.json()).result
if (!chainHex) fail(`no chainId from ${rpcUrl}`)
const chainId = Number(chainHex)
const isLocal = chainId === 31337
console.log(`target chainId ${chainId} (${rpcUrl})${isLocal ? ' — local anvil' : ''}`)

if (doVerify && isLocal) {
  console.log(
    'WARN  --verify requested on chainId 31337: anvil has no explorer, source verification skipped'
  )
}
if (doVerify && !isLocal && !process.env.ETHERSCAN_API_KEY) {
  fail('--verify on a real chain requires ETHERSCAN_API_KEY in the environment')
}

const cmd = [forge, 'script', 'script/Deploy.s.sol:Deploy']
if (doBroadcast) cmd.push('--broadcast')
cmd.push('--rpc-url', rpcUrl)
if (doVerify && !isLocal) cmd.push('--verify', '--etherscan-api-key', process.env.ETHERSCAN_API_KEY)
if (isLocal) cmd.push('--code-size-limit', '131072') // documented EIP-170 deviation (SECURITY.md)

console.log(`$ ${cmd.map((c) => (c.includes(' ') ? `"${c}"` : c)).join(' ')}`)
const run = spawnSync(cmd[0], cmd.slice(1), { cwd: CONTRACTS_DIR, stdio: 'inherit' })
if (run.status !== 0) fail(`forge script exited ${run.status}`)

if (!doBroadcast) {
  console.log('simulated only (no --broadcast): chain untouched, manifest not refreshed')
} else {
  if (doVerify && isLocal) {
    console.log('source verification skipped (local chain, no explorer)')
  }
  if (!skipManifest) {
    console.log('\nrefreshing F.2 manifest...')
    const build = spawnSync(
      process.execPath,
      [
        join(REPO_ROOT, 'apps', 'web', 'scripts', 'build-manifest.mjs'),
        String(chainId),
        '--rpc',
        rpcUrl,
      ],
      { stdio: 'inherit' }
    )
    if (build.status !== 0) fail(`build-manifest exited ${build.status}`)
    console.log(`next: node apps/web/scripts/sign-manifest.mjs ${chainId}`)
  }
}
