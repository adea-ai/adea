/**
 * The Adea-side consumer types for control-plane#558 decision-resolution.v1.
 *
 * This module deliberately contains no resolver or selection policy. The
 * Control Plane selects the launch plan; the composer only submits the pinned
 * request and presents the response. Host code supplies the transport and the
 * adapter from the logical harness selection to a local installation.
 */

export const DECISION_RESOLUTION_CONTRACT_VERSION = Object.freeze({ major: 1, minor: 0 })

export type ResolutionSource =
  | 'explicit-pin'
  | 'project-default'
  | 'profile-default'
  | 'policy-default'

export type SandboxResolution = Readonly<{
  mode: 'none' | 'managed'
  effectiveCapabilities: readonly string[]
}>

export type DelegationResolution = Readonly<{
  fanOut: 'none' | 'bounded'
  maxChildren?: number
  promotion: 'review-required' | 'auto-eligible'
}>

export type DecisionPins = Readonly<{
  harness?: Readonly<{ harnessId: string }>
  model?: Readonly<{ modelId: string }>
  skills?: Readonly<{ skillVersionIds: readonly string[] }>
  capabilities?: Readonly<{ capabilityNames: readonly string[] }>
  runtime?: Readonly<{ runtimeDefinitionId: string }>
  sandbox?: SandboxResolution
  contextPackage?: Readonly<{
    mode: 'none' | 'existing' | 'author'
    contextPackageId?: string
  }>
  delegation?: DelegationResolution
}>

export type AvailableRuntime = Readonly<{
  runtimeDefinitionId: string
  kind: 'local' | 'self-hosted' | 'cloud'
  transport: 'direct-local' | 'remote-gateway'
  harnessIds: readonly string[]
  capabilities: readonly string[]
}>

export type ModelAccessEntitlement = 'byok' | 'provisioned' | 'free-tier' | 'none'

export type DecisionResolutionRequest = Readonly<{
  contractVersion: Readonly<{ major: 1; minor: number }>
  caller: Readonly<{ servicePrincipalId: string }>
  requestId: string
  workspaceId: string
  projectId?: string
  correlation: Readonly<{
    traceId: string
    causationCommandId?: string
    parentEventId?: string
  }>
  requestedAt: string
  objective: string
  agentProfile: Readonly<{
    profileId: string
    profileVersionId?: string
  }>
  availableRuntimes: readonly AvailableRuntime[]
  entitlements: Readonly<{
    modelAccess: ModelAccessEntitlement
    grantedCapabilityNames: readonly string[]
  }>
  requiredCapabilities: readonly string[]
  costLatencyPreference: 'cost' | 'balanced' | 'latency'
  projectDefaults: DecisionPins
  profileDefaults: DecisionPins
  explicitPins: DecisionPins
}>

export type DecisionResolutionDiagnostic =
  | 'UNSUPPORTED_RUNTIME_PIN'
  | 'MODEL_ACCESS_NOT_ENTITLED'
  | 'NO_DEFAULT_MODEL'
  | 'CAPABILITY_BEYOND_GRANT'
  | 'HARNESS_UNAVAILABLE_ON_PINNED_RUNTIME'
  | 'CONTEXT_PACKAGE_PIN_MISMATCH'

export type ResolvedOutput = Readonly<{
  source: ResolutionSource
  value: unknown
}>

export type DecisionLayerResolution = Readonly<{
  schemaVersion: number
  requestId: string
  workspaceId: string
  contractVersion: Readonly<{ major: 1; minor: number }>
  resolvedAt: string
  resolution: Readonly<{
    harness: Readonly<{ harnessId: string }>
    model: Readonly<{ modelId: string } | { withheld: DecisionResolutionDiagnostic }>
    skills: Readonly<{ skillVersionIds: readonly string[] }>
    capabilities: Readonly<{ capabilityNames: readonly string[] }>
    runtime: AvailableRuntime
    sandbox: SandboxResolution
    contextPackage: Readonly<{
      mode: 'none' | 'existing' | 'author'
      contextPackageId?: string
    }>
    delegation: DelegationResolution
  }>
  trace: Readonly<Record<string, ResolvedOutput>>
  diagnostics: readonly DecisionResolutionDiagnostic[]
  resolutionDigest: string
}>

export type DecisionLayerClient = Readonly<{
  resolve(request: DecisionResolutionRequest): Promise<unknown>
}>

export type DecisionLayerStatus = 'auth_required' | 'unavailable'

export type DecisionLayerFailure = Readonly<{
  kind: 'failure'
  status: DecisionLayerStatus
  action: 'sign_in' | 'retry'
  message: string
  diagnostics?: readonly DecisionResolutionDiagnostic[]
}>

export type DecisionLayerOutcome =
  | Readonly<{ kind: 'resolved'; resolution: DecisionLayerResolution }>
  | DecisionLayerFailure

export class DecisionLayerProtocolError extends Error {
  readonly status: DecisionLayerStatus = 'unavailable'

  constructor(message: string) {
    super(message)
    this.name = 'DecisionLayerProtocolError'
  }
}

export class DecisionLayerUnavailableError extends Error {
  readonly status: DecisionLayerStatus

  constructor(status: DecisionLayerStatus, message: string) {
    super(message)
    this.name = 'DecisionLayerUnavailableError'
    this.status = status
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new DecisionLayerProtocolError('Decision layer returned a non-object response.')
  return value as Record<string, unknown>
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new DecisionLayerProtocolError(`Decision layer response has an invalid ${path}.`)
  return value
}

function stringArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    throw new DecisionLayerProtocolError(`Decision layer response has an invalid ${path}.`)
  return value
}

function runtime(value: unknown, path: string): AvailableRuntime {
  const item = record(value)
  stringValue(item.runtimeDefinitionId, `${path}.runtimeDefinitionId`)
  stringValue(item.kind, `${path}.kind`)
  stringValue(item.transport, `${path}.transport`)
  stringArray(item.harnessIds, `${path}.harnessIds`)
  stringArray(item.capabilities, `${path}.capabilities`)
  return item as AvailableRuntime
}

function diagnostics(value: unknown): readonly DecisionResolutionDiagnostic[] {
  if (!Array.isArray(value))
    throw new DecisionLayerProtocolError('Decision layer response has invalid diagnostics.')
  const allowed = new Set<DecisionResolutionDiagnostic>([
    'UNSUPPORTED_RUNTIME_PIN',
    'MODEL_ACCESS_NOT_ENTITLED',
    'NO_DEFAULT_MODEL',
    'CAPABILITY_BEYOND_GRANT',
    'HARNESS_UNAVAILABLE_ON_PINNED_RUNTIME',
    'CONTEXT_PACKAGE_PIN_MISMATCH',
  ])
  if (value.some((item) => typeof item !== 'string' || !allowed.has(item as never)))
    throw new DecisionLayerProtocolError('Decision layer response has invalid diagnostics.')
  return value as DecisionResolutionDiagnostic[]
}

/** Validate the pinned CP response before exposing it to launch code. */
export function decodeDecisionLayerResolution(value: unknown): DecisionLayerResolution {
  const item = record(value)
  if (item.schemaVersion !== 1)
    throw new DecisionLayerProtocolError('Unsupported resolution schema.')
  const contract = record(item.contractVersion)
  if (contract.major !== 1 || typeof contract.minor !== 'number')
    throw new DecisionLayerProtocolError('Unsupported decision-resolution contract version.')
  stringValue(item.requestId, 'requestId')
  stringValue(item.workspaceId, 'workspaceId')
  stringValue(item.resolvedAt, 'resolvedAt')
  stringValue(item.resolutionDigest, 'resolutionDigest')
  const output = record(item.resolution)
  const harness = record(output.harness)
  stringValue(harness.harnessId, 'resolution.harness.harnessId')
  const model = record(output.model)
  if (model.modelId !== undefined) stringValue(model.modelId, 'resolution.model.modelId')
  else stringValue(model.withheld, 'resolution.model.withheld')
  const skills = record(output.skills)
  stringArray(skills.skillVersionIds, 'resolution.skills.skillVersionIds')
  const capabilities = record(output.capabilities)
  stringArray(capabilities.capabilityNames, 'resolution.capabilities.capabilityNames')
  runtime(output.runtime, 'resolution.runtime')
  record(output.sandbox)
  record(output.contextPackage)
  record(output.delegation)
  diagnostics(item.diagnostics)
  const trace = record(item.trace)
  return {
    ...item,
    contractVersion: { major: 1, minor: contract.minor as number },
    resolution: output as DecisionLayerResolution['resolution'],
    trace: trace as DecisionLayerResolution['trace'],
    diagnostics: diagnostics(item.diagnostics),
  } as DecisionLayerResolution
}

function failureFrom(error: unknown): DecisionLayerFailure {
  if (error instanceof DecisionLayerUnavailableError) {
    return {
      kind: 'failure',
      status: error.status,
      action: error.status === 'auth_required' ? 'sign_in' : 'retry',
      message: error.message,
    }
  }
  return {
    kind: 'failure',
    status: 'unavailable',
    action: 'retry',
    message: error instanceof Error ? error.message : 'Decision layer is unavailable.',
  }
}

/** Submit to CP and expose only a validated response or one typed recovery. */
export async function resolveDecisionLayer(
  client: DecisionLayerClient | undefined,
  request: DecisionResolutionRequest
): Promise<DecisionLayerOutcome> {
  if (!client)
    return {
      kind: 'failure',
      status: 'unavailable',
      action: 'retry',
      message: 'Decision layer is unavailable. Retry after the Control Plane is connected.',
    }
  try {
    const resolution = decodeDecisionLayerResolution(await client.resolve(request))
    if (resolution.diagnostics.length > 0)
      return {
        kind: 'failure',
        status: 'unavailable',
        action: 'retry',
        message:
          'The Control Plane withheld a launch decision. Review the required access and retry.',
        diagnostics: resolution.diagnostics,
      }
    return { kind: 'resolved', resolution }
  } catch (error) {
    return failureFrom(error)
  }
}
