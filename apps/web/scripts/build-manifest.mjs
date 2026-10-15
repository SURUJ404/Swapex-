// F.2 — build `deployments/<chainId>.json` from a Deploy.s.sol broadcast run.
//
// Sources (all local, no network secrets):
//   * contracts/broadcast/Deploy.s.sol/<chainId>/run-latest.json  -> addresses (deploy order)
//   * contracts/out/<Name>.sol/<Name>.json                        -> init + artifact deployed code
//     (external libraries are re-linked here with the broadcast's addresses before hashing)
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

// forge leaves `__$…$__` placeholders in an artifact for *external* libraries (here SwapLogic):
// the linker only runs inside `forge script`/`forge create`, so the JSON on disk is still
// unlinked. Re-apply the link here with the address the broadcast actually deployed, otherwise
// keccak256 over the bytecode throws on the placeholder bytes.
const linkBytecode = (hex, linkReferences) => {
  const body = asHex(hex).slice(2)
  let out = body
  for (const libs of Object.values(linkReferences || {})) {
    for (const [libName, spots] of Object.entries(libs)) {
      const addr = byName.get(libName)?.[0]
      if (!addr) throw new Error(`library ${libName} referenced but never deployed by the broadcast`)
      const bare = addr.toLowerCase().replace(/^0x/, '')
      if (bare.length !== 40) throw new Error(`library ${libName}: bad address ${addr}`)
      for (const { start, length } of spots) {
        out = out.slice(0, start * 2) + bare + out.slice((start + length) * 2)
      }
    }
  }
  if (out.includes('__$')) throw new Error('unlinked library placeholder survived linking')
  return `0x${out}`
}

for (const [name, addresses] of byName) {
  const artifact = artifacts.get(name)
  const initCode = linkBytecode(artifact.bytecode.object, artifact.bytecode.linkReferences)
  const artifactDeployed = linkBytecode(
    artifact.deployedBytecode.object,
    artifact.deployedBytecode.linkReferences,
  )

  const onchainHashes = new Set()
  let onchainHex = null
  for (const address of addresses) {
    const code = await rpcGetCode(rpcUrl, address)
    if (!code || code === '0x') throw new Error(`no code on-chain at ${name} ${address} (${rpcUrl})`)
    onchainHashes.add(keccak(code))
    if (onchainHex !== null && onchainHex !== code) {
      // Same contract, same build → identical runtime code; distinct hashes mean a mixed deploy.
      throw new Error(`${name}: on-chain code differs across instances (${addresses.join(', ')})`)
    }
    onchainHex = code
  }
  if (onchainHashes.size !== 1) {
    throw new Error(`${name}: on-chain code hashes differ across instances: ${[...onchainHashes]}`)
  }

  // The address we just linked into the artifact must be the one baked into the live runtime
  // code — that is what ties this manifest to the deployment the broadcast recorded.
  const live = onchainHex.slice(2)
  for (const libs of Object.values(artifact.deployedBytecode.linkReferences || {})) {
    for (const [libName, spots] of Object.entries(libs)) {
      const bare = byName.get(libName)[0].toLowerCase().replace(/^0x/, '')
      for (const { start, length } of spots) {
        const embedded = live.slice(start * 2, (start + length) * 2)
        if (embedded !== bare) {
          throw new Error(
            `${name}: on-chain code links ${libName} as 0x${embedded}, broadcast deployed 0x${bare}`,
          )
        }
      }
    }
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
