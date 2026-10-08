import type {
  ApiModelChoice,
  ApiModelConnection,
  ApiModelConnectionsResponse,
  ApiModelDefaultsResponse,
  ApiModelDefaultsSetInput,
  ApiModelExecutionTarget,
  ApiModelFundingBinding,
  ApiModelFundingView,
  ApiModelSelection,
  ApiModelSelectionResolveInput,
  ApiWorkspaceModelDefaults,
  ApiModelAuthKind,
  ApiModelFundingSource,
  ApiModelConnectionCreateInput,
  ApiModelConnectionRevokeInput,
  ApiModelConnectionResponse,
} from '@adea-ai/api-client/model-connections'
import {
  ControlPlaneProxyError,
  commandEnvelope,
  isRecord,
  readEnvelope,
  scopedAdminCredential,
  type AdminCorrelation,
  type ControlPlaneHopDependencies,
} from './control-plane-client'
import {
  installedModelMetadataPort,
  type ModelMetadataMethod,
  type ModelMetadataPort,
} from './model-connections-sdk'
import { modelReadiness } from './model-selection-readiness'

export type ModelMetadataDependencies = ControlPlaneHopDependencies &
  Readonly<{
    /** Trusted host composition; browser requests cannot qualify a target. */
    target?: () => ApiModelExecutionTarget | null
    port?: ModelMetadataPort
  }>

const OPERATIONS = {
  createModelConnection: 'model-connections.create',
  revokeModelConnection: 'model-connections.revoke',
  listModelConnections: 'model-connections.list',
  getModelDefaults: 'model-defaults.get',
  setModelDefaults: 'model-defaults.set',
  resolveModelSelection: 'model-selection.resolve',
  getModelSelectionFunding: 'model-selection.funding.get',
} as const

/** All returned objects are allow-listed product projections, never SDK/provider objects. */
export function createWorkspaceModelMetadataAdapter(
  workspaceId: string,
  canManage: boolean,
  correlation: AdminCorrelation,
  dependencies: ModelMetadataDependencies
) {
  const port = dependencies.port ?? installedModelMetadataPort
  const target = dependencies.target?.() ?? null
  const available = port.supported && target !== null

  async function call(method: ModelMetadataMethod, payload: Record<string, unknown>, key?: string) {
    if (!available) throw unavailable()
    const credential = await scopedAdminCredential(
      [key ? 'credential:write' : 'credential:read'],
      dependencies
    )
    const now = dependencies.now?.() ?? Date.now()
    const operation = OPERATIONS[method]
    const body = key
      ? commandEnvelope(credential, correlation, { operation, payload, idempotencyKey: key, now })
      : readEnvelope(credential, correlation, operation, payload, now)
    const response = await port.invoke(method, credential, body, dependencies)
    if (
      !isRecord(response) ||
      response.requestId !== correlation.requestId ||
      !isRecord(response.correlation) ||
      response.correlation.traceId !== correlation.traceId ||
      !isRecord(response.data)
    )
      throw unavailable()
    return {
      data: response.data,
      controlPlaneWorkspaceId: credential.workspaceId,
      now: dependencies.now?.() ?? Date.now(),
    }
  }

  return {
    async create(input: ApiModelConnectionCreateInput): Promise<ApiModelConnectionResponse> {
      const { idempotencyKey, ...payload } = input
      const result = await call('createModelConnection', payload, idempotencyKey)
      const connection = connectionProjection(
        { connection: result.data.connection, models: [] },
        result.controlPlaneWorkspaceId
      )
      if (connection.status !== 'active') throw unavailable()
      return { connection }
    },
    async revoke(input: ApiModelConnectionRevokeInput): Promise<ApiModelConnectionResponse> {
      const { idempotencyKey, ...payload } = input
      const result = await call('revokeModelConnection', payload, idempotencyKey)
      const connection = connectionProjection(
        { connection: result.data.connection, models: [] },
        result.controlPlaneWorkspaceId
      )
      if (connection.connectionRef !== input.connectionRef || connection.status !== 'revoked')
        throw unavailable()
      return { connection }
    },
    async list(): Promise<ApiModelConnectionsResponse> {
      if (!available)
        return { availability: 'unavailable', target: null, connections: [], canManage }
      const result = await call('listModelConnections', { target })
      if (!Array.isArray(result.data.connections) || result.data.connections.length > 128)
        throw unavailable()
      return {
        availability: 'available',
        target,
        canManage,
        connections: result.data.connections.map((entry) =>
          connectionProjection(entry, result.controlPlaneWorkspaceId)
        ),
      }
    },
    async getDefaults(): Promise<ApiModelDefaultsResponse> {
      if (!available) return { availability: 'unavailable', defaults: null, canManage }
      const result = await call('getModelDefaults', {})
      return {
        availability: 'available',
        canManage,
        defaults: defaultsProjection(result.data.defaults, result.controlPlaneWorkspaceId),
      }
    },
    async setDefaults(input: ApiModelDefaultsSetInput): Promise<ApiModelDefaultsResponse> {
      const { idempotencyKey, ...payload } = input
      const result = await call('setModelDefaults', payload, idempotencyKey)
      if (result.data.defaults === null) throw unavailable()
      return {
        availability: 'available',
        canManage,
        defaults: defaultsProjection(result.data.defaults, result.controlPlaneWorkspaceId),
      }
    },
    async resolve(input: ApiModelSelectionResolveInput): Promise<ApiModelSelection> {
      const result = await call('resolveModelSelection', { ...input, target })
      const selection = selectionProjection(
        result.data.selection,
        result.controlPlaneWorkspaceId,
        target!
      )
      if (
        input.override &&
        (selection.connectionRef !== input.override.connectionRef ||
          selection.providerModel !== input.override.providerModel)
      )
        throw unavailable()
      return selection
    },
    async funding(binding: ApiModelFundingBinding): Promise<ApiModelFundingView> {
      const result = await call('getModelSelectionFunding', { ...binding })
      return projectModelSelectionFunding(
        result.data.funding,
        workspaceId,
        result.controlPlaneWorkspaceId,
        binding,
        result.now
      )
    },
  }
}

function connectionProjection(value: unknown, workspaceId: string): ApiModelConnection {
  const entry = record(value)
  const connection = record(entry.connection)
  if (
    connection.workspaceId !== workspaceId ||
    !Array.isArray(entry.models) ||
    entry.models.length > 256
  )
    throw unavailable()
  const status = enumValue(connection.status, ['active', 'revoked'] as const)
  return {
    connectionRef: reference(connection.connectionRef, /^mconn_[a-f0-9]{32}$/u),
    revision: revision(connection.revision),
    provider: reference(connection.provider, /^[a-z][a-z0-9.-]{0,127}$/u),
    accountRef: reference(connection.accountRef),
    authKind: authKind(connection.authKind),
    fundingSource: fundingSource(connection.fundingSource),
    status,
    models: entry.models.map((modelValue) => {
      const model = record(modelValue)
      const readiness = modelReadiness(model.readiness)
      // A connection revocation always dominates an inconsistent provider assessment.
      return {
        providerModel: reference(model.providerModel),
        readiness:
          status === 'revoked'
            ? modelReadiness({ ready: false, reasonCode: 'CONNECTION_REVOKED' })
            : readiness,
      }
    }),
  }
}

function defaultsProjection(value: unknown, workspaceId: string): ApiWorkspaceModelDefaults | null {
  if (value === null) return null
  const defaults = record(value)
  if (defaults.workspaceId !== workspaceId) throw unavailable()
  return {
    revision: revision(defaults.revision),
    ...(defaults.lead === undefined ? {} : { lead: choice(defaults.lead) }),
    ...(defaults.child === undefined ? {} : { child: choice(defaults.child) }),
    ...(defaults.direct === undefined ? {} : { direct: choice(defaults.direct) }),
  }
}

function selectionProjection(
  value: unknown,
  workspaceId: string,
  target: ApiModelExecutionTarget
): ApiModelSelection {
  const selection = record(value)
  if (
    selection.schemaVersion !== 'model-selection/v1' ||
    selection.workspaceId !== workspaceId ||
    Object.entries(target).some(([key, expected]) => selection[key] !== expected)
  )
    throw unavailable()
  return {
    selectionRef: reference(selection.selectionRef, /^msel_[a-f0-9]{32}$/u),
    selectionRevision: revision(selection.selectionRevision),
    connectionRef: reference(selection.connectionRef, /^mconn_[a-f0-9]{32}$/u),
    provider: reference(selection.provider, /^[a-z][a-z0-9.-]{0,127}$/u),
    providerModel: reference(selection.providerModel),
    authKind: authKind(selection.authKind),
    fundingSource: fundingSource(selection.fundingSource),
    target: { ...target },
  }
}

/** Exact execution-bound disclosure; payer comes only from explicit authenticated owner evidence. */
export function projectModelSelectionFunding(
  value: unknown,
  adeaWorkspaceId: string,
  controlPlaneWorkspaceId: string,
  binding: ApiModelFundingBinding,
  now: number
): ApiModelFundingView {
  const funding = record(value)
  if (
    !isModelFundingBinding(binding) ||
    funding.schemaVersion !== 'model-funding-display/v1' ||
    funding.workspaceId !== controlPlaneWorkspaceId ||
    Object.entries(binding).some(([key, expected]) => funding[key] !== expected)
  )
    throw unavailable()
  const base = {
    schemaVersion: 'model-funding-display/v1' as const,
    workspaceId: adeaWorkspaceId,
    ...binding,
  }
  if (funding.state === 'blocked') {
    const readiness = modelReadiness({ ready: false, reasonCode: funding.reasonCode })
    return { ...base, state: 'blocked', reasonCode: readiness.reasonCode }
  }
  if (funding.state !== 'ready') throw unavailable()
  const owner = record(funding.fundingOwner)
  const expiresAt = text(funding.expiresAt, 64)
  const validUntil = Date.parse(expiresAt)
  if (!Number.isFinite(validUntil) || validUntil <= now)
    return { ...base, state: 'blocked', reasonCode: 'READINESS_UNAVAILABLE' }
  // Authorization/evidence refs must exist, but never leave the private projection.
  reference(funding.authorizationRef)
  reference(owner.evidenceRef)
  return {
    ...base,
    state: 'ready',
    provider: reference(funding.provider, /^[a-z][a-z0-9.-]{0,127}$/u),
    providerModel: text(funding.providerModel, 256),
    accountRef: reference(funding.accountRef),
    authKind: authKind(funding.authKind),
    fundingSource: fundingSource(funding.fundingSource),
    fundingOwner: {
      ownerRef: reference(owner.ownerRef),
      kind: enumValue(owner.kind, [
        'provider_account',
        'workspace_account',
        'adea_account',
      ] as const),
      displayName: text(owner.displayName, 128),
      revision: revision(owner.revision),
    },
    authorityRevision: revision(funding.authorityRevision),
    expiresAt,
  }
}

export function isModelFundingBinding(value: unknown): value is ApiModelFundingBinding {
  if (
    !isRecord(value) ||
    Object.keys(value).toSorted().join(',') !==
      'attemptId,executionId,selectionRef,selectionRevision'
  )
    return false
  return (
    typeof value.executionId === 'string' &&
    /^exe_[0-9A-HJKMNP-TV-Z]{26}$/u.test(value.executionId) &&
    typeof value.attemptId === 'string' &&
    /^att_[0-9A-HJKMNP-TV-Z]{26}$/u.test(value.attemptId) &&
    typeof value.selectionRef === 'string' &&
    /^msel_[a-f0-9]{32}$/u.test(value.selectionRef) &&
    Number.isSafeInteger(value.selectionRevision) &&
    Number(value.selectionRevision) > 0
  )
}

export function isModelChoice(value: unknown): value is ApiModelChoice {
  return (
    isRecord(value) &&
    Object.keys(value).toSorted().join(',') === 'connectionRef,providerModel' &&
    typeof value.connectionRef === 'string' &&
    /^mconn_[a-f0-9]{32}$/u.test(value.connectionRef) &&
    typeof value.providerModel === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(value.providerModel)
  )
}

function choice(value: unknown): ApiModelChoice {
  if (!isModelChoice(value)) throw unavailable()
  return { connectionRef: value.connectionRef, providerModel: value.providerModel }
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw unavailable()
  return value
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) throw unavailable()
  return value
}
function reference(value: unknown, pattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u): string {
  const result = text(value, 256)
  if (!pattern.test(result)) throw unavailable()
  return result
}
function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw unavailable()
  return value
}
function enumValue<const T extends readonly string[]>(value: unknown, values: T): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) throw unavailable()
  return value as T[number]
}
function authKind(value: unknown): ApiModelAuthKind {
  return enumValue(value, ['api_key', 'provider_subscription', 'local_runtime'] as const)
}
function fundingSource(value: unknown): ApiModelFundingSource {
  return enumValue(value, ['byo_api', 'external_subscription', 'hq_managed'] as const)
}
function unavailable() {
  return new ControlPlaneProxyError('READINESS_UNAVAILABLE', 'Model metadata is unavailable')
}
