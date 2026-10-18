import React, { useState } from 'react'
import { useRouter } from 'next/router'
import { resolveRoute } from '../lib/navSearch'

const MAGNIFIER = (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 10a7 7 0 11-14 0 7 7 0 0114 0z" />
  </svg>
)

/**
 * Top-nav search box: token symbol/address or pool pair/address -> explore
 * detail, anything else -> the filtered explore list (lib/navSearch.js decides).
 * On transport failure it falls back to the list page, whose own error banner
 * reports the indexer problem — the header never guesses a route it did not
 * verify.
 *
 * Below md the nav links are hidden, so the center slot holds a toggle button
 * that expands the same input into a full-width row under the header.
 */
export default function NavSearch() {
  const router = useRouter()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [openMobile, setOpenMobile] = useState(false)

  function finish() {
    setValue('')
    setBusy(false)
    setOpenMobile(false)
  }

  async function onSubmit(e) {
    e.preventDefault()
    const query = value.trim()
    if (!query || busy) return
    setBusy(true)
    let route
    try {
      route = await resolveRoute(query)
    } catch {
      // indexer unreachable: let the explore list page show its own honest error
      route = { pathname: '/explore', query: { q: query } }
    }
    if (route) await router.push(route)
    finish()
  }

  function onKeyDown(e) {
    if (e.key !== 'Escape') return
    if (value) setValue('')
    else setOpenMobile(false)
  }

  const formClass = openMobile
    ? 'absolute top-full inset-x-0 p-3 bg-[var(--bg-primary)] border-b border-[var(--border)] md:static md:p-0 md:border-0 md:flex md:items-center'
    : 'hidden md:flex md:items-center'

  return (
    <>
      <button
        type="button"
        aria-label="Search tokens and pools"
        aria-expanded={openMobile}
        onClick={() => setOpenMobile((o) => !o)}
        onKeyDown={onKeyDown}
        className="md:hidden w-9 h-9 rounded-full border border-[var(--border)] flex items-center justify-center justify-self-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-card)] transition-colors"
      >
        {MAGNIFIER}
      </button>

      <form role="search" onSubmit={onSubmit} className={formClass}>
        <label className="relative block w-44 lg:w-60">
          <span className="sr-only">Search tokens and pools</span>
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]">{MAGNIFIER}</span>
          <input
            type="search"
            value={value}
            disabled={busy}
            aria-busy={busy}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search symbol or 0x…"
            className="w-full rounded-full border border-[var(--border)] bg-[var(--bg-secondary)] pl-9 pr-3 py-1.5 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)] disabled:opacity-60"
          />
        </label>
        <button type="submit" className="sr-only" disabled={busy || !value.trim()}>
          Search
        </button>
      </form>
    </>
  )
}
