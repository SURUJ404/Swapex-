import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { formatUnits } from 'viem'
import { useWeb3 } from '../context/Web3Context'
import { DEPLOYMENT, FEE_TIERS } from '../lib/config'
import { TOKENS } from '../lib/tokens'
import { parseAmount, formatAmount, deadlineFromNow } from '../lib/amounts'
import { ORDER_TYPES, orderDomain, minAmountOutFor, newNonce, orderBody } from '../lib/limitOrders'
import { postOrder, indexerConfigured } from '../lib/indexerApi'
import { findPool } from '../lib/contracts/factory'
import { quoteExactInputSingle } from '../lib/contracts/quoter'
import { allowance, approve } from '../lib/contracts/erc20'
import TokenSelectModal from './TokenSelectModal'
import NetworkGuard from './NetworkGuard'
import useTokenBalance from '../hooks/useTokenBalance'
import useTransact from '../hooks/useTransact'
import { useToast } from './Toast'
import { parseError } from '../lib/errors'

// Limit orders settle through ERC-20 transferFrom at fill time: only ERC-20s qualify
// (no NATIVE ETH — hold WETH instead, which is the pool token anyway).
const ERC20_ONLY = (t) => t.address !== 'NATIVE'

const DURATIONS = [
  { label: '1 hour', minutes: 60 },
  { label: '8 hours', minutes: 480 },
  { label: '24 hours', minutes: 1440 },
  { label: '7 days', minutes: 10080 },
]

const ERC20_TOKENS = TOKENS.filter(ERC20_ONLY)
const DEFAULT_IN = ERC20_TOKENS[0]
const DEFAULT_OUT = ERC20_TOKENS.find((t) => t.address !== DEFAULT_IN.address)

export default function LimitOrderForm({ onPlaced }) {
  const { account, clients, wrongNetwork } = useWeb3()
  const { run } = useTransact()
  const { addToast } = useToast()
  const publicClient = clients.public

  const [tokenIn, setTokenIn] = useState(DEFAULT_IN)
  const [tokenOut, setTokenOut] = useState(DEFAULT_OUT)
  const [amount, setAmount] = useState('')
  const [price, setPrice] = useState('')
  const [durationIdx, setDurationIdx] = useState(1)
  const [modal, setModal] = useState(null) // 'in' | 'out' | null
  // keyed results: the *current* pair/account derives its own "checking" view, and
  // effects only ever setState after an await (React 19: no sync setState in effects)
  const [poolInfo, setPoolInfo] = useState({ key: null, fee: null, state: 'idle' })
  const [allowanceInfo, setAllowanceInfo] = useState({ key: null, value: null })
  const [busy, setBusy] = useState(null) // 'signing' | 'submitting' | 'approving'

  const { balance } = useTokenBalance(tokenIn)
  const amountBn = useMemo(() => parseAmount(amount, tokenIn.decimals), [amount, tokenIn])
  const minOut = useMemo(
    () => minAmountOutFor(amountBn, price, tokenIn.decimals, tokenOut.decimals),
    [amountBn, price, tokenIn, tokenOut]
  )
  const sameToken = tokenIn.address.toLowerCase() === tokenOut.address.toLowerCase()
  const pairKey = `${tokenIn.address}:${tokenOut.address}`

  // Derived pool status: idle without a wallet, none for a same-token pair, the
  // stored probe result once it matches this pair, otherwise "checking" while the
  // effect probes the factory.
  let poolState = 'idle'
  let fee = null
  if (!account || !publicClient || wrongNetwork) {
    poolState = sameToken && account ? 'none' : 'idle'
  } else if (sameToken) {
    poolState = 'none'
  } else if (poolInfo.key === pairKey) {
    poolState = poolInfo.state
    fee = poolInfo.fee
  } else {
    poolState = 'checking'
  }

  // Discover a fee tier that actually has a pool for this pair (the seed uses 3000;
  // probing the factory keeps the form honest when a tier simply does not exist).
  useEffect(() => {
    if (!account || !publicClient || wrongNetwork || sameToken) return undefined
    let cancelled = false
    ;(async () => {
      for (const tier of FEE_TIERS) {
        try {
          const pool = await findPool(publicClient, tokenIn.address, tokenOut.address, tier)
          if (cancelled) return
          if (pool) {
            setPoolInfo({ key: pairKey, fee: tier, state: 'found' })
            return
          }
        } catch {
          // an RPC hiccup on one tier must not decide the pair is pool-less
        }
      }
      if (!cancelled) setPoolInfo({ key: pairKey, fee: null, state: 'none' })
    })()
    return () => {
      cancelled = true
    }
  }, [tokenIn, tokenOut, account, publicClient, wrongNetwork, sameToken, pairKey])

  // Allowance of tokenIn to the limit contract: fills pull straight from the maker,
  // so an order placed with no allowance would sit unfilled forever. Keyed by
  // account+token, so a switch reads as "checking" until the new value lands.
  const allowanceKey = account ? `${account}:${tokenIn.address}` : null
  const allowanceAmt = allowanceKey && allowanceInfo.key === allowanceKey ? allowanceInfo.value : null

  const refreshAllowance = useCallback(async () => {
    if (!account || !publicClient || !DEPLOYMENT || !DEPLOYMENT.limitOrders) return
    const key = `${account}:${tokenIn.address}`
    try {
      const amt = await allowance(publicClient, tokenIn.address, account, DEPLOYMENT.limitOrders)
      setAllowanceInfo({ key, value: amt })
    } catch {
      // unknown allowance: treat as none — prompting a (idempotent) approve is the
      // safe direction; placing an order the keeper cannot fill is not.
      setAllowanceInfo({ key, value: 0n })
    }
  }, [account, publicClient, tokenIn])

  useEffect(() => {
    // deferred like useTokenBalance: the effect body itself never sets state
    Promise.resolve()
      .then(() => refreshAllowance())
      .catch(() => {})
  }, [refreshAllowance])

  const needsApprove = allowanceAmt != null && amountBn != null && allowanceAmt < amountBn

  const setMax = () => setAmount(formatUnits(balance, tokenIn.decimals))

  const flipTokens = () => {
    setTokenIn(tokenOut)
    setTokenOut(tokenIn)
    setPrice('')
  }

  // Best-effort current market price from the pool's quoter; the user's limit price
  // stays whatever they type — this only fills the field in.
  const useMarketPrice = async () => {
    if (!publicClient || !fee || !amountBn || busy) return
    try {
      const q = await quoteExactInputSingle(publicClient, {
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        fee,
        amount: amountBn,
      })
      const scale = 10n ** BigInt(tokenIn.decimals)
      const priceRaw = (q.amount * scale) / amountBn
      const s = formatUnits(priceRaw, tokenOut.decimals)
      setPrice(s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''))
    } catch {
      addToast('No market quote for this pair right now.', 'error')
    }
  }

  let status = null
  if (!indexerConfigured()) status = 'Indexer not connected — orders cannot be placed'
  else if (!amountBn) status = amount ? 'Enter a valid amount' : 'Enter an amount'
  else if (amountBn > balance) status = `Insufficient ${tokenIn.symbol} balance`
  else if (sameToken) status = 'Choose two different tokens'
  else if (poolState === 'checking' || (poolState === 'idle' && account)) status = 'Finding a pool…'
  else if (poolState === 'none') status = 'No pool exists for this pair'
  else if (!parseAmount(price, tokenOut.decimals)) status = price ? 'Enter a valid limit price' : 'Enter a limit price'
  else if (!minOut) status = 'Limit price is too low for this amount'
  else if (account && allowanceAmt === null) status = 'Checking allowance…'

  const doApprove = async () => {
    if (!account || !clients.wallet || !amountBn || status) return
    setBusy('approving')
    try {
      await run({
        label: `Approve ${tokenIn.symbol}`,
        successMessage: `Approved ${formatAmount(amountBn, tokenIn.decimals)} ${tokenIn.symbol} for limit orders`,
        send: () => approve(clients.wallet, tokenIn.address, DEPLOYMENT.limitOrders, amountBn),
        onSuccess: refreshAllowance,
      })
    } finally {
      setBusy(null)
    }
  }

  const place = async () => {
    if (!account || !clients.wallet || status || fee == null) return
    const domain = orderDomain()
    const message = {
      maker: account,
      tokenIn: tokenIn.address,
      tokenOut: tokenOut.address,
      amountIn: amountBn,
      minAmountOut: minOut,
      expiry: BigInt(deadlineFromNow(DURATIONS[durationIdx].minutes)),
      nonce: newNonce(),
      receiver: account,
    }
    setBusy('signing')
    try {
      const signature = await clients.wallet.signTypedData({
        domain,
        types: ORDER_TYPES,
        primaryType: 'Order',
        message,
      })
      setBusy('submitting')
      const res = await postOrder({ ...orderBody(message, fee), signature })
      addToast(
        res.status === 'duplicate'
          ? 'This order is already on the book'
          : `Order placed: ${formatAmount(amountBn, tokenIn.decimals)} ${tokenIn.symbol} at ${price} ${tokenOut.symbol}`,
        'success'
      )
      setAmount('')
      if (onPlaced) onPlaced()
    } catch (e) {
      addToast(e && e.name === 'IndexError' ? e.message : parseError(e, 'Place order failed'), 'error')
    } finally {
      setBusy(null)
    }
  }

  const busyLabel = busy === 'signing' ? 'Sign in your wallet…' : busy === 'submitting' ? 'Submitting…' : busy === 'approving' ? 'Approving…' : null

  const tokenButton = (token, which, id) => (
    <button
      id={id}
      onClick={() => setModal(which)}
      className="flex items-center gap-2 px-3 py-2 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border)] text-sm font-medium text-[var(--text-primary)] hover:bg-[var(--bg-card)] transition-colors"
    >
      <img src={token.logo} alt={token.symbol} className="w-5 h-5 rounded-full" />
      {token.symbol}
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
      </svg>
    </button>
  )

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-6">
      <h2 className="text-xl font-semibold font-display text-[var(--text-primary)] mb-6">Limit order</h2>

      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="limit-pay-token" className="text-xs text-[var(--text-tertiary)] mb-1 block">You pay</label>
            <div className="flex items-center gap-2">
              {tokenButton(tokenIn, 'in', 'limit-pay-token')}
              <div className="flex-1 min-w-0">
                <input
                  id="limit-amount-in"
                  type="text"
                  inputMode="decimal"
                  placeholder="0.0"
                  value={amount}
                  onChange={(e) => {
                    const v = e.target.value.replace(',', '.')
                    if (/^\d*\.?\d*$/.test(v)) setAmount(v)
                  }}
                  className="w-full px-3 py-2 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)] text-[var(--text-primary)] text-lg font-mono outline-none focus:border-[var(--accent)]"
                  aria-label={`Amount of ${tokenIn.symbol} to sell`}
                />
              </div>
            </div>
            <div className="flex items-center justify-between mt-1">
              <span className="text-xs text-[var(--text-tertiary)] font-mono">
                Balance: {formatAmount(balance, tokenIn.decimals, 4) || '0'}
              </span>
              <button
                onClick={setMax}
                className="px-2 py-0.5 rounded bg-[var(--accent)]/10 text-[var(--accent)] text-xs font-medium hover:bg-[var(--accent)]/20 transition-colors"
              >
                MAX
              </button>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label htmlFor="limit-amount-out" className="text-xs text-[var(--text-tertiary)]">You receive (min)</label>
              {tokenButton(tokenOut, 'out', 'limit-out-token')}
            </div>
            <div className="px-3 py-2 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)] text-[var(--text-primary)] text-lg font-mono h-[42px] flex items-center justify-between">
              <span className={minOut ? '' : 'text-[var(--text-tertiary)]'}>{minOut ? formatAmount(minOut, tokenOut.decimals, 6) : '0.0'}</span>
              <button
                onClick={flipTokens}
                aria-label="Swap pay and receive tokens"
                className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] text-sm"
              >
                ⇅
              </button>
            </div>
            <div className="text-xs text-[var(--text-tertiary)] font-mono mt-1">at your limit price</div>
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label htmlFor="limit-price" className="text-xs text-[var(--text-tertiary)]">
              Limit price ({tokenOut.symbol} per {tokenIn.symbol})
            </label>
            <button
              onClick={useMarketPrice}
              disabled={!fee || !amountBn || !account}
              className="text-xs text-[var(--accent)] hover:underline disabled:opacity-40 disabled:no-underline"
            >
              Use market
            </button>
          </div>
          <input
            id="limit-price"
            type="text"
            inputMode="decimal"
            placeholder="0.0"
            value={price}
            onChange={(e) => {
              const v = e.target.value.replace(',', '.')
              if (/^\d*\.?\d*$/.test(v)) setPrice(v)
            }}
            className="w-full px-3 py-2 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)] text-[var(--text-primary)] text-lg font-mono outline-none focus:border-[var(--accent)]"
          />
        </div>

        <div>
          <label htmlFor="limit-duration" className="text-xs text-[var(--text-tertiary)] mb-1 block">Expires after</label>
          <select
            id="limit-duration"
            value={durationIdx}
            onChange={(e) => setDurationIdx(Number(e.target.value))}
            className="w-full px-3 py-2 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)] text-[var(--text-primary)] text-sm outline-none focus:border-[var(--accent)]"
          >
            {DURATIONS.map((d, i) => (
              <option key={d.label} value={i}>
                {d.label}
              </option>
            ))}
          </select>
        </div>

        <div className="rounded-xl border border-yellow-500/40 bg-yellow-500/10 p-3 text-xs text-yellow-500/90">
          Fee-on-transfer tokens are not supported: a taxed input token makes fills revert, and a tax on the
          output cannot be detected — the receiver may get less than the minimum shown.
        </div>
      </div>

      <div className="mt-6">
        <NetworkGuard>
          <button
            onClick={needsApprove ? doApprove : place}
            disabled={Boolean(status) || Boolean(busyLabel)}
            className={`w-full py-3 rounded-xl font-semibold text-sm font-display transition-all ${
              status
                ? 'bg-[var(--bg-secondary)] text-[var(--text-tertiary)] cursor-not-allowed'
                : busyLabel
                ? 'bg-[var(--accent)]/50 text-white cursor-wait'
                : 'bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]'
            }`}
          >
            {busyLabel || status || (needsApprove ? `Approve ${tokenIn.symbol}` : 'Place order')}
          </button>
        </NetworkGuard>
      </div>

      <TokenSelectModal open={modal === 'in'} onClose={() => setModal(null)} onSelect={setTokenIn} filter={ERC20_ONLY} />
      <TokenSelectModal open={modal === 'out'} onClose={() => setModal(null)} onSelect={setTokenOut} filter={ERC20_ONLY} />
    </div>
  )
}
