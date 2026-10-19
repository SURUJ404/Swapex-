import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'

const tokenSchema = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  symbol: z.string(),
  name: z.string(),
  decimals: z.number().int().nonnegative(),
})

const manifestSchema = z.object({
  chainId: z.number().int().positive(),
  blockNumber: z.number().int().nonnegative().default(0),
  factory: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  positionManager: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  // written by Deploy.s.sol since the limit-order phase; optional so manifests
  // from older deployments still load (the orders endpoints then report it absent)
  limitOrders: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  tokens: z.array(tokenSchema).default([]),
})

export type Manifest = z.infer<typeof manifestSchema>

/** Sibling seed manifest written by SeedTestnet.s.sol (deployments/<id>.seed.json). */
function seedPathFor(manifestPath: string): string {
  return manifestPath.endsWith('.json') ? `${manifestPath.slice(0, -'.json'.length)}.seed.json` : `${manifestPath}.seed.json`
}

/**
 * Tokens from the seed manifest, merged under the main manifest's own tokens.
 * Deploy.s.sol writes no token list; SeedTestnet.s.sol writes the test tokens to
 * the sibling file (scripts/export-abis.sh merges the same way for the web app).
 * Without this merge there are no stable-coin anchors and every USD price is null.
 */
function mergeSeedTokens(tokens: z.infer<typeof tokenSchema>[], manifestPath: string): z.infer<typeof tokenSchema>[] {
  const seedPath = seedPathFor(manifestPath)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(seedPath, 'utf8'))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return tokens
    throw new Error(`Cannot read seed manifest at ${seedPath}: ${(e as Error).message}`)
  }
  const parsed = z.object({ tokens: z.array(tokenSchema) }).safeParse(raw)
  if (!parsed.success) throw new Error(`Invalid seed manifest at ${seedPath}: ${parsed.error.message}`)
  const seen = new Set(tokens.map((t) => t.address.toLowerCase()))
  const merged = [...tokens]
  for (const t of parsed.data.tokens) {
    const key = t.address.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(t)
  }
  return merged
}

/**
 * Load and validate the deployment manifest written by swapex-contracts.
 * Path resolution: DEPLOYMENT_PATH env wins; otherwise ../swapex-contracts/deployments/<chainId>.json
 * relative to the indexer package.
 */
export function loadManifest(chainId: number, env: Record<string, string | undefined> = process.env): Manifest {
  const path =
    env.DEPLOYMENT_PATH ||
    resolve(process.cwd(), '..', 'swapex-contracts', 'deployments', `${chainId}.json`)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    throw new Error(`Cannot read deployment manifest at ${path}: ${(e as Error).message}`)
  }
  const parsed = manifestSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(`Invalid deployment manifest at ${path}: ${parsed.error.message}`)
  }
  if (parsed.data.chainId !== chainId) {
    throw new Error(`Manifest at ${path} is for chain ${parsed.data.chainId}, expected ${chainId}`)
  }
  return { ...parsed.data, tokens: mergeSeedTokens(parsed.data.tokens, path) }
}
