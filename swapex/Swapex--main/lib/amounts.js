import { BigNumber, utils } from 'ethers'

const BPS = 10000

/**
 * Parse a user-typed decimal string into a BigNumber of base units.
 * Returns null for empty / invalid / non-positive input.
 * Extra fractional digits beyond `decimals` are truncated, never thrown on.
 */
export function parseAmount(value, decimals) {
  if (typeof value !== 'string') return null
  const v = value.trim()
  if (!/^\d*\.?\d*$/.test(v) || v === '' || v === '.') return null
  let [whole, frac = ''] = v.split('.')
  if (whole === '') whole = '0'
  frac = frac.slice(0, decimals)
  try {
    const n = utils.parseUnits(frac ? `${whole}.${frac}` : whole, decimals)
    return n.gt(0) ? n : null
  } catch {
    return null
  }
}

/** minimum received = amount * (10000 - bps) / 10000 (integer math only) */
export function minAfterSlippage(amount, bps) {
  assertBps(bps)
  return BigNumber.from(amount).mul(BPS - bps).div(BPS)
}

/** maximum sent = amount * (10000 + bps) / 10000 */
export function maxAfterSlippage(amount, bps) {
  assertBps(bps)
  return BigNumber.from(amount).mul(BPS + bps).div(BPS)
}

function assertBps(bps) {
  if (!Number.isInteger(bps) || bps < 0 || bps > BPS) {
    throw new Error(`Invalid slippage (bps): ${bps}`)
  }
}

/** "0.5" (percent, as typed) -> 50 bps. Returns null if invalid or out of range. */
export function percentToBps(percent, maxBps = 5000) {
  if (typeof percent !== 'string' && typeof percent !== 'number') return null
  const s = String(percent).trim()
  if (!/^\d*\.?\d+$/.test(s) && !/^\d+\.?$/.test(s)) return null
  const bps = Math.round(parseFloat(s) * 100)
  if (!Number.isFinite(bps) || bps < 0 || bps > maxBps) return null
  return bps
}

export function bpsToPercent(bps) {
  return (bps / 100).toString()
}

/** quote(amountA, reserveA, reserveB), same as UniswapV2Library.quote */
export function quote(amountA, reserveA, reserveB) {
  const a = BigNumber.from(amountA)
  const rA = BigNumber.from(reserveA)
  const rB = BigNumber.from(reserveB)
  if (a.lte(0) || rA.lte(0) || rB.lte(0)) return null
  return a.mul(rB).div(rA)
}

/** Deadline as unix seconds, `minutes` from now. */
export function deadlineFromNow(minutes, nowMs = Date.now()) {
  const m = Number.isFinite(minutes) && minutes > 0 ? minutes : 20
  return Math.floor(nowMs / 1000) + Math.floor(m * 60)
}

/** Format base units to a short human string without float math on the raw value. */
export function formatAmount(amount, decimals, maxFrac = 6) {
  if (amount == null) return ''
  const s = utils.formatUnits(amount, decimals)
  const [w, f = ''] = s.split('.')
  const frac = f.slice(0, maxFrac).replace(/0+$/, '')
  return frac ? `${w}.${frac}` : w
}

/**
 * Price impact of a route vs. spot price, excluding the 0.3% LP fee per hop.
 * hops: [{ reserveIn, reserveOut }] as BigNumbers; amountIn/amountOut as BigNumbers.
 * Returns a fraction (0.01 = 1%) or null if it cannot be computed.
 */
export function priceImpact(amountIn, amountOut, hops, decimalsIn, decimalsOut) {
  try {
    if (!hops.length) return null
    let spot = Number(utils.formatUnits(amountIn, decimalsIn))
    for (const h of hops) {
      const rIn = Number(h.reserveIn)
      const rOut = Number(h.reserveOut)
      if (!(rIn > 0) || !(rOut > 0)) return null
      spot = spot * (rOut / rIn) * 0.997
    }
    // the reserves are in raw units of each token, so rescale to token units
    spot = spot * Math.pow(10, decimalsIn) / Math.pow(10, decimalsOut)
    const out = Number(utils.formatUnits(amountOut, decimalsOut))
    if (!(spot > 0)) return null
    return Math.max(0, 1 - out / spot)
  } catch {
    return null
  }
}
