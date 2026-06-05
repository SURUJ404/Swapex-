import React, { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { useWeb3 } from '../context/Web3Context'
import Footer from './Footer'
import WalletModal from './WalletModal'

const tabOrder = [
  { path: '/swap', label: 'Swap' },
  { path: '/send', label: 'Send' },
  { path: '/pool', label: 'Pool' },
]

export default function Layout({ children }) {
  const router = useRouter()
  const { active, account, disconnectWallet, ensName } = useWeb3()
  const [showWalletModal, setShowWalletModal] = useState(false)

  const isPoolActive = ['/pool', '/add', '/remove', '/create'].includes(router.pathname)
  const currentTabIndex = tabOrder.findIndex(({ path }) =>
    path === '/pool' ? isPoolActive : router.pathname === path
  )

  return (
    <div className="min-h-screen bg-[var(--bg-primary)] text-[var(--text-primary)] flex flex-col">
      <header className="border-b border-[var(--border)] sticky top-0 z-40 bg-[var(--bg-primary)]">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <Link href="/swap" className="flex items-center hover:opacity-80 transition-opacity no-underline">
            <span className="text-lg font-semibold tracking-tight text-[var(--accent)]" style={{ fontFamily: 'var(--font-display)' }}>
              Swapex
            </span>
          </Link>

          <div className="flex items-center gap-3">
            {active ? (
              <div className="flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-[var(--success)]"></div>
                <span className="text-sm text-[var(--text-secondary)] font-medium">{ensName || `${account?.slice(0, 6)}...${account?.slice(-4)}`}</span>
                <button
                  onClick={disconnectWallet}
                  className="px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] border border-[var(--border)] rounded-full hover:bg-[var(--bg-card)] transition-colors"
                >
                  Disconnect
                </button>
              </div>
            ) : (
              <button
                onClick={() => setShowWalletModal(true)}
                className="px-4 py-2 text-sm font-medium text-white bg-[var(--accent)] rounded-full hover:bg-[var(--accent-hover)] transition-colors"
              >
                Connect Wallet
              </button>
            )}
            <WalletModal
              isOpen={showWalletModal}
              onClose={() => setShowWalletModal(false)}
            />
          </div>
        </div>
      </header>

      <div className="max-w-xl mx-auto w-full px-4 py-6">
        <div className="flex items-center gap-1 bg-[var(--bg-secondary)] rounded-2xl p-1 mb-6 border border-[var(--border)] w-fit">
          {tabOrder.map(({ path, label }, index) => {
            const isActive = index === currentTabIndex
            const href = path === '/pool' ? '/pool' : path
            return (
              <Link
                key={path}
                href={href}
                className={`px-6 py-1.5 rounded-xl text-sm font-medium transition-all no-underline ${
                  isActive
                    ? 'bg-[var(--bg-card)] text-[var(--text-primary)] border border-[var(--border)] shadow-sm'
                    : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)]'
                }`}
              >
                {label}
              </Link>
            )
          })}
        </div>

        <main className="w-full">{children}</main>
      </div>

      <Footer />
    </div>
  )
}
