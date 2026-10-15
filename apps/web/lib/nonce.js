// Permit-nonce selection for AllowanceTransfer.
//
// The contract keeps a Permit2-style bitmap: nonce n lives in word (n / 256), bit (n % 256), and
// `nonceBitmap(owner, word)` returns that whole 256-bit word in one call. Scanning word-by-word needs
// one RPC per 256 nonces instead of one per nonce, and has no practical ceiling (the old per-nonce scan
// gave up after 1024, which locked out any account that had burned that many permits).

const WORD_BITS = 256

/** Lowest unset bit index (0..255) of a 256-bit word, or -1 when every bit is set. */
export function lowestFreeBit(word) {
  const w = BigInt(word.toString())
  for (let i = 0; i < WORD_BITS; i++) {
    if (((w >> BigInt(i)) & 1n) === 0n) return i
  }
  return -1
}

/**
 * First unused nonce for an owner.
 * @param {(wordIndex: number) => Promise<bigint|string|{toString(): string}>} readWord
 *        returns `nonceBitmap(owner, wordIndex)`
 * @param {number} [maxWords=64] words to scan (64 words = 16384 nonces) before giving up
 */
export async function findFreeNonce(readWord, maxWords = 64) {
  for (let word = 0; word < maxWords; word++) {
    const bit = lowestFreeBit(await readWord(word))
    if (bit !== -1) return word * WORD_BITS + bit
  }
  throw new Error(`no free permit nonce in the first ${maxWords * WORD_BITS}`)
}
