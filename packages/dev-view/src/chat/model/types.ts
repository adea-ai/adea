import type { Project, RuntimeEvent, RuntimeSession, Scope } from '@adea-ai/types/dev-runtime'
import type { PasteBlock } from '@adea-ai/ui/components/conversation/paste-tokens'

export type ChatDraftValue = Readonly<{
  text: string
  blocks: readonly PasteBlock[]
}>

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
  title: string
  status: ChatConversationStatus
  archived: boolean
  projection: RuntimeSession['projection']
  generation: number
  version: number
  activeHarnessRunId?: string
  /** Retained coordination holder projected from the host (#1177); absent
   *  means no explicit coordination was ever recorded for this session. */
  coordinationOwner?: RuntimeSession['coordinationOwner']
  draft: string
  draftBlocks: readonly PasteBlock[]
  events: readonly RuntimeEvent[]
  retention: ChatRetentionTruth
}>

export type ChatProjectProjection = Readonly<{
  /** The cloud project id the local binding is keyed by. */
  id: string
  /** Display label: the host-supplied cloud name, or the short project id. */
  name: string
  conversationIds: readonly string[]
}>

export type ChatConversationProjection = Readonly<{
  scope: Scope
  projects: readonly ChatProjectProjection[]
  conversations: readonly ChatConversation[]
}>

export type ConversationRegistryInput = Readonly<{
  scope: Scope
  projects: readonly Project[]
  /** Cloud project names keyed by project id; the register stores none. */
  projectNames?: ReadonlyMap<string, string>
  sessions: readonly RuntimeSession[]
  events?: ReadonlyMap<string, readonly RuntimeEvent[]>
  drafts?: ReadonlyMap<string, string | ChatDraftValue>
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
  /** Cloud project names keyed by project id, read at each projection. */
  projectNames?: () => ReadonlyMap<string, string> | undefined
}>
