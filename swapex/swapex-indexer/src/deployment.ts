import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'

const manifestSchema = z.object({
  chainId: z.number().int().positive(),
  blockNumber: z.number().int().nonnegative().default(0),
  factory: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  positionManager: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  tokens: z
    .array(
      z.object({
        address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
        symbol: z.string(),
        name: z.string(),
        decimals: z.number().int().nonnegative(),
      })
    )
    .default([]),
})

export type Manifest = z.infer<typeof manifestSchema>

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
  return parsed.data
}
