// Log scans the UI needs until the indexer exists. Every scan takes an explicit fromBlock:
// the position manager's Transfer events start at the deployment block in the manifest.
import { contractAt } from './client'
import { DEPLOYMENT } from '../config'

/** fromBlock for any log scan against the deployed contracts. */
export function deploymentBlock() {
  return DEPLOYMENT?.blockNumber || 0
}

/** Position NFT ids ever transferred to `owner` (includes ids since sold/burned — callers
 *  still verify ownership with ownerOf). Deduped, as strings. */
export async function positionIdsTransferredTo(library, owner, fromBlock) {
  const pm = contractAt('positionManager', library)
  const logs = await pm.queryFilter(pm.filters.Transfer(null, owner), fromBlock ?? deploymentBlock())
  return [...new Set(logs.map((l) => l.args.tokenId.toString()))]
}

/** Ids from `ids` that `owner` still owns (burned/foreign ids dropped). */
export async function ownedTokenIds(library, owner, ids) {
  const pm = contractAt('positionManager', library)
  const owned = []
  for (const id of ids) {
    try {
      if ((await pm.ownerOf(id)).toLowerCase() === owner.toLowerCase()) owned.push(id)
    } catch {
      // burned or nonexistent
    }
  }
  return owned
}
