// SwapexLimitOrders reads and the maker's only on-chain action.
// Orders are signed off-chain (EIP-712, lib/limitOrders.js); the contract itself
// is only ever written by cancel(nonce). Fills are anyone-called (the keeper).
import { contractFor, readNamed } from './client'
import { DEPLOYMENT } from '../config'

function limit() {
  if (!DEPLOYMENT || !DEPLOYMENT.limitOrders) throw new Error('limit orders contract is not deployed on this chain')
  return contractFor('limitOrders', DEPLOYMENT.limitOrders)
}

/** Cancel every order the caller signed with `nonce`. Returns the tx hash. */
export function cancelOrder(wallet, nonce) {
  return wallet.writeContract({ ...limit(), functionName: 'cancel', args: [BigInt(nonce)] })
}

/** Has the maker cancelled this nonce? */
export function isNonceCancelled(client, maker, nonce) {
  return client.readContract({ ...limit(), functionName: 'cancelled', args: [maker, BigInt(nonce)] })
}

/** Filled state for an order digest: { filled, amountOutReceived } as bigints. */
export async function orderState(client, orderHash) {
  const r = await readNamed(client, limit(), 'orders', [orderHash])
  return { filled: r.filled, amountOutReceived: r.amountOutReceived }
}
