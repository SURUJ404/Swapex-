import React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { useWeb3 } from '../context/Web3Context'
import Footer from './Footer'
import TransactionHistory from './TransactionHistory'
import TestnetBanner from './TestnetBanner'
import WalletModal from './WalletModal'
import ThemeToggle from './ThemeToggle'

const NAV = [
  { href: '/', label: 'Swap', match: (p) => ['/', '/send', '/limit'].includes(p) },
  { href: '/explore', label: 'Explore', match: (p) => p.startsWith('/explore') },
  { href: '/pool', label: 'Pool', match: (p) => ['/pool', '/add', '/remove', '/create'].includes(p) },
  { href: '/portfolio', label: 'Portfolio', match: (p) => p.startsWith('/portfolio') },
]

const SWAP_SUBTABS = [
  { path: '/', label: 'Swap' },
  { path: '/limit', label: 'Limit' },
  { path: '/send', label: 'Send' },
]

const WIDE_ROUTES = ['/explore', '/portfolio', '/pool']
export default function Layout({ children }) {
  const router = useRouter()
  const { active, account, disconnectWallet, ensName, walletModalOpen: showWalletModal, setWalletModalOpen: setShowWalletModal } = useWeb3()

  const path = router.pathname
  const isSwapFamily = SWAP_SUBTABS.some((t) => t.path === path)
  const wide = WIDE_ROUTES.some((r) => path.startsWith(r))

  return (
    <div className="min-h-screen bg-[var(--bg-primary)] text-[var(--text-primary)] flex flex-col">
      <TestnetBanner />
      <header className="sticky top-0 z-40 bg-[var(--bg-primary)]/90 backdrop-blur border-b border-[var(--border)]">
        <div className="max-w-7xl mx-auto px-4 h-16 grid grid-cols-[auto_1fr_auto] items-center gap-4">
          <Link href="/" className="no-underline hover:opacity-80 transition-opacity">
            <span className="text-lg font-semibold tracking-tight text-[var(--accent)]">Swapex</span>
          </Link>

          <nav aria-label="Primary" className="hidden md:flex items-center justify-center gap-1">
            {NAV.map(({ href, label, match }) => (
              <Link
                key={href}
                href={href}
                aria-current={match(path) ? 'page' : undefined}
                className={`px-4 py-2 rounded-full text-sm font-medium no-underline transition-colors ${
                  match(path)
                    ? 'bg-[var(--bg-card)] text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                {label}
              </Link>
            ))}
          </nav>

          <div className="flex items-center gap-2 justify-self-end">
            <ThemeToggle />
            {active ? (
              <div className="flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-[var(--success)]" />
                <span className="text-sm text-[var(--text-secondary)] font-medium">
                  {ensName || `${account?.slice(0, 6)}...${account?.slice(-4)}`}
                </span>
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
            <WalletModal isOpen={showWalletModal} onClose={() => setShowWalletModal(false)} />
          </div>
        </div>
      </header>

      <div className={`${wide ? 'max-w-5xl' : 'max-w-xl'} mx-auto w-full px-4 py-6 pb-24 md:pb-6`}>
        {isSwapFamily && (
          <div className="flex items-center gap-1 mb-4 w-fit">
            {SWAP_SUBTABS.map(({ path: p, label }) => (
              <Link
                key={p}
                href={p}
                aria-current={path === p ? 'page' : undefined}
                className={`px-4 py-1.5 rounded-full text-sm font-medium no-underline transition-colors ${
                  path === p ? 'bg-[var(--bg-card)] text-[var(--text-primary)]' : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)]'
                }`}
              >
                {label}
              </Link>
            ))}
          </div>
        )}
        <main className="w-full">{children}</main>
        <div className="mt-6"><TransactionHistory /></div>
      </div>

      <nav aria-label="Primary mobile" className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-[var(--bg-primary)] border-t border-[var(--border)] flex justify-around py-2">
        {NAV.map(({ href, label, match }) => (
          <Link
            key={href}
            href={href}
            aria-current={match(path) ? 'page' : undefined}
            className={`px-3 py-2 text-xs font-medium no-underline ${match(path) ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]'}`}
          >
            {label}
          </Link>
        ))}
      </nav>

      <Footer />
    </div>
  )
}
