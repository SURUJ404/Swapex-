import React, { useState } from 'react'
import { DialogOverlay, DialogContent } from '@reach/dialog'
import '@reach/dialog/styles.css'
import { useWeb3 } from '../context/Web3Context'
import { searchTokens, findToken, tokenLogo } from '../lib/tokens'
import { saveImportedToken } from '../lib/importedTokens'
import { getTokenMeta } from '../lib/tokenMeta'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/

export default function TokenSelectModal({ open, onClose, onSelect, filter }) {
  const { clients } = useWeb3()
  const publicClient = clients?.public
  const [search, setSearch] = useState('')
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState(null)

  const query = search.trim()
  const results = searchTokens(query).filter(filter || (() => true))
  const isAddress = ADDRESS.test(query)
  const known = isAddress ? findToken(query) : null
  const canImport = isAddress && !known

  const doImport = async () => {
    if (!publicClient || importing) return
    setImporting(true)
    setImportError(null)
    try {
      const meta = await getTokenMeta(publicClient, query)
      const entry = {
        address: meta.address,
        symbol: meta.symbol,
        name: meta.name,
        decimals: meta.decimals,
        logo: tokenLogo(meta.symbol),
      }
      saveImportedToken(entry)
      onSelect(entry)
      onClose()
      setSearch('')
    } catch {
      setImportError('Could not read this token on-chain. Check the address and your network.')
    } finally {
      setImporting(false)
    }
  }

  return (
    <DialogOverlay
      isOpen={open}
      onDismiss={() => {
        onClose()
        setSearch('')
        setImportError(null)
      }}
      className="z-50"
    >
      <DialogContent
        aria-label="Select a token"
        className="!bg-[var(--bg-card)] !border !border-[var(--border)] !rounded-2xl !p-0 !w-full !max-w-sm !m-4"
      >
        <div className="p-4 border-b border-[var(--border)]">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold font-display text-[var(--text-primary)]">Select a Token</h2>
            <button
              onClick={() => {
                onClose()
                setSearch('')
                setImportError(null)
              }}
              className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] text-xl"
            >
              &times;
            </button>
          </div>
          <input
            type="text"
            placeholder="Search by name, symbol or paste address"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setImportError(null)
            }}
            className="w-full px-3 py-2 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)] text-[var(--text-primary)] text-sm outline-none focus:border-[var(--accent)]"
          />
        </div>
        <div className="max-h-72 overflow-y-auto p-2">
          {results.map((token) => (
            <button
              key={token.address}
              onClick={() => {
                onSelect(token)
                onClose()
                setSearch('')
              }}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-[var(--bg-secondary)] transition-colors text-left"
            >
              <img src={token.logo} alt={token.symbol} className="w-8 h-8 rounded-full" />
              <div className="flex flex-col">
                <span className="font-medium text-sm text-[var(--text-primary)]">{token.symbol}</span>
                <span className="text-xs text-[var(--text-tertiary)]">{token.name}</span>
              </div>
            </button>
          ))}

          {canImport && (
            <div className="m-1 rounded-xl border border-yellow-500/40 bg-yellow-500/10 p-3">
              <div className="text-sm font-semibold text-yellow-500 mb-1">Import unknown token</div>
              <p className="text-xs text-yellow-500/90 mb-2">
                This token is not on the list for this network. Anyone can create a token with any name and
                symbol. Import it only if you trust the source. Some tokens also take a fee on every transfer,
                which the amounts here will not account for.
              </p>
              <div className="font-mono text-xs text-[var(--text-tertiary)] mb-2 break-all">{query}</div>
              {importError && <div className="text-xs text-[var(--danger)] mb-2">{importError}</div>}
              <button
                onClick={doImport}
                disabled={!publicClient || importing}
                className="w-full py-2 rounded-lg text-xs font-semibold bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {!publicClient ? 'Connect a wallet to import' : importing ? 'Reading on-chain…' : 'Import'}
              </button>
            </div>
          )}

          {query && !results.length && !canImport && (
            <div className="px-3 py-6 text-center text-sm text-[var(--text-tertiary)]">No tokens found</div>
          )}
        </div>
      </DialogContent>
    </DialogOverlay>
  )
}
