// Swap path encoding for the Swapex router: token (20 bytes) | fee (3 bytes) | token | fee | token ...
// Exact-input paths run tokenIn -> tokenOut. Exact-output paths are the same list reversed.
// Pure functions on hex strings, so they are easy to test and have no wallet or network dependency.

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
export const MAX_POOLS = 4

function feeHex(fee) {
  if (!Number.isInteger(fee) || fee <= 0 || fee >= 0x1000000) throw new Error(`Invalid fee tier: ${fee}`)
  return fee.toString(16).padStart(6, '0')
}

/** tokens: [a, b, c...] (addresses), fees: [fee_ab, fee_bc...] -> 0x-prefixed packed hex (lowercase). */
export function encodePath(tokens, fees) {
  if (!Array.isArray(tokens) || !Array.isArray(fees)) throw new Error('Invalid path')
  if (tokens.length < 2 || fees.length !== tokens.length - 1) throw new Error('Path needs one fee per hop')
  if (fees.length > MAX_POOLS) throw new Error(`Path has more than ${MAX_POOLS} hops`)
  let out = '0x'
  tokens.forEach((t, i) => {
    if (!ADDRESS.test(t)) throw new Error(`Invalid token address: ${t}`)
    out += t.slice(2).toLowerCase()
    if (i < fees.length) out += feeHex(fees[i])
  })
  return out
}

/** Path for exact-output swaps: the same hops in reverse order. */
export function encodePathReversed(tokens, fees) {
  return encodePath([...tokens].reverse(), [...fees].reverse())
}

/** Inverse of encodePath, used to show a route in the UI and in tests. */
export function decodePath(hex) {
  if (typeof hex !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(hex)) throw new Error('Invalid path')
  const body = hex.slice(2)
  if (body.length < 86 || (body.length - 40) % 46 !== 0) throw new Error('Invalid path length')
  const tokens = []
  const fees = []
  for (let i = 0; i < body.length; ) {
    tokens.push(`0x${body.slice(i, i + 40)}`)
    i += 40
    if (i < body.length) {
      fees.push(parseInt(body.slice(i, i + 6), 16))
      i += 6
    }
  }
  return { tokens, fees }
}
