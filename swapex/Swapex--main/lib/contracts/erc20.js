// ERC-20 reads and writes. `client` is a viem public client for reads, a wallet client for writes.
import { contractFor } from './client'

const erc20At = (token) => contractFor('erc20', token)

export function balanceOf(client, token, owner) {
  return client.readContract({ ...erc20At(token), functionName: 'balanceOf', args: [owner] })
}

export function allowance(client, token, owner, spender) {
  return client.readContract({ ...erc20At(token), functionName: 'allowance', args: [owner, spender] })
}

export function symbol(client, token) {
  return client.readContract({ ...erc20At(token), functionName: 'symbol' })
}

export function decimals(client, token) {
  return client.readContract({ ...erc20At(token), functionName: 'decimals' })
}

/** Exact-amount approve; returns the tx hash (caller awaits / wraps in useTransact). */
export function approve(wallet, token, spender, amount) {
  return wallet.writeContract({ ...erc20At(token), functionName: 'approve', args: [spender, amount] })
}

export function transfer(wallet, token, to, amount) {
  return wallet.writeContract({ ...erc20At(token), functionName: 'transfer', args: [to, amount] })
}
