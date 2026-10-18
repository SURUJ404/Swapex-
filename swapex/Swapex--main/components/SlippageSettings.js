import React, { useState } from 'react'
import {
  MAX_SLIPPAGE_BPS,
  HIGH_SLIPPAGE_BPS,
  LOW_SLIPPAGE_BPS,
} from '../lib/config'
import { percentToBps, bpsToPercent } from '../lib/amounts'

const PRESETS_BPS = [10, 50, 100]

/** Slippage presets + custom input + deadline. Values are held by the parent in bps / minutes. */
export default function SlippageSettings({ bps, onBpsChange, deadline, onDeadlineChange }) {
  const [custom, setCustom] = useState('')

  const onCustom = (v) => {
    setCustom(v)
    const parsed = percentToBps(v, MAX_SLIPPAGE_BPS)
    if (parsed != null) onBpsChange(parsed)
  }

  const warning =
    bps >= HIGH_SLIPPAGE_BPS
      ? 'High slippage: your trade may be front-run.'
      : bps <= LOW_SLIPPAGE_BPS
      ? 'Very low slippage: your transaction may fail.'
      : null

  return (
    <div className="mt-4 mb-6">
      <span className="text-xs text-[var(--text-tertiary)] block mb-2">Slippage Tolerance</span>
      <div className="flex gap-2 items-center flex-wrap">
        {PRESETS_BPS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => { setCustom(''); onBpsChange(s) }}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              bps === s && !custom
                ? 'bg-[var(--accent)] text-white'
                : 'bg-[var(--bg-secondary)] text-[var(--text-secondary)] border border-[var(--border)] hover:border-[var(--accent)]'
            }`}
          >
            {bpsToPercent(s)}%
          </button>
        ))}
        <label htmlFor="slippage-custom" className="sr-only">Custom slippage percent</label>
        <input
          id="slippage-custom"
          type="text"
          inputMode="decimal"
          placeholder="Custom %"
          value={custom}
          onChange={(e) => onCustom(e.target.value)}
          className="w-24 px-2 py-1.5 rounded-lg text-xs bg-[var(--bg-secondary)] border border-[var(--border)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
        />
        <label htmlFor="slippage-deadline" className="flex items-center gap-1 text-xs text-[var(--text-tertiary)] ml-auto">
          Deadline
          <input
            id="slippage-deadline"
            type="number"
            min="1"
            max="4320"
            value={deadline}
            onChange={(e) => onDeadlineChange(Number(e.target.value) || 20)}
            className="w-14 px-2 py-1.5 rounded-lg text-xs bg-[var(--bg-secondary)] border border-[var(--border)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          />
          min
        </label>
      </div>
      {warning && <p className="mt-2 text-xs text-yellow-500">{warning}</p>}
    </div>
  )
}
