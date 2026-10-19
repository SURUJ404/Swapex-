import { parseAbi, parseEventLogs, type Log } from 'viem'
import { ALL_EVENTS } from './abis'
import type { StoredEvent } from './db'

// viem needs parsed AbiEvent objects here, not raw human-readable strings.
const ABI = parseAbi(ALL_EVENTS as readonly string[])

/** Parsed logs carry eventName/args at runtime; viem's strict:false typing omits them. */
interface DecodedLog extends Log {
  eventName?: string
  args?: unknown
}

/** bigint → string (and deep) so event args survive JSON storage. */
export function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(jsonSafe)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, jsonSafe(v)]))
  }
  return value
}

export function logId(transactionHash: string, logIndex: number): string {
  return `${transactionHash}:${logIndex}`
}

/** Decode raw logs against the Swapex event set. Non-matching logs are dropped. */
export function decodeLogs(logs: Log[]): StoredEvent[] {
  const parsed = parseEventLogs({ abi: ABI, logs, strict: false }) as unknown as DecodedLog[]
  const out: StoredEvent[] = []
  for (const p of parsed) {
    if (!p.eventName || !p.transactionHash || p.logIndex == null || p.blockNumber == null || !p.blockHash) continue
    out.push({
      logId: logId(p.transactionHash, Number(p.logIndex)),
      blockNumber: Number(p.blockNumber),
      blockHash: p.blockHash,
      txHash: p.transactionHash,
      logIndex: Number(p.logIndex),
      address: p.address.toLowerCase(), // every query compares against lowercased params
      event: p.eventName,
      args: JSON.stringify(jsonSafe(p.args ?? {})),
    })
  }
  return out
}
