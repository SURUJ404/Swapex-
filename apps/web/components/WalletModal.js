import React from 'react'
import { useWeb3React } from '@web3-react/core'
import { injected, walletconnect, walletlink } from '../context/Web3Context'

const wallets = [
  {
    id: 'injected',
    name: 'MetaMask',
    description: 'Connect using browser extension',
    icon: '/images/wallets/metamask.png',
    connector: injected,
    color: '#E8831D',
  },
  {
    id: 'walletconnect',
    name: 'WalletConnect',
    description: 'Connect to Trust Wallet, Rainbow and more',
    icon: '/images/wallets/walletconnect.svg',
    connector: walletconnect,
    color: '#4196FC',
  },
  {
    id: 'walletlink',
    name: 'Coinbase Wallet',
    description: 'Use Coinbase Wallet app',
    icon: '/images/wallets/coinbase.svg',
    connector: walletlink,
    color: '#315CF5',
  },
]

export default function WalletModal({ isOpen, onClose }) {
  const { activate } = useWeb3React()

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-6 w-full max-w-sm mx-4 animate-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">
            Connect Wallet
          </h2>
          <button
            onClick={onClose}
            className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors text-xl leading-none"
          >
            &times;
          </button>
        </div>

        <div className="space-y-2">
          {wallets.map((wallet) => (
            <button
              key={wallet.id}
              onClick={() => {
                activate(wallet.connector)
                onClose()
              }}
              className="w-full flex items-center gap-4 p-3 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border)] hover:border-[var(--accent)] transition-all text-left group"
            >
              <div
                className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 overflow-hidden"
                style={{ backgroundColor: wallet.color + '20' }}
              >
                <img
                  src={wallet.icon}
                  alt={wallet.name}
                  className="w-6 h-6"
                  onError={(e) => {
                    e.target.style.display = 'none'
                  }}
                />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-[var(--text-primary)] group-hover:text-[var(--accent)] transition-colors">
                  {wallet.name}
                </div>
                <div className="text-xs text-[var(--text-tertiary)] truncate">
                  {wallet.description}
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
