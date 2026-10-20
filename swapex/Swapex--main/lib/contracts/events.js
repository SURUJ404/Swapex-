// Log scans the UI needs until the indexer exists. Every scan takes an explicit fromBlock:
// the position manager's Transfer events start at the deployment block in the manifest.
import { parseAbiItem } from 'viem'
import { coreContract } from './client'
import { DEPLOYMENT } from '../config'

const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)')

/** fromBlock for any log scan against the deployed contracts. */
export function deploymentBlock() {
  return DEPLOYMENT?.blockNumber || 0
}

/** Position NFT ids ever transferred to `owner` (includes ids since sold/burned — callers
 *  still verify ownership with ownerOf). Deduped, as strings. */
export async function positionIdsTransferredTo(client, owner, fromBlock) {
  const logs = await client.getLogs({
    ...coreContract('positionManager'),
    event: TRANSFER_EVENT,
    args: { to: owner },
    fromBlock: BigInt(fromBlock ?? deploymentBlock()),
  })
  return [...new Set(logs.map((l) => l.args.tokenId.toString()))]
}

/** Ids from `ids` that `owner` still owns (burned/foreign ids dropped). */
export async function ownedTokenIds(client, owner, ids) {
  const pm = coreContract('positionManager')
  const owned = []
  for (const id of ids) {
    try {
      const current = await client.readContract({ ...pm, functionName: 'ownerOf', args: [BigInt(id)] })
      if (current.toLowerCase() === owner.toLowerCase()) owned.push(id)
    } catch {
      // burned or nonexistent
    }
  }
  return owned
}
