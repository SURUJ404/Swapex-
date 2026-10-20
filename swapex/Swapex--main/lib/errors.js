import { decodeErrorResult } from 'viem'
import { abiFor } from './contracts/client'

// Custom errors the Swapex contracts can revert with, in plain language.
const CONTRACT_ERRORS = {
  TooLittleReceived: 'Price moved beyond your slippage tolerance. Try raising slippage or retry.',
  TooMuchRequested: 'Price moved beyond your slippage tolerance.',
  PriceSlippage: 'Pool price moved beyond your slippage tolerance. Refresh and retry.',
  Expired: 'Transaction deadline passed. Try again.',
  PoolNotFound: 'No pool exists for this pair and fee tier.',
  PartialFill: 'Not enough liquidity to fill this trade in full. Try a smaller amount.',
  InsufficientLiquidity: 'Not enough liquidity to fill this trade in full. Try a smaller amount.',
  TransferFailed: 'Token transfer failed. Check your balance and that the token is approved.',
  InvalidPath: 'This route is not valid.',
  ZeroAmount: 'Enter an amount greater than zero.',
  ZeroRecipient: 'Missing recipient address.',
  InsufficientETH: 'Received less ETH than your minimum. Try raising slippage.',
  PermitFailed: 'The token permit signature was rejected.',
  NotAuthorized: 'You are not allowed to manage this position.',
}

// ABIs come from the adapter layer (deduped, single source of truth).
const ERROR_ABIS = ['router', 'positionManager', 'quoter'].map((name) => abiFor(name))

function revertData(e) {
  const candidates = [e?.data, e?.error?.data, e?.error?.error?.data, e?.data?.data, e?.error?.data?.data]
  return candidates.find((d) => typeof d === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(d))
}

/** Name of the Swapex custom error in a failed call, or null. */
export function decodeContractError(e) {
  const data = revertData(e)
  if (!data) return null
  for (const abi of ERROR_ABIS) {
    try {
      return decodeErrorResult({ abi, data }).abiItem.name
    } catch {
      // not this contract's error
    }
  }
  return null
}

/** Turn wallet / RPC / contract errors into a short message a user can act on. */
export function parseError(e, fallback = 'Transaction failed') {
  if (!e) return fallback
  const named = decodeContractError(e)
  if (named && CONTRACT_ERRORS[named]) return CONTRACT_ERRORS[named]
  const code = e.code
  const raw = [e.reason, e.shortMessage, e.details, e.data?.message, e.error?.message, e.message, String(e)]
    .filter(Boolean)
    .join(' | ')

  if (code === 4001 || code === 'ACTION_REJECTED' || /user (rejected|denied)|UserRejectedRequestError/i.test(raw)) {
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
  if (/insufficient funds|InsufficientBalanceError/i.test(raw) || code === 'INSUFFICIENT_FUNDS') {
    return 'Not enough ETH to cover the amount plus network fee.'
  }
  if (code === 'UNPREDICTABLE_GAS_LIMIT' || /ContractFunctionExecutionError|estimateGas/i.test(raw)) {
    return 'This transaction would fail on-chain (simulation reverted). Check amounts and slippage.'
  }
  if (code === 'NETWORK_ERROR' || /network (changed|error)|HttpRequestError/i.test(raw)) {
    return 'Network error. Check your connection and wallet network.'
  }
  const msg = e.reason || e.shortMessage || e.message || fallback
  return msg.length > 140 ? `${msg.slice(0, 137)}...` : msg
}
