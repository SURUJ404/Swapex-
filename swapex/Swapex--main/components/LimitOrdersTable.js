import React, { useState, useEffect, useCallback } from 'react'
import { useWeb3 } from '../context/Web3Context'
import { getOrders, indexerConfigured, indexerErrorMessage } from '../lib/indexerApi'
import { findToken } from '../lib/tokens'
import { formatAmount } from '../lib/amounts'
import { orderPrice, formatTimeLeft } from '../lib/limitOrders'
import { cancelOrder } from '../lib/contracts/limitOrders'
import useTransact from '../hooks/useTransact'
import { shortAddress } from '../lib/fmt'

const POLL_MS = 12000

const STATUS_STYLE = {
  open: 'bg-emerald-500/15 text-emerald-500',
  filled: 'bg-blue-500/15 text-blue-500',
  cancelled: 'bg-red-500/15 text-red-500',
  expired: 'bg-[var(--bg-secondary)] text-[var(--text-tertiary)]',
}

function tokenLabel(address) {
  const t = findToken(address)
  return t ? t.symbol : shortAddress(address)
}

function tokenDecimals(address, fallback = 18) {
  const t = findToken(address)
  return t ? t.decimals : fallback
}

export default function LimitOrdersTable({ refreshKey = 0 }) {
  const { account, clients } = useWeb3()
  const { run, pending: cancelling } = useTransact()

  // Tab is derived: no wallet -> only "open" makes sense; with a wallet the default
  // is "mine" until the user picks otherwise (no effect needed to flip it).
  const [tabChoice, setTabChoice] = useState(null)
  const tab = !account ? 'open' : tabChoice || 'mine'
  const [orders, setOrders] = useState(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState(null)

  const configured = indexerConfigured()
  const loading = !orders && !error // first load only; refreshes keep the current rows

  const load = useCallback(
    async ({ silent = false } = {}) => {
      if (!configured) return
      try {
        const mine = tab === 'mine' && account
        const res = await getOrders(mine ? { maker: account, status: 'all', limit: 50 } : { status: 'open', limit: 50 })
        setOrders(res ? res.orders : [])
        setTotal(res ? res.total : 0)
        setError(null)
      } catch (e) {
        if (!silent) setError(e)
      }
    },
    [tab, account, configured]
  )

  // load on mount / tab / account / refresh-key; poll silently while visible.
  // Deferred through a microtask (same pattern as useTokenBalance): no state is
  // touched synchronously inside the effect itself.
  useEffect(() => {
    Promise.resolve()
      .then(() => load())
      .catch(() => {})
    if (!configured) return undefined
    const id = setInterval(() => load({ silent: true }), POLL_MS)
    return () => clearInterval(id)
  }, [load, configured, refreshKey])

  const cancel = (order) =>
    run({
      label: 'Cancel limit order',
      successMessage: 'Limit order cancelled',
      send: () => cancelOrder(clients.wallet, order.nonce),
      onSuccess: () => load({ silent: false }),
    })

  const tabClass = (name) =>
    `px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
      tab === name ? 'bg-[var(--bg-card)] text-[var(--text-primary)]' : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)]'
    }`

  const body = () => {
    if (!configured) {
      return (
        <p className="text-sm text-[var(--text-secondary)] py-6 text-center">
          Indexer not connected — open orders are listed by the indexer, so none are shown.
        </p>
      )
    }
    if (error) {
      return (
        <div className="py-6 text-center space-y-2">
          <p className="text-sm text-[var(--danger)]">{indexerErrorMessage(error)}</p>
          <button
            onClick={() => load()}
            className="px-4 py-1.5 rounded-full border border-[var(--border)] text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-card)]"
          >
            Retry
          </button>
        </div>
      )
    }
    if (loading && !orders) return <p className="text-sm text-[var(--text-tertiary)] py-6 text-center">Loading orders…</p>
    if (!orders || !orders.length) {
      return (
        <p className="text-sm text-[var(--text-tertiary)] py-6 text-center">
          {tab === 'mine' ? 'You have no orders yet.' : 'No open orders.'}
        </p>
      )
    }
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-[var(--text-tertiary)] border-b border-[var(--border)]">
              <th className="py-2 pr-3 font-medium">Order</th>
              <th className="py-2 pr-3 font-medium">Price</th>
              <th className="py-2 pr-3 font-medium">Filled</th>
              <th className="py-2 pr-3 font-medium">Expires</th>
              <th className="py-2 pr-3 font-medium">Status</th>
              <th className="py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => {
              const inSym = tokenLabel(o.tokenIn)
              const outSym = tokenLabel(o.tokenOut)
              const inDec = tokenDecimals(o.tokenIn)
              const outDec = tokenDecimals(o.tokenOut)
              const priceStr = orderPrice(o.amountIn, o.minAmountOut, inDec, outDec)
              const amountIn = formatAmount(o.amountIn, inDec, 6)
              const filledAmt = formatAmount(o.filled, inDec, 6)
              const pct = o.amountIn !== '0' ? Math.min(100, (Number(o.filled) / Number(o.amountIn)) * 100) : 0
              const own = Boolean(account) && o.maker.toLowerCase() === account.toLowerCase()
              return (
                <tr key={o.orderHash} className="border-b border-[var(--border)] last:border-0" data-testid="order-row">
                  <td className="py-3 pr-3">
                    <div className="font-medium text-[var(--text-primary)]">
                      Sell {amountIn} {inSym}
                    </div>
                    <div className="text-xs text-[var(--text-tertiary)]">for {outSym}{own ? ' · yours' : ''}</div>
                  </td>
                  <td className="py-3 pr-3 font-mono text-[var(--text-primary)]">{priceStr ?? '—'}</td>
                  <td className="py-3 pr-3">
                    <div className="font-mono text-xs text-[var(--text-secondary)]">
                      {filledAmt} / {amountIn} {inSym}
                    </div>
                    <div className="h-1 w-20 rounded bg-[var(--bg-secondary)] mt-1 overflow-hidden">
                      <div className="h-full bg-[var(--accent)]" style={{ width: `${pct}%` }} />
                    </div>
                  </td>
                  <td className="py-3 pr-3 text-xs text-[var(--text-secondary)]">{formatTimeLeft(o.expiry)}</td>
                  <td className="py-3 pr-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLE[o.status] || STATUS_STYLE.open}`}>
                      {o.status}
                    </span>
                  </td>
                  <td className="py-3 text-right">
                    {own && o.status === 'open' && (
                      <button
                        onClick={() => cancel(o)}
                        disabled={cancelling}
                        className="px-3 py-1 rounded-lg border border-[var(--border)] text-xs text-[var(--danger)] hover:bg-red-500/10 disabled:opacity-50"
                      >
                        {cancelling ? 'Cancelling…' : 'Cancel'}
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {total > orders.length && (
          <p className="text-xs text-[var(--text-tertiary)] pt-2">Showing {orders.length} of {total} orders.</p>
        )}
      </div>
    )
  }

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold font-display text-[var(--text-primary)]">Limit orders</h2>
        <div className="flex items-center gap-1">
          {account && <button className={tabClass('mine')} onClick={() => setTabChoice('mine')}>My orders</button>}
          <button className={tabClass('open')} onClick={() => setTabChoice('open')}>Open orders</button>
          <button
            onClick={() => load()}
            aria-label="Refresh orders"
            className="ml-2 px-2 py-1.5 rounded-lg text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)] border border-[var(--border)]"
          >
            ⟳
          </button>
        </div>
      </div>
      {body()}
    </div>
  )
}
