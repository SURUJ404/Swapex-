import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import LimitOrderForm from '../../components/LimitOrderForm'

const state = {
  account: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  wrongNetwork: false,
  clients: { public: null, wallet: null, account: null },
  publicClient: {},
  walletClient: { signTypedData: vi.fn() },
  CONFIG_ERROR: null,
  indexerConfigured: true,
  findPool: vi.fn(),
  allowance: vi.fn(),
  balance: 10n * 10n ** 18n,
  run: vi.fn(),
  postOrder: vi.fn(),
  addToast: vi.fn(),
  onPlaced: vi.fn(),
}

vi.mock('../../context/Web3Context', () => ({
  useWeb3: () => ({
    get account() {
      return state.account
    },
    get wrongNetwork() {
      return state.wrongNetwork
    },
    get clients() {
      return { public: state.account ? state.publicClient : null, wallet: state.account ? state.walletClient : null, account: state.account }
    },
  }),
}))

vi.mock('../../lib/config', () => ({
  get CONFIG_ERROR() {
    return state.CONFIG_ERROR
  },
  CHAINS: { 31337: { name: 'Local (anvil)' } },
  REQUIRED_CHAIN_ID: 31337,
  FEE_TIERS: [500, 3000, 10000],
  DEPLOYMENT: { limitOrders: '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707' },
}))

vi.mock('../../lib/tokens', () => ({
  TOKENS: [
    { symbol: 'ETH', name: 'Ether', address: 'NATIVE', decimals: 18, logo: 'data:,' },
    { symbol: 'WETH', name: 'Wrapped Ether', address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', decimals: 18, logo: 'data:,' },
    { symbol: 'tUSDC', name: 'Test USD Coin', address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', decimals: 6, logo: 'data:,' },
  ],
}))

vi.mock('../../lib/indexerApi', () => ({
  indexerConfigured: () => state.indexerConfigured,
  postOrder: (...args) => state.postOrder(...args),
}))

vi.mock('../../lib/contracts/factory', () => ({
  findPool: (...args) => state.findPool(...args),
}))

vi.mock('../../lib/contracts/quoter', () => ({
  quoteExactInputSingle: vi.fn(),
}))

vi.mock('../../lib/contracts/erc20', () => ({
  allowance: (...args) => state.allowance(...args),
  approve: vi.fn(),
}))

vi.mock('../../hooks/useTokenBalance', () => ({
  __esModule: true,
  default: () => ({ balance: state.balance, loading: false, refetch: vi.fn() }),
}))

vi.mock('../../hooks/useTransact', () => ({
  __esModule: true,
  default: () => ({ run: (...args) => state.run(...args), pending: false }),
}))

vi.mock('../../components/Toast', () => ({
  useToast: () => ({ addToast: (...args) => state.addToast(...args) }),
}))

vi.mock('../../lib/errors', () => ({
  parseError: (e, fallback) => (e && e.message) || fallback,
}))

vi.mock('../../components/TokenSelectModal', () => ({
  __esModule: true,
  default: () => null,
}))

const PLACEHOLDER = 'Enter an amount'

async function fillValidForm(user) {
  await user.type(screen.getByLabelText(/Amount of WETH to sell/), '0.001')
  await user.type(screen.getByLabelText(/Limit price/), '2000')
}

beforeEach(() => {
  vi.clearAllMocks()
  state.account = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
  state.indexerConfigured = true
  state.CONFIG_ERROR = null
  state.findPool.mockResolvedValue('0xpool')
  state.allowance.mockResolvedValue(10n * 10n ** 18n)
  state.postOrder.mockResolvedValue({ orderHash: '0x1', status: 'accepted', checked: 'eoa' })
  state.walletClient.signTypedData.mockResolvedValue('0x' + 'ab'.repeat(65))
})

afterEach(cleanup)

describe('LimitOrderForm', () => {
  it('asks for an amount first', async () => {
    render(<LimitOrderForm onPlaced={state.onPlaced} />)
    const btn = await screen.findByRole('button', { name: PLACEHOLDER })
    expect(btn.disabled).toBe(true)
  })

  it('discovers the seeded fee tier before enabling placement', async () => {
    const user = userEvent.setup()
    render(<LimitOrderForm onPlaced={state.onPlaced} />)
    await fillValidForm(user)
    // probing walks the tiers until the factory answers
    await waitFor(() => expect(state.findPool).toHaveBeenCalled())
    const firstCall = state.findPool.mock.calls[0]
    expect(firstCall[1]).toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') // tokenIn
    expect(firstCall[2]).toBe('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb') // tokenOut
    expect(firstCall[3]).toBe(500) // first tier tried
    expect(await screen.findByRole('button', { name: 'Place order' })).toBeTruthy()
  })

  it('blocks placement until the maker has approved the limit contract', async () => {
    state.allowance.mockResolvedValue(0n)
    const user = userEvent.setup()
    render(<LimitOrderForm onPlaced={state.onPlaced} />)
    await fillValidForm(user)
    const approveBtn = await screen.findByRole('button', { name: 'Approve WETH' })
    expect(approveBtn.disabled).toBe(false)
    await user.click(approveBtn)
    expect(state.run).toHaveBeenCalledTimes(1)
    expect(state.run.mock.calls[0][0].label).toBe('Approve WETH')
    expect(state.postOrder).not.toHaveBeenCalled()
  })

  it('signs the EIP-712 order and POSTs it, then reports success', async () => {
    const user = userEvent.setup()
    render(<LimitOrderForm onPlaced={state.onPlaced} />)
    await fillValidForm(user)
    const btn = await screen.findByRole('button', { name: 'Place order' })
    await user.click(btn)

    await waitFor(() => expect(state.postOrder).toHaveBeenCalledTimes(1))
    const signed = state.walletClient.signTypedData.mock.calls[0][0]
    expect(signed.primaryType).toBe('Order')
    expect(signed.domain.name).toBe('SwapexLimitOrders')
    expect(signed.message.amountIn).toBe(10n ** 15n) // 0.001 WETH
    expect(signed.message.minAmountOut).toBe(2n * 10n ** 6n) // 0.001 * 2000 tUSDC
    expect(signed.message.maker).toBe(state.account)
    expect(signed.message.receiver).toBe(state.account)

    const body = state.postOrder.mock.calls[0][0]
    expect(body.signature).toBe('0x' + 'ab'.repeat(65))
    expect(body.fee).toBe(500) // first tier the factory answered for
    expect(body.order.amountIn).toBe('1000000000000000') // 0.001 WETH
    expect(body.order.minAmountOut).toBe('2000000')

    expect(state.addToast).toHaveBeenCalledWith(expect.stringMatching(/^Order placed: 0\.001 WETH at 2000 tUSDC/), 'success')
    expect(state.onPlaced).toHaveBeenCalledTimes(1)
  })

  it('shows the indexer rejection reason instead of a fake success', async () => {
    const err = new Error('invalid signature')
    err.name = 'IndexError'
    state.postOrder.mockRejectedValue(err)
    const user = userEvent.setup()
    render(<LimitOrderForm onPlaced={state.onPlaced} />)
    await fillValidForm(user)
    await user.click(await screen.findByRole('button', { name: 'Place order' }))
    await waitFor(() => expect(state.addToast).toHaveBeenCalledWith('invalid signature', 'error'))
    expect(state.onPlaced).not.toHaveBeenCalled()
  })

  it('refuses to place when the indexer is not connected', async () => {
    state.indexerConfigured = false
    const user = userEvent.setup()
    render(<LimitOrderForm onPlaced={state.onPlaced} />)
    await fillValidForm(user)
    const btn = await screen.findByRole('button', { name: /Indexer not connected/ })
    expect(btn.disabled).toBe(true)
    expect(state.walletClient.signTypedData).not.toHaveBeenCalled()
  })

  it('flags a limit price too low to be a valid minAmountOut', async () => {
    const user = userEvent.setup()
    render(<LimitOrderForm onPlaced={state.onPlaced} />)
    await user.type(screen.getByLabelText(/Amount of WETH to sell/), '0.000000000000000001') // 1 wei
    await user.type(screen.getByLabelText(/Limit price/), '0.000001')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Limit price is too low for this amount' })).toBeTruthy())
  })
})
