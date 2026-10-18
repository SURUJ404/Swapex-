// Factory reads and the pool reads the UI needs (slot0 / liquidity / identity).
import { contractAt, contractFor, ZERO_ADDRESS } from './client'

export function getPool(library, tokenA, tokenB, fee) {
  return contractAt('factory', library).getPool(tokenA, tokenB, fee)
}

export function feeAmountTickSpacing(library, fee) {
  return contractAt('factory', library).feeAmountTickSpacing(fee)
}

export function slot0(library, pool) {
  return contractFor('pool', pool, library).slot0()
}

export function liquidity(library, pool) {
  return contractFor('pool', pool, library).liquidity()
}

export function tickSpacing(library, pool) {
  return contractFor('pool', pool, library).tickSpacing()
}

/** Pool address or null when the pair/fee has no pool. */
export async function findPool(library, tokenA, tokenB, fee) {
  const address = await getPool(library, tokenA, tokenB, fee)
  return address === ZERO_ADDRESS ? null : address
}
