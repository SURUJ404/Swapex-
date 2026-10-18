// PositionManager reads and writes (the NFT position manager owns all pool positions).
import { BigNumber } from 'ethers'
import { getInterface, contractAt, ADDRESS_THIS } from './client'

export { ADDRESS_THIS }
export const MAX_UINT128 = BigNumber.from(2).pow(128).sub(1)

const pmInterface = () => getInterface('positionManager')

// ---- reads
export function ownerOf(library, tokenId) {
  return contractAt('positionManager', library).ownerOf(tokenId)
}

export async function position(library, tokenId) {
  const p = await contractAt('positionManager', library).positions(tokenId)
  return {
    token0: p.token0,
    token1: p.token1,
    fee: p.fee,
    tickLower: p.tickLower,
    tickUpper: p.tickUpper,
    liquidity: p.liquidity,
    tokensOwed0: p.tokensOwed0,
    tokensOwed1: p.tokensOwed1,
  }
}

export function balanceOf(library, owner) {
  return contractAt('positionManager', library).balanceOf(owner)
}

export function nextTokenId(library) {
  return contractAt('positionManager', library).nextTokenId()
}

// ---- writes (return the transaction)
export function mint(signer, params, overrides) {
  return contractAt('positionManager', signer).mint(params, overrides || {})
}

export function increaseLiquidity(signer, params, overrides) {
  return contractAt('positionManager', signer).increaseLiquidity(params, overrides || {})
}

export function decreaseLiquidity(signer, params, overrides) {
  return contractAt('positionManager', signer).decreaseLiquidity(params, overrides || {})
}

/** Collect fees (or full balances with MAX_UINT128). Returns the transaction. */
export function collect(signer, params, overrides) {
  return contractAt('positionManager', signer).collect(params, overrides || {})
}

/** Burn an emptied position NFT. */
export function burn(signer, tokenId, overrides) {
  return contractAt('positionManager', signer).burn(tokenId, overrides || {})
}

export function createAndInitializePoolIfNecessary(signer, token0, token1, fee, sqrtPriceX96, overrides) {
  return contractAt('positionManager', signer).createAndInitializePoolIfNecessary(token0, token1, fee, sqrtPriceX96, overrides || {})
}

export function multicall(signer, calls, overrides) {
  return contractAt('positionManager', signer).multicall(calls, overrides || {})
}

// ---- encodings for multicall composition
export function encodeMint(params) {
  return pmInterface().encodeFunctionData('mint', [params])
}

export function encodeIncreaseLiquidity(params) {
  return pmInterface().encodeFunctionData('increaseLiquidity', [params])
}

export function encodeDecreaseLiquidity(params) {
  return pmInterface().encodeFunctionData('decreaseLiquidity', [params])
}

export function encodeCollect(params) {
  return pmInterface().encodeFunctionData('collect', [params])
}

export function encodeBurn(tokenId) {
  return pmInterface().encodeFunctionData('burn', [tokenId])
}

export function encodeUnwrapWETH9(amountMinimum, recipient) {
  return pmInterface().encodeFunctionData('unwrapWETH9', [amountMinimum, recipient])
}

export function encodeSweepToken(token, amountMinimum, recipient) {
  return pmInterface().encodeFunctionData('sweepToken', [token, amountMinimum, recipient])
}

export function encodeRefundETH() {
  return pmInterface().encodeFunctionData('refundETH', [])
}

export function encodeCreateAndInitializePoolIfNecessary(token0, token1, fee, sqrtPriceX96) {
  return pmInterface().encodeFunctionData('createAndInitializePoolIfNecessary', [token0, token1, fee, sqrtPriceX96])
}
