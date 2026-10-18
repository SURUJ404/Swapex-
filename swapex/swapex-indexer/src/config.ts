import { z } from 'zod'

const schema = z.object({
  CHAIN_ID: z.coerce.number().int().positive(),
  RPC_URL: z.string().url(),
  DATABASE_PATH: z.string().default('./data/indexer.db'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  REORG_DEPTH: z.coerce.number().int().min(1).max(256).default(12),
})

export type Config = Omit<z.infer<typeof schema>, 'CORS_ORIGINS'> & { CORS_ORIGINS: string[] }

/** Parse and validate the environment. Throws a readable error instead of starting misconfigured. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.parse(env)
  const origins = parsed.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  if (origins.includes('*')) throw new Error('CORS_ORIGINS must be an explicit list, not "*"')
  return { ...parsed, CORS_ORIGINS: origins }
}
