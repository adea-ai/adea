import type { ApiRuntimeConnection, ApiRuntimeNodeConnectionsResponse } from '@adea-ai/api-client'

const FRESHNESS_WINDOW_MS = 5 * 60 * 1000
export type NodeProof = Pick<
  ApiRuntimeNodeConnectionsResponse['node'],
  'health' | 'pairingState' | 'lastProofAt'
>

/** Either authoritative registration read can downgrade the inspector. */
export function conservativeNodeProof(first: NodeProof, second: NodeProof, now: number): NodeProof {
  const firstAt = Date.parse(first.lastProofAt ?? '')
  const secondAt = Date.parse(second.lastProofAt ?? '')
  return {
    pairingState:
      first.pairingState === 'revoked' || second.pairingState === 'revoked' ? 'revoked' : 'paired',
    health:
      first.health === 'unknown' || second.health === 'unknown'
        ? 'unknown'
        : first.health === 'stale' || second.health === 'stale'
          ? 'stale'
          : 'healthy',
    lastProofAt:
      !Number.isFinite(firstAt) || !Number.isFinite(secondAt) || firstAt > now || secondAt > now
        ? null
        : firstAt <= secondAt
          ? first.lastProofAt
          : second.lastProofAt,
  }
}

/** Read classifications only; neither a recent proof nor eligibility authorizes execution. */
export function nodeProofState(node: NodeProof, now: number): string {
  const proof = Date.parse(node.lastProofAt ?? '')
  if (!Number.isFinite(proof) || proof > now || node.health === 'unknown') return 'Proof unknown'
  return node.health === 'stale' || now - proof > FRESHNESS_WINDOW_MS
    ? 'Stale proof'
    : 'Recent proof'
}

export function connectionFreshness(
  connection: ApiRuntimeConnection,
  now: number
): ApiRuntimeConnection['freshness']['state'] {
  const observed = Date.parse(connection.freshness.observedAt)
  const outerObserved = Date.parse(connection.observedAt)
  const expires = connection.freshness.expiresAt
    ? Date.parse(connection.freshness.expiresAt)
    : undefined
  if (
    !Number.isFinite(observed) ||
    !Number.isFinite(outerObserved) ||
    observed > now ||
    outerObserved > now ||
    (expires !== undefined && (!Number.isFinite(expires) || expires < observed))
  )
    return 'unknown'
  if (expires !== undefined && now >= expires) return 'expired'
  const state = connection.freshness.state
  return state === 'fresh' &&
    (now - observed > FRESHNESS_WINDOW_MS || now - outerObserved > FRESHNESS_WINDOW_MS)
    ? 'stale'
    : state
}

export function runtimeInspectionState(
  connection: ApiRuntimeConnection,
  node: NodeProof,
  now: number
): string {
  if (node.pairingState === 'revoked') return 'Host revoked'
  if (
    nodeProofState(node, now) !== 'Recent proof' ||
    connectionFreshness(connection, now) !== 'fresh'
  )
    return 'Refresh required'
  return `Reported ${connection.eligibility.state}`
}

export function runtimeInventoryLoadNotice(error: unknown): string {
  const status =
    typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined
  if (status === 401) return 'Sign in to inspect execution hosts.'
  if (status === 403) return 'Only workspace owners and admins can inspect execution hosts.'
  if (status === 503) return 'Execution host discovery is unavailable. Try again later.'
  return 'Execution hosts could not be loaded. Refresh to try again.'
}

/** Only contract enum values use this formatter; upstream free-form error text is never rendered. */
export function runtimeStateLabel(value: string): string {
  return value.replaceAll('_', ' ')
}
