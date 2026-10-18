// ERC-20 reads and writes. `library` is a provider for reads, `signer` for writes.
import { contractAt, contractFor } from './client'

export function balanceOf(library, token, owner) {
  return contractFor('erc20', token, library).balanceOf(owner)
}

export function allowance(library, token, owner, spender) {
  return contractFor('erc20', token, library).allowance(owner, spender)
}

export function symbol(library, token) {
  return contractFor('erc20', token, library).symbol()
}

export function decimals(library, token) {
  return contractFor('erc20', token, library).decimals()
}

/** Exact-amount approve; returns the transaction (caller awaits / wraps in useTransact). */
export function approve(signer, token, spender, amount) {
  return contractFor('erc20', token, signer).approve(spender, amount)
}

export function transfer(signer, token, to, amount) {
  return contractFor('erc20', token, signer).transfer(to, amount)
}

/** Reads for the deployed test token (faucet) when present. */
export function testToken(library, address) {
  return contractFor('testToken', address, library)
}
