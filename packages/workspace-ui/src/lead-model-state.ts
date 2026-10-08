import type {
  ApiModelAuthKind,
  ApiModelChoice,
  ApiModelFundingBinding,
  ApiModelFundingSource,
  ApiModelFundingView,
  ApiModelRole,
  ApiWorkspaceModelDefaults,
} from '@adea-ai/api-client/model-connections'

/** Product projections only: these values authorize no inference or spending. */
export const MODEL_READINESS_REASON_CODES = [
  'READY',
  'CONNECTION_MISSING',
  'CONNECTION_REVOKED',
  'CREDENTIAL_MISSING',
  'CREDENTIAL_EXPIRED',
  'CREDENTIAL_REVOKED',
  'CREDENTIAL_REVISION_CHANGED',
  'WORKSPACE_GRANT_EXPIRED',
  'WORKSPACE_GRANT_REVOKED',
  'QUOTA_EXHAUSTED',
  'INCOMPATIBLE_HARNESS',
  'INCOMPATIBLE_LOCATION',
  'AUTH_MODE_UNSUPPORTED',
  'PROVIDER_POLICY_DENIED',
  'MODEL_UNAVAILABLE',
  'SELECTION_CHANGED',
  'READINESS_UNAVAILABLE',
] as const

export type ModelReadinessReasonCode = (typeof MODEL_READINESS_REASON_CODES)[number]
export type ModelReadinessRemedy = Readonly<{
  action:
    | 'choose_model_connection'
    | 'manage_credentials'
    | 'review_workspace_access'
    | 'review_provider_quota'
    | 'choose_compatible_target'
    | 'choose_supported_auth'
    | 'review_provider_policy'
    | 'choose_available_model'
    | 'refresh_selection'
    | 'retry_readiness'
  message: string
}>
export type ProjectedModelReadiness = Readonly<{
  ready: boolean
  reasonCode: ModelReadinessReasonCode
  remedy: ModelReadinessRemedy | null
}>
export type SelectableModel = Readonly<{
  choice: ApiModelChoice
  provider: string
  accountRef: string
  authKind: ApiModelAuthKind
  fundingSource: ApiModelFundingSource
}>
export type ModelFundingScope = Readonly<{ workspaceId: string }> & ApiModelFundingBinding
export type ModelFundingFreshness = Readonly<{ current: boolean; now: number }>
export type ProjectedModelFunding =
  | Extract<ApiModelFundingView, { state: 'ready' }>
  | Readonly<{
      state: 'blocked'
      reasonCode: Exclude<ModelReadinessReasonCode, 'READY'>
      remedy: ModelReadinessRemedy
    }>

const credentialRemedy = {
  action: 'manage_credentials',
  message: 'Choose a connection with a valid credential in workspace settings.',
} as const
const grantRemedy = {
  action: 'review_workspace_access',
  message: 'Review model connection access for this workspace.',
} as const
const targetRemedy = {
  action: 'choose_compatible_target',
  message: 'Choose a model compatible with this runtime and location.',
} as const
const remedies = {
  CONNECTION_MISSING: {
    action: 'choose_model_connection',
    message: 'Choose a model connection in workspace settings.',
  },
  CONNECTION_REVOKED: {
    action: 'choose_model_connection',
    message: 'Choose another model connection in workspace settings.',
  },
  CREDENTIAL_MISSING: credentialRemedy,
  CREDENTIAL_EXPIRED: credentialRemedy,
  CREDENTIAL_REVOKED: credentialRemedy,
  CREDENTIAL_REVISION_CHANGED: {
    action: 'refresh_selection',
    message: 'Refresh the selection to use the current credential.',
  },
  WORKSPACE_GRANT_EXPIRED: grantRemedy,
  WORKSPACE_GRANT_REVOKED: grantRemedy,
  QUOTA_EXHAUSTED: {
    action: 'review_provider_quota',
    message: 'Review provider quota or choose another connection.',
  },
  INCOMPATIBLE_HARNESS: targetRemedy,
  INCOMPATIBLE_LOCATION: targetRemedy,
  AUTH_MODE_UNSUPPORTED: {
    action: 'choose_supported_auth',
    message: 'Choose authentication supported by this runtime.',
  },
  PROVIDER_POLICY_DENIED: {
    action: 'review_provider_policy',
    message: 'Review workspace provider policy or choose an allowed connection.',
  },
  MODEL_UNAVAILABLE: {
    action: 'choose_available_model',
    message: 'Choose an available model for this connection.',
  },
  SELECTION_CHANGED: {
    action: 'refresh_selection',
    message: 'Refresh the model selection before trying again.',
  },
  READINESS_UNAVAILABLE: {
    action: 'retry_readiness',
    message: 'Model readiness could not be verified. Refresh and try again.',
  },
} as const satisfies Record<Exclude<ModelReadinessReasonCode, 'READY'>, ModelReadinessRemedy>

function reasonCode(value: unknown): ModelReadinessReasonCode {
  return enumValue(value, MODEL_READINESS_REASON_CODES) ? value : 'READINESS_UNAVAILABLE'
}

/** Never render arbitrary upstream remedy copy or provider error text. */
export function modelReadinessRemedy(reason: unknown): ModelReadinessRemedy | null {
  const code = reasonCode(reason)
  return code === 'READY' ? null : { ...remedies[code] }
}

export function projectModelReadiness(value: unknown): ProjectedModelReadiness {
  const assessment = record(value)
  const code = reasonCode(assessment?.reasonCode)
  if (
    !assessment ||
    typeof assessment.ready !== 'boolean' ||
    assessment.ready !== (code === 'READY')
  )
    return {
      ready: false,
      reasonCode: 'READINESS_UNAVAILABLE',
      remedy: modelReadinessRemedy('READINESS_UNAVAILABLE'),
    }
  return { ready: assessment.ready, reasonCode: code, remedy: modelReadinessRemedy(code) }
}

/** An explicit override replaces only this role; an invalid override cannot fall back. */
export function roleModelChoice(
  defaults: ApiWorkspaceModelDefaults | null | undefined,
  role: ApiModelRole,
  explicitOverride?: ApiModelChoice | null
): ApiModelChoice | null {
  if (!enumValue(role, ['lead', 'child', 'direct'])) return null
  if (explicitOverride !== undefined) return modelChoice(explicitOverride)
  if (!defaults || !revision(defaults.revision, true)) return null
  return modelChoice(defaults[role])
}

/** Eligible models come only from this exact current target's metadata listing. */
export function projectSelectableModels(value: unknown): readonly SelectableModel[] {
  const response = record(value)
  if (
    !response ||
    response.availability !== 'available' ||
    typeof response.canManage !== 'boolean' ||
    !executionTarget(response.target) ||
    !Array.isArray(response.connections)
  )
    return []
  const refCounts = counts(response.connections.map((entry) => record(entry)?.connectionRef))
  const selectable: SelectableModel[] = []
  for (const entry of response.connections) {
    const connection = record(entry)
    if (
      !connection ||
      !connectionRef(connection.connectionRef) ||
      refCounts.get(connection.connectionRef) !== 1 ||
      !revision(connection.revision) ||
      connection.status !== 'active' ||
      !text(connection.provider) ||
      !text(connection.accountRef) ||
      !enumValue(connection.authKind, authKinds) ||
      !enumValue(connection.fundingSource, fundingSources) ||
      !Array.isArray(connection.models)
    )
      continue
    const modelCounts = counts(connection.models.map((model) => record(model)?.providerModel))
    for (const item of connection.models) {
      const model = record(item)
      if (
        !model ||
        !text(model.providerModel) ||
        modelCounts.get(model.providerModel) !== 1 ||
        !projectModelReadiness(model.readiness).ready
      )
        continue
      selectable.push({
        choice: { connectionRef: connection.connectionRef, providerModel: model.providerModel },
        provider: connection.provider,
        accountRef: connection.accountRef,
        authKind: connection.authKind,
        fundingSource: connection.fundingSource,
      })
    }
  }
  return selectable
}

export function projectRoleModel(
  connections: unknown,
  defaults: ApiWorkspaceModelDefaults | null | undefined,
  role: ApiModelRole,
  explicitOverride?: ApiModelChoice | null
): SelectableModel | null {
  const choice = roleModelChoice(defaults, role, explicitOverride)
  if (!choice) return null
  return (
    projectSelectableModels(connections).find(
      (model) =>
        model.choice.connectionRef === choice.connectionRef &&
        model.choice.providerModel === choice.providerModel
    ) ?? null
  )
}

/** Ready funding is an exact, fresh execution view, never an account-to-payer inference. */
export function projectModelFunding(
  value: unknown,
  scope: ModelFundingScope,
  freshness: ModelFundingFreshness
): ProjectedModelFunding {
  const view = record(value)
  if (freshness.current !== true || !Number.isFinite(freshness.now) || freshness.now < 0 || !view)
    return blockedFunding()
  if (
    view.schemaVersion !== 'model-funding-display/v1' ||
    !exactKeys(scope, [
      'workspaceId',
      'executionId',
      'attemptId',
      'selectionRef',
      'selectionRevision',
    ]) ||
    !text(scope.workspaceId) ||
    !text(scope.executionId) ||
    !text(scope.attemptId) ||
    !selectionRef(scope.selectionRef) ||
    !revision(scope.selectionRevision)
  )
    return blockedFunding()
  for (const key of [
    'workspaceId',
    'executionId',
    'attemptId',
    'selectionRef',
    'selectionRevision',
  ] as const)
    if (view[key] !== scope[key]) return blockedFunding('SELECTION_CHANGED')
  if (view.state === 'blocked') {
    if (!exactKeys(view, [...fundingBindingKeys, 'state', 'reasonCode'])) return blockedFunding()
    return blockedFunding(view.reasonCode)
  }
  const owner = record(view.fundingOwner)
  if (
    view.state !== 'ready' ||
    !exactKeys(view, [
      ...fundingBindingKeys,
      'state',
      'provider',
      'providerModel',
      'accountRef',
      'authKind',
      'fundingSource',
      'fundingOwner',
      'authorityRevision',
      'expiresAt',
    ]) ||
    !text(view.provider) ||
    !text(view.providerModel) ||
    !text(view.accountRef) ||
    !enumValue(view.authKind, authKinds) ||
    !enumValue(view.fundingSource, fundingSources) ||
    !revision(view.authorityRevision) ||
    !text(view.expiresAt) ||
    !utcTimestamp(view.expiresAt) ||
    Date.parse(view.expiresAt) <= freshness.now ||
    !owner ||
    !exactKeys(owner, ['ownerRef', 'kind', 'displayName', 'revision']) ||
    !text(owner.ownerRef) ||
    !text(owner.displayName) ||
    !revision(owner.revision) ||
    !enumValue(owner.kind, ['provider_account', 'workspace_account', 'adea_account'])
  )
    return blockedFunding()
  return {
    schemaVersion: 'model-funding-display/v1',
    workspaceId: scope.workspaceId,
    executionId: scope.executionId,
    attemptId: scope.attemptId,
    selectionRef: scope.selectionRef,
    selectionRevision: scope.selectionRevision,
    state: 'ready',
    provider: view.provider,
    providerModel: view.providerModel,
    accountRef: view.accountRef,
    authKind: view.authKind,
    fundingSource: view.fundingSource,
    fundingOwner: {
      ownerRef: owner.ownerRef,
      kind: owner.kind,
      displayName: owner.displayName,
      revision: owner.revision,
    },
    authorityRevision: view.authorityRevision,
    expiresAt: view.expiresAt,
  }
}

const authKinds = ['api_key', 'provider_subscription', 'local_runtime'] as const
const fundingSources = ['byo_api', 'external_subscription', 'hq_managed'] as const
const fundingBindingKeys = [
  'schemaVersion',
  'workspaceId',
  'executionId',
  'attemptId',
  'selectionRef',
  'selectionRevision',
] as const

function blockedFunding(
  reason: unknown = 'READINESS_UNAVAILABLE'
): Extract<ProjectedModelFunding, { state: 'blocked' }> {
  const bounded = reasonCode(reason)
  const code = bounded === 'READY' ? 'READINESS_UNAVAILABLE' : bounded
  return { state: 'blocked', reasonCode: code, remedy: { ...remedies[code] } }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function text(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    Array.from(value).every((character) => {
      const code = character.codePointAt(0)!
      return code > 31 && (code < 127 || code > 159)
    })
  )
}

function revision(value: unknown, allowZero = false): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= (allowZero ? 0 : 1)
}

function enumValue<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T)
}

function connectionRef(value: unknown): value is string {
  return typeof value === 'string' && /^mconn_[a-f0-9]{32}$/.test(value)
}

function selectionRef(value: unknown): value is string {
  return typeof value === 'string' && /^msel_[a-f0-9]{32}$/.test(value)
}

function utcTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) return false
  const parsed = Date.parse(value)
  return (
    Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19)
  )
}

function modelChoice(value: unknown): ApiModelChoice | null {
  const choice = record(value)
  if (
    !choice ||
    !exactKeys(choice, ['connectionRef', 'providerModel']) ||
    !connectionRef(choice.connectionRef) ||
    !text(choice.providerModel)
  )
    return null
  return { connectionRef: choice.connectionRef, providerModel: choice.providerModel }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

function counts(values: readonly unknown[]): Map<unknown, number> {
  const result = new Map<unknown, number>()
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1)
  return result
}

function executionTarget(value: unknown): boolean {
  const target = record(value)
  return Boolean(
    target &&
    exactKeys(target, ['location', 'harness', 'harnessVersion', 'providerBinding']) &&
    text(target.harnessVersion) &&
    enumValue(target.location, ['local_device', 'remote_host', 'agent_hq_cloud']) &&
    enumValue(target.harness, ['pi', 'pi_durable', 'cloudflare_agents', 'acp']) &&
    enumValue(target.providerBinding, [
      'pi_model_runtime',
      'pi_durable_models',
      'cloudflare_binding',
      'native_harness',
    ])
  )
}
