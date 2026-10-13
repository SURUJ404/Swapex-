// Merkle allowlist generator (crypto item C).
//
// Produces the root + per-entry proofs that `contracts/src/v4/periphery/MerkleDistributor.sol`
// verifies on-chain. Conventions (must match the contract exactly):
//   leaf = keccak256(bytes.concat(keccak256(abi.encode(index, account, amount))))
//          (double-hashed: an internal tree node can never be reinterpreted as a leaf)
//   pair = keccak256(sorted(a, b)) -- commutative, lexicographic bytes32 order, the same
//          convention OpenZeppelin's MerkleProof standard tooling uses
//   odd  = the last node of a layer is carried up unchanged (proofs then simply omit that
//          level, which OZ's fold-style verify accepts with a shorter proof)
//
// Pure TypeScript with zero new dependencies: hashing goes through the already-pinned
// `ethers` v5 dependency, and no third-party Merkle library is trusted for correctness.
// Cross-checks: contracts/test/v4/MerkleDistributor.t.sol verifies this generator's output
// with OpenZeppelin's audited MerkleProof (forged proofs and duplicate claims must fail),
// and tests/merkle.test.ts folds every proof with an independent implementation.

import { utils } from 'ethers'

// Ambient shims: this repo has no @types/node (deliberately - see DECISIONS D35), so the
// handful of node globals the CLI touches are declared here rather than pulled in as a dep.
declare const process: { argv: string[]; exit: (code?: number) => never }
declare const console: { log: (...args: unknown[]) => void; error: (...args: unknown[]) => void }

export interface AllowEntry {
  index: number
  account: string
  amount: string // decimal string, any size
}

export interface ClaimProof {
  index: number
  account: string
  amount: string
  proof: string[]
}

export interface MerkleOutput {
  root: string
  count: number
  claims: ClaimProof[]
}

interface NodeFs {
  readFileSync(path: string, encoding: 'utf8'): string
  writeFileSync(path: string, data: string): void
}

/** Double-hashed leaf; mirrors `MerkleDistributor.leafOf`. */
export function hashLeaf(index: number, account: string, amount: string): string {
  const inner = utils.keccak256(
    utils.defaultAbiCoder.encode(['uint256', 'address', 'uint256'], [index, account, amount])
  )
  return utils.keccak256(inner)
}

/**
 * Commutative pair hash: keccak256 of the lexicographically smaller bytes32 first.
 * Lowercase 0x-hex compares lexicographically in exactly byte order, so no Buffer needed.
 */
export function hashPair(a: string, b: string): string {
  const [x, y] = a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a]
  return utils.keccak256(x + y.slice(2))
}

/**
 * Build the tree over `entries` IN ARRAY ORDER (array position determines topology; the
 * entry's own `index` only feeds the leaf hash, where it drives the on-chain claim bitmap).
 * Returns the root and the sibling proof for every entry.
 */
export function buildTree(entries: AllowEntry[]): MerkleOutput {
  if (entries.length === 0) throw new Error('empty allowlist')
  const leaves = entries.map((e) => hashLeaf(e.index, e.account, e.amount))
  const proofs: string[][] = entries.map(() => [])

  // each node remembers which ORIGINAL leaf positions live under it, so every sibling
  // hash is appended to the proof of all covered leaves (not just the leftmost one)
  let layer = leaves.map((leaf, i) => ({ leaf, members: [i] }))
  while (layer.length > 1) {
    const next: { leaf: string; members: number[] }[] = []
    for (let i = 0; i < layer.length; i += 2) {
      if (i + 1 === layer.length) {
        next.push(layer[i]) // odd node out: carry up, no proof element for this level
        continue
      }
      const l = layer[i]
      const r = layer[i + 1]
      for (const m of l.members) proofs[m].push(r.leaf)
      for (const m of r.members) proofs[m].push(l.leaf)
      next.push({ leaf: hashPair(l.leaf, r.leaf), members: [...l.members, ...r.members] })
    }
    layer = next
  }

  return {
    root: layer[0].leaf,
    count: entries.length,
    claims: entries.map((e, i) => ({
      index: e.index,
      account: utils.getAddress(e.account),
      amount: e.amount,
      proof: proofs[i],
    })),
  }
}

/** Fold a proof exactly the way OZ's MerkleProof.verify does (independent of buildTree). */
export function verifyProof(proof: string[], root: string, leaf: string): boolean {
  let cur = leaf
  for (const sibling of proof) cur = hashPair(cur, sibling)
  return cur.toLowerCase() === root.toLowerCase()
}

// ---------------------------------------------------------------------------
// CLI: node <compiled-merkle.js> <input.json> <output.json>
// input:  { "entries": [ { "index": 0, "account": "0x..", "amount": "..." }, ... ] }
// output: MerkleOutput, consumed by forge via vm.readFile + vm.parseJson
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  // @ts-expect-error no @types/node in this repo; the runtime provides node:fs
  const fs = (await import('node:fs')) as NodeFs
  const [inPath, outPath] = process.argv.slice(2)
  if (!inPath || !outPath) {
    console.error('usage: merkle <input.json> <output.json>')
    process.exit(2)
  }
  const input = JSON.parse(fs.readFileSync(inPath, 'utf8')) as { entries: AllowEntry[] }
  const out = buildTree(input.entries)
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n')
  console.log(`root ${out.root} (${out.count} entries) -> ${outPath}`)
}

// CLI guard without require/module: only the compiled CLI run has merkle.js as argv[1]
if (process.argv[1] !== undefined && process.argv[1].endsWith('merkle.js')) {
  main().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
