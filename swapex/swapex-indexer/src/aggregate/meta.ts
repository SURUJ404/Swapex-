// Token metadata: manifest tokens first, on-chain ERC-20 reads (cached) for
// anything else the pools reference. Injected into the aggregate layer so
// tests never need an RPC.
import { createPublicClient, http, parseAbi } from 'viem'
import type { Manifest } from '../deployment'
import type { TokenMeta, TokenMetaProvider } from './prices'

const ERC20 = parseAbi([
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function decimals() view returns (uint8)',
])

export function createTokenMetaProvider(manifest: Manifest, rpcUrl: string): TokenMetaProvider {
  const known = new Map(manifest.tokens.map((t) => [t.address.toLowerCase(), { ...t } as TokenMeta]))
  const client = createPublicClient({ transport: http(rpcUrl) })
  const inflight = new Map<string, Promise<TokenMeta>>()

  return async (address: string): Promise<TokenMeta> => {
    const key = address.toLowerCase()
    const hit = known.get(key)
    if (hit) return hit
    const existing = inflight.get(key)
    if (existing) return existing

    const pending = (async () => {
      const contract = { address: key as `0x${string}`, abi: ERC20 }
      const [symbol, name, decimals] = await Promise.all([
        client.readContract({ ...contract, functionName: 'symbol' }),
        client.readContract({ ...contract, functionName: 'name' }),
        client.readContract({ ...contract, functionName: 'decimals' }),
      ])
      const meta: TokenMeta = { address: key, symbol, name, decimals: Number(decimals) }
      known.set(key, meta)
      return meta
    })()
    inflight.set(key, pending)
    try {
      return await pending
    } finally {
      inflight.delete(key)
    }
  }
}
