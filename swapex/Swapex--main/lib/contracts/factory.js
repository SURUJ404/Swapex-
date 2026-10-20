// Factory reads and the pool reads the UI needs (slot0 / liquidity / identity).
import { coreContract, contractFor, readNamed, ZERO_ADDRESS } from './client'

const factory = () => coreContract('factory')
const poolAt = (pool) => contractFor('pool', pool)

export function getPool(client, tokenA, tokenB, fee) {
  return client.readContract({ ...factory(), functionName: 'getPool', args: [tokenA, tokenB, fee] })
}

export function feeAmountTickSpacing(client, fee) {
  return client.readContract({ ...factory(), functionName: 'feeAmountTickSpacing', args: [fee] })
}

export function slot0(client, pool) {
  return readNamed(client, poolAt(pool), 'slot0')
}

export function liquidity(client, pool) {
  return client.readContract({ ...poolAt(pool), functionName: 'liquidity' })
}

export function tickSpacing(client, pool) {
  return client.readContract({ ...poolAt(pool), functionName: 'tickSpacing' })
}

/** Pool address or null when the pair/fee has no pool. */
export async function findPool(client, tokenA, tokenB, fee) {
  const address = await getPool(client, tokenA, tokenB, fee)
  return address === ZERO_ADDRESS ? null : address
}
