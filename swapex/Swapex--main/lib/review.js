// Pure summary math for the swap confirmation modal. No wallet or network access.
import { BigNumber, utils } from 'ethers'
import { formatAmount } from './amounts'
import { HIGH_PRICE_IMPACT } from './config'

/**
 * Execution rate as "per 1 tokenIn" in tokenOut units: format(out * 10^decimalsIn / in, decimalsOut).
 * Returns a short string, or null when either side is missing or zero.
 */
export function formatRate(amountIn, decimalsIn, amountOut, decimalsOut) {
  try {
    if (amountIn == null || amountOut == null) return null
    const inBn = BigNumber.from(amountIn)
    const outBn = BigNumber.from(amountOut)
    if (inBn.lte(0) || outBn.lte(0)) return null
    const one = utils.parseUnits('1', decimalsIn)
    const perOne = outBn.mul(one).div(inBn)
    return formatAmount(perOne, decimalsOut, 8)
  } catch {
    return null
  }
}

/** "2.31%" or "n/a". */
export function impactPercent(impact) {
  if (impact == null || !Number.isFinite(impact)) return 'n/a'
  return `${(impact * 100).toFixed(2)}%`
}

/** True when impact is at or above the app-wide extra-confirm threshold. */
export function needsExtraConfirm(impact) {
  return impact != null && Number.isFinite(impact) && impact >= HIGH_PRICE_IMPACT
}

/** Estimated network fee in wei (gasEstimate * gasPrice), or null when either is missing. */
export function feeEstimateWei(gasEstimate, gasPrice) {
  if (gasEstimate == null || gasPrice == null) return null
  try {
    return BigNumber.from(gasEstimate).mul(gasPrice)
  } catch {
    return null
  }
}

/** Estimated network fee as a short ETH string, or null. */
export function feeEstimateEth(gasEstimate, gasPrice) {
  const wei = feeEstimateWei(gasEstimate, gasPrice)
  return wei == null ? null : formatAmount(wei, 18, 6)
}
