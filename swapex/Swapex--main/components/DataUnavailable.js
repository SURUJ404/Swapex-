import { IS_TESTNET } from '../lib/config'

// Shown when a screen needs the Swapex indexer or contracts that are not deployed yet.
// Never render placeholder numbers: an empty state is honest, fake data is not.
export default function DataUnavailable({ title, needs }) {
  return (
    <div className="rounded-3xl border border-[var(--border)] bg-[var(--bg-secondary)] p-8 text-center">
      <h2 className="text-lg font-semibold mb-2">{title}</h2>
      <p className="text-sm text-[var(--text-secondary)] mb-4">
        This screen needs {needs}, which is not connected yet.
        {IS_TESTNET ? ' Nothing here is real data.' : ''}
      </p>
      <p className="text-xs text-[var(--text-tertiary)]">
        See docs/UI_PARITY.md for the build order.
      </p>
    </div>
  )
}
