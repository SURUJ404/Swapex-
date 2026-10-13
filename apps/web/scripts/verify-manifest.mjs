// F.2 — verify a signed deployment manifest. This is the CI entry point.
//
// Checks:
//   1. EIP-191 signature over the manifest's exact bytes recovers the declared signer  (required)
//   2. the manifest's recorded commit is an ancestor of HEAD                           (required
//      when git can answer; warning on shallow clones / detached CI checkouts)
//   3. the recorded compiler settings still match contracts/foundry.toml               (warning —
//      a settings change makes the manifest stale, but does not falsify the signature)
//   4. with --rpc: eth_getCode at every recorded address keccak256-hashes to the stored
//      onchainCodeHash for its contract                                              (required
//      when --rpc is passed)
//
// Run from apps/web:
//   node scripts/verify-manifest.mjs [chainId] [--rpc <url>] [--signer <address>]
import { ethers } from 'ethers'
import {
  manifestPath,
  readText,
  readFoundrySettings,
  gitIsAncestor,
  rpcGetCode,
  keccak,
} from './manifest-lib.mjs'

const args = process.argv.slice(2)
const chainId = Number(args.find((a) => /^\d+$/.test(a)) || 31337)
const opt = (flag) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}
const rpcUrl = opt('--rpc')
const expectedSigner = opt('--signer')

const path = manifestPath(chainId)
const text = readText(path)
const manifest = JSON.parse(text)
const sigPath = `${path}.sig`
const sig = JSON.parse(readText(sigPath))

let failures = 0
const pass = (msg) => console.log(`  PASS  ${msg}`)
const warn = (msg) => console.log(`  WARN  ${msg}`)
const fail = (msg) => {
  failures++
  console.log(`  FAIL  ${msg}`)
}

console.log(`verifying ${path}`)

// 1. signature over the exact manifest bytes
let recovered
try {
  recovered = ethers.utils.verifyMessage(text, sig.signature)
} catch (e) {
  fail(`signature not parseable: ${e.message}`)
}
if (recovered) {
  if (recovered !== ethers.utils.getAddress(sig.signer)) {
    fail(`signer mismatch: sig file says ${sig.signer}, recovered ${recovered}`)
  } else {
    pass(`eip-191 signature valid, signer ${recovered}`)
    if (expectedSigner && recovered !== ethers.utils.getAddress(expectedSigner)) {
      fail(`signer ${recovered} is not the expected ${expectedSigner}`)
    }
  }
}

// 2. recorded commit is part of this checkout's history
const ancestor = gitIsAncestor(manifest.commit)
if (ancestor === null) warn(`git could not confirm commit ${manifest.commit} (shallow clone?)`)
else if (ancestor) pass(`commit ${manifest.commit} is an ancestor of HEAD`)
else fail(`commit ${manifest.commit} is NOT in this checkout's history`)

// 3. recorded compiler settings still match foundry.toml
const current = readFoundrySettings()
const drift = Object.entries(current).filter(([k, v]) => manifest.foundry?.[k] !== v)
if (drift.length === 0) pass('compiler settings match foundry.toml')
else warn(`compiler settings drifted since manifest was written: ${drift.map(([k]) => k).join(', ')}`)

// 4. optional live codehash verification over RPC
if (rpcUrl) {
  for (const [name, c] of Object.entries(manifest.contracts)) {
    for (const address of c.addresses) {
      try {
        const code = await rpcGetCode(rpcUrl, address)
        if (!code || code === '0x') fail(`${name} ${address}: no code at that address on ${rpcUrl}`)
        else if (keccak(code) !== c.onchainCodeHash)
          fail(`${name} ${address}: on-chain codehash ${keccak(code)} != manifest ${c.onchainCodeHash}`)
        else pass(`${name} ${address} codehash matches`)
      } catch (e) {
        fail(`${name} ${address}: ${e.message}`)
      }
    }
  }
} else {
  warn('no --rpc given: skipped live on-chain codehash verification')
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`)
  // exitCode, not process.exit(): hard-exiting while fetch keep-alive sockets are still
  // closing trips a libuv assertion on some Windows/Node combos and mangles the exit code.
  process.exitCode = 1
} else {
  console.log('\nmanifest OK')
}
