import { createPublicClient, http, type PublicClient } from 'viem'

export type ChainClient = PublicClient

/**
 * Minimal viem public client for log/block reads.
 * cacheTime: 0 is required - viem caches getBlockNumber() by default, and a stale
 * head makes runOnce skip not-yet-indexed blocks while reporting "caught up"
 * (the cursor then sits behind the chain until the cache expires).
 */
export function createChainClient(rpcUrl: string): ChainClient {
  return createPublicClient({ transport: http(rpcUrl), cacheTime: 0 })
}
