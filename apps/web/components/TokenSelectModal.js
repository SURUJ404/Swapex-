import React, { useState } from 'react'
import { DialogOverlay, DialogContent } from '@reach/dialog'
import '@reach/dialog/styles.css'
import { TOKEN_LIST } from '../constants'

export default function TokenSelectModal({ open, onClose, onSelect }) {
  const [search, setSearch] = useState('')

  const filtered = TOKEN_LIST.filter(
    (t) =>
      t.symbol.toLowerCase().includes(search.toLowerCase()) ||
      t.name.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <DialogOverlay isOpen={open} onDismiss={onClose} className="z-50">
      <DialogContent
        aria-label="Select a token"
        className="!bg-[var(--bg-card)] !border !border-[var(--border)] !rounded-2xl !p-0 !w-full !max-w-sm !m-4"
      >
        <div className="p-4 border-b border-[var(--border)]">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold font-display text-[var(--text-primary)]">Select a Token</h2>
            <button onClick={onClose} className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] text-xl">
              &times;
            </button>
          </div>
          <input
            type="text"
            placeholder="Search by name or symbol"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)] text-[var(--text-primary)] text-sm outline-none focus:border-[var(--accent)]"
          />
        </div>
        <div className="max-h-72 overflow-y-auto p-2">
          {filtered.map((token) => (
            <button
              key={token.address}
              onClick={() => {
                onSelect(token)
                onClose()
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
        </div>
      </DialogContent>
    </DialogOverlay>
  )
}
