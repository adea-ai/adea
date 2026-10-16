/** Cloud-safe projections of the public Control Plane discovery contract. */
export const runtimeConnectionDiscoveryUnknownDependencies = {
  controlPlaneReadiness: 'control_plane.runtime_connection_discovery.readiness',
  deviceOnline: 'control_plane.runtime_connection_discovery.device_online',
  hostReachability: 'control_plane.runtime_connection_discovery.host_reachability',
  sessionOperations: 'control_plane.runtime_connection_discovery.session_operations',
  transport: 'control_plane.runtime_connection_discovery.transport',
} as const

export type RuntimeConnectionUnknownField<TDependency extends string> = Readonly<{
  state: 'unknown'
  dependency: TDependency
}>

export type ApiRuntimeHostReachability =
  | Readonly<{ state: 'not_applicable' }>
  | RuntimeConnectionUnknownField<
      typeof runtimeConnectionDiscoveryUnknownDependencies.hostReachability
    >

export type ApiRuntimeDeviceOnline =
  | Readonly<{ state: 'not_applicable' }>
  | Readonly<{ state: 'online' | 'offline' }>
  | RuntimeConnectionUnknownField<typeof runtimeConnectionDiscoveryUnknownDependencies.deviceOnline>

export function runtimeNodeHostReachability(kind: 'local_device' | 'remote_host') {
  return kind === 'remote_host'
    ? ({
        state: 'unknown',
        dependency: runtimeConnectionDiscoveryUnknownDependencies.hostReachability,
      } as const)
    : ({ state: 'not_applicable' } as const)
}

export function runtimeNodeDeviceOnline(
  kind: 'local_device' | 'remote_host',
  status?: 'online' | 'offline' | 'revoked'
): ApiRuntimeDeviceOnline {
  if (kind === 'remote_host') return { state: 'not_applicable' }
  if (status === 'online' || status === 'offline') return { state: status }
  return {
    state: 'unknown',
    dependency: runtimeConnectionDiscoveryUnknownDependencies.deviceOnline,
  }
}

export type ApiRuntimeNode = ApiRuntimeNodeConnectionsResponse['node'] &
  Readonly<{
    platform: string
    softwareVersion: string
    lastSeenAt: string | null
  }>

export type ApiRuntimeNodesResponse = Readonly<{ nodes: readonly ApiRuntimeNode[] }>

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
    deviceOnline: ApiRuntimeDeviceOnline
    /** Remote host probing is not part of the current Control Plane list contract. */
    hostReachability: ApiRuntimeHostReachability
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
  /** RuntimeConnectionDiscoveryReadModel does not report transport or session operations. */
  transport: RuntimeConnectionUnknownField<
    typeof runtimeConnectionDiscoveryUnknownDependencies.transport
  >
  sessionOperations: RuntimeConnectionUnknownField<
    typeof runtimeConnectionDiscoveryUnknownDependencies.sessionOperations
  >
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
    deviceOnline: ApiRuntimeDeviceOnline
    hostReachability: ApiRuntimeHostReachability
  }>
  /** An unavailable discovery is distinct from a successful empty inventory. */
  discovery:
    | Readonly<{ state: 'available' }>
    | Readonly<{ state: 'unavailable'; code: 'CONTROL_PLANE_UNAVAILABLE' }>
  /** A successful list request proves discovery reachability, not service readiness. */
  controlPlaneReadiness: RuntimeConnectionUnknownField<
    typeof runtimeConnectionDiscoveryUnknownDependencies.controlPlaneReadiness
  >
  connections: readonly ApiRuntimeConnection[]
  nextCursor?: string
  observedAt: string
}>
