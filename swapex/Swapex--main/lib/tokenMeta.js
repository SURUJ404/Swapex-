import { symbol as erc20Symbol, decimals as erc20Decimals } from './contracts/erc20'
import { findToken, tokenLogo } from './tokens'

const cache = new Map()

/** { address, symbol, name, decimals, logo } for any ERC-20, using the known list first. */
export async function getTokenMeta(library, address) {
  const known = findToken(address)
  if (known) return known
  const key = address.toLowerCase()
  if (cache.has(key)) return cache.get(key)
  let symbol = 'TOKEN'
  let decimals = 18
  try {
    ;[symbol, decimals] = await Promise.all([erc20Symbol(library, address), erc20Decimals(library, address)])
  } catch {
    // non-standard token: keep the defaults rather than failing the whole screen
  }
  const meta = { address, symbol, name: symbol, decimals: Number(decimals), logo: tokenLogo(symbol) }
  cache.set(key, meta)
  return meta
}
