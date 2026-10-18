import React from 'react'
import { useWeb3React } from '@web3-react/core'
import { DialogOverlay, DialogContent } from '@reach/dialog'
import '@reach/dialog/styles.css'
import { injected, walletlink } from '../context/Web3Context'

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

  return (
    <DialogOverlay
      isOpen={isOpen}
      onDismiss={onClose}
      className="z-50"
    >
      <DialogContent
        aria-label="Connect Wallet"
        className="!bg-[var(--bg-card)] !border !border-[var(--border)] !rounded-2xl !p-6 !w-full !max-w-sm !m-4 animate-slide-up"
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">
            Connect Wallet
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
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
                  alt=""
                  aria-hidden="true"
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
      </DialogContent>
    </DialogOverlay>
  )
}
