// Local transaction log, scoped per chain + account, safe against corrupt storage.
const MAX_ENTRIES = 50

function key(chainId, account) {
  return `swapex_tx_v2:${chainId}:${(account || '').toLowerCase()}`
}

function read(chainId, account) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key(chainId, account)) || '[]')
    return Array.isArray(parsed) ? parsed.filter((t) => t && typeof t.hash === 'string') : []
  } catch {
    return []
  }
}

function write(chainId, account, list) {
  try {
    localStorage.setItem(key(chainId, account), JSON.stringify(list.slice(-MAX_ENTRIES)))
    window.dispatchEvent(new Event('swapex-tx'))
  } catch {
    /* storage unavailable or full: history is best-effort */
  }
}

export function getTransactions(chainId, account) {
  if (typeof window === 'undefined' || !account) return []
  return read(chainId, account)
}

export function addTransaction(chainId, account, { hash, label }) {
  if (!account || !hash) return
  const list = read(chainId, account).filter((t) => t.hash !== hash)
  list.push({ hash, label, status: 'pending', addedAt: Date.now() })
  write(chainId, account, list)
}

export function setTransactionStatus(chainId, account, hash, status) {
  const list = read(chainId, account).map((t) => (t.hash === hash ? { ...t, status } : t))
  write(chainId, account, list)
}
