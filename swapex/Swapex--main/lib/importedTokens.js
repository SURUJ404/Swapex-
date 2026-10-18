// Tokens the user imported by address, persisted per chain in localStorage.
// Unknown addresses are dangerous (anyone can mint a token with any name), so the modal
// warns before importing and this list is what the UI treats as "known from now on".
import { REQUIRED_CHAIN_ID } from './config'

const MAX_IMPORTED = 50
const ADDRESS = /^0x[0-9a-fA-F]{40}$/

function defaultStorage() {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

function storageKey(chainId) {
  return `swapex:imported-tokens:${chainId}`
}

function validEntry(t) {
  return (
    t &&
    typeof t.address === 'string' &&
    ADDRESS.test(t.address) &&
    typeof t.symbol === 'string' &&
    t.symbol.length > 0 &&
    typeof t.name === 'string' &&
    Number.isInteger(t.decimals) &&
    t.decimals >= 0 &&
    t.decimals <= 255
  )
}

/** Imported tokens for `chainId`; [] when storage is unavailable or the data is corrupt. */
export function loadImportedTokens(chainId = REQUIRED_CHAIN_ID, storage = defaultStorage()) {
  if (!storage) return []
  try {
    const raw = storage.getItem(storageKey(chainId))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(validEntry) : []
  } catch {
    return []
  }
}

/** Upsert `token` (by address, case-insensitive) and persist. Returns the updated list. */
export function saveImportedToken(token, chainId = REQUIRED_CHAIN_ID, storage = defaultStorage()) {
  if (!validEntry(token)) return loadImportedTokens(chainId, storage)
  const list = loadImportedTokens(chainId, storage).filter(
    (t) => t.address.toLowerCase() !== token.address.toLowerCase()
  )
  list.unshift({ address: token.address, symbol: token.symbol, name: token.name, decimals: token.decimals })
  const capped = list.slice(0, MAX_IMPORTED)
  if (storage) {
    try {
      storage.setItem(storageKey(chainId), JSON.stringify(capped))
    } catch {
      // quota / private mode: keep the in-memory result, just do not persist
    }
  }
  return capped
}

/** True when `address` is on the imported list for `chainId`. */
export function isImported(address, chainId = REQUIRED_CHAIN_ID, storage = defaultStorage()) {
  if (!address) return false
  return loadImportedTokens(chainId, storage).some((t) => t.address.toLowerCase() === address.toLowerCase())
}
