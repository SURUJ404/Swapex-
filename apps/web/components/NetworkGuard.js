import React from 'react'
import { useWeb3 } from '../context/Web3Context'
import { CHAINS, REQUIRED_CHAIN_ID } from '../lib/config'

/**
 * Primary action button logic shared by every form: connect -> switch network -> action.
 * Renders the connect / wrong-network button itself when needed, otherwise `children`.
 */
export default function NetworkGuard({ children, className = '' }) {
  const { account, wrongNetwork, switchNetwork, setWalletModalOpen } = useWeb3()
  const base = `w-full py-3 rounded-xl font-semibold text-sm font-display transition-all bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] ${className}`

  if (!account) {
    return (
      <button type="button" onClick={() => setWalletModalOpen(true)} className={base}>
        Connect Wallet
      </button>
    )
  }
  if (wrongNetwork) {
    return (
      <button type="button" onClick={switchNetwork} className={base}>
        Switch to {CHAINS[REQUIRED_CHAIN_ID]?.name || 'the supported network'}
      </button>
    )
  }
  return children
}
