import React, { useState } from 'react'
import { Contract, utils } from 'ethers'
import { useWeb3 } from '../context/Web3Context'
import { FACTORY_ADDRESS, FACTORY_ABI, ERC20_ABI } from '../constants'
import NetworkGuard from './NetworkGuard'
import useTransact from '../hooks/useTransact'
import { useToast } from './Toast'
import { WETH_ADDRESS } from '../lib/config'

const ZERO = '0x0000000000000000000000000000000000000000'

export default function CreateExchangeForm() {
  const { account, library } = useWeb3()
  const { addToast } = useToast()
  const { run, pending: loading } = useTransact()
  const [tokenAddress, setTokenAddress] = useState('')
  const [checking, setChecking] = useState(false)

  const valid = utils.isAddress(tokenAddress)

  const createExchange = async () => {
    if (!account || !library || !valid) return
    if (tokenAddress.toLowerCase() === WETH_ADDRESS.toLowerCase()) {
      addToast('Pools are created against WETH, so pick a different token', 'error')
      return
    }
    setChecking(true)
    try {
      // 1. must be an ERC-20 (has code and answers symbol/decimals)
      const code = await library.getCode(tokenAddress)
      if (!code || code === '0x') {
        addToast('No contract at that address on this network', 'error')
        return
      }
      try {
        const t = new Contract(tokenAddress, ERC20_ABI, library)
        await Promise.all([t.decimals(), t.totalSupply()])
      } catch {
        addToast('That contract does not look like an ERC-20 token', 'error')
        return
      }
      // 2. must not already have a pool
      const factory = new Contract(FACTORY_ADDRESS, FACTORY_ABI, library)
      if ((await factory.getPair(tokenAddress, WETH_ADDRESS)) !== ZERO) {
        addToast('A pool for this token already exists. Add liquidity instead.', 'error')
        return
      }
    } catch {
      addToast('Could not verify the token. Try again.', 'error')
      return
    } finally {
      setChecking(false)
    }

    const signer = library.getSigner()
    await run({
      label: 'Create Exchange',
      successMessage: 'Exchange created. Add liquidity to start trading.',
      send: () => new Contract(FACTORY_ADDRESS, FACTORY_ABI, signer).createPair(tokenAddress, WETH_ADDRESS),
      onSuccess: () => setTokenAddress(''),
    })
  }

  const busy = loading || checking
  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-6 max-w-md mx-auto">
      <h2 className="text-xl font-semibold font-display text-[var(--text-primary)] mb-6">Create Exchange</h2>

      <p className="text-sm text-[var(--text-secondary)] mb-4">
        Create a new liquidity pool for a token paired with WETH.
      </p>

      <div className="space-y-4">
        <div>
          <label className="text-xs text-[var(--text-tertiary)] mb-1 block">Token Address</label>
          <input
            type="text"
            placeholder="0x..."
            value={tokenAddress}
            onChange={(e) => setTokenAddress(e.target.value.trim())}
            className="w-full px-3 py-2 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)] text-[var(--text-primary)] text-sm font-mono outline-none focus:border-[var(--accent)]"
          />
          {tokenAddress && !valid && <p className="text-xs text-[var(--danger)] mt-1">Not a valid address</p>}
        </div>
      </div>

      <div className="mt-6">
        <NetworkGuard>
          <button
            onClick={createExchange}
            disabled={!valid || busy}
            className={`w-full py-3 rounded-xl font-semibold text-sm font-display transition-all ${
              !valid
                ? 'bg-[var(--bg-secondary)] text-[var(--text-tertiary)] cursor-not-allowed'
                : busy
                ? 'bg-[var(--accent)]/50 text-white cursor-wait'
                : 'bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]'
            }`}
          >
            {!valid ? 'Enter a token address' : checking ? 'Checking...' : loading ? 'Creating...' : 'Create Exchange'}
          </button>
        </NetworkGuard>
      </div>
    </div>
  )
}
