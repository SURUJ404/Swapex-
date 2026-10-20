import { test as base, expect } from '@playwright/test'

const ANVIL = 'http://127.0.0.1:8545'
const INDEXER = 'http://127.0.0.1:4000'
export const ACCOUNT0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

// The app connects through wagmi's injected connector (window.ethereum).
// This shim proxies every JSON-RPC call to the local anvil node; anvil has the
// dev accounts unlocked, so eth_sendTransaction works without in-browser
// signing. The app's CSP (connect-src 'self' https: wss: <indexer>) blocks a
// direct cross-origin fetch to :8545, so the shim posts same-origin to
// /__e2e-rpc and the `wallet` fixture forwards that route to anvil
// server-side via Playwright — no CSP change needed for tests.
const providerShim = () => {
  const listeners = {}
  const post = async (method, params = []) => {
    const res = await fetch('/__e2e-rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    })
    const body = await res.json()
    if (body.error) {
      const err = new Error(body.error.message || method + ' failed')
      err.code = body.error.code
      err.data = body.error.data
      throw err
    }
    return body.result
  }
  window.ethereum = {
    isMetaMask: true,
    selectedAddress: null,
    chainId: null,
    request: async ({ method, params }) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') {
        const accounts = await post('eth_accounts')
        window.ethereum.selectedAddress = accounts[0] || null
        return accounts
      }
      if (method === 'eth_chainId') {
        const id = await post('eth_chainId')
        window.ethereum.chainId = id
        return id
      }
      if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null
      return post(method, params)
    },
    on: (event, fn) => {
      listeners[event] = listeners[event] || []
      listeners[event].push(fn)
    },
    removeListener: (event, fn) => {
      listeners[event] = (listeners[event] || []).filter((f) => f !== fn)
    },
    remove: () => {},
    // legacy send()/enable() kept for wallet libs that still call them; wagmi uses request().
    send: async (target, params) => {
      const method = typeof target === 'string' ? target : target?.method
      if (!method) throw new Error('send: no method')
      const p = (typeof target === 'object' && target.params) || params || []
      const result = await window.ethereum.request({ method, params: p })
      return { id: (typeof target === 'object' && target.id) || 1, jsonrpc: '2.0', result }
    },
    enable: async () => window.ethereum.request({ method: 'eth_requestAccounts' }),
  }
}

async function rpc(url, method, params = []) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = await res.json()
  if (body.error) throw new Error(body.error.message)
  return body.result
}

/**
 * `wallet: true` injects the anvil-backed mock wallet before any page script
 * runs. `requireIndexer: true` fails fast with a plain message when the indexer
 * is down instead of letting the page show its (correct) empty state.
 */
export const test = base.extend({
  wallet: async ({ page }, use) => {
    await page.addInitScript(providerShim)
    // same-origin /__e2e-rpc -> replayed to anvil (bypasses CSP + CORS)
    await page.route('**/__e2e-rpc*', async (route) => {
      const res = await fetch(ANVIL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: route.request().postData() || '{}',
      })
      await route.fulfill({ status: 200, contentType: 'application/json', body: await res.text() })
    })
    await use()
  },
  requireIndexer: async ({}, use) => {
    const ok = await fetch(INDEXER + '/health').then((r) => r.ok).catch(() => false)
    expect(ok, `Indexer is not running at ${INDEXER}. Start the dev stack (./dev.sh) first.`).toBe(true)
    await use()
  },
})

export { expect }

/** Connect through the header button + wallet modal; returns once the account shows. */
export async function connectWallet(page) {
  // clicks before React hydrates land on inert SSR buttons — settle first
  await page.waitForLoadState('networkidle')
  await page.getByRole('button', { name: 'Connect Wallet' }).first().click()
  await page.getByRole('dialog', { name: 'Connect Wallet' }).getByRole('button', { name: 'MetaMask' }).click()
  // the account chip is a span; the Disconnect button only renders when active
  await expect(page.getByRole('button', { name: 'Disconnect' })).toBeVisible()
}

/** Confirm a pending success toast by its exact message. */
export function toast(page, message) {
  return page.getByRole('status').filter({ hasText: message })
}
