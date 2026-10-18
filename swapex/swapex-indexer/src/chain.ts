import { createPublicClient, http, type PublicClient } from 'viem'

export type ChainClient = PublicClient

/** Minimal viem public client for log/block reads. */
export function createChainClient(rpcUrl: string): ChainClient {
  return createPublicClient({ transport: http(rpcUrl) })
}
