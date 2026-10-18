// Feature flags. Driven by env, deployment availability, and indexer
// configuration — sync, so pages can branch at render time. An indexer URL
// being set only enables the flag optimistically; S21 screens still render an
// honest error state when the indexer is unreachable.
import { DEPLOYMENT } from './config'
import { indexerConfigured } from './indexerApi'

/**
 * - explore: needs a deployment (to know the chain) and an indexer URL.
 * - portfolio: works from chain events alone; enabled whenever deployed.
 * - limit: reserved, always false today (no order-type gating yet).
 */
export function getFeatures({ hasDeployment = Boolean(DEPLOYMENT), indexerAvailable = indexerConfigured() } = {}) {
  return {
    explore: Boolean(hasDeployment && indexerAvailable),
    portfolio: Boolean(hasDeployment),
    limit: false,
  }
}
