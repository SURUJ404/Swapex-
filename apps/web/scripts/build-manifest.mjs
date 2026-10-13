// F.2 — build `deployments/<chainId>.json` from a Deploy.s.sol broadcast run.
//
// Sources (all local, no network secrets):
//   * contracts/broadcast/Deploy.s.sol/<chainId>/run-latest.json  -> addresses (deploy order)
//   * contracts/out/<Name>.sol/<Name>.json                        -> init + artifact deployed code
//   * eth_getCode over --rpc (default anvil)                      -> the live on-chain runtime code
//   * git rev-parse HEAD + contracts/foundry.toml                 -> commit and compiler settings
//
// Run from apps/web:  node scripts/build-manifest.mjs [chainId] [--rpc <url>]
// Then sign it:       node scripts/sign-manifest.mjs <chainId>
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import {
  DEPLOYMENTS_DIR,
  manifestPath,
  readBroadcastCreates,
  loadArtifacts,
  readFoundrySettings,
  gitCommit,
  keccak,
  rpcGetCode,
  readText,
} from './manifest-lib.mjs'

const args = process.argv.slice(2)
const chainId = Number(args.find((a) => /^\d+$/.test(a)) || 31337)
const rpcIdx = args.indexOf('--rpc')
const rpcUrl = rpcIdx >= 0 ? args[rpcIdx + 1] : 'http://127.0.0.1:8545'

const creates = readBroadcastCreates(chainId)
const byName = new Map()
for (const { name, address } of creates) {
  if (!byName.has(name)) byName.set(name, [])
  byName.get(name).push(address)
}

const artifacts = loadArtifacts(new Set(byName.keys()))
const contracts = {}
const asHex = (s) => (s.startsWith('0x') ? s : `0x${s}`) // forge artifacts may or may not prefix
for (const [name, addresses] of byName) {
  const artifact = artifacts.get(name)
  const initCode = asHex(artifact.bytecode.object)
  const artifactDeployed = asHex(artifact.deployedBytecode.object)

  const onchainHashes = new Set()
  for (const address of addresses) {
    const code = await rpcGetCode(rpcUrl, address)
    if (!code || code === '0x') throw new Error(`no code on-chain at ${name} ${address} (${rpcUrl})`)
    onchainHashes.add(keccak(code))
  }
  if (onchainHashes.size !== 1) {
    // Same contract, same build → identical runtime code; distinct hashes mean a mixed deploy.
    throw new Error(`${name}: on-chain code hashes differ across instances: ${[...onchainHashes]}`)
  }

  contracts[name] = {
    addresses,
    initCodeHash: keccak(initCode),
    artifactDeployedCodeHash: keccak(artifactDeployed),
    onchainCodeHash: [...onchainHashes][0],
  }
}

const manifest = {
  chainId,
  commit: gitCommit(),
  generatedAt: new Date().toISOString(),
  foundry: readFoundrySettings(),
  contracts,
}

mkdirSync(DEPLOYMENTS_DIR, { recursive: true })
const out = manifestPath(chainId)
writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n')

// self-check: the file we just wrote must hash to what we computed (the signer signs these exact
// bytes, so a write-path bug must not survive to the signature step)
const reread = readText(out)
if (JSON.stringify(JSON.parse(reread)) !== JSON.stringify(manifest)) {
  throw new Error('round-trip mismatch: written manifest differs from generated object')
}

console.log(`wrote ${out}`)
console.log(`  commit   ${manifest.commit}`)
console.log(`  solc     ${manifest.foundry.solc} runs=${manifest.foundry.optimizerRuns} viaIr=${manifest.foundry.viaIr} bytecodeHash=${manifest.foundry.bytecodeHash}`)
for (const [name, c] of Object.entries(contracts)) {
  console.log(`  ${name.padEnd(20)} ${c.addresses.join(', ')}`)
  console.log(`${' '.repeat(22)}onchain ${c.onchainCodeHash}`)
}
console.log(`  (${Object.keys(contracts).length} contracts, rpc ${rpcUrl})`)
