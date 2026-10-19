// EIP-712 definitions for SwapexLimitOrders, shared by the API (verification) and its tests.
// Must match swapex-contracts/src/periphery/SwapexLimitOrders.sol: ORDER_TYPEHASH and DOMAIN_TYPEHASH.

import type { TypedDataDomain } from 'viem'

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
} as const

export interface OrderMessage {
  maker: `0x${string}`
  tokenIn: `0x${string}`
  tokenOut: `0x${string}`
  amountIn: bigint
  minAmountOut: bigint
  expiry: bigint
  nonce: bigint
  receiver: `0x${string}`
}

export function orderDomain(chainId: number, verifyingContract: `0x${string}`): TypedDataDomain {
  return { name: 'SwapexLimitOrders', version: '1', chainId, verifyingContract }
}

/** IERC-1271 isValidSignature + the magic value a smart-wallet must return. */
export const ERC1271_ABI = [
  {
    type: 'function',
    name: 'isValidSignature',
    stateMutability: 'view',
    inputs: [
      { name: 'hash', type: 'bytes32' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [{ name: 'magicValue', type: 'bytes4' }],
  },
] as const

export const ERC1271_MAGIC = '0x1626ba7e'
