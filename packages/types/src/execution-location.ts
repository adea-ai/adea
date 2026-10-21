/**
 * Pure execution-location policy for M11 #186, and the runtime and profile
 * read models for M11 #37 and #41.
 *
 * This module deliberately consumes read models and returns a decision. It
 * does not discover, authorize, move, or execute work on a runtime node. The
 * Control Plane/runtime integrations own those effects.
 *
 * The read models below are the only shapes a client payload may carry for a
 * runtime connection or an Agent profile pin. They have no field for credential
 * material, a native path, a process handle, an endpoint, a free-form upstream
 * label or native session state.
 */

export const executionLocationKinds = ['local_device', 'remote_host', 'agent_hq_cloud'] as const

export type ExecutionLocationKind = (typeof executionLocationKinds)[number]
export type RuntimeNodeLocationKind = Exclude<ExecutionLocationKind, 'agent_hq_cloud'>

/** A user-selected location. A runtime node id is required for both developer locations. */
export type ExecutionLocationSelection =
  | Readonly<{ kind: 'local_device'; runtimeNodeId: string }>
  | Readonly<{ kind: 'remote_host'; runtimeNodeId: string }>
  | Readonly<{ kind: 'agent_hq_cloud' }>

export const executionRuntimeNodeAvailability = [
  'available',
  'offline',
  'revoked',
  'stale',
  'incompatible',
  'unknown',
] as const

export type ExecutionRuntimeNodeAvailability = (typeof executionRuntimeNodeAvailability)[number]

/** A health observation older than this cannot authorize a new execution. */
export const EXECUTION_LOCATION_MAX_OBSERVATION_AGE_MS = 5 * 60 * 1_000

/**
 * The smallest normalized node read model required by this policy. Callers
 * map the existing RuntimeNode/Control Plane read model into this shape; no
 * transport or credential fields cross this boundary.
 */
export type RuntimeNodeExecutionReadModel = Readonly<{
  availability: ExecutionRuntimeNodeAvailability
  capabilities: readonly string[]
  displayName: string
  id: string
  kind: RuntimeNodeLocationKind
  /** Timestamp at which this node read model was observed. */
  observedAt: string
  /** Last accepted node proof. Required and fresh when availability is `available`. */
  proofAt: string | null
}>

export type ExecutionDataAvailability = Readonly<{
  /** Channel/message metadata remains a Control Plane product read model. */
  channelMessageMetadata: 'available' | 'unavailable'
  /** Authorized e2e-synchronized history may remain readable while a host is offline. */
  synchronizedHistory: 'available' | 'unavailable'
  /** Local-authority bodies require the content authority to be available. */
  localOnlyContent: 'available' | 'unavailable'
}>

/** Explicit feature gate for the future managed cloud location. */
export type AgentHqCloudExecutionGate = Readonly<{
  capabilities?: readonly string[]
  enabled: boolean
}>

export type ExecutionLocationPolicyInput = Readonly<{
  /**
   * The runtime connections registered for the workspace's hosts, when the
   * caller holds that inventory.
   *
   * A connection is evidence about a runtime on a host. It never replaces the
   * registered node's own availability, and a host with no connection in this
   * list is not blocked for that alone: an undiscovered runtime is not the
   * same observation as a broken one.
   */
  connections?: readonly RuntimeConnectionExecutionReadModel[]
  cloud?: AgentHqCloudExecutionGate
  dataAvailability: ExecutionDataAvailability
  /** The paired local device used when the user provides no location override. */
  localRuntimeNodeId: string
  nodes: readonly RuntimeNodeExecutionReadModel[]
  requiredCapabilities: readonly string[]
  requestedLocation?: ExecutionLocationSelection
  /** Admission time used for deterministic observation/proof freshness checks. */
  now: string
}>

/**
 * Every explicit blocked or queued state this policy can report.
 *
 * The `location_*` codes describe the registered node; the `connection_*`,
 * `provider_*`, `transport_*`, `grant_*` and `entitlement_*` codes describe one
 * runtime connection on that node. They are separate authorities and are never
 * reported as one another.
 */
export const executionLocationBlockers = [
  'location_missing',
  'location_offline',
  'location_revoked',
  'location_stale',
  'location_incompatible',
  'capability_mismatch',
  'cloud_feature_disabled',
  'location_unknown',
  'connection_unavailable',
  'connection_stale',
  'provider_auth_required',
  'provider_auth_expired',
  'transport_unavailable',
  'grant_missing',
  'grant_revoked',
  'entitlement_denied',
] as const

export type ExecutionLocationBlocker = (typeof executionLocationBlockers)[number]

export type ExecutionLocationRemediationAction =
  | 'select_registered_location'
  | 'reconnect_location'
  | 'refresh_location'
  | 'repair_or_select_location'
  | 'upgrade_or_select_compatible_location'
  | 'enable_required_capabilities_or_select_location'
  | 'enable_cloud_feature'

export type ExecutionLocationRemediation = Readonly<{
  action: ExecutionLocationRemediationAction
  missingCapabilities?: readonly string[]
}>

/**
 * How a location was resolved.
 *
 * `default_local` and `explicit_selection` describe the first attempt;
 * `sticky_retry` and `authorized_reroute` describe a later one. The durable
 * per-attempt change vocabulary is `ExecutionAttemptChange`
 * (`initial | sticky_retry | authorized_reroute`): `initial` covers both
 * `default_local` and `explicit_selection`.
 */
export type ExecutionLocationProvenance =
  | 'default_local'
  | 'explicit_selection'
  | 'sticky_retry'
  | 'authorized_reroute'

type DecisionBase = Readonly<{
  dataAvailability: ExecutionDataAvailability
  /** How this location was resolved. */
  provenance: ExecutionLocationProvenance
  selectedLocation: ExecutionLocationSelection
}>

export type ExecutionLocationDecision =
  | (DecisionBase &
      Readonly<{
        action: 'execute'
        reason: 'location_available'
      }>)
  | (DecisionBase &
      Readonly<{
        action: 'queue'
        blocker: 'location_offline' | 'location_stale' | 'connection_stale'
        remediation: ExecutionLocationRemediation
      }>)
  | (DecisionBase &
      Readonly<{
        action: 'block'
        blocker: Exclude<
          ExecutionLocationBlocker,
          'location_offline' | 'location_stale' | 'connection_stale'
        >
        remediation: ExecutionLocationRemediation
        missingCapabilities?: readonly string[]
      }>)

/** The durable location binding for one task execution attempt. */
export type ExecutionLocationAttempt = Readonly<{
  attempt: number
  /**
   * The exact profile version this attempt is bound to. The pin is immutable
   * for the attempt's lifetime: a retry keeps it, a reroute keeps it, and a
   * newer catalog version is never substituted for it.
   */
  profile: ExecutionProfilePin
  scope: ExecutionLocationAttemptScope
  selectedLocation: ExecutionLocationSelection
}>

/** The task/actor scope an authorization proof must bind exactly. */
export type ExecutionLocationAttemptScope = Readonly<{
  accountId: string
  actorId: string
  taskId: string
  workspaceId: string
}>

/**
 * Opaque Control Plane authorization, bound to one attempt and target. The
 * Control Plane issues/validates the proof; this pure policy only checks its
 * scope binding before admitting a reroute.
 */
export type ExecutionLocationRerouteAuthorization = Readonly<{
  attempt: number
  authorizationProof: string
  scope: ExecutionLocationAttemptScope
  targetLocation: ExecutionLocationSelection
}>

export type ExecutionRetryResolution =
  | Readonly<{
      admission: Extract<ExecutionLocationDecision, { action: 'execute' }>
      attempt: ExecutionLocationAttempt
      change: 'sticky_retry' | 'authorized_reroute'
      ok: true
    }>
  | Readonly<{
      change: 'location_not_admissible'
      decision: Exclude<ExecutionLocationDecision, { action: 'execute' }>
      ok: false
      previousLocation: ExecutionLocationSelection
    }>
  | Readonly<{
      change: 'reroute_authorization_invalid' | 'reroute_requires_authorization'
      ok: false
      previousLocation: ExecutionLocationSelection
      requestedLocation: ExecutionLocationSelection
    }>
  | Readonly<{
      change: 'attempt_invalid'
      ok: false
      previousLocation: ExecutionLocationSelection
    }>
  | Readonly<{
      change: 'profile_pin_changed'
      ok: false
      previousLocation: ExecutionLocationSelection
      previousProfile: ExecutionProfilePin
      requestedProfile: ExecutionProfilePin
    }>

export function normalizeExecutionRuntimeNodeAvailability(
  value: unknown
): ExecutionRuntimeNodeAvailability {
  return executionRuntimeNodeAvailability.includes(value as ExecutionRuntimeNodeAvailability)
    ? (value as ExecutionRuntimeNodeAvailability)
    : 'unknown'
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

function missingCapabilities(required: readonly string[], available: readonly string[]): string[] {
  const availableSet = new Set(available)
  return uniqueSorted(required.filter((capability) => !availableSet.has(capability)))
}

function locationsEqual(
  left: ExecutionLocationSelection,
  right: ExecutionLocationSelection
): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'agent_hq_cloud') return true
  if (right.kind === 'agent_hq_cloud') return false
  return left.runtimeNodeId === right.runtimeNodeId
}

function remediationForBlocker(
  blocker: ExecutionLocationBlocker,
  capabilities: readonly string[] = []
): ExecutionLocationRemediation {
  switch (blocker) {
    case 'location_missing':
      return { action: 'select_registered_location' }
    case 'location_offline':
      return { action: 'reconnect_location' }
    case 'location_stale':
      return { action: 'refresh_location' }
    case 'location_revoked':
      return { action: 'repair_or_select_location' }
    case 'location_incompatible':
      return { action: 'upgrade_or_select_compatible_location' }
    case 'capability_mismatch':
      return {
        action: 'enable_required_capabilities_or_select_location',
        missingCapabilities: capabilities,
      }
    case 'cloud_feature_disabled':
      return { action: 'enable_cloud_feature' }
    case 'location_unknown':
      return { action: 'refresh_location' }
    case 'connection_unavailable':
      return { action: 'reconnect_location' }
    case 'connection_stale':
      return { action: 'refresh_location' }
    case 'provider_auth_required':
    case 'provider_auth_expired':
    case 'transport_unavailable':
    case 'grant_missing':
    case 'grant_revoked':
    case 'entitlement_denied':
      return { action: 'repair_or_select_location' }
  }
}

/**
 * How the caller reached this decision: an explicit choice, or the paired
 * local device the policy defaults to.
 */
function provenanceFor(input: ExecutionLocationPolicyInput): ExecutionLocationProvenance {
  return input.requestedLocation ? 'explicit_selection' : 'default_local'
}

function blocked(
  input: ExecutionLocationPolicyInput,
  selectedLocation: ExecutionLocationSelection,
  blocker: Exclude<
    ExecutionLocationBlocker,
    'location_offline' | 'location_stale' | 'connection_stale'
  >,
  missing: readonly string[] = []
): ExecutionLocationDecision {
  return {
    action: 'block',
    blocker,
    dataAvailability: input.dataAvailability,
    ...(missing.length ? { missingCapabilities: missing } : {}),
    provenance: provenanceFor(input),
    remediation: remediationForBlocker(blocker, missing),
    selectedLocation,
  }
}

function queued(
  input: ExecutionLocationPolicyInput,
  selectedLocation: ExecutionLocationSelection,
  blocker: 'location_offline' | 'location_stale' | 'connection_stale'
): ExecutionLocationDecision {
  return {
    action: 'queue',
    blocker,
    dataAvailability: input.dataAvailability,
    provenance: provenanceFor(input),
    remediation: remediationForBlocker(blocker),
    selectedLocation,
  }
}

function parseTimestamp(value: string): number | null {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

function observationFreshness(
  node: RuntimeNodeExecutionReadModel,
  availability: ExecutionRuntimeNodeAvailability,
  now: string
): 'fresh' | 'stale' | 'unknown' {
  const nowMs = parseTimestamp(now)
  const observedAtMs = parseTimestamp(node.observedAt)
  if (nowMs === null || observedAtMs === null || observedAtMs > nowMs) return 'unknown'
  if (nowMs - observedAtMs > EXECUTION_LOCATION_MAX_OBSERVATION_AGE_MS) return 'stale'

  if (availability !== 'available') return 'fresh'
  if (!node.proofAt) return 'unknown'
  const proofAtMs = parseTimestamp(node.proofAt)
  if (proofAtMs === null || proofAtMs > nowMs || proofAtMs > observedAtMs) return 'unknown'
  return nowMs - proofAtMs > EXECUTION_LOCATION_MAX_OBSERVATION_AGE_MS ? 'stale' : 'fresh'
}

/**
 * Select and evaluate one location without ever considering another location
 * as an implicit fallback. Local is selected when the caller omits a choice.
 */
export function decideExecutionLocation(
  input: ExecutionLocationPolicyInput
): ExecutionLocationDecision {
  const selectedLocation =
    input.requestedLocation ??
    ({ kind: 'local_device', runtimeNodeId: input.localRuntimeNodeId } as const)

  if (selectedLocation.kind === 'agent_hq_cloud') {
    if (!input.cloud?.enabled) return blocked(input, selectedLocation, 'cloud_feature_disabled')

    const missing = missingCapabilities(input.requiredCapabilities, input.cloud.capabilities ?? [])
    if (missing.length) return blocked(input, selectedLocation, 'capability_mismatch', missing)
    return {
      action: 'execute',
      dataAvailability: input.dataAvailability,
      provenance: provenanceFor(input),
      reason: 'location_available',
      selectedLocation,
    }
  }

  const node = input.nodes.find(
    (candidate) =>
      candidate.id === selectedLocation.runtimeNodeId && candidate.kind === selectedLocation.kind
  )
  if (!node) return blocked(input, selectedLocation, 'location_missing')

  const availability = normalizeExecutionRuntimeNodeAvailability(node.availability)
  const freshness = observationFreshness(node, availability, input.now)
  if (availability === 'unknown' || freshness === 'unknown')
    return blocked(input, selectedLocation, 'location_unknown')
  if (freshness === 'stale') return queued(input, selectedLocation, 'location_stale')

  switch (availability) {
    case 'offline':
      return queued(input, selectedLocation, 'location_offline')
    case 'stale':
      return queued(input, selectedLocation, 'location_stale')
    case 'revoked':
      return blocked(input, selectedLocation, 'location_revoked')
    case 'incompatible':
      return blocked(input, selectedLocation, 'location_incompatible')
    case 'available': {
      const missing = missingCapabilities(input.requiredCapabilities, node.capabilities)
      if (missing.length) return blocked(input, selectedLocation, 'capability_mismatch', missing)

      const connectionDecision = decideConnectionAdmission(input, selectedLocation)
      if (connectionDecision) return connectionDecision

      return {
        action: 'execute',
        dataAvailability: input.dataAvailability,
        provenance: provenanceFor(input),
        reason: 'location_available',
        selectedLocation,
      }
    }
  }
}

/**
 * The registered node stays the authority for node and host admission; a
 * runtime connection is the authority for the runtime, provider and transport
 * it carries. A connection therefore only adds a blocked state when every
 * connection registered for the selected node is itself blocked. One usable
 * connection is enough, and the blocked ones stay visible in the inventory
 * instead of failing the location.
 */
function decideConnectionAdmission(
  input: ExecutionLocationPolicyInput,
  selectedLocation: ExecutionLocationSelection
): ExecutionLocationDecision | null {
  if (selectedLocation.kind === 'agent_hq_cloud') return null
  const connections = (input.connections ?? []).filter(
    (connection) => connection.identity.runtimeNodeId === selectedLocation.runtimeNodeId
  )
  if (connections.length === 0) return null

  const evaluated = connections.map((connection) => {
    const missing = missingCapabilities(input.requiredCapabilities, connection.capabilities)
    const freshness = connectionFreshness(connection, input.now)
    const blockers: ExecutionLocationBlocker[] = [...connection.blockers]
    if (missing.length) blockers.push('capability_mismatch')
    if (freshness === 'unknown') blockers.push('location_unknown')
    else if (freshness === 'stale') blockers.push('connection_stale')
    return { blockers, missing }
  })

  const blockedConnections = evaluated.filter((entry) => entry.blockers.length > 0)
  if (blockedConnections.length < evaluated.length) return null

  const blocker = mostSevereBlocker(blockedConnections.flatMap((entry) => entry.blockers))
  if (!blocker) return null
  if (isQueueBlocker(blocker)) return queued(input, selectedLocation, blocker)
  const missing =
    blocker === 'capability_mismatch'
      ? uniqueSorted(blockedConnections.flatMap((entry) => entry.missing))
      : []
  return blocked(input, selectedLocation, blocker, missing)
}

/**
 * A connection observation older than the admission window is stale inventory,
 * not a healthy runtime. A missing or future timestamp is unusable and blocks.
 */
function connectionFreshness(
  connection: RuntimeConnectionExecutionReadModel,
  now: string
): 'fresh' | 'stale' | 'unknown' {
  const nowMs = parseTimestamp(now)
  const observedAtMs = parseTimestamp(connection.observedAt)
  if (nowMs === null || observedAtMs === null || observedAtMs > nowMs) return 'unknown'
  return nowMs - observedAtMs > EXECUTION_LOCATION_MAX_OBSERVATION_AGE_MS ? 'stale' : 'fresh'
}

/**
 * Retries retain the attempt's location. A different location is accepted
 * only when the caller supplies an explicit authorized reroute decision.
 *
 * The attempt's profile pin is immutable: a retry may not move the attempt to
 * another profile version, because the pinned version is the one the
 * submission was authorized against.
 */
export function resolveExecutionRetry(
  input: Readonly<{
    attempt: ExecutionLocationAttempt
    policy: ExecutionLocationPolicyInput
    requestedLocation?: ExecutionLocationSelection
    /** A pin that differs from the attempt's own pin is refused. */
    requestedProfile?: ExecutionProfilePin
    rerouteAuthorization?: ExecutionLocationRerouteAuthorization
  }>
): ExecutionRetryResolution {
  if (!isValidAttempt(input.attempt))
    return {
      change: 'attempt_invalid',
      ok: false,
      previousLocation: input.attempt.selectedLocation,
    }

  if (input.requestedProfile && !pinsEqual(input.requestedProfile, input.attempt.profile))
    return {
      change: 'profile_pin_changed',
      ok: false,
      previousLocation: input.attempt.selectedLocation,
      previousProfile: input.attempt.profile,
      requestedProfile: input.requestedProfile,
    }

  const requestedLocation = input.requestedLocation ?? input.attempt.selectedLocation
  const rerouted = !locationsEqual(requestedLocation, input.attempt.selectedLocation)
  if (rerouted && !input.rerouteAuthorization)
    return {
      change: 'reroute_requires_authorization',
      ok: false,
      previousLocation: input.attempt.selectedLocation,
      requestedLocation,
    }
  if (
    rerouted &&
    input.rerouteAuthorization &&
    !isValidRerouteAuthorization({
      attempt: input.attempt,
      authorization: input.rerouteAuthorization,
      requestedLocation,
    })
  )
    return {
      change: 'reroute_authorization_invalid',
      ok: false,
      previousLocation: input.attempt.selectedLocation,
      requestedLocation,
    }

  const admission = decideExecutionLocation({ ...input.policy, requestedLocation })
  if (admission.action !== 'execute')
    return {
      change: 'location_not_admissible',
      decision: admission,
      ok: false,
      previousLocation: input.attempt.selectedLocation,
    }

  const provenance: ExecutionLocationProvenance = rerouted ? 'authorized_reroute' : 'sticky_retry'
  return {
    admission: { ...admission, provenance },
    attempt: {
      attempt: input.attempt.attempt + 1,
      profile: input.attempt.profile,
      scope: input.attempt.scope,
      selectedLocation: requestedLocation,
    },
    change: rerouted ? 'authorized_reroute' : 'sticky_retry',
    ok: true,
  }
}

function sameScope(left: ExecutionLocationAttemptScope, right: ExecutionLocationAttemptScope) {
  return (
    left.accountId === right.accountId &&
    left.actorId === right.actorId &&
    left.taskId === right.taskId &&
    left.workspaceId === right.workspaceId
  )
}

function hasText(value: string): boolean {
  return value.trim().length > 0
}

function isValidScope(scope: ExecutionLocationAttemptScope): boolean {
  return (
    hasText(scope.accountId) &&
    hasText(scope.actorId) &&
    hasText(scope.taskId) &&
    hasText(scope.workspaceId)
  )
}

function isValidAttempt(attempt: ExecutionLocationAttempt): boolean {
  return (
    Number.isInteger(attempt.attempt) &&
    attempt.attempt > 0 &&
    isValidScope(attempt.scope) &&
    isValidPin(attempt.profile)
  )
}

/** A pin is usable only when it names an exact profile version and revision. */
function isValidPin(pin: ExecutionProfilePin): boolean {
  return (
    hasText(pin.id) && hasText(pin.version) && Number.isInteger(pin.revision) && pin.revision >= 0
  )
}

function pinsEqual(left: ExecutionProfilePin, right: ExecutionProfilePin): boolean {
  return left.id === right.id && left.version === right.version && left.revision === right.revision
}

function isValidRerouteAuthorization(
  input: Readonly<{
    attempt: ExecutionLocationAttempt
    authorization: ExecutionLocationRerouteAuthorization
    requestedLocation: ExecutionLocationSelection
  }>
): boolean {
  const { attempt, authorization, requestedLocation } = input
  return (
    hasText(authorization.authorizationProof) &&
    authorization.attempt === attempt.attempt &&
    isValidScope(authorization.scope) &&
    sameScope(authorization.scope, attempt.scope) &&
    locationsEqual(authorization.targetLocation, requestedLocation)
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Stable identity (M11 #37/#41)
// ────────────────────────────────────────────────────────────────────────────

/**
 * The stable public identity of a registered execution host.
 *
 * `controlPlaneRuntimeNodeRefId` is minted once at registration and survives
 * resume, key rotation and revocation; `id` is the Adea UUID of the registered
 * node. Consumers join on these two values, never on a display name, a
 * transport variant, a key or an array position. Possessing either reference
 * grants no authority.
 */
export type RuntimeNodeExecutionIdentity = Readonly<{
  controlPlaneRuntimeNodeRefId: string
  id: string
  kind: RuntimeNodeLocationKind
}>

/**
 * The stable public identity of one runtime connection.
 *
 * The transport variant is deliberately absent: `direct_local` and
 * `remote_gateway` describe how work would travel, not what the connection is.
 * A connection keeps its identity when its transport variant changes.
 */
export type RuntimeConnectionExecutionIdentity = Readonly<{
  id: string
  runtimeDefinitionId: string
  runtimeNodeId: string
}>

/**
 * The stable public identity of an Agent.
 *
 * Both values survive a profile version change: an upgrade or a rollback
 * changes the pin, never the identity.
 */
export type AgentExecutionIdentity = Readonly<{
  controlPlaneAgentId: string
  id: string
}>

// ────────────────────────────────────────────────────────────────────────────
// Health dimensions (M11 #37)
// ────────────────────────────────────────────────────────────────────────────

/**
 * The five independent health dimensions of one execution target.
 *
 * They are reported separately because they are separate observations from
 * separate authorities, and one is never inferred from another.
 */
export const executionHealthDimensions = [
  'host',
  'node',
  'provider',
  'runtime',
  'transport',
] as const

export type ExecutionHealthDimension = (typeof executionHealthDimensions)[number]

/** Adea's own proof-derived health for the registered node. */
export type ExecutionNodeHealth = 'healthy' | 'stale' | 'unknown'

/**
 * The Control Plane's reported reachability of the host that owns the node.
 *
 * `not_applicable` is the honest state for a local device, whose reachability
 * is not a remote-host property; it is never reported as healthy.
 */
export type ExecutionHostHealth = 'online' | 'offline' | 'revoked' | 'unknown' | 'not_applicable'

/** The runtime connection's own health. */
export type ExecutionRuntimeHealth = 'healthy' | 'degraded' | 'unhealthy' | 'unknown'

/** Whether the model provider behind the connection can still be used. */
export type ExecutionProviderHealth = 'ready' | 'required' | 'expired' | 'unknown'

/** Whether the transport variant can carry work at all. */
export type ExecutionTransportHealth = 'available' | 'unavailable' | 'unknown'

export type ExecutionLocationHealth = Readonly<{
  host: ExecutionHostHealth
  node: ExecutionNodeHealth
  provider: ExecutionProviderHealth
  runtime: ExecutionRuntimeHealth
  transport: ExecutionTransportHealth
}>

/**
 * How work travels to a runtime connection.
 *
 * This is a variant, never part of a connection's identity: the same
 * connection keeps its identity when its transport variant is reported
 * differently.
 */
export type ExecutionTransport = 'direct_local' | 'remote_gateway'

// ────────────────────────────────────────────────────────────────────────────
// Runtime connection read model (M11 #37)
// ────────────────────────────────────────────────────────────────────────────

/**
 * The access facts a connection reports. A grant state is a public fact about
 * permission; it is never a credential.
 */
export type RuntimeConnectionExecutionAccess = Readonly<{
  /** The entitlement the connection needs before it may run work. */
  entitlement: 'allowed' | 'denied' | 'unknown'
  /** The project grant the connection needs before it may run work. */
  grant: 'not_required' | 'granted' | 'missing' | 'revoked'
}>

/**
 * The observations a caller may offer when projecting a runtime connection.
 *
 * This type is an allow-list. It has no field for credential material, a
 * native path, a process handle, an endpoint, a free-form upstream label or
 * native session state, so none of those can reach a client payload through
 * the projection. A host adapter that holds such values keeps them.
 */
export type RuntimeConnectionExecutionSource = Readonly<{
  /** The stable public identity of the connection. */
  identity: RuntimeConnectionExecutionIdentity
  /** How work would travel to this connection. */
  transport: ExecutionTransport
  /** The five independent health observations about this connection. */
  health: ExecutionLocationHealth
  /** The public capability names this connection reports. */
  capabilities: readonly string[]
  /** The access facts this connection reports. */
  access: RuntimeConnectionExecutionAccess
  /** When this observation was taken. */
  observedAt: string
}>

/**
 * The bounded public read model of one runtime connection.
 *
 * This is the only shape a client payload may carry for a connection. It
 * reports the five health dimensions separately, names the connection's stable
 * identity, and lists the explicit blocked states instead of collapsing them
 * into one availability field.
 */
export type RuntimeConnectionExecutionReadModel = Readonly<{
  /** The stable public identity of the connection. */
  identity: RuntimeConnectionExecutionIdentity
  /** How work would travel to this connection. Never part of the identity. */
  transport: ExecutionTransport
  /** The five independent health observations about this connection. */
  health: ExecutionLocationHealth
  /** The public capability names this connection reports. */
  capabilities: readonly string[]
  /** The access facts this connection reports. */
  access: RuntimeConnectionExecutionAccess
  /** The explicit blocked states for this connection. Empty when none. */
  blockers: readonly ExecutionLocationBlocker[]
  /** When this observation was taken. */
  observedAt: string
}>

/**
 * The blocked states a connection's own observations imply.
 *
 * The node and host dimensions are deliberately not judged here: the
 * registered node's read model stays the authority for node and host
 * admission, and a connection must not report a second, different answer for
 * them. An unknown observation is reported as unknown and never as healthy.
 */
function connectionBlockers(
  source: RuntimeConnectionExecutionSource
): readonly ExecutionLocationBlocker[] {
  const blockers: ExecutionLocationBlocker[] = []
  const { access, health } = source
  if (health.runtime === 'unhealthy') blockers.push('connection_unavailable')
  if (health.provider === 'required') blockers.push('provider_auth_required')
  if (health.provider === 'expired') blockers.push('provider_auth_expired')
  if (health.transport === 'unavailable') blockers.push('transport_unavailable')
  if (access.grant === 'missing') blockers.push('grant_missing')
  if (access.grant === 'revoked') blockers.push('grant_revoked')
  if (access.entitlement === 'denied') blockers.push('entitlement_denied')
  return blockers
}

/**
 * Project one runtime connection's observations into the bounded public read
 * model.
 *
 * Only allow-listed fields are copied, so a native path, credential, process
 * handle or native session state held by the caller cannot travel into a
 * client payload through this projection.
 */
export function projectRuntimeConnectionExecutionReadModel(
  source: RuntimeConnectionExecutionSource
): RuntimeConnectionExecutionReadModel {
  return {
    access: { ...source.access },
    blockers: [...connectionBlockers(source)],
    capabilities: [...source.capabilities],
    health: { ...source.health },
    identity: { ...source.identity },
    observedAt: source.observedAt,
    transport: source.transport,
  }
}

/**
 * How severe a blocked state is, when more than one applies. The most severe
 * one is reported; the rest stay visible in the connection's own read model.
 */
const blockerSeverity: Readonly<Record<ExecutionLocationBlocker, number>> = {
  capability_mismatch: 68,
  cloud_feature_disabled: 20,
  connection_stale: 60,
  connection_unavailable: 90,
  entitlement_denied: 85,
  grant_missing: 72,
  grant_revoked: 80,
  location_incompatible: 74,
  location_missing: 30,
  location_offline: 55,
  location_revoked: 100,
  location_stale: 50,
  location_unknown: 40,
  provider_auth_expired: 78,
  provider_auth_required: 76,
  transport_unavailable: 70,
}

function mostSevereBlocker(
  blockers: readonly ExecutionLocationBlocker[]
): ExecutionLocationBlocker | null {
  let worst: ExecutionLocationBlocker | null = null
  for (const blocker of blockers) {
    if (!worst || blockerSeverity[blocker] > blockerSeverity[worst]) worst = blocker
  }
  return worst
}

function isQueueBlocker(
  blocker: ExecutionLocationBlocker
): blocker is 'location_offline' | 'location_stale' | 'connection_stale' {
  return (
    blocker === 'location_offline' || blocker === 'location_stale' || blocker === 'connection_stale'
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Agent profile read model (M11 #41)
// ────────────────────────────────────────────────────────────────────────────

/**
 * The exact profile version an Agent is pinned to.
 *
 * The pin is immutable for the lifetime of an execution: a retry keeps it, a
 * reroute keeps it, and a newer catalog version is never substituted for it.
 * Only an explicit, authorized profile change alters an Agent's pin.
 */
export type ExecutionProfilePin = Readonly<{
  id: string
  revision: number
  version: string
}>

/**
 * Read-time availability of an exact profile pin.
 *
 * This mirrors `AgentProfileState`: only the saved pin is ever checked, never
 * a newer version. `deprecated`, `revoked`, `incompatible`, `unapproved` and
 * `unavailable` are read-time states that the stored catalog state never
 * asserts on its own.
 */
export type ExecutionProfileState =
  | 'available'
  | 'deprecated'
  | 'missing'
  | 'revoked'
  | 'incompatible'
  | 'unapproved'
  | 'unavailable'

/**
 * The read model of one Agent's profile pin.
 *
 * It carries the Agent's stable identity, the exact pin, and the read-time
 * state of that pin. It never carries a profile body, a tool set, a model
 * configuration or any other runtime configuration: the profile itself stays
 * Control Plane-owned.
 */
export type AgentProfileExecutionReadModel = Readonly<{
  /** The Agent's stable identity; it survives a profile version change. */
  identity: AgentExecutionIdentity
  /** The exact pin this Agent is bound to. */
  pin: ExecutionProfilePin
  /** The read-time availability of that exact pin. */
  state: ExecutionProfileState
  /** When the availability check was attempted, including failed checks. */
  checkedAt?: string
}>

export const executionProfileBlockers = [
  'profile_missing',
  'profile_deprecated',
  'profile_revoked',
  'profile_incompatible',
  'profile_unapproved',
  'profile_unavailable',
  'profile_pin_invalid',
] as const

export type ExecutionProfileBlocker = (typeof executionProfileBlockers)[number]

export const executionProfileRemediationActions = [
  'select_available_profile_version',
  'approve_profile_version',
  'upgrade_profile_version',
  'retry_profile_check',
] as const

export type ExecutionProfileRemediationAction = (typeof executionProfileRemediationActions)[number]

export type ExecutionProfileRemediation = Readonly<{
  action: ExecutionProfileRemediationAction
}>

export type ExecutionProfileDecision =
  | Readonly<{
      action: 'execute'
      pin: ExecutionProfilePin
      reason: 'profile_available'
    }>
  | Readonly<{
      action: 'block'
      blocker: ExecutionProfileBlocker
      pin: ExecutionProfilePin
      remediation: ExecutionProfileRemediation
    }>

function profileRemediation(blocker: ExecutionProfileBlocker): ExecutionProfileRemediation {
  switch (blocker) {
    case 'profile_missing':
    case 'profile_revoked':
    case 'profile_pin_invalid':
      return { action: 'select_available_profile_version' }
    case 'profile_deprecated':
    case 'profile_incompatible':
      return { action: 'upgrade_profile_version' }
    case 'profile_unapproved':
      return { action: 'approve_profile_version' }
    case 'profile_unavailable':
      return { action: 'retry_profile_check' }
  }
}

/**
 * The read-time outcome of one Agent's profile pin.
 *
 * This is a read model, not an execution authorization: it says whether the
 * exact saved pin is currently available and what to do about it when it is
 * not. It never changes the stored pin, revision or audit history, and it
 * never checks a newer version in place of the saved one.
 */
export function decideExecutionProfileAdmission(
  model: AgentProfileExecutionReadModel
): ExecutionProfileDecision {
  if (!isValidPin(model.pin))
    return {
      action: 'block',
      blocker: 'profile_pin_invalid',
      pin: model.pin,
      remediation: profileRemediation('profile_pin_invalid'),
    }

  switch (model.state) {
    case 'available':
      return { action: 'execute', pin: model.pin, reason: 'profile_available' }
    case 'deprecated':
      return {
        action: 'block',
        blocker: 'profile_deprecated',
        pin: model.pin,
        remediation: profileRemediation('profile_deprecated'),
      }
    case 'missing':
      return {
        action: 'block',
        blocker: 'profile_missing',
        pin: model.pin,
        remediation: profileRemediation('profile_missing'),
      }
    case 'revoked':
      return {
        action: 'block',
        blocker: 'profile_revoked',
        pin: model.pin,
        remediation: profileRemediation('profile_revoked'),
      }
    case 'incompatible':
      return {
        action: 'block',
        blocker: 'profile_incompatible',
        pin: model.pin,
        remediation: profileRemediation('profile_incompatible'),
      }
    case 'unapproved':
      return {
        action: 'block',
        blocker: 'profile_unapproved',
        pin: model.pin,
        remediation: profileRemediation('profile_unapproved'),
      }
    case 'unavailable':
      return {
        action: 'block',
        blocker: 'profile_unavailable',
        pin: model.pin,
        remediation: profileRemediation('profile_unavailable'),
      }
  }
}
