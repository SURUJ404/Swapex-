import { useState } from 'react'
import LimitOrderForm from '../components/LimitOrderForm'
import LimitOrdersTable from '../components/LimitOrdersTable'
import DataUnavailable from '../components/DataUnavailable'
import { DEPLOYMENT } from '../lib/config'
import { getFeatures } from '../lib/features'

export default function LimitPage() {
  const [refreshKey, setRefreshKey] = useState(0)
  const features = getFeatures()

  if (!features.limit) {
    const needs = !DEPLOYMENT
      ? 'Swapex contracts deployed on this network'
      : !DEPLOYMENT.limitOrders
      ? 'the SwapexLimitOrders deployment on this network'
      : 'an indexer URL (NEXT_PUBLIC_INDEXER_URL) so signed orders can be listed'
    return <DataUnavailable title="Limit orders" needs={needs} />
  }

  return (
    <div className="space-y-4">
      <LimitOrderForm onPlaced={() => setRefreshKey((k) => k + 1)} />
      <LimitOrdersTable refreshKey={refreshKey} />
    </div>
  )
}
