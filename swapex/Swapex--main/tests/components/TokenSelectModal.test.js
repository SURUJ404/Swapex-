import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import TokenSelectModal from '../../components/TokenSelectModal'
import { getTokenMeta } from '../../lib/tokenMeta'
import { loadImportedTokens } from '../../lib/importedTokens'

const UNKNOWN = '0x1111111111111111111111111111111111111111'
const IMPORTED = '0x2222222222222222222222222222222222222222'
const STORAGE_KEY = 'swapex:imported-tokens:11155111' // default chain when NEXT_PUBLIC_CHAIN_ID is unset

const state = { clients: { public: null, wallet: null, account: null } }

vi.mock('../../context/Web3Context', () => ({
  useWeb3: () => ({ clients: state.clients }),
}))

vi.mock('../../lib/tokenMeta', () => ({
  getTokenMeta: vi.fn(),
}))

beforeEach(() => {
  vi.clearAllMocks()
  state.clients = { public: null, wallet: null, account: null }
  window.localStorage.clear()
})

afterEach(cleanup)

describe('TokenSelectModal', () => {
  it('warns about importing an unknown address and blocks it without a wallet', async () => {
    const user = userEvent.setup()
    render(<TokenSelectModal open onClose={vi.fn()} onSelect={vi.fn()} />)
    await user.type(screen.getByPlaceholderText(/Search by name/), UNKNOWN)

    expect(screen.getByText('Import unknown token')).toBeTruthy()
    expect(screen.getByText(/Anyone can create a token/)).toBeTruthy()
    expect(screen.getByText(/fee on every transfer/)).toBeTruthy()

    const btn = screen.getByRole('button', { name: 'Connect a wallet to import' })
    expect(btn.disabled).toBe(true)
    expect(getTokenMeta).not.toHaveBeenCalled()
  })

  it('imports after the warning: reads on-chain meta, persists, selects and closes', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    const onClose = vi.fn()
    state.clients = { public: { _client: 'fake' }, wallet: null, account: '0x1' }
    getTokenMeta.mockResolvedValueOnce({ address: UNKNOWN, symbol: 'MOCK', name: 'Mock Token', decimals: 18 })

    render(<TokenSelectModal open onClose={onClose} onSelect={onSelect} />)
    await user.type(screen.getByPlaceholderText(/Search by name/), UNKNOWN)
    await user.click(screen.getByRole('button', { name: 'Import' }))

    expect(getTokenMeta).toHaveBeenCalledWith(state.clients.public, UNKNOWN)
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ address: UNKNOWN, symbol: 'MOCK', name: 'Mock Token', decimals: 18 })
    )
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(loadImportedTokens().some((t) => t.address === UNKNOWN)).toBe(true)
  })

  it('shows an honest error when the on-chain read fails', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    state.clients = { public: { _client: 'fake' }, wallet: null, account: '0x1' }
    getTokenMeta.mockRejectedValueOnce(new Error('not a token'))

    render(<TokenSelectModal open onClose={vi.fn()} onSelect={onSelect} />)
    await user.type(screen.getByPlaceholderText(/Search by name/), UNKNOWN)
    await user.click(screen.getByRole('button', { name: 'Import' }))

    expect(await screen.findByText(/Could not read this token on-chain/)).toBeTruthy()
    expect(onSelect).not.toHaveBeenCalled()
    expect(loadImportedTokens()).toEqual([])
  })

  it('treats a previously imported address as known: listed, no warning, selectable', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    const onClose = vi.fn()
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([{ address: IMPORTED, symbol: 'IMP', name: 'Imported', decimals: 6 }])
    )

    render(<TokenSelectModal open onClose={onClose} onSelect={onSelect} />)
    await user.type(screen.getByPlaceholderText(/Search by name/), IMPORTED)

    expect(screen.queryByText('Import unknown token')).toBeNull()
    await user.click(screen.getByRole('button', { name: /IMP/ }))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ address: IMPORTED, symbol: 'IMP' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('shows "No tokens found" for a text query with no matches', async () => {
    const user = userEvent.setup()
    render(<TokenSelectModal open onClose={vi.fn()} onSelect={vi.fn()} />)
    await user.type(screen.getByPlaceholderText(/Search by name/), 'zzz-not-a-token')
    expect(screen.getByText('No tokens found')).toBeTruthy()
  })
})
