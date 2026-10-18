// Router writes. Swap flows either call one function or encode several into a multicall
// (swap + unwrapWETH9 in one transaction). Encoding helpers are pure (no signer needed).
import { getInterface, contractAt, ADDRESS_THIS } from './client'

export { ADDRESS_THIS }

const routerInterface = () => getInterface('router')

// ---- reads
export function weth9(library) {
  return contractAt('router', library).WETH9()
}

// ---- single-call writes (return the transaction)
export function exactInput(signer, params, overrides) {
  return contractAt('router', signer).exactInput(params, overrides || {})
}

export function exactInputSingle(signer, params, overrides) {
  return contractAt('router', signer).exactInputSingle(params, overrides || {})
}

export function exactOutput(signer, params, overrides) {
  return contractAt('router', signer).exactOutput(params, overrides || {})
}

export function exactOutputSingle(signer, params, overrides) {
  return contractAt('router', signer).exactOutputSingle(params, overrides || {})
}

/** Run encoded calls in one transaction. `overrides` carries { value } for native-ETH input. */
export function multicall(signer, calls, overrides) {
  return contractAt('router', signer).multicall(calls, overrides || {})
}

// ---- encodings for multicall composition
export function encodeExactInput(params) {
  return routerInterface().encodeFunctionData('exactInput', [params])
}

export function encodeExactInputSingle(params) {
  return routerInterface().encodeFunctionData('exactInputSingle', [params])
}

export function encodeExactOutput(params) {
  return routerInterface().encodeFunctionData('exactOutput', [params])
}

export function encodeExactOutputSingle(params) {
  return routerInterface().encodeFunctionData('exactOutputSingle', [params])
}

/** Unwrap WETH held by the router down to `amountMinimum` and send the ETH to `recipient`. */
export function encodeUnwrapWETH9(amountMinimum, recipient) {
  return routerInterface().encodeFunctionData('unwrapWETH9', [amountMinimum, recipient])
}

/** Send `token` held by the router to `recipient`, keeping at least `amountMinimum`. */
export function encodeSweepToken(token, amountMinimum, recipient) {
  return routerInterface().encodeFunctionData('sweepToken', [token, amountMinimum, recipient])
}

/** Return unused ETH after an exact-output or wrapped-input swap. */
export function encodeRefundETH() {
  return routerInterface().encodeFunctionData('refundETH', [])
}

/** Swap exact input and unwrap to ETH for `recipient` in one multicall. */
export function encodeExactInputToETH(params, amountMinimum, recipient) {
  return [encodeExactInput({ ...params, recipient: ADDRESS_THIS }), encodeUnwrapWETH9(amountMinimum, recipient)]
}
