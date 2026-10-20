// Quoter reads. Every quote goes through readContract (eth_call), never a transaction:
// the quoter runs the real swap inside the call and unwinds it before returning.
// All four quoter functions have multiple outputs, so reads go through readNamed.
import { coreContract, readNamed } from './client'

const quoter = () => coreContract('quoter')

/** Exact-input over an encoded path. Returns { amountOut, gasEstimate } (bigints). */
export function quoteExactInput(client, path, amountIn) {
  return readNamed(client, quoter(), 'quoteExactInput', [path, amountIn]).then((r) => ({
    amountOut: r.amountOut,
    gasEstimate: r.gasEstimate,
  }))
}

/** Exact-output over an encoded path. Returns { amountIn, gasEstimate }. */
export function quoteExactOutput(client, path, amountOut) {
  return readNamed(client, quoter(), 'quoteExactOutput', [path, amountOut]).then((r) => ({
    amountIn: r.amountIn,
    gasEstimate: r.gasEstimate,
  }))
}

/** Exact-input single hop: params { tokenIn, tokenOut, fee, amount, sqrtPriceLimitX96? }.
 *  Returns { amount, sqrtPriceX96After, tickAfter, gasEstimate }. */
export function quoteExactInputSingle(client, params) {
  return readNamed(client, quoter(), 'quoteExactInputSingle', [params]).then((q) => ({
    amount: q.amount,
    sqrtPriceX96After: q.sqrtPriceX96After,
    tickAfter: q.tickAfter,
    gasEstimate: q.gasEstimate,
  }))
}

/** Exact-output single hop: params { tokenIn, tokenOut, fee, amount, sqrtPriceLimitX96? }.
 *  Returns { amount, sqrtPriceX96After, tickAfter, gasEstimate }. */
export function quoteExactOutputSingle(client, params) {
  return readNamed(client, quoter(), 'quoteExactOutputSingle', [params]).then((q) => ({
    amount: q.amount,
    sqrtPriceX96After: q.sqrtPriceX96After,
    tickAfter: q.tickAfter,
    gasEstimate: q.gasEstimate,
  }))
}
