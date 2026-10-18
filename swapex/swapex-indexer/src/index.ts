import { loadConfig } from './config'
import { openDb } from './db'
import { createChainClient } from './chain'
import { loadManifest } from './deployment'
import { runOnce } from './indexer'

const config = loadConfig()
const db = openDb(config.DATABASE_PATH)
const client = createChainClient(config.RPC_URL)
const manifest = loadManifest(config.CHAIN_ID)

console.log(
  `swapex-indexer: chain ${config.CHAIN_ID}, factory ${manifest.factory}, db ${config.DATABASE_PATH}, poll ${config.POLL_INTERVAL_MS}ms`
)

async function loop(): Promise<void> {
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

loop()
