import React from 'react'
import { useSigning } from '../context/SigningContext'

// In-page panel shown next to the wallet prompt (crypto G.1): every field the signature
// actually commits to, in plain words, so the user can compare it against the prompt.
export default function SigningSummary() {
  const { summary } = useSigning()
  if (!summary) return null
  return (
    <div
      data-testid="signing-summary"
      role="dialog"
      aria-live="polite"
      aria-label={summary.title}
      className="fixed inset-0 z-50 flex items-start justify-center pt-24 px-4 bg-black/60"
    >
      <div className="bg-[var(--bg-card)] border border-[var(--accent)] rounded-2xl p-6 max-w-md w-full shadow-2xl">
        <h3 className="text-lg font-semibold font-display text-[var(--text-primary)] mb-1">
          {summary.title}
        </h3>
        <p className="text-xs text-[var(--text-tertiary)] mb-4 font-body">
          Check every line against your wallet prompt before approving. If anything differs, reject it.
        </p>
        <dl className="space-y-2 text-sm font-mono">
          {summary.lines.map(([label, value]) => (
            <div key={label} className="flex justify-between gap-4 border-b border-[var(--border)] pb-1.5 last:border-0">
              <dt className="text-[var(--text-tertiary)] shrink-0">{label}</dt>
              <dd className="text-[var(--text-primary)] text-right break-all">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  )
}
