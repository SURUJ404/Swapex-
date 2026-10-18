import { loadConfig } from './config'

// Entry point. The indexer itself is the next phase: see prompts/01-next-phase.md, section 1.
const config = loadConfig()
console.log(`swapex-indexer skeleton: chain ${config.CHAIN_ID}, not implemented yet`)
