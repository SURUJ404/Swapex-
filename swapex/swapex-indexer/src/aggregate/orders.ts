// Derived limit-order state. The signed payload lives in the orders table (POST only);
// fill and cancel state is computed from OrderFilled/OrderCancelled events at read time,
// so it reorgs away with the events and stays idempotent under replay.

import type { Db, OrderRow } from '../db'
import { listOrders as listOrderRows } from '../db'

export type OrderStatus = 'open' | 'filled' | 'cancelled' | 'expired'

export interface OrderState {
  filled: string // tokenIn filled so far (sum of OrderFilled, decimal string)
  amountOutReceived: string // tokenOut delivered so far
  remaining: string // amountIn - filled
  cancelled: boolean
  status: OrderStatus
  fillable: boolean
}

export interface DecoratedOrder extends OrderRow, OrderState {}

interface FillTotals {
  filled: bigint
  out: bigint
}

/** Sum of OrderFilled events per order hash, for one limit contract. */
export function fillTotals(db: Db, limitOrders: string): Map<string, FillTotals> {
  const rows = db
    .prepare(`SELECT args FROM events WHERE address = ? AND event = 'OrderFilled'`)
    .all(limitOrders.toLowerCase()) as { args: string }[]
  const out = new Map<string, FillTotals>()
  for (const r of rows) {
    const a = JSON.parse(r.args) as { orderHash: string; amountInFilled: string; amountOutPaid: string }
    const cur = out.get(a.orderHash) ?? { filled: 0n, out: 0n }
    cur.filled += BigInt(a.amountInFilled)
    cur.out += BigInt(a.amountOutPaid)
    out.set(a.orderHash, cur)
  }
  return out
}

/** Cancelled `maker:nonce` pairs from OrderCancelled events, for one limit contract. */
export function cancelledNonces(db: Db, limitOrders: string): Set<string> {
  const rows = db
    .prepare(`SELECT args FROM events WHERE address = ? AND event = 'OrderCancelled'`)
    .all(limitOrders.toLowerCase()) as { args: string }[]
  const out = new Set<string>()
  for (const r of rows) {
    const a = JSON.parse(r.args) as { maker: string; nonce: string | number }
    out.add(`${a.maker.toLowerCase()}:${String(a.nonce)}`)
  }
  return out
}

/** Status/fillability of one stored order given the derived event state. */
export function decorateOrder(
  order: OrderRow,
  fills: Map<string, FillTotals>,
  cancels: Set<string>,
  now: number
): DecoratedOrder {
  const filled = fills.get(order.orderHash)?.filled ?? 0n
  const out = fills.get(order.orderHash)?.out ?? 0n
  const amountIn = BigInt(order.amountIn)
  const remaining = amountIn > filled ? amountIn - filled : 0n
  const cancelled = cancels.has(`${order.maker.toLowerCase()}:${order.nonce}`)
  const expired = now > order.expiry
  const status: OrderStatus =
    remaining === 0n && filled > 0n ? 'filled' : cancelled ? 'cancelled' : expired ? 'expired' : 'open'
  return {
    ...order,
    filled: filled.toString(),
    amountOutReceived: out.toString(),
    remaining: remaining.toString(),
    cancelled,
    status,
    fillable: status === 'open',
  }
}

/** Paged, optionally maker-filtered orders with their event-derived state. */
export function listOrders(
  db: Db,
  limitOrders: string,
  filter: { maker?: string; status?: OrderStatus | 'all'; limit: number; offset: number },
  now: number
): { orders: DecoratedOrder[]; total: number } {
  const fills = fillTotals(db, limitOrders)
  const cancels = cancelledNonces(db, limitOrders)
  const hasStatus = Boolean(filter.status && filter.status !== 'all')
  // Derived state lives in JS, so a status filter fetches everything, filters, then
  // pages - page arithmetic stays correct without pushing state into SQL (fine at
  // testnet order volumes; revisit if the table ever grows large).
  const { rows, total } = hasStatus
    ? listOrderRows(db, { maker: filter.maker })
    : listOrderRows(db, { maker: filter.maker, limit: filter.limit, offset: filter.offset })
  let decorated = rows.map((r) => decorateOrder(r, fills, cancels, now))
  if (hasStatus) {
    decorated = decorated.filter((o) => o.status === filter.status)
    return { orders: decorated.slice(filter.offset, filter.offset + filter.limit), total: decorated.length }
  }
  return { orders: decorated, total }
}

/** Every open order (the keeper's work list). */
export function openOrders(db: Db, limitOrders: string, now: number): DecoratedOrder[] {
  return listOrders(db, limitOrders, { status: 'open', limit: 100, offset: 0 }, now).orders
}
