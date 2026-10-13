// EIP-55 checksum validation for every address the user or the app handles (crypto G.2).
// Threat: a dapp that accepts a pasted address without checksum validation silently sends
// funds to an address whose casing was altered (the checksum is the only typo/phish tripwire
// hex addresses have). `utils.getAddress` is the standard validator: all-lowercase,
// all-uppercase, and correctly-checksummed mixed-case inputs normalize; mixed-case with a
// bad checksum throws.
import { utils } from 'ethers'

/**
 * @returns {{ok: boolean, normalized: string|null, mixedCase: boolean, warning: string|null}}
 *  - `ok`        — address parses and (if mixed-case) passes its EIP-55 checksum
 *  - `normalized`— canonical checksummed (mixed-case) form, for display and submission
 *  - `mixedCase` — input used mixed casing, so its checksum was actually verifiable
 *  - `warning`   — human-readable reason when `ok` is false
 */
export function checkAddress(input) {
  const raw = String(input ?? '').trim().replace(/^0X/, '0x')
  const body = raw.startsWith('0x') ? raw.slice(2) : raw
  const mixedCase = /^[0-9a-fA-F]{40}$/.test(body) && body !== body.toLowerCase() && body !== body.toUpperCase()
  try {
    return { ok: true, normalized: utils.getAddress(raw), mixedCase, warning: null }
  } catch (e) {
    return {
      ok: false,
      normalized: null,
      mixedCase,
      warning: mixedCase
        ? 'bad EIP-55 checksum: this mixed-case address does not match its checksum — it may have been altered'
        : e.reason || 'invalid address',
    }
  }
}
