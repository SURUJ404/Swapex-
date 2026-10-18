import { loadConfig } from './config'
import { openDb } from './db'
import { createChainClient } from './chain'
import { loadManifest } from './deployment'
import { runOnce } from './indexer'
import { createTokenMetaProvider } from './aggregate/meta'
import { buildServer } from './api/server'

const config = loadConfig()
const db = openDb(config.DATABASE_PATH)
const client = createChainClient(config.RPC_URL)
const manifest = loadManifest(config.CHAIN_ID)
const meta = createTokenMetaProvider(manifest, config.RPC_URL)

console.log(
  `swapex-indexer: chain ${config.CHAIN_ID}, factory ${manifest.factory}, db ${config.DATABASE_PATH}, poll ${config.POLL_INTERVAL_MS}ms`
)

async function indexLoop(): Promise<void> {
  for (;;) {
    try {
      const result = await runOnce(client, db, manifest, config.REORG_DEPTH)
      if (result) {
        console.log(`indexed blocks ${result.from}..${result.to} (head ${result.head}, ${result.events} events)`)
      }
    } catch (e) {
      console.error('index pass failed:', e)
    }
    await new Promise((resolve) => setTimeout(resolve, config.POLL_INTERVAL_MS))
  }
}

async function main(): Promise<void> {
  const app = await buildServer({
    db,
    manifest,
    chainId: config.CHAIN_ID,
    corsOrigins: config.CORS_ORIGINS,
    meta,
  })
  await app.listen({ port: config.PORT, host: '0.0.0.0' })
  console.log(`api listening on :${config.PORT}`)
  await indexLoop()
}

main().catch((e) => {
  console.error('fatal:', e)
  process.exit(1)
})
