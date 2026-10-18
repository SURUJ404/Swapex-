import { useRouter } from 'next/router'
import PositionDetail from '../../components/PositionDetail'

export default function PositionPage() {
  const { query, isReady } = useRouter()
  if (!isReady) return null
  if (!/^\d+$/.test(String(query.id))) return null
  return <PositionDetail tokenId={String(query.id)} />
}
