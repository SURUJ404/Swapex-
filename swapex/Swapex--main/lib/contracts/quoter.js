// Quoter reads. The Swapex quoter reverts with its result, so every call MUST go through
// callStatic (eth_call). A plain call throws CallException even when the quote succeeds.
import { BigNumber } from 'ethers'
import { contractAt } from './client'

function quoter(library) {
  return contractAt('quoter', library)
}

/** Exact-input over an encoded path. Returns { amountOut, gasEstimate } (BigNumbers). */
export async function quoteExactInput(library, path, amountIn) {
  const r = await quoter(library).callStatic.quoteExactInput(path, amountIn)
  return { amountOut: BigNumber.from(r.amountOut), gasEstimate: BigNumber.from(r.gasEstimate) }
}

/** Exact-output over an encoded path. Returns { amountIn, gasEstimate }. */
export async function quoteExactOutput(library, path, amountOut) {
  const r = await quoter(library).callStatic.quoteExactOutput(path, amountOut)
  return { amountIn: BigNumber.from(r.amountIn), gasEstimate: BigNumber.from(r.gasEstimate) }
}

/** Exact-input single hop: params { tokenIn, tokenOut, fee, amount, sqrtPriceLimitX96? }.
 *  Returns { amount, sqrtPriceX96After, tickAfter, gasEstimate }. */
export async function quoteExactInputSingle(library, params) {
  const q = await quoter(library).callStatic.quoteExactInputSingle(params)
  return {
    amount: BigNumber.from(q.amount),
    sqrtPriceX96After: BigNumber.from(q.sqrtPriceX96After),
    tickAfter: q.tickAfter,
    gasEstimate: BigNumber.from(q.gasEstimate),
  }
}

/** Exact-output single hop: params { tokenIn, tokenOut, fee, amount, sqrtPriceLimitX96? }.
 *  Returns { amount, sqrtPriceX96After, tickAfter, gasEstimate }. */
export async function quoteExactOutputSingle(library, params) {
  const q = await quoter(library).callStatic.quoteExactOutputSingle(params)
  return {
    amount: BigNumber.from(q.amount),
    sqrtPriceX96After: BigNumber.from(q.sqrtPriceX96After),
    tickAfter: q.tickAfter,
    gasEstimate: BigNumber.from(q.gasEstimate),
  }
}
