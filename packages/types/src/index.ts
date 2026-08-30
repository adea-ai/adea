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
  objective: string
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
