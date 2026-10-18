import DataUnavailable from '../components/DataUnavailable'

export default function ExplorePage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold mb-4">Explore</h1>
      <DataUnavailable
        title="Tokens and pools"
        needs="the Swapex indexer (volume, TVL, price history per token and pool)"
      />
    </div>
  )
}
