// Router writes. Swap flows either call one function or encode several into a multicall
// (swap + unwrapWETH9 in one transaction). Encoding helpers are pure (no wallet needed).
import { encodeFunctionData } from 'viem'
import { coreContract, abiFor, ADDRESS_THIS } from './client'

export { ADDRESS_THIS }

const router = () => coreContract('router')
const encode = (functionName, args) => encodeFunctionData({ abi: abiFor('router'), functionName, args })

// ---- reads
export function weth9(client) {
  return client.readContract({ ...router(), functionName: 'WETH9' })
}

// ---- single-call writes (return the tx hash)
export function exactInput(wallet, params, overrides) {
  return wallet.writeContract({ ...router(), functionName: 'exactInput', args: [params], value: overrides?.value })
}

export function exactInputSingle(wallet, params, overrides) {
  return wallet.writeContract({ ...router(), functionName: 'exactInputSingle', args: [params], value: overrides?.value })
}

export function exactOutput(wallet, params, overrides) {
  return wallet.writeContract({ ...router(), functionName: 'exactOutput', args: [params], value: overrides?.value })
}

export function exactOutputSingle(wallet, params, overrides) {
  return wallet.writeContract({ ...router(), functionName: 'exactOutputSingle', args: [params], value: overrides?.value })
}

/** Run encoded calls in one transaction. `overrides` carries { value } for native-ETH input. */
export function multicall(wallet, calls, overrides) {
  return wallet.writeContract({ ...router(), functionName: 'multicall', args: [calls], value: overrides?.value })
}

// ---- encodings for multicall composition
export function encodeExactInput(params) {
  return encode('exactInput', [params])
}

export function encodeExactInputSingle(params) {
  return encode('exactInputSingle', [params])
}

export function encodeExactOutput(params) {
  return encode('exactOutput', [params])
}

export function encodeExactOutputSingle(params) {
  return encode('exactOutputSingle', [params])
}

/** Unwrap WETH held by the router down to `amountMinimum` and send the ETH to `recipient`. */
export function encodeUnwrapWETH9(amountMinimum, recipient) {
  return encode('unwrapWETH9', [amountMinimum, recipient])
}

/** Send `token` held by the router to `recipient`, keeping at least `amountMinimum`. */
export function encodeSweepToken(token, amountMinimum, recipient) {
  return encode('sweepToken', [token, amountMinimum, recipient])
}

/** Return unused ETH after an exact-output or wrapped-input swap. */
export function encodeRefundETH() {
  return encode('refundETH', [])
}

/** Swap exact input and unwrap to ETH for `recipient` in one multicall. */
export function encodeExactInputToETH(params, amountMinimum, recipient) {
  return [encodeExactInput({ ...params, recipient: ADDRESS_THIS }), encodeUnwrapWETH9(amountMinimum, recipient)]
}
