import DataUnavailable from '../components/DataUnavailable'

export default function LimitPage() {
  return (
    <DataUnavailable
      title="Limit orders"
      needs="the signed limit-order contract (EIP-712) and an order indexer"
    />
  )
}
