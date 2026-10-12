import { BigNumber } from 'ethers'

// Port of the contracts' from-scratch TickMath (contracts/src/libraries/TickMath.sol). Every
// intermediate is a BigInt (arbitrary precision) so the Q128 multiplications cannot overflow the
// way a fixed-width integer would; the result is returned as an ethers BigNumber.

export const MIN_TICK = -887272
export const MAX_TICK = 887272

const TWO_POW_256 = (1n << 256n) - 1n // type(uint256).max
const SHIFT_32 = 1n << 32n

const MULTIPLIERS = [
  [0x1, 0xfffcb933bd6fad37aa2d162d1a594001n],
  [0x2, 0xfff97272373d413259a46990580e2139n],
  [0x4, 0xfff2e50f5f656932ef12357cf3c7fdcbn],
  [0x8, 0xffe5caca7e10e4e61c3624eaa0941ccfn],
  [0x10, 0xffcb9843d60f6159c9db58835c926643n],
  [0x20, 0xff973b41fa98c081472e6896dfb254bfn],
  [0x40, 0xff2ea16466c96a3843ec78b326b52860n],
  [0x80, 0xfe5dee046a99a2a811c461f1969c3052n],
  [0x100, 0xfcbe86c7900a88aedcffc83b479aa3a3n],
  [0x200, 0xf987a7253ac413176f2b074cf7815e53n],
  [0x400, 0xf3392b0822b70005940c7a398e4b70f2n],
  [0x800, 0xe7159475a2c29b7443b29c7fa6e889d8n],
  [0x1000, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000, 0xa9f746462d870fdf8a65dc1f90e061e4n],
  [0x4000, 0x70d869a156d2a1b890bb3df62baf32f6n],
  [0x8000, 0x31be135f97d08fd981231505542fcfa5n],
  [0x10000, 0x9aa508b5b7a84e1c677de54f3e99bc8n],
  [0x20000, 0x5d6af8dedb81196699c329225ee604n],
  [0x40000, 0x2216e584f5fa1ea926041bedfe97n],
  [0x80000, 0x48a170391f7dc42444e8fa2n],
]

/** The sqrt price (Q96) at a tick: 1.0001^tick, as an ethers BigNumber. */
export function getSqrtRatioAtTick(tick) {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) {
    throw new Error(`tick out of range: ${tick}`)
  }
  const absTick = tick < 0 ? -tick : tick
  let ratio = 1n << 128n
  for (const [mask, multiplier] of MULTIPLIERS) {
    if (absTick & mask) ratio = (ratio * multiplier) >> 128n
  }
  // for positive ticks the price is the reciprocal
  if (tick > 0) ratio = TWO_POW_256 / ratio
  // Q128 -> Q96, rounding up so getSqrtRatioAtTick is the exact inverse of getTickAtSqrtRatio
  const sqrtPriceX96 = (ratio >> 32n) + (ratio % SHIFT_32 === 0n ? 0n : 1n)
  return BigNumber.from(sqrtPriceX96.toString())
}

/**
 * The full-range tick bounds for a given spacing: the widest [tickLower, tickUpper] that are exact
 * multiples of `tickSpacing` and still inside [MIN_TICK, MAX_TICK]. For spacing 60 that is
 * [-887220, 887220] — effectively the whole price space.
 */
export function fullRangeTicks(tickSpacing) {
  const s = Number(tickSpacing)
  if (!Number.isInteger(s) || s <= 0) throw new Error(`invalid tickSpacing: ${tickSpacing}`)
  const tickLower = Math.ceil(MIN_TICK / s) * s
  const tickUpper = Math.floor(MAX_TICK / s) * s
  return { tickLower, tickUpper }
}
