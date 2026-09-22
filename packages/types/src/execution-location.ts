/**
 * Pure execution-location policy for M11 #186.
 *
 * This module deliberately consumes read models and returns a decision. It
 * does not discover, authorize, move, or execute work on a runtime node. The
 * Control Plane/runtime integrations own those effects.
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

export type ExecutionLocationBlocker =
  | 'location_missing'
  | 'location_offline'
  | 'location_revoked'
  | 'location_stale'
  | 'location_incompatible'
  | 'capability_mismatch'
  | 'cloud_feature_disabled'
  | 'location_unknown'

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

type DecisionBase = Readonly<{
  dataAvailability: ExecutionDataAvailability
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
        blocker: 'location_offline' | 'location_stale'
        remediation: ExecutionLocationRemediation
      }>)
  | (DecisionBase &
      Readonly<{
        action: 'block'
        blocker: Exclude<ExecutionLocationBlocker, 'location_offline' | 'location_stale'>
        remediation: ExecutionLocationRemediation
        missingCapabilities?: readonly string[]
      }>)

/** The durable location binding for one task execution attempt. */
export type ExecutionLocationAttempt = Readonly<{
  attempt: number
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
  }
}

function blocked(
  input: ExecutionLocationPolicyInput,
  selectedLocation: ExecutionLocationSelection,
  blocker: Exclude<ExecutionLocationBlocker, 'location_offline' | 'location_stale'>,
  missing: readonly string[] = []
): ExecutionLocationDecision {
  return {
    action: 'block',
    blocker,
    dataAvailability: input.dataAvailability,
    ...(missing.length ? { missingCapabilities: missing } : {}),
    remediation: remediationForBlocker(blocker, missing),
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
  if (freshness === 'stale')
    return {
      action: 'queue',
      blocker: 'location_stale',
      dataAvailability: input.dataAvailability,
      remediation: remediationForBlocker('location_stale'),
      selectedLocation,
    }

  switch (availability) {
    case 'offline':
      return {
        action: 'queue',
        blocker: 'location_offline',
        dataAvailability: input.dataAvailability,
        remediation: remediationForBlocker('location_offline'),
        selectedLocation,
      }
    case 'stale':
      return {
        action: 'queue',
        blocker: 'location_stale',
        dataAvailability: input.dataAvailability,
        remediation: remediationForBlocker('location_stale'),
        selectedLocation,
      }
    case 'revoked':
      return blocked(input, selectedLocation, 'location_revoked')
    case 'incompatible':
      return blocked(input, selectedLocation, 'location_incompatible')
    case 'available': {
      const missing = missingCapabilities(input.requiredCapabilities, node.capabilities)
      if (missing.length) return blocked(input, selectedLocation, 'capability_mismatch', missing)
      return {
        action: 'execute',
        dataAvailability: input.dataAvailability,
        reason: 'location_available',
        selectedLocation,
      }
    }
  }
}

/**
 * Retries retain the attempt's location. A different location is accepted
 * only when the caller supplies an explicit authorized reroute decision.
 */
export function resolveExecutionRetry(
  input: Readonly<{
    attempt: ExecutionLocationAttempt
    policy: ExecutionLocationPolicyInput
    requestedLocation?: ExecutionLocationSelection
    rerouteAuthorization?: ExecutionLocationRerouteAuthorization
  }>
): ExecutionRetryResolution {
  if (!isValidAttempt(input.attempt))
    return {
      change: 'attempt_invalid',
      ok: false,
      previousLocation: input.attempt.selectedLocation,
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

  return {
    attempt: {
      attempt: input.attempt.attempt + 1,
      scope: input.attempt.scope,
      selectedLocation: requestedLocation,
    },
    change: rerouted ? 'authorized_reroute' : 'sticky_retry',
    admission,
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
  return Number.isInteger(attempt.attempt) && attempt.attempt > 0 && isValidScope(attempt.scope)
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
