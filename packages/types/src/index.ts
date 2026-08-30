export type WorkspaceSceneId = 'home' | 'work'

export type WorkspaceViewMode = 'perspective' | 'orthographic'

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
  profile: Readonly<{ id: string; state: AgentProfileState; version: string }>
  roleSummary?: string
  roomId?: string
  updatedAt: string
  workspaceId: string
}

export type WorkspaceSummary = {
  id: string
  name: string
  scene: WorkspaceSceneId
  updatedAt: string
}

export type RoomLifecycleState = 'active' | 'archived'

export type RoomSummary = Readonly<{
  createdAt: string
  functionKey: string
  id: string
  layoutRef?: string
  lifecycleState: RoomLifecycleState
  name: string
  sortOrder: number
  spatialRef?: string
  templateKey?: string
  updatedAt: string
  workspaceId: string
}>

export type TaskLifecycleState = 'created' | 'queued' | 'cancelled' | 'archived'
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent'

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
  synchronizationPolicy: 'local_only' | 'e2e_optional'
  taskId?: string
  updatedAt: string
  workspaceId: string
}>

export type TaskSummary = Readonly<{
  agentId?: string
  artifactRefs: readonly string[]
  controlPlaneExecutionRef?: string
  controlPlaneWorkflowRef?: string
  conversation: Readonly<{
    channelId?: string
    messageId?: string
    threadRootMessageId?: string
  }>
  createdAt: string
  creator: UserPrincipalRef
  dependencyIds: readonly string[]
  id: string
  lifecycleState: TaskLifecycleState
  objective?: string
  objectiveContentRefId?: string
  priority: TaskPriority
  roomId?: string
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
  isPrimaryRoomChannel: boolean
  kind: 'room' | 'direct_agent' | 'group'
  lifecycleState: 'active' | 'archived'
  participants: readonly ConversationParticipantRef[]
  roomId?: string
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

export type WorkspaceSearchResult = Readonly<{
  channelId?: string
  id: string
  kind: 'action' | 'agent' | 'artifact' | 'channel' | 'message' | 'room' | 'settings' | 'task'
  label: string
  messageId?: string
  roomId?: string
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
