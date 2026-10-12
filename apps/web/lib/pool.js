import { BigNumber, Contract, utils } from 'ethers'
import {
  POOL_MANAGER_ADDRESS,
  QUOTER_ADDRESS,
  POOL_MANAGER_ABI,
  QUOTER_ABI,
  POOL_FEE,
  POOL_TICK_SPACING,
  POOL_HOOKS,
  NATIVE_ADDRESS,
  ZERO_ADDRESS,
  MIN_SQRT_RATIO,
  MAX_SQRT_RATIO,
} from '../constants'

const Q96 = BigNumber.from(2).pow(96)

/** The on-chain currency address for a token entry (native ETH maps to address(0)). */
export function toCurrencyAddress(token) {
  if (!token) return null
  return token.address === NATIVE_ADDRESS ? ZERO_ADDRESS : token.address
}

/** Sort two currency addresses so currency0 < currency1, as the manager requires. */
export function sortCurrencies(a, b) {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a]
}

/** Build the PoolKey identifying the pool for a token pair (single fee tier, no hooks). */
export function buildPoolKey(tokenA, tokenB) {
  const a = toCurrencyAddress(tokenA)
  const b = toCurrencyAddress(tokenB)
  const [currency0, currency1] = sortCurrencies(a, b)
  return {
    currency0,
    currency1,
    fee: POOL_FEE,
    tickSpacing: POOL_TICK_SPACING,
    hooks: POOL_HOOKS,
  }
}

/** True when `tokenIn` is currency0 of the pool (so the swap is zeroForOne). */
export function isZeroForOne(key, tokenIn) {
  return key.currency0.toLowerCase() === toCurrencyAddress(tokenIn).toLowerCase()
}

/** Deterministic pool id (keccak of the tightly-packed key), used for reads / display. */
export function poolId(key) {
  return utils.keccak256(
    utils.solidityPack(
      ['address', 'address', 'uint24', 'int24', 'address'],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]
    )
  )
}

/** The manager's strict price-limit bounds: one tick inside MIN/MAX means "no limit". */
export function sqrtPriceLimitX96(zeroForOne) {
  return zeroForOne
    ? BigNumber.from(MIN_SQRT_RATIO).add(1)
    : BigNumber.from(MAX_SQRT_RATIO).sub(1)
}

/** Human-readable price of token1 per token0 from a Q96 sqrt price and the two decimals. */
export function priceFromSqrt(sqrtPriceX96, dec0, dec1) {
  try {
    const sqrtP = BigNumber.from(sqrtPriceX96)
    // price_raw = (sqrtP / 2^96)^2; scale by 10^(dec0-dec1) and 1e18 to keep precision.
    const num = sqrtP.mul(sqrtP)
    const den = Q96.mul(Q96)
    const scale = BigNumber.from(10).pow(18 + Number(dec0) - Number(dec1))
    const scaled = num.mul(scale).div(den)
    return Number(utils.formatUnits(scaled, 18))
  } catch {
    return null
  }
}

/** Read the live pool state (sqrt price, tick, in-range liquidity) for a key. */
export async function getPoolState(library, key) {
  const pm = new Contract(POOL_MANAGER_ADDRESS, POOL_MANAGER_ABI, library)
  const [sqrtPriceX96, tick] = await pm.getSlot0(key)
  const liquidity = await pm.getLiquidity(key)
  const price = priceFromSqrt(sqrtPriceX96, 18, 18)
  return { sqrtPriceX96, tick, liquidity, price }
}

/**
 * Simulate an exact-input single swap via the on-chain Quoter and return the signed deltas plus
 * the output amount (the positive delta's magnitude). A static call — no state is committed and
 * no balance or allowance is required.
 */
export async function quoteExactInputSingle(library, key, zeroForOne, amountIn) {
  const quoter = new Contract(QUOTER_ADDRESS, QUOTER_ABI, library)
  const sp = {
    zeroForOne,
    amountSpecified: BigNumber.from(amountIn),
    sqrtPriceLimitX96: sqrtPriceLimitX96(zeroForOne),
  }
  const [a0, a1] = await quoter.callStatic.quoteExactInputSingle(key, sp)
  const amountOut = zeroForOne ? a1 : a0
  return { amount0: a0, amount1: a1, amountOut }
}
