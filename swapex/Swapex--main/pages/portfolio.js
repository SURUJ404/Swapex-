import WalletOverview from '../components/WalletOverview'
import PortfolioPositions from '../components/PortfolioPositions'
import ActivityList from '../components/ActivityList'
import { DEPLOYMENT } from '../lib/config'

export default function PortfolioPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Portfolio</h1>
      {DEPLOYMENT && <WalletOverview />}
      <PortfolioPositions />
      <ActivityList />
    </div>
  )
}
