// EIP-712 limit-order helpers for the /limit page: the typed-data definition the
// wallet signs and the pure math that turns a user's limit price into the order's
// minAmountOut. Must mirror swapex-contracts/src/periphery/SwapexLimitOrders.sol
// (ORDER_TYPEHASH, domain name/version) and swapex-indexer/src/eip712.ts — the
// indexer re-verifies every signature against the same definitions.
import { DEPLOYMENT, REQUIRED_CHAIN_ID } from './config'
import { parseAmount, formatAmount } from './amounts'

export const ORDER_TYPES = {
  Order: [
    { name: 'maker', type: 'address' },
    { name: 'tokenIn', type: 'address' },
    { name: 'tokenOut', type: 'address' },
    { name: 'amountIn', type: 'uint256' },
    { name: 'minAmountOut', type: 'uint256' },
    { name: 'expiry', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'receiver', type: 'address' },
  ],
}

/** The domain a signature is valid in, or null when the contract is not deployed here. */
export function orderDomain(chainId = REQUIRED_CHAIN_ID, verifyingContract = DEPLOYMENT ? DEPLOYMENT.limitOrders : null) {
  if (!verifyingContract) return null
  return { name: 'SwapexLimitOrders', version: '1', chainId, verifyingContract }
}

/**
 * minAmountOut for a limit price (tokenOut per whole tokenIn, decimal string).
 * Integer math only: priceRaw is tokenOut base units per whole tokenIn, scaled by
 * amountIn / 10^decimalsIn. Returns null for invalid input or a floor of zero
 * (the contract rejects minAmountOut == 0).
 */
export function minAmountOutFor(amountIn, price, decimalsIn, decimalsOut) {
  if (!amountIn || amountIn <= 0n) return null
  const priceRaw = parseAmount(price, decimalsOut)
  if (!priceRaw) return null
  const scale = 10n ** BigInt(decimalsIn)
  const minOut = (priceRaw * amountIn) / scale
  return minOut > 0n ? minOut : null
}

/** The order's effective price (minAmountOut per whole tokenIn) as a display string. */
export function orderPrice(amountIn, minAmountOut, decimalsIn, decimalsOut) {
  if (!amountIn || amountIn <= 0n) return null
  const scale = 10n ** BigInt(decimalsIn)
  const priceRaw = (BigInt(minAmountOut) * scale) / BigInt(amountIn)
  return formatAmount(priceRaw, decimalsOut, 8)
}

/**
 * A fresh nonce for a new order: time-based (revoke once, dead forever — same
 * mental model as the app's transaction deadlines) plus a random tail so two
 * orders signed in the same millisecond never collide.
 */
export function newNonce(nowMs = Date.now(), rand = Math.random()) {
  return BigInt(nowMs) * 1_000_000n + BigInt(Math.floor(rand * 1_000_000))
}

/** bigint signing message -> the decimal-string order payload for POST /orders (fee tier is not signed). */
export function orderBody(message, fee) {
  return {
    order: {
      maker: message.maker,
      tokenIn: message.tokenIn,
      tokenOut: message.tokenOut,
      amountIn: message.amountIn.toString(),
      minAmountOut: message.minAmountOut.toString(),
      expiry: message.expiry.toString(),
      nonce: message.nonce.toString(),
      receiver: message.receiver,
    },
    fee,
  }
}

/** "4m left" / "expired" for an order expiry (unix seconds). */
export function formatTimeLeft(expiry, nowSec = Math.floor(Date.now() / 1000)) {
  const d = Number(expiry) - nowSec
  if (!Number.isFinite(d) || d <= 0) return 'expired'
  if (d < 90) return `${d}s left`
  const m = Math.floor(d / 60)
  if (m < 90) return `${m}m left`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h left`
  return `${Math.floor(h / 24)}d left`
}
