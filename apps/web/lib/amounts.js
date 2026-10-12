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

/** Deadline as unix seconds, `minutes` from now. (The V4 router has no deadline; retained for
 *  display and for any periphery that may add one.) */
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
