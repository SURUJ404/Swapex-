import React from 'react'
import { CHAINS, REQUIRED_CHAIN_ID, IS_TESTNET, CONFIG_ERROR } from '../lib/config'

/** Always-visible notice: what network this is, that tokens have no value, and why actions are disabled. */
export default function TestnetBanner() {
  const chain = CHAINS[REQUIRED_CHAIN_ID]?.name || `chain ${REQUIRED_CHAIN_ID}`
  return (
    <div role="status">
      {IS_TESTNET && (
        <div className="bg-yellow-500/15 text-yellow-600 text-xs text-center px-4 py-2">
          {chain} testnet. Tokens have no value. Swapex is unaudited, so do not use funds you cannot lose.
        </div>
      )}
      {CONFIG_ERROR && (
        <div className="bg-[var(--danger-bg)] text-[var(--danger)] text-xs text-center px-4 py-2">{CONFIG_ERROR}</div>
      )}
    </div>
  )
}
