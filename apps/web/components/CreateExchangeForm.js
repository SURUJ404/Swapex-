import React, { useState, useMemo } from 'react'
import { Contract } from 'ethers'
import { useWeb3 } from '../context/Web3Context'
import { TOKEN_LIST, ROUTER_ADDRESS, ROUTER_ABI } from '../constants'
import NetworkGuard from './NetworkGuard'
import TokenSelectModal from './TokenSelectModal'
import useTransact from '../hooks/useTransact'
import { buildPoolKey, toCurrencyAddress, getPoolState } from '../lib/pool'
import { priceToSqrtPriceX96 } from '../lib/price'
import { NATIVE_ADDRESS } from '../constants'

function TokenButton({ token, onClick }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-[var(--bg-card)] border border-[var(--border)] text-sm font-medium text-[var(--text-primary)]"
    >
      <img src={token.logo} alt={token.symbol} className="w-5 h-5 rounded-full" />
      {token.symbol}
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
      </svg>
    </button>
  )
}

function tokenFor(address) {
  if (address.toLowerCase() === '0x0000000000000000000000000000000000000000') {
    return TOKEN_LIST.find((t) => t.address === NATIVE_ADDRESS) || { symbol: 'ETH', decimals: 18 }
  }
  return TOKEN_LIST.find((t) => toCurrencyAddress(t).toLowerCase() === address.toLowerCase()) || null
}

export default function CreateExchangeForm() {
  const { account, library } = useWeb3()
  const { run, pending: creating } = useTransact()

  const [tokenA, setTokenA] = useState(TOKEN_LIST[1])
  const [tokenB, setTokenB] = useState(TOKEN_LIST[0]) // default: pair with native ETH
  const [price, setPrice] = useState('1')
  const [busy, setBusy] = useState(false)
  const [showA, setShowA] = useState(false)
  const [showB, setShowB] = useState(false)

  const key = useMemo(() => buildPoolKey(tokenA, tokenB), [tokenA, tokenB])
  const sameToken = tokenA.address === tokenB.address
  const currency0 = tokenFor(key.currency0)
  const currency1 = tokenFor(key.currency1)

  const validPrice = /^\d*\.?\d+$|^\d+\.$/.test(price.trim()) && parseFloat(price) > 0

  const checkAndCreate = async () => {
    if (!account || !library || sameToken || !validPrice) return
    setBusy(true)
    try {
      for (const addr of [key.currency0, key.currency1]) {
        if (addr.toLowerCase() !== '0x0000000000000000000000000000000000000000') {
          const code = await library.getCode(addr)
          if (!code || code === '0x') throw new Error('no-code')
        }
      }
      const state = await getPoolState(library, key)
      if (!state.sqrtPriceX96.isZero()) throw new Error('exists')
    } catch (e) {
      alert(e.message === 'exists' ? 'This pool already exists. Add liquidity instead.' : e.message === 'no-code' ? 'That address has no contract on this network.' : 'Could not verify the pair.')
      return
    } finally {
      setBusy(false)
    }

    const signer = library.getSigner()
    const sqrtPriceX96 = priceToSqrtPriceX96(price, currency0.decimals, currency1.decimals)
    await run({
      label: 'Create Pool',
      successMessage: `Pool created. Add liquidity to start trading.`,
      send: () => new Contract(ROUTER_ADDRESS, ROUTER_ABI, signer).initialize(key, sqrtPriceX96),
      onSuccess: () => {},
    })
  }

  const busyAll = busy || creating
  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-6 max-w-md mx-auto">
      <h2 className="text-xl font-semibold font-display text-[var(--text-primary)] mb-6">Create Pool</h2>

      <p className="text-sm text-[var(--text-secondary)] mb-4">
        Initialize a new pool between two tokens at a starting price.
      </p>

      <div className="space-y-4">
        <div className="flex gap-3">
          <div className="flex-1 bg-[var(--bg-secondary)] rounded-xl p-4">
            <span className="text-xs text-[var(--text-tertiary)] block mb-2">Token A</span>
            <TokenButton token={tokenA} onClick={() => setShowA(true)} />
          </div>
          <div className="flex-1 bg-[var(--bg-secondary)] rounded-xl p-4">
            <span className="text-xs text-[var(--text-tertiary)] block mb-2">Token B</span>
            <TokenButton token={tokenB} onClick={() => setShowB(true)} />
          </div>
        </div>

        <div>
          <label className="text-xs text-[var(--text-tertiary)] mb-1 block">
            Starting price (how many {currency1?.symbol} per {currency0?.symbol})
          </label>
          <input
            type="text"
            inputMode="decimal"
            placeholder="1.0"
            value={price}
            onChange={(e) => setPrice(e.target.value.replace(',', '.'))}
            className="w-full px-3 py-2 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)] text-[var(--text-primary)] text-sm font-mono outline-none focus:border-[var(--accent)]"
          />
          {!validPrice && price && <p className="text-xs text-[var(--danger)] mt-1">Enter a price greater than 0</p>}
        </div>

        <p className="text-xs text-[var(--text-tertiary)] font-mono">
          Pool: {currency0?.symbol} / {currency1?.symbol} (sorted by address)
        </p>
      </div>

      <div className="mt-6">
        <NetworkGuard>
          <button
            onClick={checkAndCreate}
            disabled={sameToken || !validPrice || busyAll}
            className={`w-full py-3 rounded-xl font-semibold text-sm font-display transition-all ${
              sameToken || !validPrice
                ? 'bg-[var(--bg-secondary)] text-[var(--text-tertiary)] cursor-not-allowed'
                : busyAll
                ? 'bg-[var(--accent)]/50 text-white cursor-wait'
                : 'bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]'
            }`}
          >
            {sameToken ? 'Choose two different tokens' : busy ? 'Checking...' : creating ? 'Creating...' : 'Create Pool'}
          </button>
        </NetworkGuard>
      </div>

      <TokenSelectModal open={showA} onClose={() => setShowA(false)} onSelect={setTokenA} />
      <TokenSelectModal open={showB} onClose={() => setShowB(false)} onSelect={setTokenB} />
    </div>
  )
}
