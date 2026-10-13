// F.2 — sign `deployments/<chainId>.json` with an EIP-191 (personal_sign) signature over the
// file's exact bytes, writing `<chainId>.json.sig` beside it.
//
// The default key is anvil account #0 — a publicly known development key. That is deliberate and
// documented: on a public testnet the signature proves *manifest integrity + which key published
// it*, never authorship by a secret. A real release signs with a maintained release key supplied
// via PRIVATE_KEY (still never committed — see docs/TESTNET_SECURITY.md).
//
// Run from apps/web:  node scripts/sign-manifest.mjs [chainId]
import { writeFileSync } from 'node:fs'
import { ethers } from 'ethers'
import { manifestPath, readText, ANVIL_KEY0 } from './manifest-lib.mjs'

const args = process.argv.slice(2)
const chainId = Number(args.find((a) => /^\d+$/.test(a)) || 31337)
const path = manifestPath(chainId)

const privateKey = process.env.PRIVATE_KEY || ANVIL_KEY0
const wallet = new ethers.Wallet(privateKey)
const text = readText(path)
const signature = await wallet.signMessage(text) // EIP-191 over the exact file bytes

const sig = {
  manifest: `${chainId}.json`,
  algorithm: 'eip-191',
  signer: wallet.address,
  signature,
}
writeFileSync(`${path}.sig`, JSON.stringify(sig, null, 2) + '\n')

console.log(`signed ${path}`)
console.log(`  ->      ${path}.sig`)
console.log(`  signer  ${wallet.address}`)
console.log(
  process.env.PRIVATE_KEY
    ? '  key     PRIVATE_KEY from environment'
    : '  key     anvil dev key #0 (PUBLIC — demo-grade integrity proof only, see D30)'
)
