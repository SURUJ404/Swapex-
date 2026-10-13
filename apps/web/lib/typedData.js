// EIP-712 typed-data helpers — the single place every Swapex signature is built (crypto G.1).
// Threat: a wallet prompt over raw bytes, or a signature bound to the wrong chain, lets a
// phishing page collect a portable signature the user cannot read. Defense: build typed data
// here, refuse a domain whose chainId differs from the connected chain, show a human-readable
// summary while the wallet prompt is open, and verify post-sign that the digest recovers to
// the expected signer before anyone submits it on-chain.
// Library: ethers v5 (pinned in package.json) — `_signTypedData` / `verifyTypedData` per EIP-712.
import { utils } from 'ethers'

export const TYPED_DATA_NAME = 'Swapex AllowanceTransfer'
export const TYPED_DATA_VERSION = '1'

// ethers `_signTypedData(domain, types, value)` wants types WITHOUT an EIP712Domain entry
// (the domain is passed separately and hashed by the library).
export const PERMIT_SINGLE_TYPES = {
  PermitSingle: [
    { name: 'details', type: 'PermitDetails' },
    { name: 'spender', type: 'address' },
    { name: 'sigDeadline', type: 'uint256' },
  ],
  PermitDetails: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint160' },
    { name: 'expiration', type: 'uint48' },
    { name: 'nonce', type: 'uint48' },
  ],
}

/**
 * Builds the PermitSingle typed data for AllowanceTransfer.permit(owner, message, sig).
 * Addresses are normalized through `getAddress`, so a mixed-case input with a bad EIP-55
 * checksum throws here instead of producing a signature over garbage.
 */
export function buildPermitTypedData({
  chainId,
  verifyingContract,
  token,
  amount,
  expiration,
  nonce,
  spender,
  sigDeadline,
}) {
  if (chainId == null || !verifyingContract) {
    throw new Error('buildPermitTypedData: chainId and verifyingContract are required')
  }
  if (amount == null || expiration == null || nonce == null || spender == null || sigDeadline == null) {
    throw new Error('buildPermitTypedData: incomplete permit fields')
  }
  const expirationN = Number(expiration)
  const nonceN = Number(nonce)
  const sigDeadlineN = Number(sigDeadline)
  if (!Number.isSafeInteger(expirationN) || expirationN < 0) throw new Error('buildPermitTypedData: bad expiration')
  if (!Number.isSafeInteger(nonceN) || nonceN < 0) throw new Error('buildPermitTypedData: bad nonce')
  if (!Number.isSafeInteger(sigDeadlineN) || sigDeadlineN < 0) throw new Error('buildPermitTypedData: bad sigDeadline')
  return {
    domain: {
      name: TYPED_DATA_NAME,
      version: TYPED_DATA_VERSION,
      chainId: Number(chainId),
      verifyingContract: utils.getAddress(verifyingContract),
    },
    types: PERMIT_SINGLE_TYPES,
    primaryType: 'PermitSingle',
    message: {
      details: {
        token: utils.getAddress(token),
        // uint160 may exceed Number.MAX_SAFE_INTEGER: keep it a decimal string
        amount: amount.toString(),
        // uint48 timestamps/nonces are far below 2^53: safe as numbers
        expiration: expirationN,
        nonce: nonceN,
      },
      spender: utils.getAddress(spender),
      sigDeadline: sigDeadlineN,
    },
  }
}

/**
 * Refuses to proceed unless the typed-data domain targets the connected chain.
 * This is the "testnet signature can never replay on another chain" rule (rule 4) applied
 * at the moment of signing, not only at submit time.
 */
export function assertDomainChainId(domain, connectedChainId) {
  if (!domain || domain.chainId == null) {
    throw new Error('refusing to sign: typed-data domain carries no chainId')
  }
  const domainChain = Number(domain.chainId)
  const connected = Number(connectedChainId)
  if (!Number.isSafeInteger(domainChain) || !Number.isSafeInteger(connected)) {
    throw new Error('refusing to sign: unparseable chainId in domain or connection')
  }
  if (domainChain !== connected) {
    throw new Error(
      `refusing to sign: typed-data domain targets chain ${domainChain}, wallet is on chain ${connected}`
    )
  }
  return true
}

const short = (address) => `${address.slice(0, 6)}…${address.slice(-4)}`

/**
 * Human-readable summary shown in-page next to the wallet prompt: what is being signed,
 * how much, to whom, until when, on which chain, against which contract.
 */
export function formatSigningSummary(typedData, { tokenSymbol = '', tokenDecimals = 18 } = {}) {
  const { domain, message } = typedData
  // ethers formatUnits renders "25.0"; trim the trailing zero so summaries read naturally
  const amount = utils
    .formatUnits(message.details.amount, tokenDecimals)
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '')
  const when = (unixSeconds) => `${new Date(unixSeconds * 1000).toISOString().replace('.000Z', 'Z')}`
  return {
    title: 'Review this signature',
    lines: [
      ['Action', 'One-time spending grant (EIP-712 typed data)'],
      ['Amount', tokenSymbol ? `${amount} ${tokenSymbol}` : amount],
      ['Token', short(message.details.token)],
      ['Spender', short(message.spender)],
      ['Valid until', `${when(message.sigDeadline)} (signed deadline)`],
      ['Grant expires', `${when(message.details.expiration)} (chain time)`],
      ['Chain', `${domain.chainId} — ${domain.name} v${domain.version}`],
      ['Contract', short(domain.verifyingContract)],
    ],
  }
}

/**
 * Signs typed data with the chainId guard, then proves the signature recovers to the expected
 * signer before it is ever submitted. Two independent refusals: wrong domain chain, or a
 * digest that does not map back to the signing account (malleable/cross-key result).
 */
export async function signTypedDataWithGuard({ signer, typedData, connectedChainId, expectedSigner }) {
  assertDomainChainId(typedData.domain, connectedChainId)
  const who = expectedSigner || (await signer.getAddress())
  const sig = await signer._signTypedData(typedData.domain, typedData.types, typedData.message)
  const recovered = utils.verifyTypedData(typedData.domain, typedData.types, typedData.message, sig)
  if (recovered.toLowerCase() !== who.toLowerCase()) {
    throw new Error('refusing to submit: signature recovers to a different signer')
  }
  return sig
}
