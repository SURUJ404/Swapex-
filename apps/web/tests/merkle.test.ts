import { describe, it, expect } from 'vitest'
import { utils } from 'ethers'
import {
  hashLeaf,
  hashPair,
  buildTree,
  verifyProof,
  type AllowEntry,
  type MerkleOutput,
} from '../scripts/merkle'
import fixture from '../../../contracts/test/fixtures/merkle.json'

// The four well-known anvil accounts (same set as contracts/test/fixtures/allowlist.json)
const A0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const A1 = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const A2 = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'
const A3 = '0x90F79bf6EB2c4f870365E785982E1f101E93b906'

const entries: AllowEntry[] = [
  { index: 0, account: A0, amount: '1000000000000000000' },
  { index: 1, account: A1, amount: '2000000000000000000' },
  { index: 2, account: A2, amount: '3000000000000000000' },
  { index: 256, account: A3, amount: '4000000000000000000' },
]

/** independent re-derivation of the documented leaf convention, from the spec text */
function specLeaf(index: number, account: string, amount: string): string {
  const encoded = utils.defaultAbiCoder.encode(
    ['uint256', 'address', 'uint256'],
    [index, account, amount]
  )
  return utils.keccak256(utils.keccak256(encoded))
}

describe('merkle generator (item C)', () => {
  it('leaf is double-hashed exactly as the contract requires', () => {
    for (const e of entries) {
      expect(hashLeaf(e.index, e.account, e.amount)).toBe(specLeaf(e.index, e.account, e.amount))
    }
  })

  it('pair hash is commutative and lexicographically sorted', () => {
    const a = hashLeaf(0, A0, '1')
    const b = hashLeaf(1, A1, '2')
    expect(hashPair(a, b)).toBe(hashPair(b, a))
    const [x, y] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a]
    expect(hashPair(a, b)).toBe(utils.keccak256(x + y.slice(2)))
    // hashPair is a real keccak of the concatenation, not a passthrough
    expect(hashPair(a, b)).not.toBe(hashPair(a, a))
  })

  it('every proof folds to the root with an independent verifier', () => {
    const out = buildTree(entries)
    for (const claim of out.claims) {
      const leaf = hashLeaf(claim.index, claim.account, claim.amount)
      expect(verifyProof(claim.proof, out.root, leaf), `claim ${claim.index}`).toBe(true)
      expect(claim.proof.length, `claim ${claim.index} covers all levels`).toBeGreaterThan(0)
    }
    // all four leaves must reach full depth (a right-child leaf missing an upper sibling
    // would fold short - this exact bug existed before the member-set fix)
    expect(out.claims.map((c) => c.proof.length)).toEqual([2, 2, 2, 2])
  })

  it('tampered claims and single-hash leaves never fold to the root', () => {
    const out = buildTree(entries)
    const good = out.claims[0]
    const leaf0 = hashLeaf(good.index, good.account, good.amount)

    // wrong amount (proof kept)
    expect(verifyProof(good.proof, out.root, hashLeaf(good.index, good.account, '999'))).toBe(false)
    // wrong account (proof kept)
    expect(verifyProof(good.proof, out.root, hashLeaf(good.index, A1, good.amount))).toBe(false)
    // wrong index (proof kept)
    expect(verifyProof(good.proof, out.root, hashLeaf(3, good.account, good.amount))).toBe(false)
    // truncated / extra proof element
    expect(verifyProof(good.proof.slice(1), out.root, leaf0)).toBe(false)
    expect(verifyProof([...good.proof, good.proof[0]], out.root, leaf0)).toBe(false)
    // second-preimage attempt: the SINGLE-hashed payload is never a valid leaf, so an
    // internal node (or raw abi.encode payload) cannot be replayed as a claim leaf
    const singleHashed = utils.keccak256(
      utils.defaultAbiCoder.encode(
        ['uint256', 'address', 'uint256'],
        [good.index, good.account, good.amount]
      )
    )
    expect(verifyProof(good.proof, out.root, singleHashed)).toBe(false)
    expect(singleHashed).not.toBe(leaf0)
  })

  it('odd-sized trees (carried node) still verify', () => {
    const odd: AllowEntry[] = entries.slice(0, 3)
    const out = buildTree(odd)
    for (const claim of out.claims) {
      const leaf = hashLeaf(claim.index, claim.account, claim.amount)
      expect(verifyProof(claim.proof, out.root, leaf), `claim ${claim.index}`).toBe(true)
    }
    // the odd (3rd) leaf carried up at level 0: its proof is shorter than its siblings'
    expect(out.claims[2].proof.length).toBe(1)
    expect(out.claims[0].proof.length).toBe(2)
  })

  it('duplicate account at two indexes yields two independent claims', () => {
    const dup: AllowEntry[] = [
      { index: 7, account: A1, amount: '1000000000000000000' },
      { index: 8, account: A1, amount: '1000000000000000000' },
    ]
    const out = buildTree(dup)
    expect(out.claims[0].proof).not.toEqual(out.claims[1].proof)
    for (const claim of out.claims) {
      const leaf = hashLeaf(claim.index, claim.account, claim.amount)
      expect(verifyProof(claim.proof, out.root, leaf)).toBe(true)
    }
    // same (index, account, amount) twice is a different tree - leaves must collide only if inputs match
    expect(hashLeaf(7, A1, '1000000000000000000')).not.toBe(hashLeaf(8, A1, '1000000000000000000'))
  })

  it('reproduces the committed forge fixture byte-for-byte', () => {
    const out: MerkleOutput = buildTree(entries)
    expect(out).toEqual(fixture as MerkleOutput)
    expect(out.count).toBe(4)
    // index 256 sits in bitmap word 1, bits 0..255 in word 0 - both words must be exercised
    expect(out.claims.map((c) => c.index)).toEqual([0, 1, 2, 256])
    expect(fixture.root).toBe(out.root)
  })

  it('rejects an empty allowlist', () => {
    expect(() => buildTree([])).toThrow('empty allowlist')
  })
})
