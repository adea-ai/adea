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
] as const

export type ExecutionRuntimeNodeAvailability = (typeof executionRuntimeNodeAvailability)[number]

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
}>

export type ExecutionLocationBlocker =
  | 'location_missing'
  | 'location_offline'
  | 'location_revoked'
  | 'location_stale'
  | 'location_incompatible'
  | 'capability_mismatch'
  | 'cloud_feature_disabled'

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
  selectedLocation: ExecutionLocationSelection
}>

export type ExecutionRetryResolution =
  | Readonly<{
      attempt: ExecutionLocationAttempt
      change: 'sticky_retry' | 'authorized_reroute'
      ok: true
    }>
  | Readonly<{
      change: 'reroute_requires_authorization'
      ok: false
      previousLocation: ExecutionLocationSelection
      requestedLocation: ExecutionLocationSelection
    }>

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

  switch (node.availability) {
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
    authorizedReroute?: boolean
    requestedLocation?: ExecutionLocationSelection
  }>
): ExecutionRetryResolution {
  const requestedLocation = input.requestedLocation ?? input.attempt.selectedLocation
  if (
    !locationsEqual(requestedLocation, input.attempt.selectedLocation) &&
    input.authorizedReroute !== true
  )
    return {
      change: 'reroute_requires_authorization',
      ok: false,
      previousLocation: input.attempt.selectedLocation,
      requestedLocation,
    }

  const rerouted = !locationsEqual(requestedLocation, input.attempt.selectedLocation)
  return {
    attempt: {
      attempt: input.attempt.attempt + 1,
      selectedLocation: requestedLocation,
    },
    change: rerouted ? 'authorized_reroute' : 'sticky_retry',
    ok: true,
  }
}
