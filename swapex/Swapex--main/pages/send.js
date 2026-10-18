import SendForm from '../components/SendForm'
import DataUnavailable from '../components/DataUnavailable'
import { DEPLOYMENT } from '../lib/config'

export default function SendPage() {
  if (!DEPLOYMENT) return <DataUnavailable title="Send" needs="Swapex contracts deployed on this network" />
  return <SendForm />
}
