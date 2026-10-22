import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import LimitOrdersTable from '../../components/LimitOrdersTable'

const state = {
  account: null,
  clients: { public: null, wallet: null, account: null },
  configured: true,
  getOrders: vi.fn(),
  indexerErrorMessage: (e) => (e && e.message) || 'indexer error',
  run: vi.fn(),
  pending: false,
  cancelOrder: vi.fn(),
}

vi.mock('../../context/Web3Context', () => ({
  useWeb3: () => ({ account: state.account, clients: state.clients }),
}))

vi.mock('../../lib/indexerApi', () => ({
  indexerConfigured: () => state.configured,
  getOrders: (...args) => state.getOrders(...args),
  indexerErrorMessage: (e) => state.indexerErrorMessage(e),
}))

vi.mock('../../hooks/useTransact', () => ({
  __esModule: true,
  default: () => ({ run: (...args) => state.run(...args), pending: state.pending }),
}))

vi.mock('../../lib/contracts/limitOrders', () => ({
  cancelOrder: (...args) => state.cancelOrder(...args),
}))

vi.mock('../../lib/tokens', () => ({
  findToken: (address) => {
    const map = {
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa': { symbol: 'WETH', decimals: 18 },
      '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb': { symbol: 'tUSDC', decimals: 6 },
    }
    return map[address.toLowerCase()] || null
  },
}))

const MAKER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

const openOrder = (overrides = {}) => ({
  orderHash: '0x' + 'ab'.repeat(32),
  maker: MAKER.toLowerCase(),
  tokenIn: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  tokenOut: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  amountIn: '1000000000000000000',
  minAmountOut: '2000000000',
  expiry: Math.floor(Date.now() / 1000) + 3600,
  nonce: '7',
  receiver: MAKER.toLowerCase(),
  fee: 3000,
  signature: '0x' + 'cd'.repeat(65),
  verifyingContract: '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707',
  chainId: 31337,
  submittedAt: 1700000000,
  filled: '0',
  amountOutReceived: '0',
  remaining: '1000000000000000000',
  cancelled: false,
  status: 'open',
  fillable: true,
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  state.account = null
  state.configured = true
  state.pending = false
  state.getOrders.mockResolvedValue({ orders: [], total: 0, limitOrders: '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707', limit: 50, offset: 0 })
})

afterEach(cleanup)

describe('LimitOrdersTable', () => {
  it('shows the honest not-connected state and never calls the indexer', async () => {
    state.configured = false
    render(<LimitOrdersTable />)
    expect(await screen.findByText(/Indexer not connected/)).toBeTruthy()
    expect(state.getOrders).not.toHaveBeenCalled()
  })

  it('lists open orders for a visitor (no wallet) without cancel buttons', async () => {
    state.getOrders.mockResolvedValue({ orders: [openOrder()], total: 1, limitOrders: '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707', limit: 50, offset: 0 })
    render(<LimitOrdersTable />)
    expect(await screen.findByTestId('order-row')).toBeTruthy()
    expect(screen.getByText('Sell 1 WETH')).toBeTruthy()
    expect(screen.getByText('2000')).toBeTruthy() // price per WETH in tUSDC
    expect(screen.getByText('open')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open orders' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
    expect(state.getOrders).toHaveBeenCalledWith({ status: 'open', limit: 50 })
  })

  it('shows an empty state when there are no open orders', async () => {
    render(<LimitOrdersTable />)
    expect(await screen.findByText('No open orders.')).toBeTruthy()
  })

  it('surfaces indexer failures with a retry', async () => {
    state.getOrders.mockRejectedValue(new Error('indexer down'))
    render(<LimitOrdersTable />)
    expect(await screen.findByText('indexer down')).toBeTruthy()
    const user = userEvent.setup()
    state.getOrders.mockResolvedValue({ orders: [], total: 0, limitOrders: '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707', limit: 50, offset: 0 })
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByText('No open orders.')).toBeTruthy())
  })

  it('scopes to the maker and offers cancel for own open orders', async () => {
    state.account = MAKER
    state.getOrders.mockResolvedValue({ orders: [openOrder()], total: 1, limitOrders: '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707', limit: 50, offset: 0 })
    render(<LimitOrdersTable />)
    const user = userEvent.setup()
    const cancelBtn = await screen.findByRole('button', { name: 'Cancel' })
    expect(state.getOrders).toHaveBeenCalledWith({ maker: MAKER, status: 'all', limit: 50 })
    await user.click(cancelBtn)
    expect(state.run).toHaveBeenCalledTimes(1)
    const call = state.run.mock.calls[0][0]
    expect(call.label).toBe('Cancel limit order')
    // the send fn goes through the contract adapter with the order's nonce
    await call.send()
    expect(state.cancelOrder).toHaveBeenCalledWith(state.clients.wallet, '7')
  })

  it('does not offer cancel on someone else’s order', async () => {
    state.account = '0x1111111111111111111111111111111111111111'
    state.getOrders.mockResolvedValue({ orders: [openOrder()], total: 1, limitOrders: '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707', limit: 50, offset: 0 })
    render(<LimitOrdersTable />)
    await screen.findByTestId('order-row')
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  })

  it('renders a filled order without a cancel action', async () => {
    state.account = MAKER
    state.getOrders.mockResolvedValue({ orders: [openOrder({ status: 'filled', filled: '1000000000000000000', remaining: '0' })], total: 1, limitOrders: '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707', limit: 50, offset: 0 })
    render(<LimitOrdersTable />)
    await screen.findByTestId('order-row')
    expect(screen.getByText('filled')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  })
})
