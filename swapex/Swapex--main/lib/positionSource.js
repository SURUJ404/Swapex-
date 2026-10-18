// Position-NFT id discovery for one account.
//
// Primary source: the indexer's GET /positions?owner= — one HTTP call instead of
// a Transfer-log scan over the whole chain history. Two safety properties:
//
// 1. Freshness: the indexer polls every couple of seconds, so events after its
//    cursor (e.g. a position minted moments ago) are not in the response yet.
//    The caller passes `gapFrom` (the indexer's cursor block) and we merge a
//    small Transfer-log scan from there to the chain head.
// 2. Fallback: the indexer not being configured, failing its request, being on
//    another chain, or simply returning no rows -> the full event scan, which is
//    exactly the pre-indexer behaviour.
//
// Returned ids are candidates only: callers verify ownership with ownerOf
// (ownedTokenIds/loadPosition), so a stale or foreign id can never surface a
// position the account does not own.

/** Ids from indexer `/positions` rows, non-empty tokenId strings only. */
export function positionIdsFromRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((r) => (r && r.tokenId != null ? String(r.tokenId) : null)).filter(Boolean)
}

/**
 * @param account owner address
 * @param fromIndexer (account) => { ids: string[], gapFrom: number|null } | null
 *                    null => indexer unusable (not configured, wrong chain, …)
 *                    throws => request failed; both fall back to the event scan
 * @param fromEvents (account, fromBlock?) => Promise<string[]> full or gap log scan
 * @returns { ids: string[], source: 'indexer' | 'events' }
 */
export async function discoverPositionIds(account, { fromIndexer = null, fromEvents }) {
  if (typeof fromIndexer === 'function') {
    try {
      const res = await fromIndexer(account)
      if (res && res.ids.length > 0) {
        const gap = res.gapFrom == null ? [] : await fromEvents(account, res.gapFrom)
        return { ids: [...new Set([...res.ids, ...gap])], source: 'indexer' }
      }
      // no rows: either nothing indexed for this owner or the indexer is behind
      // -> the full scan is the cheap correctness answer either way
    } catch {
      // transport / HTTP / chain mismatch: fall through to the event scan
    }
  }
  return { ids: await fromEvents(account), source: 'events' }
}
