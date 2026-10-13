import { describe, it, expect } from 'vitest'
import { Wallet, utils } from 'ethers'
import {
  buildPermitTypedData,
  assertDomainChainId,
  formatSigningSummary,
  signTypedDataWithGuard,
  PERMIT_SINGLE_TYPES,
  TYPED_DATA_NAME,
  TYPED_DATA_VERSION,
} from '../lib/typedData'

// anvil dev account #0 — the same test-only key the e2e wallet shim uses (published in anvil docs)
const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const AT = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0'
const SWA = '0x0165878A594ca255338adfa4d48449f69242Eb8F'
const ROUTER = '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9'
const EXPIRATION = 1_900_000_000
const SIG_DEADLINE = 1_900_000_360

const base = (over = {}) =>
  buildPermitTypedData({
    chainId: 31337,
    verifyingContract: AT,
    token: SWA,
    amount: '25000000000000000000',
    expiration: EXPIRATION,
    nonce: 7,
    spender: ROUTER,
    sigDeadline: SIG_DEADLINE,
    ...over,
  })

describe('buildPermitTypedData', () => {
  it('produces the domain, types and message shape the contract expects', () => {
    const td = base()
    expect(td.domain).toEqual({
      name: TYPED_DATA_NAME,
      version: TYPED_DATA_VERSION,
      chainId: 31337,
      verifyingContract: AT,
    })
    expect(td.primaryType).toBe('PermitSingle')
    expect(Object.keys(td.types)).toEqual(['PermitSingle', 'PermitDetails'])
    // ethers signs without an EIP712Domain member in `types`
    expect(td.types.EIP712Domain).toBeUndefined()
    expect(td.message.details).toEqual({
      token: SWA,
      amount: '25000000000000000000',
      expiration: EXPIRATION,
      nonce: 7,
    })
    expect(td.message.spender).toBe(ROUTER)
    expect(td.message.sigDeadline).toBe(SIG_DEADLINE)
  })

  it('normalizes addresses to EIP-55 and refuses a bad mixed-case checksum at build time', () => {
    const lower = base({ spender: ROUTER.toLowerCase() })
    expect(lower.message.spender).toBe(ROUTER)
    const badMixed = ROUTER.slice(0, 4) + ROUTER[4].toUpperCase() + ROUTER.slice(5).toLowerCase()
    expect(() => base({ spender: badMixed })).toThrow(/checksum/i)
  })

  it('keeps uint160 amounts exact as decimal strings', () => {
    const huge = '1461501637330902918203684832716283019655932542975' // > 2^53
    const td = base({ amount: huge })
    expect(td.message.details.amount).toBe(huge)
    expect(td.message.details.amount.length).toBe(49) // ceil(log10(2^160)) = 49 digits
  })

  it('rejects incomplete input', () => {
    expect(() => base({ sigDeadline: null })).toThrow(/incomplete/)
    expect(() => base({ chainId: null })).toThrow(/required/)
    expect(() => base({ nonce: -1 })).toThrow(/nonce/)
  })
})

describe('assertDomainChainId', () => {
  it('accepts the matching chain across number/string/bigint forms', () => {
    expect(assertDomainChainId({ chainId: 31337 }, 31337)).toBe(true)
    expect(assertDomainChainId({ chainId: '31337' }, 31337)).toBe(true)
    expect(assertDomainChainId({ chainId: 31337 }, '31337')).toBe(true)
    expect(assertDomainChainId({ chainId: 31337n }, 31337)).toBe(true)
  })

  it('refuses a domain that targets another chain', () => {
    expect(() => assertDomainChainId({ chainId: 1 }, 31337)).toThrow(
      /targets chain 1, wallet is on chain 31337/
    )
    expect(() => assertDomainChainId({ chainId: 31337 }, 1)).toThrow(/refusing to sign/)
  })

  it('refuses a domain with no chainId or unparseable values', () => {
    expect(() => assertDomainChainId({}, 31337)).toThrow(/no chainId/)
    expect(() => assertDomainChainId(null, 31337)).toThrow(/no chainId/)
    expect(() => assertDomainChainId({ chainId: 'mainnet' }, 31337)).toThrow(/unparseable/)
  })
})

describe('signTypedDataWithGuard', () => {
  const wallet = new Wallet(PK)

  it('signs and verifies: digest recovers to the signing account', async () => {
    const td = base()
    const sig = await signTypedDataWithGuard({
      signer: wallet,
      typedData: td,
      connectedChainId: 31337,
      expectedSigner: wallet.address,
    })
    expect(sig).toMatch(/^0x[0-9a-fA-F]{130}$/) // 65-byte compact-form expanded signature
    const recovered = utils.verifyTypedData(td.domain, td.types, td.message, sig)
    expect(recovered).toBe(wallet.address)
  })

  it('refuses to sign when the domain chain differs from the connected chain', async () => {
    const td = base({ chainId: 1 })
    await expect(
      signTypedDataWithGuard({ signer: wallet, typedData: td, connectedChainId: 31337 })
    ).rejects.toThrow(/targets chain 1/)
  })

  it('refuses to submit when the signature recovers to a different signer', async () => {
    const td = base()
    await expect(
      signTypedDataWithGuard({
        signer: wallet,
        typedData: td,
        connectedChainId: 31337,
        expectedSigner: Wallet.createRandom().address,
      })
    ).rejects.toThrow(/recovers to a different signer/)
  })

  it('domain separation: the same message on another chain yields a different signature', async () => {
    const sig31337 = await wallet._signTypedData(base().domain, PERMIT_SINGLE_TYPES, base().message)
    const sig1 = await wallet._signTypedData(
      base({ chainId: 1 }).domain,
      PERMIT_SINGLE_TYPES,
      base().message
    )
    expect(sig31337).not.toBe(sig1)
    // neither signature verifies under the other domain
    expect(utils.verifyTypedData(base({ chainId: 1 }).domain, PERMIT_SINGLE_TYPES, base().message, sig31337)).not.toBe(
      wallet.address
    )
  })

  it('replay surface: a different nonce changes the digest', async () => {
    const a = await wallet._signTypedData(base().domain, PERMIT_SINGLE_TYPES, base().message)
    const b = await wallet._signTypedData(base().domain, PERMIT_SINGLE_TYPES, base({ nonce: 8 }).message)
    expect(a).not.toBe(b)
  })
})

describe('formatSigningSummary', () => {
  it('shows amount, spender, signed deadline, chain and contract in plain words', () => {
    const td = base()
    const s = formatSigningSummary(td, { tokenSymbol: 'SWA', tokenDecimals: 18 })
    expect(s.title).toMatch(/signature/i)
    const flat = s.lines.map((l) => l.join(' ')).join('\n')
    expect(flat).toContain('25 SWA')
    expect(flat).toContain('31337')
    expect(flat).toContain(TYPED_DATA_NAME)
    expect(flat).toContain(ROUTER.slice(0, 6)) // spender shown, short but recognizable
    expect(flat).toContain(AT.slice(0, 6))
    expect(flat).toMatch(/1900000360|2030-03-17/) // signed deadline rendered as a date
  })

  it('renders the amount exactly for large uint160 values', () => {
    const td = base({ amount: '1000000000000000000000000' })
    const s = formatSigningSummary(td, { tokenSymbol: 'SWA', tokenDecimals: 18 })
    expect(s.lines.find((l) => l[0] === 'Amount')[1]).toBe('1000000 SWA')
  })
})
