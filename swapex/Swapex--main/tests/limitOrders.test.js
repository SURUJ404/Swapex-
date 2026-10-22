import { describe, it, expect } from 'vitest'
import { keccak256, stringToHex } from 'viem'
import {
  ORDER_TYPES,
  orderDomain,
  minAmountOutFor,
  orderPrice,
  newNonce,
  orderBody,
  formatTimeLeft,
} from '../lib/limitOrders'
import { REQUIRED_CHAIN_ID } from '../lib/config'

const WETH = '0x5FbDB2315678afecb367f032d93F642f64180aa3'
const USDC = '0x0165878A594ca255338adfa4d48449f69242Eb8F'

describe('ORDER_TYPES', () => {
  // The exact struct string SwapexLimitOrders hashes into ORDER_TYPEHASH; if the
  // field list drifts from the contract, every signature stops verifying.
  const CONTRACT_TYPE_STRING =
    'Order(address maker,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint256 expiry,uint256 nonce,address receiver)'

  it('encodes the contract type string exactly', () => {
    const encoded = `Order(${ORDER_TYPES.Order.map((f) => `${f.type} ${f.name}`).join(',')})`
    expect(encoded).toBe(CONTRACT_TYPE_STRING)
    // keccak of that string is the ORDER_TYPEHASH constant in the .sol
    expect(keccak256(stringToHex(encoded))).toMatch(/^0x[0-9a-f]{64}$/)
  })
})

describe('orderDomain', () => {
  it('returns null when the contract is not deployed on this chain', () => {
    expect(orderDomain(REQUIRED_CHAIN_ID, null)).toBeNull()
  })

  it('binds name, version, chainId and verifyingContract', () => {
    expect(orderDomain(31337, USDC)).toEqual({
      name: 'SwapexLimitOrders',
      version: '1',
      chainId: 31337,
      verifyingContract: USDC,
    })
  })
})

describe('minAmountOutFor', () => {
  it('scales a whole-token price by amountIn', () => {
    // 1 WETH at 2000 tUSDC (6 decimals) -> 2000e6
    expect(minAmountOutFor(10n ** 18n, '2000', 18, 6)).toBe(2000n * 10n ** 6n)
  })

  it('handles fractional amounts', () => {
    // 0.5 WETH at 1000.5 tUSDC -> 500.25e6
    expect(minAmountOutFor(5n * 10n ** 17n, '1000.5', 18, 6)).toBe(500250000n)
  })

  it('truncates sub-base-unit dust toward zero', () => {
    // 1 wei at any sane price floors to 0 base units
    expect(minAmountOutFor(1n, '1', 18, 6)).toBeNull()
  })

  it('returns null for invalid or zero input', () => {
    expect(minAmountOutFor(null, '2000', 18, 6)).toBeNull()
    expect(minAmountOutFor(0n, '2000', 18, 6)).toBeNull()
    expect(minAmountOutFor(10n ** 18n, '', 18, 6)).toBeNull()
    expect(minAmountOutFor(10n ** 18n, '0', 18, 6)).toBeNull()
    expect(minAmountOutFor(10n ** 18n, 'abc', 18, 6)).toBeNull()
    // price beyond the output decimals is truncated by parseAmount, not rounded up
    expect(minAmountOutFor(10n ** 18n, '0.0000001', 18, 6)).toBeNull()
  })
})

describe('orderPrice', () => {
  it('inverts minAmountOut to a per-whole-token price', () => {
    expect(orderPrice(10n ** 18n, 2000n * 10n ** 6n, 18, 6)).toBe('2000')
    expect(orderPrice(5n * 10n ** 17n, 1000n * 10n ** 6n, 18, 6)).toBe('2000')
  })

  it('returns null for a zero amount', () => {
    expect(orderPrice(0n, 1n, 18, 6)).toBeNull()
  })
})

describe('newNonce', () => {
  it('is a uint256-safe bigint built from time + randomness', () => {
    expect(newNonce(1700000000000, 0)).toBe(1700000000000n * 1_000_000n)
    expect(newNonce(1700000000000, 0.5)).toBe(1700000000000n * 1_000_000n + 500_000n)
    expect(typeof newNonce()).toBe('bigint')
  })

  it('never collides across orders signed in the same millisecond', () => {
    // deterministic sample across the random tail's whole space
    const seen = new Set()
    for (let i = 0; i < 1000; i++) seen.add(newNonce(1700000000000, i / 1000).toString())
    expect(seen.size).toBe(1000)
    // and a later millisecond can never reuse an earlier nonce value
    expect(newNonce(1700000000001, 0)).not.toBe(newNonce(1700000000000, 0.999999))
  })
})

describe('orderBody', () => {
  it('converts the signing message to decimal strings and keeps the unsigned fee', () => {
    const body = orderBody(
      {
        maker: '0xAAA',
        tokenIn: WETH,
        tokenOut: USDC,
        amountIn: 10n ** 18n,
        minAmountOut: 2000n * 10n ** 6n,
        expiry: 1700000000n,
        nonce: 42n,
        receiver: '0xAAA',
      },
      3000
    )
    expect(body).toEqual({
      order: {
        maker: '0xAAA',
        tokenIn: WETH,
        tokenOut: USDC,
        amountIn: '1000000000000000000',
        minAmountOut: '2000000000',
        expiry: '1700000000',
        nonce: '42',
        receiver: '0xAAA',
      },
      fee: 3000,
    })
    expect(body.order.nonce).toMatch(/^\d+$/)
  })
})

describe('formatTimeLeft', () => {
  const now = 1700000000
  it('says expired at or past the expiry', () => {
    expect(formatTimeLeft(now, now)).toBe('expired')
    expect(formatTimeLeft(now - 1, now)).toBe('expired')
  })

  it('formats seconds, minutes, hours and days', () => {
    expect(formatTimeLeft(now + 30, now)).toBe('30s left')
    expect(formatTimeLeft(now + 600, now)).toBe('10m left')
    expect(formatTimeLeft(now + 7200, now)).toBe('2h left')
    expect(formatTimeLeft(now + 3 * 86400, now)).toBe('3d left')
  })
})
