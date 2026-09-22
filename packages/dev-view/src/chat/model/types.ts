import type {
  Group,
  Project,
  RuntimeEvent,
  RuntimeSession,
  Scope,
} from '@adea-ai/types/dev-runtime'

export type ChatConversationStatus = RuntimeSession['lifecycle'] | 'stale_generation'

export type ChatRetentionTruth = Readonly<{
  maxEvents: number
  oldestSequence?: string
  newestSequence?: string
  complete: boolean
  reason?: 'retention' | 'sequence_gap' | 'checkpoint_required'
}>

export type ChatConversation = Readonly<{
  /** The canonical identity. Chat never creates a second conversation ID. */
  runtimeSessionId: string
  scope: Scope
  projectId: string
  repoId: string
  worktreeId: string
  groupIds: readonly string[]
  title: string
  status: ChatConversationStatus
  archived: boolean
  projection: RuntimeSession['projection']
  generation: number
  version: number
  activeHarnessRunId?: string
  draft: string
  events: readonly RuntimeEvent[]
  retention: ChatRetentionTruth
}>

export type ChatProjectProjection = Readonly<{
  id: string
  name: string
  groupIds: readonly string[]
  conversationIds: readonly string[]
}>

export type ChatGroupProjection = Readonly<{
  id: string
  name: string
  projectIds: readonly string[]
}>

export type ChatConversationProjection = Readonly<{
  scope: Scope
  groups: readonly ChatGroupProjection[]
  projects: readonly ChatProjectProjection[]
  conversations: readonly ChatConversation[]
}>

export type ConversationRegistryInput = Readonly<{
  scope: Scope
  groups: readonly Group[]
  projects: readonly Project[]
  sessions: readonly RuntimeSession[]
  events?: ReadonlyMap<string, readonly RuntimeEvent[]>
  drafts?: ReadonlyMap<string, string>
}>

export type ChatUserInput = Readonly<{
  runtimeSessionId: string
  generation: number
  source: 'chat_user'
  text: string
  sentAt: string
}>

export type ChatInputTransport = (input: ChatUserInput) => void | Promise<void>

export type ConversationCreateInput = Readonly<{
  projectId: string
  repoId: string
  worktreeId: string
  taskId?: string
  agentProfileId?: string
  agentProfileVersion?: number
  harnessInstallationId?: string
  modelId?: string
  initialPrompt?: string
  attachTerminal?: boolean
  idempotencyKey?: string
}>

export type ConversationModelOptions = Readonly<{
  sendInput?: ChatInputTransport
  now?: () => Date
  randomId?: () => string
}>
