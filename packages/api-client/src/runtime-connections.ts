/** Cloud-safe projections of the public Control Plane discovery contract. */
export type ApiRuntimeConnection = Readonly<{
  id: string
  runtimeDefinitionId: string
  family: string
  connectionType: 'managed_cloud' | 'managed_local' | 'external_local'
  location: 'local_device' | 'remote_host'
  status: 'available' | 'degraded' | 'unavailable' | 'revoked'
  node: Readonly<{
    runtimeNodeRefId: string
    location: 'local_device' | 'remote_host'
    status: 'online' | 'offline' | 'revoked'
    health: 'online' | 'offline' | 'unknown' | 'revoked'
    observedAt: string
  }>
  connection: Readonly<{
    status: 'connected' | 'degraded' | 'unavailable' | 'disconnected' | 'expired' | 'revoked'
    health: 'healthy' | 'degraded' | 'unavailable'
    availability:
      | 'healthy'
      | 'degraded'
      | 'reconnecting'
      | 'offline'
      | 'incompatible'
      | 'revoked'
      | 'stale'
      | 'unknown'
  }>
  freshness: Readonly<{
    state: 'fresh' | 'stale' | 'expired' | 'unknown'
    observedAt: string
    expiresAt?: string
  }>
  versions: Readonly<{ adapter: string; driver: string; harness: string; protocol?: string }>
  capabilities: readonly string[]
  capabilityDetails: readonly Readonly<{
    name: string
    support: 'supported' | 'degraded' | 'unsupported'
    limitations?: readonly string[]
  }>[]
  compatibility: Readonly<{
    state:
      | 'compatible'
      | 'degraded'
      | 'untested'
      | 'incompatible'
      | 'deprecated'
      | 'revoked'
      | 'unavailable'
      | 'capability_missing'
    limitations: readonly string[]
  }>
  access: Readonly<{
    localProjectGrant: Readonly<{
      required: boolean
      state: 'not_required' | 'granted' | 'missing' | 'revoked'
    }>
    entitlement: Readonly<{ state: 'allowed' | 'denied' | 'unknown' }>
  }>
  eligibility: Readonly<{
    state: 'eligible' | 'degraded' | 'ineligible'
    reasons: readonly string[]
    degradations: readonly string[]
    remediation: readonly string[]
  }>
  /** Discovery 1.14.0 does not report transport. Execution resolution owns selection. */
  transport: Readonly<{ state: 'unreported' }>
  observedAt: string
  limitations: readonly string[]
}>

export type ApiRuntimeNodeConnectionsResponse = Readonly<{
  node: Readonly<{
    id: string
    controlPlaneRuntimeNodeRefId: string
    kind: 'local_device' | 'remote_host'
    displayName: string
    health: 'healthy' | 'stale' | 'unknown'
    pairingState: 'paired' | 'revoked'
    lastProofAt: string | null
  }>
  /** An unavailable discovery is distinct from a successful empty inventory. */
  discovery:
    | Readonly<{ state: 'available' }>
    | Readonly<{ state: 'unavailable'; code: 'CONTROL_PLANE_UNAVAILABLE' }>
  connections: readonly ApiRuntimeConnection[]
  nextCursor?: string
  observedAt: string
}>
