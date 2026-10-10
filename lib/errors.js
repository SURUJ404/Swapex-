/** Turn wallet / RPC / contract errors into a short message a user can act on. */
export function parseError(e, fallback = 'Transaction failed') {
  if (!e) return fallback
  const code = e.code
  const raw = [e.reason, e.data?.message, e.error?.message, e.message, String(e)]
    .filter(Boolean)
    .join(' | ')

  if (code === 4001 || code === 'ACTION_REJECTED' || /user (rejected|denied)/i.test(raw)) {
    return 'Transaction rejected in your wallet'
  }
  if (/INSUFFICIENT_OUTPUT_AMOUNT|Too little received/i.test(raw)) {
    return 'Price moved beyond your slippage tolerance. Try raising slippage or retry.'
  }
  if (/EXCESSIVE_INPUT_AMOUNT/i.test(raw)) {
    return 'Price moved beyond your slippage tolerance.'
  }
  if (/EXPIRED/i.test(raw)) return 'Transaction deadline passed. Try again.'
  if (/INSUFFICIENT_LIQUIDITY/i.test(raw)) return 'Not enough liquidity in this pool for that trade.'
  if (/INSUFFICIENT_(A|B)_AMOUNT/i.test(raw)) {
    return 'Pool ratio changed beyond your slippage tolerance. Refresh and retry.'
  }
  if (/TRANSFER_FROM_FAILED|transfer amount exceeds allowance|insufficient allowance/i.test(raw)) {
    return 'Token approval is missing or too low. Approve the token and retry.'
  }
  if (/insufficient funds/i.test(raw) || code === 'INSUFFICIENT_FUNDS') {
    return 'Not enough ETH to cover the amount plus network fee.'
  }
  if (code === 'UNPREDICTABLE_GAS_LIMIT') {
    return 'This transaction would fail on-chain (simulation reverted). Check amounts and slippage.'
  }
  if (code === 'NETWORK_ERROR' || /network (changed|error)/i.test(raw)) {
    return 'Network error. Check your connection and wallet network.'
  }
  const msg = e.reason || e.message || fallback
  return msg.length > 140 ? `${msg.slice(0, 137)}...` : msg
}
