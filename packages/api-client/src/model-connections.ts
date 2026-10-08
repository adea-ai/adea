export type ApiModelRole = 'lead' | 'child' | 'direct'
export type ApiModelAuthKind = 'api_key' | 'provider_subscription' | 'local_runtime'
export type ApiModelFundingSource = 'byo_api' | 'external_subscription' | 'hq_managed'
export type ApiModelExecutionTarget = Readonly<{
  location: 'local_device' | 'remote_host' | 'agent_hq_cloud'
  harness: 'pi' | 'pi_durable' | 'cloudflare_agents' | 'acp'
  harnessVersion: string
  providerBinding:
    | 'pi_model_runtime'
    | 'pi_durable_models'
    | 'cloudflare_binding'
    | 'native_harness'
}>
export type ApiModelChoice = Readonly<{ connectionRef: string; providerModel: string }>
export type ApiModelReadiness = Readonly<{
  ready: boolean
  reasonCode: string
  remedy: Readonly<{ action: string; message: string }> | null
}>
/** Workspace metadata only. Credential revisions and grant capabilities stay server-side. */
export type ApiModelConnection = Readonly<{
  connectionRef: string
  revision: number
  provider: string
  accountRef: string
  authKind: ApiModelAuthKind
  fundingSource: ApiModelFundingSource
  status: 'active' | 'revoked'
  models: readonly Readonly<{ providerModel: string; readiness: ApiModelReadiness }>[]
}>
export type ApiWorkspaceModelDefaults = Readonly<{
  revision: number
  lead?: ApiModelChoice
  child?: ApiModelChoice
  direct?: ApiModelChoice
}>
export type ApiModelConnectionsResponse = Readonly<{
  availability: 'available' | 'unavailable'
  target: ApiModelExecutionTarget | null
  connections: readonly ApiModelConnection[]
  canManage: boolean
}>
export type ApiModelDefaultsResponse = Readonly<{
  availability: 'available' | 'unavailable'
  defaults: ApiWorkspaceModelDefaults | null
  canManage: boolean
}>
export type ApiModelDefaultsSetInput = Readonly<{
  expectedRevision: number
  lead?: ApiModelChoice
  child?: ApiModelChoice
  direct?: ApiModelChoice
  idempotencyKey: string
}>
/** Registers an existing canonical vault credential; never writes credential material. */
export type ApiModelConnectionCreateInput = Readonly<{
  credentialRef: string
  credentialRevision: number
  idempotencyKey: string
}>
export type ApiModelConnectionRevokeInput = Readonly<{
  connectionRef: string
  expectedRevision: number
  idempotencyKey: string
}>
/** Mutation metadata has no assessed models; refresh inventory for readiness. */
export type ApiModelConnectionResponse = Readonly<{ connection: ApiModelConnection }>
/** A preparation receipt, never execution or spending authority. */
export type ApiModelSelection = Readonly<{
  selectionRef: string
  selectionRevision: number
  connectionRef: string
  provider: string
  providerModel: string
  authKind: ApiModelAuthKind
  fundingSource: ApiModelFundingSource
  target: ApiModelExecutionTarget
}>
export type ApiModelSelectionResolveInput = Readonly<{
  role: ApiModelRole
  override?: ApiModelChoice
}>
export type ApiModelSelectionResponse = Readonly<{ selection: ApiModelSelection }>
export type ApiModelFundingBinding = Readonly<{
  executionId: string
  attemptId: string
  selectionRef: string
  selectionRevision: number
}>
export type ApiModelFundingView = Readonly<{
  schemaVersion: 'model-funding-display/v1'
  workspaceId: string
}> &
  ApiModelFundingBinding &
  (
    | Readonly<{
        state: 'ready'
        provider: string
        providerModel: string
        accountRef: string
        authKind: ApiModelAuthKind
        fundingSource: ApiModelFundingSource
        fundingOwner: Readonly<{
          ownerRef: string
          kind: 'provider_account' | 'workspace_account' | 'adea_account'
          displayName: string
          revision: number
        }>
        authorityRevision: number
        expiresAt: string
      }>
    | Readonly<{ state: 'blocked'; reasonCode: string }>
  )
export type ApiModelFundingResponse = Readonly<{ funding: ApiModelFundingView }>
export type ApiModelSelectionFundingBinding = ApiModelFundingBinding
export type ApiModelSelectionFundingView = ApiModelFundingView

/** Structural port, also implemented by the existing AgentHqApiClient. */
export interface AgentHqModelConnectionsClient {
  createModelConnection(
    workspaceId: string,
    input: ApiModelConnectionCreateInput
  ): Promise<ApiModelConnectionResponse>
  revokeModelConnection(
    workspaceId: string,
    input: ApiModelConnectionRevokeInput
  ): Promise<ApiModelConnectionResponse>
  listModelConnections(workspaceId: string): Promise<ApiModelConnectionsResponse>
  getWorkspaceModelDefaults(workspaceId: string): Promise<ApiModelDefaultsResponse>
  setWorkspaceModelDefaults(
    workspaceId: string,
    input: ApiModelDefaultsSetInput
  ): Promise<ApiModelDefaultsResponse>
  resolveWorkspaceModelSelection(
    workspaceId: string,
    input: ApiModelSelectionResolveInput
  ): Promise<ApiModelSelectionResponse>
  getModelSelectionFunding(
    workspaceId: string,
    input: ApiModelFundingBinding
  ): Promise<ApiModelFundingResponse>
}

/** Uses the owning API client's authenticated transport; carries no new credentials. */
export function createModelConnectionsAdapter(
  request: <T>(path: string, init: RequestInit) => Promise<T>
): AgentHqModelConnectionsClient {
  async function modelRequest<T>(
    workspaceId: string,
    action: string,
    input: unknown = {}
  ): Promise<T> {
    const allowed =
      action === 'connections.create'
        ? ['credentialRef', 'credentialRevision', 'idempotencyKey']
        : action === 'connections.revoke'
          ? ['connectionRef', 'expectedRevision', 'idempotencyKey']
          : action === 'defaults.set'
            ? ['expectedRevision', 'idempotencyKey', 'lead', 'child', 'direct']
            : action === 'selection.resolve'
              ? ['role', 'override']
              : action === 'funding.get'
                ? ['executionId', 'attemptId', 'selectionRef', 'selectionRevision']
                : []
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      !Object.keys(input).every((key) => allowed.includes(key))
    )
      throw new Error('Invalid model metadata input')
    const fields = input as Record<string, unknown>
    for (const key of ['lead', 'child', 'direct', 'override']) {
      const choice = fields[key]
      if (choice === undefined) continue
      if (
        !choice ||
        typeof choice !== 'object' ||
        Array.isArray(choice) ||
        Object.keys(choice).toSorted().join(',') !== 'connectionRef,providerModel'
      )
        throw new Error('Invalid model metadata input')
    }
    return request(`/workspaces/${encodeURIComponent(workspaceId)}/model-connections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, input }),
    })
  }
  return {
    createModelConnection: (workspaceId, input) =>
      modelRequest(workspaceId, 'connections.create', input),
    revokeModelConnection: (workspaceId, input) =>
      modelRequest(workspaceId, 'connections.revoke', input),
    listModelConnections: (workspaceId) => modelRequest(workspaceId, 'list'),
    getWorkspaceModelDefaults: (workspaceId) => modelRequest(workspaceId, 'defaults.get'),
    setWorkspaceModelDefaults: (workspaceId, input) =>
      modelRequest(workspaceId, 'defaults.set', input),
    resolveWorkspaceModelSelection: (workspaceId, input) =>
      modelRequest(workspaceId, 'selection.resolve', input),
    getModelSelectionFunding: (workspaceId, input) =>
      modelRequest(workspaceId, 'funding.get', input),
  }
}
