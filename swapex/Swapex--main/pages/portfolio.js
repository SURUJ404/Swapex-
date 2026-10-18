import DataUnavailable from '../components/DataUnavailable'
import WalletOverview from '../components/WalletOverview'
import { DEPLOYMENT } from '../lib/config'

export default function PortfolioPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Portfolio</h1>
      {DEPLOYMENT && <WalletOverview />}
      <DataUnavailable
        title="Positions and activity"
        needs="the V3 position screens and the Swapex indexer"
      />
    </div>
  )
}
