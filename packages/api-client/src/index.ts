import {
  createModelConnectionsAdapter,
  type ApiModelConnectionsResponse,
  type ApiModelDefaultsResponse,
  type ApiModelDefaultsSetInput,
  type ApiModelSelectionResolveInput,
  type ApiModelSelectionResponse,
  type ApiModelFundingBinding,
  type ApiModelFundingResponse,
  type ApiModelConnectionCreateInput,
  type ApiModelConnectionRevokeInput,
  type ApiModelConnectionResponse,
} from './model-connections.js'

import type {
  AccountSummary,
  AgentSummary,
  ArtifactLocation,
  ArtifactSummary,
  ChannelReadStateSummary,
  ChannelSummary,
  ContentReplicaSummary,
  ConversationParticipantRef,
  ContentRefSummary,
  MessageSummary,
  PrincipalRef,
  ProjectMemberRole,
  ProjectMemberSummary,
  ProjectSourceKind,
  ProjectSummary,
  ProjectVisibility,
  TaskKind,
  TaskSummary,
  WorkspaceInvitationRole,
  WorkspaceInvitationSummary,
  WorkspaceMemberRole,
  WorkspaceMemberSummary,
  WorkspaceSummary,
  WorkspaceUpdate,
  WorkspaceSearchPage,
} from '@adea-ai/types'

import {
  runtimeNodeDeviceOnline,
  runtimeNodeHostReachability,
  type ApiRuntimeNodeConnectionsResponse,
  type ApiRuntimeNodesResponse,
} from './runtime-connections'
export type {
  ApiRuntimeDeviceOnline,
  ApiRuntimeHostReachability,
  ApiRuntimeConnection,
  ApiRuntimeNode,
  ApiRuntimeNodeConnectionsResponse,
  ApiRuntimeNodesResponse,
  RuntimeConnectionUnknownField,
} from './runtime-connections'
export {
  runtimeConnectionDiscoveryUnknownDependencies,
  runtimeNodeDeviceOnline,
  runtimeNodeHostReachability,
} from './runtime-connections'

export type ApiAgentCreateInput = Readonly<{
  avatarRef?: string
  characterRef?: string
  name: string
  presentationMetadata?: Readonly<Record<string, string>>
  profileId: string
  profileVersion: string
  roleSummary?: string
  projectId?: string
}>
export type ApiAgentPresentationInput = Readonly<{
  avatarRef?: string | null
  characterRef?: string | null
  /** The Agent `revision` the editor opened; a superseded revision answers 409. */
  expectedRevision: number
  name?: string
  presentationMetadata?: Readonly<Record<string, string>>
  roleSummary?: string | null
}>
export type ApiAgentProjectInput = Readonly<{
  expectedRevision: number
  projectId: string | null
}>
export type ApiAgentProfileInput = Readonly<{
  expectedRevision: number
  profileId: string
  profileVersion: string
}>
export type ApiAgentResponse = Readonly<{ agent: AgentSummary }>
export type ApiWorkspaceLeadResponse = Readonly<{ lead: AgentSummary | null }>

export type ApiArtifactCreateInput = Readonly<{
  agentId?: string
  availability?: ArtifactSummary['availability']
  checksumSha256: string
  executionRef?: string
  filename: string
  location: ArtifactLocation
  mediaType: string
  provenance?: Readonly<Record<string, unknown>>
  retentionPolicy?: ArtifactSummary['retentionPolicy']
  sensitivity?: ArtifactSummary['sensitivity']
  sizeBytes: number
  sourceArtifactRef: string
  sourcePrincipal: PrincipalRef
  taskId?: string
}>
export type ApiArtifactResponse = Readonly<{ artifact: ArtifactSummary }>

export type ApiTaskCommand = Readonly<{
  correlationId?: string
  expectedVersion?: number
  idempotencyKey: string
  requestId: string
}>
export type ApiTaskCreateInput = Readonly<{
  agentId?: string
  artifactRefs?: readonly string[]
  controlPlaneExecutionRef?: string
  controlPlaneWorkflowRef?: string
  conversation?: Readonly<{
    channelId?: string
    messageId?: string
    threadRootMessageId?: string
  }>
  dependencyIds?: readonly string[]
  kind?: TaskKind
  objective?: string
  objectiveContentRefId?: string
  priority?: 'low' | 'normal' | 'high' | 'urgent'
  projectId?: string
  title: string
}>
export type ApiTaskUpdateInput = Readonly<{
  controlPlaneExecutionRef?: string | null
  controlPlaneWorkflowRef?: string | null
  kind?: TaskKind
  objective?: string
  objectiveContentRefId?: string
  priority?: 'low' | 'normal' | 'high' | 'urgent'
  title?: string
}>
/**
 * The outbound result a completion may carry for a group channel. The artifact is named
 * by id and grant only; its facts come from the server's registry.
 */
export type ApiJobOutboundResult = Readonly<{
  artifact: Readonly<{ artifactId: string; grantId: string }> | null
  artifactPolicy?: 'require' | 'omit_unauthorized'
  channelId: string
  summary: string
}>
/** How a completion's outbound result landed: published with its message, or held at the named gate. */
export type ApiOutboundPublication =
  | Readonly<{ action: 'publish'; artifactOmitted: string | null; messageId: string | null }>
  | Readonly<{ action: 'hold'; gate: string; messageId: null; reason: string }>
export type ApiTaskResponse = Readonly<{
  outboundPublication?: ApiOutboundPublication
  task: TaskSummary
}>
export type ApiContentRefCreateInput = Readonly<{
  availability: Exclude<ContentRefSummary['availability'], 'deleted'>
  contentType: ContentRefSummary['contentType']
  digestSha256: string
  id: string
  keyVersion: number
  messageId?: string
  schemaVersion: number
  sensitivity: ContentRefSummary['sensitivity']
  storagePolicy: ContentRefSummary['storagePolicy']
  synchronizationPolicy: ContentRefSummary['synchronizationPolicy']
  taskId?: string
}>
export type ApiContentRefUpdateInput = Readonly<{
  availability: ContentRefSummary['availability']
  digestSha256: string
  expectedRevision: number
  keyVersion: number
  revision: number
}>
export type ApiContentRefResponse = Readonly<{ contentRef: ContentRefSummary }>
export type ApiContentReplicaUpsertInput = Readonly<{
  availability: ContentReplicaSummary['availability']
  ciphertext: string
  digestSha256: string
  keyEpochId?: string
  nonce: string
  replicaKind: ContentReplicaSummary['replicaKind']
  revision: number
  schemaVersion: number
}>
export type ApiContentReplicaUpsertResponse = Readonly<{
  contentReplica: ContentReplicaSummary
  outcome: 'created' | 'duplicate' | 'stale'
}>
export type ApiContentReplicaListResponse = Readonly<{
  contentReplicas: readonly ContentReplicaSummary[]
}>
export type ApiReadStateResponse = Readonly<{ readState: readonly ChannelReadStateSummary[] }>
/** Counts-only unread status for every workspace the caller belongs to. */
export type ApiAccountSummaryResponse = AccountSummary

export type ApiChannelResponse = Readonly<{ channel: ChannelSummary }>
export type {
  ApiAddressedTurn,
  ApiAddressedTurnCancelResponse,
  ApiAddressedTurnInput,
  ApiAddressedTurnPage,
  ApiAddressedTurnResponse,
  ApiAddressedTurnState,
} from './addressed-turns'
import type {
  ApiAddressedTurnCancelResponse,
  ApiAddressedTurnInput,
  ApiAddressedTurnPage,
  ApiAddressedTurnResponse,
} from './addressed-turns'
export type {
  ApiLeadTurnChild,
  ApiLeadTurnChildrenCursor,
  ApiLeadTurnChildrenQuery,
  ApiLeadTurnChildrenPage,
  ApiLeadTurnChildrenResponse,
  ApiHandoffTarget,
  ApiLeadTurnStatus,
  ApiRequestedRoleModelSelections,
  ApiLeadTurnResponse,
  ApiChannelLeadTurnResponse,
  ApiLeadTurnProgress,
  ApiLeadTurnProgressResponse,
  LeadTurnRuntimeState,
  LeadTurnReasonCode,
} from './lead-turns'
import type {
  ApiLeadTurnChildrenQuery,
  ApiLeadTurnChildrenResponse,
  ApiHandoffTarget,
  ApiLeadTurnResponse,
  ApiLeadTurnProgressResponse,
  ApiChannelLeadTurnResponse,
} from './lead-turns'

export type ApiMessageResponse = Readonly<{
  message: MessageSummary
  /** Canonical persistence is not runtime admission or execution. */
  leadTurn?: Readonly<{
    schemaVersion: 'pi-lead-intent/v1'
    intentId: string
    messageId: string
    dispatchKey: string
    state: 'blocked'
    reasonCode: 'ADMISSION_SERVICE_UNAVAILABLE'
    handoffTarget?: ApiHandoffTarget
  }>
}>
export type ApiMessagePage = Readonly<{
  messages: readonly MessageSummary[]
  nextAfterSequence?: number
}>
/** An accepted coordination plan revision (#1217): the job ids a plan cites, nothing about the jobs. */
export type ApiCoordinationPlanRevision = Readonly<{
  createdAt: string
  jobIds: readonly string[]
  planId: string
  revision: number
}>
/**
 * One cited job as the reader may see it now. `authority` is always `none`: a reference grants no
 * access to the job. `messageId` is the released publication the reader can already open.
 * Unknown, hidden, revoked and unpublished jobs are the same `unavailable` view.
 */
export type ApiJobReference =
  | Readonly<{ authority: 'none'; availability: 'available'; jobId: string; messageId: string }>
  | Readonly<{ authority: 'none'; availability: 'unavailable'; jobId: string }>
export type ApiCoordinationPlanReferences = Readonly<{
  planId: string
  references: readonly ApiJobReference[]
  revision: number
}>
export type ApiHandoffTargetRequest = Readonly<{
  /** The exact direct session this admission coordinates. */
  runtimeSessionId: string
  /** The task authority claimed; the server verifies visibility and stamps it. */
  taskId: string
  /** The session generation observed when requesting; newer supersedes. */
  expectedGeneration: number
}>
export type ApiMessageCreateInput = Readonly<{
  /** Explicit workspace lead admission; direct sessions remain ordinary messages. */
  leadTurn?: true
  /** Structured handoff target; prose never carries the binding. */
  handoffTarget?: ApiHandoffTargetRequest
  requestedModelSelections?: import('./lead-turns').ApiRequestedRoleModelSelections
  artifactIds?: readonly string[]
  bodyContentRefId?: string
  bodyText?: string
  executionRef?: string
  externalSessionRef?: string
  idempotencyKey: string
  mentions?: readonly ConversationParticipantRef[]
  replyToMessageId?: string
  taskId?: string
  threadRootMessageId?: string
}>

export function taskCommandHeaders(command: ApiTaskCommand): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Idempotency-Key': command.idempotencyKey,
    'X-Request-ID': command.requestId,
    ...(command.correlationId ? { 'X-Correlation-ID': command.correlationId } : {}),
    ...(command.expectedVersion !== undefined
      ? { 'If-Match': String(command.expectedVersion) }
      : {}),
  }
}

export type ApiProjectCreateInput = Readonly<{
  iconKey: string
  /** Optional client-generated UUID; replaying the same create is idempotent. */
  id?: string
  name: string
  sourceKind?: ProjectSourceKind
}>

export type ApiProjectUpdateInput = Readonly<{
  /** A theme accent id, or null to inherit the workspace accent. */
  accent?: ProjectSummary['accent']
  iconKey?: string
  name?: string
  sourceKind?: ProjectSourceKind
}>

/**
 * Explicit project-state promotion (archived → active). `expectedVersion` is
 * the integer `ProjectSummary.version` the caller observed and `confirmed` is
 * the owner's opt-in; neither has a default, so an unconfirmed or stale call
 * fails.
 */
export type ApiProjectRestoreInput = Readonly<{
  confirmed: true
  expectedVersion: number
}>

export type ApiProjectResponse = Readonly<{ project: ProjectSummary }>
export type ApiProjectMembersResponse = Readonly<{ members: readonly ProjectMemberSummary[] }>
export type ApiProjectMemberResponse = Readonly<{ member: ProjectMemberSummary }>
export type ApiProjectMemberRemoveResponse = Readonly<{ removed: boolean }>
export type ApiWorkspaceMembersResponse = Readonly<{ members: readonly WorkspaceMemberSummary[] }>
export type ApiWorkspaceInvitationsResponse = Readonly<{
  invitations: readonly WorkspaceInvitationSummary[]
}>
export type ApiWorkspaceInvitationCreateInput = Readonly<{
  email: string
  role: WorkspaceInvitationRole
}>
/**
 * The plaintext token is returned once, here, and never again: the server
 * stores only its digest. `acceptPath` carries the token in the URL fragment,
 * so it is not sent to the server, proxies or referrers when the link opens.
 */
export type ApiWorkspaceInvitationCreateResponse = Readonly<{
  acceptPath: string
  invitation: WorkspaceInvitationSummary
  token: string
}>
export type ApiWorkspaceInvitationResponse = Readonly<{ invitation: WorkspaceInvitationSummary }>
export type ApiWorkspaceInvitationAcceptResponse = Readonly<{
  joined: boolean
  workspaceId: string
}>
/**
 * What an invitee sees before accepting: the workspace, its owner, how many people are in it, and
 * the role they would hold, which for an existing member is the role they already have.
 */
export type ApiWorkspaceInvitationPreviewResponse = Readonly<{
  alreadyMember: boolean
  expiresAt: string
  memberCount: number
  ownerName: string | null
  role: WorkspaceMemberRole
  workspaceName: string
}>
export type ApiProjectArchiveResponse = Readonly<{ archived: true }>
export type ApiProjectDeleteResponse = Readonly<{ deleted: true }>

export type ApiWorkspaceResponse = {
  workspace: WorkspaceSummary
  agents: readonly AgentSummary[]
  tasks: readonly TaskSummary[]
}

export type ApiWorkspaceBootstrapResponse = {
  activeWorkspace: WorkspaceSummary | null
  principal: Readonly<{ displayName?: string; temporary: boolean; userId?: string }>
  sessionRotated: boolean
  temporaryCredential?: string
  workspaces: readonly WorkspaceSummary[]
}

export type ApiWorkspaceCreateResponse = {
  created: boolean
  workspace: WorkspaceSummary
}

export type ApiWorkspaceClaimResponse = Readonly<{ claimed: true }>

export type ApiWorkspaceReopenResponse = Readonly<{ workspace: WorkspaceSummary }>
export type ApiPortableExportDownload = Readonly<{ bytes: number; fileName: string; text: string }>

export type ApiPortableImportResult = Readonly<{
  contentDigest: string
  counts: Readonly<{
    agents: number
    channels: number
    messages: number
    projects: number
    tasks: number
  }> &
    Readonly<Record<string, number>>
  deferred: readonly Readonly<{ class: string; reason: string; treatment: string }>[]
  workspaceId: string
}>

export type ApiWorkspaceArchiveResponse = Readonly<{ archived: true; workspaceId: string }>
export type ApiWorkspaceArchiveInput = Readonly<{ confirmed: true }>
export type ApiArchivedWorkspacesResponse = Readonly<{ workspaces: readonly WorkspaceSummary[] }>
export type ApiWorkspaceDeleteResponse = Readonly<{
  deleted: true
  workspaceId: string
  workspaces: readonly WorkspaceSummary[]
}>

export type ApiWorkspaceUpdateResponse = Readonly<{ workspace: WorkspaceSummary }>

export type ApiMarketplaceCatalogResponse = Readonly<{
  catalogId: string
  releaseId: string
  state: 'ready' | 'stale'
  artifacts: Readonly<{
    'catalog.v1.json': string
    'catalog-latest.v1.json': string
    'catalog-summary.v1.json': string
    'categories.v1.json': string
    'compatibility.v1.json': string
    'integrity.json': string
    'sources.lock.json': string
  }>
  installations?: readonly Readonly<{
    pluginId: string
    releaseId: string
    canonicalContentDigest: string
    /** The handle for installation get and uninstall (Control Plane 3.x). */
    installationId?: string
    installationInstanceId?: string
    packageDigest?: string
    state:
      | 'pending-authorization'
      | 'unavailable'
      | 'rejected-by-policy'
      | 'installed'
      | 'superseded'
  }>[]
}>

export type ApiMarketplaceInstallInput = Readonly<{
  pluginId: string
  releaseId: string
  canonicalContentDigest: string
  requestedHarness: string
  /** Stable workspace/user/plugin installation scope owned by Control Plane. */
  installationInstanceId?: string
  workspaceIdentity: Readonly<{ userId: string; workspaceId: string }>
  idempotencyKey: string
}>

export type ApiMarketplaceInstallPlanInput = Readonly<{
  pluginId: string
  releaseId: string
  instanceId: string
  requestedHarness: string
  workspaceIdentity: Readonly<{ userId: string; workspaceId: string }>
}>

export type ApiMarketplaceInstallPlanResponse = Readonly<{
  planVersion: 2
  pluginId: string
  releaseId: string
  instanceId: string
  strategy: 'native-agent-plugin' | 'component-adapter' | 'unavailable'
  compatibility: 'full' | 'partial' | 'unsupported'
  allowedToActivate: false
  approvalRequired: true
  packageDigest?: string
  [key: string]: unknown
}>

export type ApiMarketplaceInstallResponse = Readonly<{
  installationId: string
  installationInstanceId?: string
  pluginId: string
  releaseId: string
  canonicalContentDigest: string
  packageDigest?: string
  state: 'pending-authorization' | 'unavailable' | 'rejected-by-policy' | 'installed' | 'superseded'
  requiredConnectors: readonly string[]
  requiredCredentials: readonly string[]
  message?: string
}>

/** One installation as the Control Plane reports it for get and uninstall. */
export type ApiMarketplaceInstallation = Readonly<{
  installationId: string
  pluginId: string
  releaseId: string
  canonicalContentDigest: string
  catalogId: string
  installationInstanceId?: string
  packageDigest?: string
  requestedHarness: string
  state:
    | 'pending-authorization'
    | 'unavailable'
    | 'rejected-by-policy'
    | 'installed'
    | 'superseded'
    | 'uninstalled'
  installedBy: string
  installedAt: string
  updatedAt: string
  uninstalledBy?: string
  uninstalledAt?: string
}>

export type ApiMarketplaceInstallationResponse = Readonly<{
  installation: ApiMarketplaceInstallation
}>

export type ApiMarketplaceUninstallResponse = Readonly<{
  installation: ApiMarketplaceInstallation
  /** True when the installation was already uninstalled. */
  replayed: boolean
}>

export type ApiDesktopSessionCredential = Readonly<{
  credential: string
  sessionId: string
}>

/**
 * Workspace catalog (ADR 0013): Skills and agent profiles visible to the
 * workspace through the Control Plane. `owner: 'system'` items are read-only.
 */
export type ApiCatalogLifecycle = 'deprecated' | 'draft' | 'published' | 'revoked' | 'superseded'

export type ApiCatalogVersion = Readonly<{
  versionId: string
  /** Semantic version for a skill; the integer version for a profile. */
  version: string
  revision: number
  lifecycle: ApiCatalogLifecycle
  contentDigest: string
  createdAt: string
  reason?: string
}>

export type ApiCatalogItem = Readonly<{
  id: string
  kind: 'profile' | 'skill'
  displayName: string
  owner: 'system' | 'workspace'
  readOnly: boolean
  createdAt: string
  latestVersion?: ApiCatalogVersion
}>

export type ApiCatalogListResponse = Readonly<{
  /** Whether the caller may publish, deprecate and revoke (owner/admin). */
  canManage: boolean
  items: readonly ApiCatalogItem[]
  nextCursor?: string
}>

export type ApiCatalogLifecycleInput = Readonly<{
  idempotencyKey: string
  reason: string
  /** Both or neither: target one version at a revision instead of every version. */
  versionId?: string
  expectedRevision?: number
}>

export type ApiCatalogLifecycleResponse = Readonly<{
  item: ApiCatalogItem
  changed: readonly ApiCatalogVersion[]
}>

export type ApiSkillPublishInput = Readonly<{
  idempotencyKey: string
  /** Omitted to create a new skill; set to publish a new version of one. */
  skillId?: string
  displayName: string
  manifest: Readonly<Record<string, unknown>>
  content: Readonly<Record<string, unknown>>
}>

export type ApiSkillPublishResponse = Readonly<{
  item: ApiCatalogItem
  version: ApiCatalogVersion
}>

/**
 * Cloud connections (ADR 0013): connector credentials held in the Control
 * Plane vault for cloud executions. Metadata only: the secret is write-only,
 * sent once on create or rotate and never returned.
 */
export type ApiCloudConnectionStatus = 'active' | 'expired' | 'revoked' | 'secret_required'

export type ApiCloudConnection = Readonly<{
  credentialId: string
  provider: string
  connectorRef: string
  status: ApiCloudConnectionStatus
  revision: number
  createdAt: string
  rotatedAt?: string
  expiresAt?: string
  revokedAt?: string
}>

export type ApiCloudConnectionsResponse = Readonly<{
  canManage: boolean
  connections: readonly ApiCloudConnection[]
  nextCursor?: string
}>

export type ApiCloudConnectionResponse = Readonly<{ connection: ApiCloudConnection }>

export type ApiCloudConnectionCreateInput = Readonly<{
  idempotencyKey: string
  provider: string
  connectorRef: string
  /** Write-only. Sent once to the vault; never stored in Adea or echoed. */
  secret: string
  expiresAt?: string
}>

export type ApiCloudConnectionRotateInput = Readonly<{
  idempotencyKey: string
  expectedRevision: number
  /** Write-only. Sent once to the vault; never stored in Adea or echoed. */
  secret: string
}>

export type ApiClientOptions = {
  baseUrl?: string
  client?: 'browser' | 'desktop'
  fetchImpl?: typeof fetch
  getAccessToken?: () => string | undefined
  getDesktopSession?: () => ApiDesktopSessionCredential | undefined
  getTemporaryCredential?: () => string | undefined
}

/**
 * The server validates paging bounds and answers 400 outside them
 * (`search`: limit 1-50, offset 0-5000; `messages`: limit 1-100). Clamping here
 * turns a footgun into a well-defined request instead of a guaranteed
 * rejection, and keeps the two sides from drifting apart silently.
 */
function boundedInt(value: number | undefined, min: number, max: number, fallback: number) {
  if (value === undefined) return fallback
  if (!Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.trunc(value), min), max)
}

/**
 * One refusal in a `400 group_grant_rejected` answer: the group-creation reason, and the participant it is
 * about when it is about one (a group-wide reason carries none). Values are read as received; the reader
 * decides which reasons it recognizes.
 */
/**
 * Who a group should hold, by stable identity: user ids and workspace-qualified
 * Agents. It carries no grant, revision or time; the server issues those.
 */
export type ApiGroupSelection = Readonly<{
  agents: readonly Readonly<{ agentId: string; workspaceId: string }>[]
  humans: readonly string[]
}>

export type ApiGroupGrantRejection = Readonly<{
  participant?: ConversationParticipantRef
  reason: string
}>

export class ApiClientError extends Error {
  readonly status: number
  readonly code?: string
  /** Names why a `409 turn_conflict` was refused; only present on addressed-turn conflicts. */
  readonly reason?: string
  /** Every refused participant of a `group_grant_rejected` answer; absent on other failures. */
  readonly rejections?: readonly ApiGroupGrantRejection[]

  constructor(
    message: string,
    status: number,
    code?: string,
    reason?: string,
    rejections?: readonly ApiGroupGrantRejection[]
  ) {
    super(message)
    this.name = 'ApiClientError'
    this.status = status
    this.code = code
    this.reason = reason
    this.rejections = rejections
  }
}

function groupGrantRejections(value: unknown): readonly ApiGroupGrantRejection[] | undefined {
  if (!Array.isArray(value)) return undefined
  const parsed: ApiGroupGrantRejection[] = []
  for (const entry of value.slice(0, 100)) {
    if (!entry || typeof entry !== 'object' || typeof entry.reason !== 'string') continue
    const participant = entry.participant as Record<string, unknown> | undefined
    if (participant?.kind === 'user' && typeof participant.userId === 'string')
      parsed.push({
        participant: { kind: 'user', userId: participant.userId },
        reason: entry.reason,
      })
    else if (participant?.kind === 'agent' && typeof participant.agentId === 'string')
      parsed.push({
        participant: { agentId: participant.agentId, kind: 'agent' },
        reason: entry.reason,
      })
    else parsed.push({ reason: entry.reason })
  }
  return parsed
}

export class AgentHqApiClient {
  /** Optional hosted Sim configuration. This uses the same identity as workspace REST calls. */
  simConfiguration(
    signal?: AbortSignal
  ): Promise<{ frameOrigin: string | null; allowLoopbackHttp?: boolean }> {
    return this.request('/sim/config', { signal })
  }

  /** Protocol validation belongs to the spatial caller; credentials stay in this transport. */
  requestSimLaunch(input: unknown, signal: AbortSignal): Promise<unknown> {
    return this.request('/sim/launch', {
      method: 'POST',
      signal,
      body: JSON.stringify(input),
      headers: { 'Content-Type': 'application/json' },
    })
  }

  private readonly baseUrl: string
  private readonly client: 'browser' | 'desktop'
  private readonly fetchImpl: typeof fetch
  private readonly getAccessToken?: () => string | undefined
  private readonly getDesktopSession?: () => ApiDesktopSessionCredential | undefined
  private readonly getTemporaryCredential?: () => string | undefined

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? '/api'
    this.client = options.client ?? 'browser'
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
    this.getAccessToken = options.getAccessToken
    this.getDesktopSession = options.getDesktopSession
    this.getTemporaryCredential = options.getTemporaryCredential
  }

  async bootstrapWorkspace(): Promise<ApiWorkspaceBootstrapResponse> {
    return this.request<ApiWorkspaceBootstrapResponse>('/workspaces/bootstrap', { method: 'POST' })
  }

  async listWorkspaces(): Promise<readonly WorkspaceSummary[]> {
    return this.request<readonly WorkspaceSummary[]>('/workspaces')
  }

  async reorderWorkspaces(workspaceIds: readonly string[]): Promise<readonly WorkspaceSummary[]> {
    return this.postJson<readonly WorkspaceSummary[]>('/workspaces/reorder', { workspaceIds })
  }

  async createWorkspace(
    input: Readonly<{
      idempotencyKey: string
      name: string
      scene?: 'home' | 'work'
    }>
  ): Promise<ApiWorkspaceCreateResponse> {
    return this.request<ApiWorkspaceCreateResponse>('/workspaces', {
      body: JSON.stringify({ name: input.name, scene: input.scene }),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': input.idempotencyKey },
      method: 'POST',
    })
  }

  async getWorkspace(workspaceId: string): Promise<ApiWorkspaceResponse> {
    return this.request<ApiWorkspaceResponse>(`/workspaces/${encodeURIComponent(workspaceId)}`)
  }

  async updateWorkspace(
    workspaceId: string,
    input: WorkspaceUpdate & Readonly<{ expectedVersion: number }>
  ): Promise<ApiWorkspaceUpdateResponse> {
    return this.request<ApiWorkspaceUpdateResponse>(
      `/workspaces/${encodeURIComponent(workspaceId)}`,
      {
        body: JSON.stringify(input),
        headers: { 'Content-Type': 'application/json' },
        method: 'PATCH',
      }
    )
  }

  async reopenWorkspace(workspaceId: string): Promise<ApiWorkspaceReopenResponse> {
    return this.request<ApiWorkspaceReopenResponse>(
      `/workspaces/${encodeURIComponent(workspaceId)}/reopen`,
      { method: 'POST' }
    )
  }

  async listArchivedWorkspaces(): Promise<ApiArchivedWorkspacesResponse> {
    return this.request<ApiArchivedWorkspacesResponse>('/workspaces/archived')
  }

  async archiveWorkspace(
    workspaceId: string,
    input: ApiWorkspaceArchiveInput
  ): Promise<ApiWorkspaceArchiveResponse> {
    return this.request<ApiWorkspaceArchiveResponse>(
      `/workspaces/${encodeURIComponent(workspaceId)}/archive`,
      {
        body: JSON.stringify(input),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }
    )
  }

  /**
   * Downloads the requester's portable export of one workspace. Refusals surface as
   * `ApiClientError` with `code` `too_large` (over 10,000 records or 8 MiB) or
   * `workspace_unavailable` (no access, whatever the reason).
   */
  async exportWorkspace(workspaceId: string): Promise<ApiPortableExportDownload> {
    const response = await this.send(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/portable-export`
    )
    if (!response.ok) throw await this.failure(response)
    const text = await response.text()
    const named = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')
    return {
      bytes: new TextEncoder().encode(text).byteLength,
      fileName: named?.[1] ?? `workspace-${workspaceId}.portable.json`,
      text,
    }
  }

  /**
   * Restores a portable export, given as its file text, as a workspace the caller owns.
   * Refusals surface as `ApiClientError` with `code` `invalid_document`, `digest_mismatch`,
   * `unresolved_users`, `importer_unavailable`, `target_exists`, `too_large` or
   * `verification_failed`.
   */
  async importWorkspace(bundleText: string): Promise<ApiPortableImportResult> {
    return this.request<ApiPortableImportResult>('/v1/portable-imports', {
      body: bundleText,
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    })
  }

  async prepareWorkspaceDeletion(
    workspaceId: string,
    confirmation: Readonly<{ confirmationName: string; expectedVersion: number }>
  ): Promise<Readonly<{ workspaceId: string; cleanupPending: true }>> {
    return this.postJson(`/workspaces/${encodeURIComponent(workspaceId)}/delete`, {
      ...confirmation,
      phase: 'prepare',
    })
  }

  async deleteWorkspace(
    workspaceId: string,
    confirmation: Readonly<{ confirmationName: string; expectedVersion: number }>
  ): Promise<ApiWorkspaceDeleteResponse> {
    return this.postJson<ApiWorkspaceDeleteResponse>(
      `/workspaces/${encodeURIComponent(workspaceId)}/delete`,
      confirmation
    )
  }

  async getMarketplaceCatalog(workspaceId: string): Promise<ApiMarketplaceCatalogResponse> {
    // Streaming proxies forward the Control Plane envelope verbatim, so the
    // payload can arrive wrapped in `data` instead of unwrapped.
    const parsed: unknown = await this.request<unknown>('/marketplace/catalog', {
      body: JSON.stringify({ workspaceId }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    })
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'data' in parsed &&
      parsed.data !== undefined
    ) {
      return parsed.data as ApiMarketplaceCatalogResponse
    }
    return parsed as ApiMarketplaceCatalogResponse
  }

  async requestMarketplaceInstallPlan(
    workspaceId: string,
    input: ApiMarketplaceInstallPlanInput
  ): Promise<ApiMarketplaceInstallPlanResponse> {
    return this.request<ApiMarketplaceInstallPlanResponse>('/marketplace/install-plan', {
      body: JSON.stringify(input),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    })
  }

  async requestMarketplaceInstall(
    workspaceId: string,
    input: ApiMarketplaceInstallInput
  ): Promise<ApiMarketplaceInstallResponse> {
    return this.request<ApiMarketplaceInstallResponse>('/marketplace/install', {
      body: JSON.stringify(input),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    })
  }

  async getMarketplaceInstallation(
    workspaceId: string,
    installationId: string
  ): Promise<ApiMarketplaceInstallationResponse> {
    return this.request<ApiMarketplaceInstallationResponse>('/marketplace/installations/get', {
      body: JSON.stringify({ installationId, workspaceId }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    })
  }

  async uninstallMarketplaceInstallation(
    workspaceId: string,
    installationId: string
  ): Promise<ApiMarketplaceUninstallResponse> {
    return this.request<ApiMarketplaceUninstallResponse>('/marketplace/installations/uninstall', {
      body: JSON.stringify({ installationId, workspaceId }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    })
  }

  async claimTemporaryWorkspace(temporaryCredential: string): Promise<ApiWorkspaceClaimResponse> {
    return this.request<ApiWorkspaceClaimResponse>('/workspaces/claim', {
      headers: { 'X-Adea-Temporary-Session': temporaryCredential },
      method: 'POST',
    })
  }

  async listWorkspaceMembers(workspaceId: string): Promise<ApiWorkspaceMembersResponse> {
    return this.request<ApiWorkspaceMembersResponse>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/members`
    )
  }

  async listWorkspaceInvitations(workspaceId: string): Promise<ApiWorkspaceInvitationsResponse> {
    return this.request<ApiWorkspaceInvitationsResponse>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/invitations`
    )
  }

  async createWorkspaceInvitation(
    workspaceId: string,
    input: ApiWorkspaceInvitationCreateInput
  ): Promise<ApiWorkspaceInvitationCreateResponse> {
    return this.request<ApiWorkspaceInvitationCreateResponse>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/invitations`,
      {
        body: JSON.stringify(input),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }
    )
  }

  async revokeWorkspaceInvitation(
    workspaceId: string,
    invitationId: string
  ): Promise<ApiWorkspaceInvitationResponse> {
    return this.request<ApiWorkspaceInvitationResponse>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/invitations/${encodeURIComponent(invitationId)}/revoke`,
      { method: 'POST' }
    )
  }

  /** Display/proof projection of the workspace's registered execution hosts. */
  async listRuntimeNodes(
    workspaceId: string,
    signal?: AbortSignal
  ): Promise<ApiRuntimeNodesResponse> {
    const result = await this.request<ApiRuntimeNodesResponse>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/runtime-nodes`,
      { signal }
    )
    // Public keys and trust metadata from the identity API do not enter the inventory cache.
    return {
      nodes: result.nodes.map(
        ({
          id,
          controlPlaneRuntimeNodeRefId,
          kind,
          displayName,
          health,
          pairingState,
          lastProofAt,
          lastSeenAt,
          platform,
          softwareVersion,
        }) => ({
          id,
          controlPlaneRuntimeNodeRefId,
          kind,
          deviceOnline: runtimeNodeDeviceOnline(kind),
          hostReachability: runtimeNodeHostReachability(kind),
          displayName,
          health,
          pairingState,
          lastProofAt,
          lastSeenAt,
          platform,
          softwareVersion,
        })
      ),
    }
  }

  /**
   * Renames one registered execution host for this workspace. The name is a product
   * label: the host keeps its own identity and keys. The host list is re-read after a
   * rename, so this call carries no projection of its own.
   */
  async renameRuntimeNode(
    workspaceId: string,
    runtimeNodeId: string,
    displayName: string
  ): Promise<void> {
    await this.request<unknown>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/runtime-nodes/${encodeURIComponent(runtimeNodeId)}/rename`,
      { method: 'POST', body: JSON.stringify({ displayName }) }
    )
  }

  /** Normalized discovery for exactly one registered execution host (M11 #37). */
  async listRuntimeNodeConnections(
    workspaceId: string,
    runtimeNodeId: string,
    cursor?: string,
    signal?: AbortSignal
  ): Promise<ApiRuntimeNodeConnectionsResponse> {
    const query = cursor ? `?${new URLSearchParams({ cursor })}` : ''
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/runtime-nodes/${encodeURIComponent(runtimeNodeId)}/connections${query}`,
      { signal }
    )
  }

  /** Workspace Skills in the Control Plane catalog (ADR 0013). */
  async listWorkspaceSkills(workspaceId: string, cursor?: string): Promise<ApiCatalogListResponse> {
    return this.request(controlPlanePath(workspaceId, 'skills', cursor))
  }

  async listWorkspaceAgentProfiles(
    workspaceId: string,
    cursor?: string
  ): Promise<ApiCatalogListResponse> {
    return this.request(controlPlanePath(workspaceId, 'skills/profiles', cursor))
  }

  async publishWorkspaceSkill(
    workspaceId: string,
    input: ApiSkillPublishInput
  ): Promise<ApiSkillPublishResponse> {
    return this.postJson(controlPlanePath(workspaceId, 'skills'), input)
  }

  /** Deprecate or revoke a workspace-owned skill or agent profile. */
  async changeWorkspaceCatalogLifecycle(
    workspaceId: string,
    target: Readonly<{ kind: 'profile' | 'skill'; id: string; action: 'deprecate' | 'revoke' }>,
    input: ApiCatalogLifecycleInput
  ): Promise<ApiCatalogLifecycleResponse> {
    const collection = target.kind === 'profile' ? 'skills/profiles' : 'skills'
    return this.postJson(
      controlPlanePath(
        workspaceId,
        `${collection}/${encodeURIComponent(target.id)}/${target.action}`
      ),
      input
    )
  }

  /** Model metadata remains separate from connector credentials and execution admission. */
  createModelConnection(
    workspaceId: string,
    input: ApiModelConnectionCreateInput
  ): Promise<ApiModelConnectionResponse> {
    return createModelConnectionsAdapter((path, init) =>
      this.request(path, init)
    ).createModelConnection(workspaceId, input)
  }

  revokeModelConnection(
    workspaceId: string,
    input: ApiModelConnectionRevokeInput
  ): Promise<ApiModelConnectionResponse> {
    return createModelConnectionsAdapter((path, init) =>
      this.request(path, init)
    ).revokeModelConnection(workspaceId, input)
  }

  listModelConnections(workspaceId: string): Promise<ApiModelConnectionsResponse> {
    return createModelConnectionsAdapter((path, init) =>
      this.request(path, init)
    ).listModelConnections(workspaceId)
  }

  getWorkspaceModelDefaults(workspaceId: string): Promise<ApiModelDefaultsResponse> {
    return createModelConnectionsAdapter((path, init) =>
      this.request(path, init)
    ).getWorkspaceModelDefaults(workspaceId)
  }

  setWorkspaceModelDefaults(
    workspaceId: string,
    input: ApiModelDefaultsSetInput
  ): Promise<ApiModelDefaultsResponse> {
    return createModelConnectionsAdapter((path, init) =>
      this.request(path, init)
    ).setWorkspaceModelDefaults(workspaceId, input)
  }

  resolveWorkspaceModelSelection(
    workspaceId: string,
    input: ApiModelSelectionResolveInput
  ): Promise<ApiModelSelectionResponse> {
    return createModelConnectionsAdapter((path, init) =>
      this.request(path, init)
    ).resolveWorkspaceModelSelection(workspaceId, input)
  }

  getModelSelectionFunding(
    workspaceId: string,
    input: ApiModelFundingBinding
  ): Promise<ApiModelFundingResponse> {
    return createModelConnectionsAdapter((path, init) =>
      this.request(path, init)
    ).getModelSelectionFunding(workspaceId, input)
  }

  /** Cloud connection metadata (ADR 0013); never secret material. */
  async listCloudConnections(
    workspaceId: string,
    cursor?: string
  ): Promise<ApiCloudConnectionsResponse> {
    return this.request(controlPlanePath(workspaceId, 'cloud-connections', cursor))
  }

  /** The secret travels in the body only, once; the response never carries it. */
  async createCloudConnection(
    workspaceId: string,
    input: ApiCloudConnectionCreateInput
  ): Promise<ApiCloudConnectionResponse> {
    return this.postJson(controlPlanePath(workspaceId, 'cloud-connections'), input)
  }

  /** The new secret travels in the body only, once; the response never carries it. */
  async rotateCloudConnection(
    workspaceId: string,
    credentialId: string,
    input: ApiCloudConnectionRotateInput
  ): Promise<ApiCloudConnectionResponse> {
    return this.postJson(
      controlPlanePath(workspaceId, `cloud-connections/${encodeURIComponent(credentialId)}/rotate`),
      input
    )
  }

  async revokeCloudConnection(
    workspaceId: string,
    credentialId: string,
    input: Readonly<{ idempotencyKey: string }>
  ): Promise<ApiCloudConnectionResponse> {
    return this.postJson(
      controlPlanePath(workspaceId, `cloud-connections/${encodeURIComponent(credentialId)}/revoke`),
      input
    )
  }

  /** Read what an invitation grants without accepting it; the token travels in the body only. */
  async previewWorkspaceInvitation(token: string): Promise<ApiWorkspaceInvitationPreviewResponse> {
    return this.request<ApiWorkspaceInvitationPreviewResponse>('/workspace-invitations/preview', {
      body: JSON.stringify({ token }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    })
  }

  /** Accept an invitation as the signed-in account; the token travels in the body only. */
  async acceptWorkspaceInvitation(token: string): Promise<ApiWorkspaceInvitationAcceptResponse> {
    return this.request<ApiWorkspaceInvitationAcceptResponse>('/workspace-invitations/accept', {
      body: JSON.stringify({ token }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    })
  }

  async setProjectVisibility(
    workspaceId: string,
    projectId: string,
    visibility: ProjectVisibility
  ): Promise<ApiProjectResponse> {
    return this.request<ApiProjectResponse>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/visibility`,
      {
        body: JSON.stringify({ visibility }),
        headers: { 'Content-Type': 'application/json' },
        method: 'PATCH',
      }
    )
  }

  async listProjectMembers(
    workspaceId: string,
    projectId: string
  ): Promise<ApiProjectMembersResponse> {
    return this.request<ApiProjectMembersResponse>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/members`
    )
  }

  async setProjectMember(
    workspaceId: string,
    projectId: string,
    userId: string,
    role: ProjectMemberRole
  ): Promise<ApiProjectMemberResponse> {
    return this.request<ApiProjectMemberResponse>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`,
      {
        body: JSON.stringify({ role }),
        headers: { 'Content-Type': 'application/json' },
        method: 'PUT',
      }
    )
  }

  async removeProjectMember(
    workspaceId: string,
    projectId: string,
    userId: string
  ): Promise<ApiProjectMemberRemoveResponse> {
    return this.request<ApiProjectMemberRemoveResponse>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`,
      { method: 'DELETE' }
    )
  }

  async listProjects(workspaceId: string): Promise<readonly ProjectSummary[]> {
    return this.request<readonly ProjectSummary[]>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/projects`
    )
  }

  /**
   * The archived projects this caller may read, for the explicit restore flow. The server lists
   * archived rows beside active ones on request; only the archived ones are returned here.
   */
  async listArchivedProjects(workspaceId: string): Promise<readonly ProjectSummary[]> {
    const projects = await this.request<readonly ProjectSummary[]>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/projects?includeArchived=true`
    )
    return projects.filter((project) => project.lifecycleState === 'archived')
  }

  async getProject(workspaceId: string, projectId: string): Promise<ApiProjectResponse> {
    return this.request<ApiProjectResponse>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}`
    )
  }

  async createProject(
    workspaceId: string,
    input: ApiProjectCreateInput
  ): Promise<ApiProjectResponse> {
    return this.request<ApiProjectResponse>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/projects`,
      {
        body: JSON.stringify(input),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }
    )
  }

  async updateProject(
    workspaceId: string,
    projectId: string,
    input: ApiProjectUpdateInput
  ): Promise<ApiProjectResponse> {
    return this.request<ApiProjectResponse>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}`,
      {
        body: JSON.stringify(input),
        headers: { 'Content-Type': 'application/json' },
        method: 'PATCH',
      }
    )
  }

  async archiveProject(workspaceId: string, projectId: string): Promise<ApiProjectArchiveResponse> {
    return this.request<ApiProjectArchiveResponse>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}`,
      { method: 'DELETE' }
    )
  }

  /** Explicitly promote an archived project back to active at the observed revision. */
  async restoreProject(
    workspaceId: string,
    projectId: string,
    input: ApiProjectRestoreInput
  ): Promise<ApiProjectResponse> {
    return this.postJson<ApiProjectResponse>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/restore`,
      input
    )
  }

  /** Soft-delete a project: it leaves every listing and its id cannot be reused. */
  async deleteProject(workspaceId: string, projectId: string): Promise<ApiProjectDeleteResponse> {
    return this.request<ApiProjectDeleteResponse>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/delete`,
      { method: 'POST' }
    )
  }

  async reorderProjects(
    workspaceId: string,
    projectIds: readonly string[]
  ): Promise<readonly ProjectSummary[]> {
    return this.request<readonly ProjectSummary[]>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/projects/reorder`,
      {
        body: JSON.stringify({ projectIds }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }
    )
  }

  async listAgents(workspaceId: string): Promise<readonly AgentSummary[]> {
    return this.request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/agents`)
  }

  async getWorkspaceLead(workspaceId: string): Promise<ApiWorkspaceLeadResponse> {
    return this.request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/agents/lead`)
  }

  async ensureWorkspaceLead(workspaceId: string): Promise<ApiWorkspaceLeadResponse> {
    return this.request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/agents/lead`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
  }

  async getAgent(workspaceId: string, agentId: string): Promise<ApiAgentResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}`
    )
  }

  async createAgent(workspaceId: string, input: ApiAgentCreateInput): Promise<ApiAgentResponse> {
    return this.request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/agents`, {
      body: JSON.stringify(input),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    })
  }

  async assignAgentToProject(
    workspaceId: string,
    agentId: string,
    input: ApiAgentProjectInput
  ): Promise<ApiAgentResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}/project`,
      {
        body: JSON.stringify({
          expectedRevision: input.expectedRevision,
          projectId: input.projectId,
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }
    )
  }

  async updateAgentPresentation(
    workspaceId: string,
    agentId: string,
    input: ApiAgentPresentationInput
  ): Promise<ApiAgentResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}/presentation`,
      {
        body: JSON.stringify(input),
        headers: { 'Content-Type': 'application/json' },
        method: 'PATCH',
      }
    )
  }

  async changeAgentProfile(
    workspaceId: string,
    agentId: string,
    input: ApiAgentProfileInput
  ): Promise<ApiAgentResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}/profile`,
      {
        body: JSON.stringify(input),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }
    )
  }

  async archiveAgent(workspaceId: string, agentId: string): Promise<Readonly<{ archived: true }>> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}`,
      { method: 'DELETE' }
    )
  }

  async listTasks(workspaceId: string): Promise<readonly TaskSummary[]> {
    return this.request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/tasks`)
  }

  async createContentRef(
    workspaceId: string,
    input: ApiContentRefCreateInput
  ): Promise<ApiContentRefResponse> {
    return this.request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/content-refs`, {
      body: JSON.stringify(input),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    })
  }

  async getContentRef(workspaceId: string, contentId: string): Promise<ApiContentRefResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/content-refs/${encodeURIComponent(contentId)}`
    )
  }

  async updateContentRef(
    workspaceId: string,
    contentId: string,
    input: ApiContentRefUpdateInput
  ): Promise<ApiContentRefResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/content-refs/${encodeURIComponent(contentId)}`,
      {
        body: JSON.stringify(input),
        headers: { 'Content-Type': 'application/json' },
        method: 'PATCH',
      }
    )
  }

  async listContentReplicas(
    workspaceId: string,
    contentId: string
  ): Promise<ApiContentReplicaListResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/content-refs/${encodeURIComponent(contentId)}/replicas`
    )
  }

  async upsertContentReplica(
    workspaceId: string,
    contentId: string,
    input: ApiContentReplicaUpsertInput
  ): Promise<ApiContentReplicaUpsertResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/content-refs/${encodeURIComponent(contentId)}/replicas`,
      {
        body: JSON.stringify(input),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }
    )
  }

  /** Unread channel and mention counts for every workspace the caller belongs to. */
  async accountSummary(): Promise<ApiAccountSummaryResponse> {
    return this.request<ApiAccountSummaryResponse>('/v1/account/summary')
  }

  async getReadState(workspaceId: string): Promise<ApiReadStateResponse> {
    return this.request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/read-state`)
  }

  async markAllRead(workspaceId: string): Promise<ApiReadStateResponse> {
    return this.request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/read-state`, {
      body: JSON.stringify({ action: 'read_all' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    })
  }

  async setChannelReadState(
    workspaceId: string,
    channelId: string,
    input: Readonly<{ action: 'read' | 'unread'; lastReadSequence?: number }>
  ): Promise<ApiReadStateResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/read-state/channels/${encodeURIComponent(channelId)}`,
      {
        body: JSON.stringify(input),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }
    )
  }

  async setThreadReadState(
    workspaceId: string,
    channelId: string,
    threadRootMessageId: string,
    input: Readonly<{ action: 'read' | 'unread'; lastReadSequence?: number }>
  ): Promise<ApiReadStateResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/read-state/threads/${encodeURIComponent(threadRootMessageId)}`,
      {
        body: JSON.stringify({ ...input, channelId }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }
    )
  }

  async searchWorkspace(
    workspaceId: string,
    query: string,
    options: Readonly<{
      channelId?: string
      limit?: number
      offset?: number
      signal?: AbortSignal
    }> = {}
  ): Promise<WorkspaceSearchPage> {
    const parameters = new URLSearchParams({ q: query })
    if (options.channelId) parameters.set('channelId', options.channelId)
    // Clamped to the bounds the route accepts, rather than forwarded and 400'd.
    parameters.set('limit', String(boundedInt(options.limit, 1, 50, 30)))
    parameters.set('offset', String(boundedInt(options.offset, 0, 5_000, 0)))
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/search?${parameters.toString()}`,
      options.signal ? { signal: options.signal } : {}
    )
  }

  async getTask(workspaceId: string, taskId: string): Promise<ApiTaskResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/tasks/${encodeURIComponent(taskId)}`
    )
  }

  async createTask(
    workspaceId: string,
    input: ApiTaskCreateInput,
    command: ApiTaskCommand
  ): Promise<ApiTaskResponse> {
    return this.taskCommand(workspaceId, undefined, undefined, input, command)
  }

  async updateTask(
    workspaceId: string,
    taskId: string,
    input: ApiTaskUpdateInput,
    command: ApiTaskCommand
  ): Promise<ApiTaskResponse> {
    return this.taskCommand(workspaceId, taskId, undefined, input, command, 'PATCH')
  }

  async assignTask(
    workspaceId: string,
    taskId: string,
    agentId: string | null,
    command: ApiTaskCommand
  ): Promise<ApiTaskResponse> {
    return this.taskCommand(workspaceId, taskId, 'assign', { agentId }, command)
  }

  async moveTaskToProject(
    workspaceId: string,
    taskId: string,
    projectId: string | null,
    command: ApiTaskCommand
  ): Promise<ApiTaskResponse> {
    return this.taskCommand(workspaceId, taskId, 'project', { projectId }, command)
  }

  async queueTask(workspaceId: string, taskId: string, command: ApiTaskCommand) {
    return this.taskCommand(workspaceId, taskId, 'queue', {}, command)
  }

  async startTask(workspaceId: string, taskId: string, command: ApiTaskCommand) {
    return this.taskCommand(workspaceId, taskId, 'start', {}, command)
  }

  async reviewTask(workspaceId: string, taskId: string, command: ApiTaskCommand) {
    return this.taskCommand(workspaceId, taskId, 'review', {}, command)
  }

  async completeTask(
    workspaceId: string,
    taskId: string,
    command: ApiTaskCommand,
    outboundResult?: ApiJobOutboundResult
  ) {
    return this.taskCommand(
      workspaceId,
      taskId,
      'complete',
      outboundResult ? { outboundResult } : {},
      command
    )
  }

  async cancelTask(workspaceId: string, taskId: string, command: ApiTaskCommand) {
    return this.taskCommand(workspaceId, taskId, 'cancel', {}, command)
  }

  async archiveTask(workspaceId: string, taskId: string, command: ApiTaskCommand) {
    return this.taskCommand(workspaceId, taskId, 'archive', {}, command)
  }

  async listArtifacts(workspaceId: string): Promise<readonly ArtifactSummary[]> {
    return this.request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/artifacts`)
  }

  async getArtifact(workspaceId: string, artifactId: string): Promise<ApiArtifactResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/artifacts/${encodeURIComponent(artifactId)}`
    )
  }

  async createArtifact(
    workspaceId: string,
    input: ApiArtifactCreateInput
  ): Promise<ApiArtifactResponse> {
    return this.request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/artifacts`, {
      body: JSON.stringify(input),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    })
  }

  async setArtifactAvailability(
    workspaceId: string,
    artifactId: string,
    availability: ArtifactSummary['availability'],
    expectedVersion: number
  ): Promise<ApiArtifactResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/artifacts/${encodeURIComponent(artifactId)}`,
      {
        body: JSON.stringify({ availability }),
        headers: { 'Content-Type': 'application/json', 'If-Match': String(expectedVersion) },
        method: 'PATCH',
      }
    )
  }

  async deleteArtifact(
    workspaceId: string,
    artifactId: string,
    expectedVersion: number
  ): Promise<ApiArtifactResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/artifacts/${encodeURIComponent(artifactId)}`,
      { headers: { 'If-Match': String(expectedVersion) }, method: 'DELETE' }
    )
  }

  async listChannels(workspaceId: string): Promise<readonly ChannelSummary[]> {
    return this.request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/channels`)
  }

  async getChannel(workspaceId: string, channelId: string): Promise<ApiChannelResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}`
    )
  }

  async createProjectChannel(
    workspaceId: string,
    input: Readonly<{ idempotencyKey: string; projectId: string; taskId?: string; title: string }>
  ): Promise<ApiChannelResponse> {
    return this.createChannel(workspaceId, { ...input, kind: 'project' })
  }

  async createDirectAgentChannel(
    workspaceId: string,
    agentId: string
  ): Promise<ApiChannelResponse> {
    return this.createChannel(workspaceId, {
      agentId,
      idempotencyKey: `direct-agent:${agentId}`,
      kind: 'direct_agent',
      title: 'Direct conversation',
    })
  }

  async createGroupChannel(
    workspaceId: string,
    input: Readonly<{
      channelId?: string
      idempotencyKey: string
      /** Who else is in the group, by qualified identity. The server issues every grant. */
      selection?: ApiGroupSelection
      title: string
    }>
  ): Promise<ApiChannelResponse> {
    return this.createChannel(workspaceId, { ...input, kind: 'group' })
  }

  async createDirectAgentTopic(
    workspaceId: string,
    input: Readonly<{ agentId: string; idempotencyKey: string; title: string }>
  ): Promise<ApiChannelResponse> {
    return this.createChannel(workspaceId, { ...input, kind: 'direct_agent', mode: 'new_topic' })
  }

  async updateChannel(
    workspaceId: string,
    channelId: string,
    input: Readonly<{
      taskId?: string | null
      title?: string
      visibility?: 'workspace' | 'participants'
    }>,
    expectedVersion: number
  ): Promise<ApiChannelResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}`,
      {
        body: JSON.stringify(input),
        headers: { 'Content-Type': 'application/json', 'If-Match': String(expectedVersion) },
        method: 'PATCH',
      }
    )
  }

  async setChannelParticipants(
    workspaceId: string,
    channelId: string,
    participants: readonly ConversationParticipantRef[],
    expectedVersion: number
  ): Promise<ApiChannelResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}/participants`,
      {
        body: JSON.stringify({ participants }),
        headers: { 'Content-Type': 'application/json', 'If-Match': String(expectedVersion) },
        method: 'POST',
      }
    )
  }

  /**
   * Replace a group's whole roster from a selection of qualified identities.
   * The server issues the grants and proves each member's standing; the
   * client never sends a grant, and a group refuses unqualified participants.
   */
  async setGroupSelection(
    workspaceId: string,
    channelId: string,
    selection: ApiGroupSelection,
    expectedVersion: number
  ): Promise<ApiChannelResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}/participants`,
      {
        body: JSON.stringify({ selection }),
        headers: { 'Content-Type': 'application/json', 'If-Match': String(expectedVersion) },
        method: 'POST',
      }
    )
  }

  async archiveChannel(
    workspaceId: string,
    channelId: string,
    expectedVersion: number
  ): Promise<ApiChannelResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}`,
      { headers: { 'If-Match': String(expectedVersion) }, method: 'DELETE' }
    )
  }

  async listMessages(
    workspaceId: string,
    channelId: string,
    options: Readonly<{
      afterSequence?: number
      limit?: number
      threadRootMessageId?: string
    }> = {}
  ): Promise<ApiMessagePage> {
    const query = new URLSearchParams()
    if (options.afterSequence !== undefined)
      query.set('afterSequence', String(options.afterSequence))
    query.set('limit', String(boundedInt(options.limit, 1, 100, 50)))
    if (options.threadRootMessageId) query.set('threadRootMessageId', options.threadRootMessageId)
    const suffix = query.size ? `?${query}` : ''
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}/messages${suffix}`
    )
  }

  async createMessage(
    workspaceId: string,
    channelId: string,
    input: ApiMessageCreateInput
  ): Promise<ApiMessageResponse> {
    const { idempotencyKey, ...body } = input
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}/messages`,
      {
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        method: 'POST',
      }
    )
  }

  /** Address an Agent from a human message. Safe to repeat: the same request converges on one turn. */
  async addressTurn(
    workspaceId: string,
    channelId: string,
    input: ApiAddressedTurnInput
  ): Promise<ApiAddressedTurnResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}/turns`,
      {
        body: JSON.stringify(input),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }
    )
  }

  /** Reconnect and replay read: the channel's turns in committed order. */
  async listAddressedTurns(
    workspaceId: string,
    channelId: string,
    options: Readonly<{ after?: string; limit?: number }> = {}
  ): Promise<ApiAddressedTurnPage> {
    const query = new URLSearchParams()
    if (options.after) query.set('after', options.after)
    if (options.limit !== undefined)
      query.set('limit', String(boundedInt(options.limit, 1, 200, 100)))
    const suffix = query.size ? `?${query}` : ''
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}/turns${suffix}`
    )
  }

  async cancelAddressedTurn(
    workspaceId: string,
    channelId: string,
    turnId: string
  ): Promise<ApiAddressedTurnCancelResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}/turns/${encodeURIComponent(turnId)}/cancel`,
      { body: '{}', headers: { 'Content-Type': 'application/json' }, method: 'POST' }
    )
  }

  async dispatchLeadTurn(workspaceId: string, intentId: string): Promise<ApiLeadTurnResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/lead-turns/${encodeURIComponent(intentId)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }
    )
  }

  async prepareLeadTurn(workspaceId: string, intentId: string): Promise<ApiLeadTurnResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/lead-turns/${encodeURIComponent(intentId)}/prepare`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }
    )
  }

  async getChannelLeadTurn(
    workspaceId: string,
    channelId: string,
    targetSessionId?: string
  ): Promise<ApiChannelLeadTurnResponse> {
    const query =
      targetSessionId === undefined ? '' : `?targetSessionId=${encodeURIComponent(targetSessionId)}`
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}/lead-turn${query}`
    )
  }

  async getLeadTurnStatus(workspaceId: string, intentId: string): Promise<ApiLeadTurnResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/lead-turns/${encodeURIComponent(intentId)}`
    )
  }

  async getLeadTurnProgress(
    workspaceId: string,
    intentId: string,
    afterSequence = 0
  ): Promise<ApiLeadTurnProgressResponse> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0)
      throw new Error('Invalid lead progress cursor')
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/lead-turns/${encodeURIComponent(intentId)}/progress?afterSequence=${afterSequence}`
    )
  }

  async getLeadTurnChildren(
    workspaceId: string,
    intentId: string,
    page: ApiLeadTurnChildrenQuery = {}
  ): Promise<ApiLeadTurnChildrenResponse> {
    const query = new URLSearchParams()
    if (page.limit !== undefined) query.set('limit', String(page.limit))
    if (page.after) {
      query.set('afterAcceptedAt', page.after.acceptedAt)
      query.set('afterDelegationId', page.after.delegationId)
    }
    const suffix = query.size ? `?${query}` : ''
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/lead-turns/${encodeURIComponent(intentId)}/children${suffix}`
    )
  }

  async cancelLeadTurn(workspaceId: string, intentId: string): Promise<ApiLeadTurnResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/lead-turns/${encodeURIComponent(intentId)}/cancel`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }
    )
  }

  async getMessage(workspaceId: string, messageId: string): Promise<ApiMessageResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/messages/${encodeURIComponent(messageId)}`
    )
  }

  async editMessage(
    workspaceId: string,
    messageId: string,
    input: Readonly<{ bodyContentRefId?: string | null; bodyText?: string | null }>,
    expectedVersion: number
  ): Promise<ApiMessageResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/messages/${encodeURIComponent(messageId)}`,
      {
        body: JSON.stringify(input),
        headers: { 'Content-Type': 'application/json', 'If-Match': String(expectedVersion) },
        method: 'PATCH',
      }
    )
  }

  async deleteMessage(
    workspaceId: string,
    messageId: string,
    expectedVersion: number
  ): Promise<ApiMessageResponse> {
    return this.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/messages/${encodeURIComponent(messageId)}`,
      { headers: { 'If-Match': String(expectedVersion) }, method: 'DELETE' }
    )
  }

  private async createChannel(
    workspaceId: string,
    input: Readonly<{
      agentId?: string
      channelId?: string
      idempotencyKey: string
      kind: 'project' | 'direct_agent' | 'group'
      mode?: 'new_topic'
      projectId?: string
      selection?: ApiGroupSelection
      taskId?: string
      title: string
    }>
  ): Promise<ApiChannelResponse> {
    const { idempotencyKey, ...body } = input
    return this.request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/channels`, {
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      method: 'POST',
    })
  }

  async setTaskDependencies(
    workspaceId: string,
    taskId: string,
    dependencyIds: readonly string[],
    command: ApiTaskCommand
  ) {
    return this.taskCommand(workspaceId, taskId, 'dependencies', { dependencyIds }, command)
  }

  async setTaskArtifactReferences(
    workspaceId: string,
    taskId: string,
    artifactRefs: readonly string[],
    command: ApiTaskCommand
  ) {
    return this.taskCommand(workspaceId, taskId, 'artifacts', { artifactRefs }, command)
  }

  async setTaskConversationReferences(
    workspaceId: string,
    taskId: string,
    conversation: Readonly<{
      channelId?: string | null
      messageId?: string | null
      threadRootMessageId?: string | null
    }>,
    command: ApiTaskCommand
  ) {
    return this.taskCommand(workspaceId, taskId, 'conversation', conversation, command)
  }

  private async taskCommand(
    workspaceId: string,
    taskId: string | undefined,
    action: string | undefined,
    payload: unknown,
    command: ApiTaskCommand,
    method = 'POST'
  ): Promise<ApiTaskResponse> {
    const path = [
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/tasks`,
      taskId ? encodeURIComponent(taskId) : undefined,
      action,
    ]
      .filter(Boolean)
      .join('/')
    return this.request(path, {
      body: JSON.stringify(payload),
      headers: taskCommandHeaders(command),
      method,
    })
  }

  /** Durable workspace event stream URL for one workspace. */
  workspaceEventStreamUrl(workspaceId: string): string {
    return `${this.baseUrl}/v1/workspaces/${workspaceId}/events`
  }

  /**
   * Auth headers for a streaming request. SSE over `fetch` cannot rely on the
   * client's own request path, so the event stream asks the client for the same
   * identity its REST calls use instead of rebuilding it per application.
   */
  eventStreamHeaders(): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'text/event-stream' }
    if (this.client === 'desktop') headers['X-Adea-Client'] = 'desktop'
    const desktopSession = this.getDesktopSession?.()
    const accessToken = this.getAccessToken?.()
    const temporaryCredential = this.getTemporaryCredential?.()
    if (desktopSession) {
      headers.Authorization = `Desktop ${desktopSession.credential}`
      headers['X-Adea-Desktop-Session'] = desktopSession.sessionId
    } else if (accessToken) headers.Authorization = `Bearer ${accessToken}`
    else if (temporaryCredential) headers.Authorization = `Temporary ${temporaryCredential}`
    return headers
  }

  private postJson<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    })
  }

  /** Sends one authenticated request and returns the raw response, whatever its status. */
  private async send(path: string, init: RequestInit = {}, accept = 'application/json') {
    const headers = new Headers(init.headers)
    headers.set('Accept', accept)
    if (this.client === 'desktop') headers.set('X-Adea-Client', 'desktop')
    const desktopSession = this.getDesktopSession?.()
    const token = this.getAccessToken?.()
    const temporaryCredential = this.getTemporaryCredential?.()
    if (desktopSession) {
      headers.set('Authorization', `Desktop ${desktopSession.credential}`)
      headers.set('X-Adea-Desktop-Session', desktopSession.sessionId)
    } else if (token) headers.set('Authorization', `Bearer ${token}`)
    else if (temporaryCredential) headers.set('Authorization', `Temporary ${temporaryCredential}`)

    const requestUrl = /^https?:\/\//i.test(this.baseUrl)
      ? new URL(path.replace(/^\//, ''), `${this.baseUrl.replace(/\/$/, '')}/`).toString()
      : `${this.baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`
    return this.fetchImpl(requestUrl, {
      ...init,
      credentials: init.credentials ?? (this.client === 'desktop' ? 'omit' : 'include'),
      headers,
    })
  }

  /**
   * Reads a failure body into an `ApiClientError`. The portable routes name the failure in
   * `error`; every other route names it in `code`.
   */
  private async failure(response: Response): Promise<ApiClientError> {
    let code: string | undefined
    let message: string | undefined
    let reason: string | undefined
    let rejections: readonly ApiGroupGrantRejection[] | undefined
    try {
      const payload = (await response.json()) as {
        code?: string
        error?: string
        message?: string
        reason?: unknown
        rejections?: unknown
      }
      code = payload.code ?? payload.error
      message = payload.message
      reason = typeof payload.reason === 'string' ? payload.reason : undefined
      if (code === 'group_grant_rejected') rejections = groupGrantRejections(payload.rejections)
    } catch {
      // A non-JSON failure body keeps the status text.
    }
    return new ApiClientError(
      message ?? response.statusText,
      response.status,
      code,
      reason,
      rejections
    )
  }

  protected async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.send(path, init)
    if (!response.ok) throw await this.failure(response)
    return (await response.json()) as T
  }
}

function controlPlanePath(workspaceId: string, path: string, cursor?: string) {
  return `/workspaces/${encodeURIComponent(workspaceId)}/${path}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`
}

export function createApiClient(options?: ApiClientOptions): AgentHqApiClient {
  return new AgentHqApiClient(options)
}
