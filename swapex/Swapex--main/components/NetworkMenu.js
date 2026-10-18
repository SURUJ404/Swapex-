import React, { useState, useEffect, useRef, useCallback } from 'react'
import { CHAINS, REQUIRED_CHAIN_ID, ALLOW_MAINNET } from '../lib/config'
import { getDeployment } from '../lib/deployments'
import { useWeb3 } from '../context/Web3Context'

const NETWORKS = Object.entries(CHAINS)
  .map(([id, c]) => ({ id: Number(id), ...c }))
  .filter((c) => ALLOW_MAINNET || c.id !== 1)
  .sort((a, b) => (a.id === REQUIRED_CHAIN_ID ? -1 : b.id === REQUIRED_CHAIN_ID ? 1 : a.name.localeCompare(b.name)))

function chainStatus(id) {
  return getDeployment(id) ? 'Deployed' : 'Not deployed'
}

export default function NetworkMenu() {
  const { active, chainId, switchTo } = useWeb3()
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  const close = useCallback(() => setOpen(false), [])

  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) close()
    }
    const onKey = (e) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, close])

  const current = chainId && CHAINS[chainId]
  const label = !active ? 'Network' : current ? current.name : 'Wrong network'
  const isCurrent = (id) => Number(chainId) === id

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Select network"
        className={`px-3 py-1.5 text-xs font-medium border rounded-full transition-colors ${
          active && !current
            ? 'text-[var(--danger)] border-[var(--danger)]'
            : 'text-[var(--text-secondary)] border-[var(--border)] hover:bg-[var(--bg-card)]'
        }`}
      >
        {label}
        <span className="ml-1.5">&#9662;</span>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Networks"
          className="absolute right-0 mt-2 w-64 rounded-xl border border-[var(--border)] bg-[var(--bg-card)] shadow-lg p-1 z-50"
        >
          {!active && (
            <div className="px-3 py-2 text-xs text-[var(--text-tertiary)]">Connect a wallet to switch networks.</div>
          )}
          {NETWORKS.map((n) => {
            const selected = isCurrent(n.id)
            const deployed = Boolean(getDeployment(n.id))
            return (
              <button
                key={n.id}
                role="menuitem"
                disabled={!active || selected}
                onClick={async () => {
                  close()
                  await switchTo(n.id)
                }}
                className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-left text-sm transition-colors ${
                  selected ? 'bg-[var(--bg-secondary)]' : 'hover:bg-[var(--bg-secondary)]'
                } ${!active || selected ? 'opacity-70 cursor-default' : 'cursor-pointer'}`}
              >
                <span className="flex items-center gap-2 min-w-0">
                  <span className="text-[var(--text-primary)] truncate">{n.name}</span>
                  {n.testnet && (
                    <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium bg-[var(--secondary)]/15 text-[var(--secondary)]">
                      Testnet
                    </span>
                  )}
                </span>
                <span
                  className={`shrink-0 text-[10px] ${deployed ? 'text-[var(--success)]' : 'text-[var(--text-tertiary)]'}`}
                >
                  {chainStatus(n.id)}
                  {selected ? ' •' : ''}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
