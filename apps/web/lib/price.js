import { BigNumber } from 'ethers'

/** BigInt integer square root (Newton's method): largest x with x*x <= n. */
export function isqrt(n) {
  const v = BigInt(n)
  if (v < 0n) throw new Error('isqrt of negative')
  if (v < 2n) return v
  let x = v
  let y = (x + 1n) / 2n
  while (y < x) {
    x = y
    y = (x + v / x) / 2n
  }
  return x
}

/**
 * The Q96 sqrt price for a pool whose price (token1 per token0, human units) is `price`.
 * price_raw = price * 10^(dec1 - dec0); sqrtPriceX96 = sqrt(price_raw) * 2^96. `price` is parsed
 * from a decimal string so no floating-point error creeps into the mantissa.
 */
export function priceToSqrtPriceX96(price, dec0, dec1) {
  const s = String(price).trim()
  if (!/^\d*\.?\d+$|^\d+\.$|^\d+$/.test(s)) throw new Error(`invalid price: ${price}`)
  const [whole, frac = ''] = s.split('.')
  const num = BigInt((whole || '0') + frac || '0')
  const den = 10n ** BigInt(frac.length)
  if (num === 0n) throw new Error('price must be > 0')
  let N = num
  let D = den
  const exp = Number(dec1) - Number(dec0)
  if (exp >= 0) N = num * 10n ** BigInt(exp)
  else D = den * 10n ** BigInt(-exp)
  // sqrt(N / D) * 2^96 == isqrt(N * 2^192 / D)
  return BigNumber.from(isqrt((N << 192n) / D).toString())
}
