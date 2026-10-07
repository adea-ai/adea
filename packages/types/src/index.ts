import type { TaskExecutionLocation } from './task-execution'

export * from './desktop-permissions'
export * from './execution-location'

export type WorkspaceSceneId = 'home' | 'work'

export type WorkspaceViewMode = 'perspective' | 'orthographic'

/**
 * The workspace sidebar's groupings of the active workspace (ADR 0011), in
 * menu order. The one source for the shared nav's `NavGroupMode`, the
 * workspace store's `SidebarGroupBy` and the persisted-state validator.
 */
export const sidebarGroupModes = ['project', 'status', 'recent'] as const

export type SidebarGroupMode = (typeof sidebarGroupModes)[number]

export function isSidebarGroupMode(value: unknown): value is SidebarGroupMode {
  return typeof value === 'string' && (sidebarGroupModes as readonly string[]).includes(value)
}

export const workspacePermissions = [
  'workspace.create',
  'workspace.read',
  'workspace.update',
  'workspace.archive',
  'workspace.events.read',
  'membership.read',
  'membership.manage',
  'runtime.invoke',
  'billing.manage',
] as const

export type WorkspacePermission = (typeof workspacePermissions)[number]

export type AgentLifecycleState = 'active' | 'archived' | 'configuration_error'
export type AgentProfileState = 'available' | 'deprecated' | 'missing'

export type UserPrincipalRef = Readonly<{ kind: 'user'; userId: string }>
export type ServicePrincipalRef = Readonly<{ kind: 'service'; serviceId: string }>
export type RuntimeNodePrincipalRef = Readonly<{
  kind: 'runtime_node'
  runtimeNodeId: string
}>
export type AgentPrincipalRef = Readonly<{ agentId: string; kind: 'agent' }>
export type WorkerPrincipalRef = Readonly<{ kind: 'worker'; workerId: string }>
export type SystemPrincipalRef = Readonly<{ kind: 'system'; systemId: string }>

export type PrincipalRef =
  | UserPrincipalRef
  | ServicePrincipalRef
  | RuntimeNodePrincipalRef
  | AgentPrincipalRef
  | WorkerPrincipalRef
  | SystemPrincipalRef

export function isPrincipalRef(value: unknown): value is PrincipalRef {
  if (!value || typeof value !== 'object' || !('kind' in value)) return false
  const candidate = value as Record<string, unknown>
  if (Object.keys(candidate).length !== 2) return false
  const hasId = (key: string) =>
    typeof candidate[key] === 'string' && candidate[key].trim().length > 0

  switch (candidate.kind) {
    case 'user':
      return hasId('userId')
    case 'service':
      return hasId('serviceId')
    case 'runtime_node':
      return hasId('runtimeNodeId')
    case 'agent':
      return hasId('agentId')
    case 'worker':
      return hasId('workerId')
    case 'system':
      return hasId('systemId')
    default:
      return false
  }
}

export function isUserPrincipalRef(principal: PrincipalRef): principal is UserPrincipalRef {
  return principal.kind === 'user'
}

export type AgentSummary = {
  avatarRef?: string
  characterRef?: string
  createdAt: string
  id: string
  lifecycleState: AgentLifecycleState
  name: string
  presentationMetadata: Readonly<Record<string, string>>
  profile: Readonly<{ id: string; state: AgentProfileState; version: string; revision?: number }>
  roleSummary?: string
  projectId?: string
  updatedAt: string
  workspaceId: string
}

/** The theme-provided accents a workspace may choose; `null` keeps the theme default. */
export const workspaceAccentIds = ['violet', 'blue', 'green', 'amber', 'cyan', 'pink'] as const
export type WorkspaceAccentId = (typeof workspaceAccentIds)[number]

/** A workspace mark: initials derived from the name, or one emoji grapheme. */
export type WorkspaceLogo =
  | Readonly<{ kind: 'monogram' }>
  | Readonly<{ kind: 'emoji'; value: string }>

export type WorkspaceSummary = {
  accent: WorkspaceAccentId | null
  id: string
  logo: WorkspaceLogo
  name: string
  scene: WorkspaceSceneId
  /** The caller's own order for their workspaces; lower sorts first. */
  sortOrder: number
  updatedAt: string
  version: number
}

/** Fields a workspace update may change; at least one is required. */
export type WorkspaceUpdate = Readonly<{
  accent?: WorkspaceAccentId | null
  logo?: WorkspaceLogo
  name?: string
  scene?: WorkspaceSceneId
}>

export type ProjectLifecycleState = 'active' | 'archived'

/**
 * Whether a project is backed by a repository. Only this boolean-level fact
 * leaves the device; repository paths, remotes and branches never do.
 */
export type ProjectSourceKind = 'none' | 'repository'

/**
 * Who can see a project (ADR 0012): every workspace member, or only its listed
 * project members plus the workspace's owners and admins.
 */
export type ProjectVisibility = 'workspace' | 'members'

/** A project member's role in a members-only project: read-only or read-write. */
export type ProjectMemberRole = 'viewer' | 'editor'

export type ProjectSummary = Readonly<{
  createdAt: string
  iconKey: string
  id: string
  lifecycleState: ProjectLifecycleState
  name: string
  sortOrder: number
  sourceKind: ProjectSourceKind
  updatedAt: string
  visibility: ProjectVisibility
  workspaceId: string
}>

export type ProjectMemberSummary = Readonly<{
  createdAt: string
  displayName: string | null
  projectId: string
  role: ProjectMemberRole
  updatedAt: string
  userId: string
}>

export type WorkspaceMemberRole = 'owner' | 'admin' | 'member'

/** A workspace member as other members see them: no email, no credentials. */
export type WorkspaceMemberSummary = Readonly<{
  displayName: string | null
  role: WorkspaceMemberRole
  userId: string
}>

export type WorkspaceInvitationRole = 'admin' | 'member'
export type WorkspaceInvitationState = 'pending' | 'accepted' | 'revoked' | 'expired'

/** An invitation as its workspace's managers list it. The token is never included. */
export type WorkspaceInvitationSummary = Readonly<{
  acceptedAt?: string
  createdAt: string
  email: string
  expiresAt: string
  id: string
  invitedByUserId: string
  revokedAt?: string
  role: WorkspaceInvitationRole
  state: WorkspaceInvitationState
  workspaceId: string
}>

export type TaskLifecycleState =
  | 'created'
  | 'queued'
  | 'in_progress'
  | 'in_review'
  | 'completed'
  | 'cancelled'
  | 'archived'
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent'
export type TaskKind = 'bug' | 'feature' | 'chore'

export type ContentRefSummary = Readonly<{
  availability: 'available' | 'offline' | 'missing' | 'deleted'
  contentType: 'message_body' | 'task_objective' | 'task_input' | 'private_field'
  createdAt: string
  deletedAt?: string
  digestSha256: string
  id: string
  keyVersion: number
  messageId?: string
  revision: number
  schemaVersion: number
  sensitivity: 'sensitive' | 'restricted'
  storagePolicy: 'local_authority'
  synchronizationPolicy: 'local_only' | 'e2e_optional' | 'agent_hq_e2ee_sync'
  taskId?: string
  updatedAt: string
  workspaceId: string
}>

/** Physical encrypted storage attached to one logical ContentRef revision. */
export type ContentReplicaSummary = Readonly<{
  availability: 'available' | 'offline' | 'missing' | 'deleted'
  ciphertext: string
  contentRefId: string
  createdAt: string
  deletedAt?: string
  digestSha256: string
  id: string
  keyEpochId?: string
  nonce: string
  replicaKind: 'local_authority' | 'self_hosted_authority' | 'agent_hq_e2ee_sync'
  revision: number
  schemaVersion: number
  updatedAt: string
  workspaceId: string
}>

export {
  executionAttemptChanges,
  type ExecutionAttemptChange,
  type ExecutionAttemptSummary,
  type TaskExecutionLocation,
} from './task-execution'

export type TaskSummary = Readonly<{
  agentId?: string
  artifactRefs: readonly string[]
  controlPlaneExecutionRef?: string
  controlPlaneWorkflowRef?: string
  /** Where the work actually ran, per attempt (#671). Absent until a task has a
   *  recorded execution, so absence means "has not run" rather than "ran
   *  nowhere". */
  execution?: TaskExecutionLocation
  conversation: Readonly<{
    channelId?: string
    messageId?: string
    threadRootMessageId?: string
  }>
  createdAt: string
  creator: UserPrincipalRef
  dependencyIds: readonly string[]
  id: string
  kind: TaskKind
  lifecycleState: TaskLifecycleState
  objective?: string
  objectiveContentRefId?: string
  priority: TaskPriority
  projectId?: string
  title: string
  updatedAt: string
  version: number
  workspaceId: string
}>

export type ConversationParticipantRef = UserPrincipalRef | AgentPrincipalRef
export type MessageSenderRef = ConversationParticipantRef | SystemPrincipalRef

export type ChannelSummary = Readonly<{
  agentId?: string
  createdAt: string
  id: string
  isPrimaryProjectChannel: boolean
  kind: 'project' | 'direct_agent' | 'group'
  lifecycleState: 'active' | 'archived'
  participants: readonly ConversationParticipantRef[]
  projectId?: string
  sortOrder: number
  taskId?: string
  title: string
  updatedAt: string
  version: number
  visibility: 'workspace' | 'participants'
  workspaceId: string
}>

export type MessageSummary = Readonly<{
  artifactIds: readonly string[]
  bodyContentRefId?: string
  bodyText?: string
  channelId: string
  createdAt: string
  deleted: boolean
  deletedAt?: string
  editedAt?: string
  executionRef?: string
  externalSessionRef?: string
  id: string
  mentions: readonly ConversationParticipantRef[]
  replyToMessageId?: string
  sender: MessageSenderRef
  sequence: number
  taskId?: string
  threadRootMessageId?: string
  updatedAt: string
  version: number
  workspaceId: string
}>

export type ThreadReadStateSummary = Readonly<{
  lastReadSequence: number
  latestSequence: number
  manuallyUnread: boolean
  readAt?: string
  threadRootMessageId: string
  unreadCount: number
  updatedAt?: string
}>

export type ChannelReadStateSummary = Readonly<{
  channelId: string
  lastReadSequence: number
  latestTopLevelSequence: number
  manuallyUnread: boolean
  readAt?: string
  threadUnreadCount: number
  threads: readonly ThreadReadStateSummary[]
  topLevelUnreadCount: number
  unread: boolean
  updatedAt?: string
  workspaceId: string
}>

/**
 * Counts-only unread status for one workspace the user belongs to (ADR 0011).
 * It names no channel, message, or person, so it can be read for workspaces
 * the user is not currently in.
 */
export type AccountWorkspaceSummary = Readonly<{
  /** Live mentions of the user in unread top-level messages. */
  mentions: number
  /** Accessible active channels with an unread top-level message or a manual unread mark. */
  unreadChannels: number
  workspaceId: string
}>

export type AccountSummary = Readonly<{ workspaces: readonly AccountWorkspaceSummary[] }>

export type WorkspaceSearchResult = Readonly<{
  channelId?: string
  id: string
  kind: 'action' | 'agent' | 'artifact' | 'channel' | 'message' | 'project' | 'settings' | 'task'
  label: string
  messageId?: string
  projectId?: string
  secondary: string
  taskId?: string
  threadRootMessageId?: string
  unavailablePrivateContent?: boolean
  workspaceId: string
}>

export type WorkspaceSearchPage = Readonly<{
  nextOffset?: number
  privateResultsUnavailable: boolean
  results: readonly WorkspaceSearchResult[]
}>

export type ArtifactLocation = Readonly<{
  externalHarnessId?: string
  reference?: string
  runtimeNodeId?: string
  type: 'object_store' | 'runtime_node' | 'external_harness'
}>

export type ArtifactSummary = Readonly<{
  agentId?: string
  availability: 'pending' | 'available' | 'unavailable' | 'quarantined' | 'failed'
  checksumSha256: string
  createdAt: string
  deletedAt?: string
  deletionState: 'active' | 'deleted'
  executionRef?: string
  filename: string
  id: string
  location: ArtifactLocation
  mediaType: string
  owner: PrincipalRef
  provenance: Readonly<Record<string, unknown>>
  retentionPolicy: 'ephemeral' | 'standard' | 'retain'
  sensitivity: 'workspace' | 'sensitive' | 'restricted'
  sizeBytes: number
  sourceArtifactRef: string
  sourcePrincipal: PrincipalRef
  taskId?: string
  updatedAt: string
  version: number
  workspaceId: string
}>

/**
 * Content types the desktop local content store holds. `memory_entry`
 * (ADR 0012) is local-only for now: the cloud `ContentRefSummary` union and
 * its schema admit it when encrypted replica publication for memory lands.
 */
export type LocalContentType = ContentRefSummary['contentType'] | 'memory_entry'

/**
 * A workspace memory entry (ADR 0012, "Memory"): a short plain-text note owned
 * by exactly one workspace. The text is restricted local content held by the
 * desktop local content store under content type `memory_entry`; agent-written
 * entries arrive as `pending` proposals and become memory only when the user
 * accepts them.
 */
export type WorkspaceMemoryEntry = Readonly<{
  id: string
  workspaceId: string
  text: string
  source: 'user' | 'agent'
  status: 'active' | 'pending'
  createdAt: string
  updatedAt: string
  revision: number
}>

/** One authorized workspace's memory as the desktop store reports it. */
export type WorkspaceMemorySnapshot = Readonly<{
  /** Newest first (creation time, then id). */
  entries: readonly WorkspaceMemoryEntry[]
  /** The per-workspace launch-injection switch; on by default. */
  injectionEnabled: boolean
  /** Records present for the workspace that failed authentication and are
   *  therefore reported, never shown. */
  unreadable: number
}>

/** Workspace memory bounds; docs/specs/local-content.md is the contract. */
export const workspaceMemoryLimits = Object.freeze({
  /** Characters per entry text (UTF-16 code units, as a textarea counts). */
  entryMaxChars: 2_000,
  /** Active plus pending entries one workspace may hold. */
  entriesPerWorkspace: 200,
  /** Pending agent proposals one workspace may hold at once. */
  pendingPerWorkspace: 20,
  /** UTF-8 bytes of the compiled launch preamble. */
  preambleMaxBytes: 16 * 1024,
})
