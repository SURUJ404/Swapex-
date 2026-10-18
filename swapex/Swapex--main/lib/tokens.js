// Token list for the configured chain: native ETH, WETH, and the test tokens from the deployment manifest.
// There is no hardcoded mainnet list: addresses differ per chain and a wrong one loses funds.
import { DEPLOYMENT, WETH_ADDRESS, REQUIRED_CHAIN_ID } from './config'

const ETH_LOGO = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#627eea"/><path fill="#fff" d="M16 5l-6 10 6 3.5L22 15zM16 19.8L10 16.3 16 27l6-10.7z"/></svg>'
)

/** A letter badge: no external image requests, so nothing leaks and nothing can 404. */
export function tokenLogo(symbol) {
  const letter = (symbol || '?').replace(/^t/, '').charAt(0).toUpperCase() || '?'
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#2a2a2a"/><text x="16" y="21" font-family="Inter,sans-serif" font-size="14" font-weight="600" fill="#fff" text-anchor="middle">${letter}</text></svg>`
  )
}

export function buildTokens(deployment = DEPLOYMENT, weth = WETH_ADDRESS) {
  if (!deployment) return []
  const list = [
    { symbol: 'ETH', name: 'Ether', address: 'NATIVE', decimals: 18, logo: ETH_LOGO },
    { symbol: 'WETH', name: 'Wrapped Ether', address: weth, decimals: 18, logo: ETH_LOGO },
  ]
  for (const t of deployment.tokens || []) {
    list.push({ symbol: t.symbol, name: t.name, address: t.address, decimals: t.decimals, logo: tokenLogo(t.symbol) })
  }
  return list
}

export const TOKENS = buildTokens()
export const CHAIN_ID = REQUIRED_CHAIN_ID

export function findToken(address) {
  if (!address) return null
  return TOKENS.find((t) => t.address.toLowerCase() === address.toLowerCase()) || null
}
