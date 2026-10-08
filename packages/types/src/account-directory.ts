import type { AgentLifecycleState, AgentProfileState } from './index'

/**
 * Account-wide page input shared by the authorized agent directory and the
 * conversation inbox (M11.03). Both lists are keyset-paginated on stable
 * identities: `after` is the opaque cursor the previous page returned, never
 * an offset, so inserting or updating rows never shifts an open page's
 * membership. Results are independent of the currently selected workspace;
 * only workspaces the caller belongs to can appear at all.
 */
export type AccountDirectoryPageInput = Readonly<{
  /** Opaque continuation cursor from the previous page's `nextCursor`. */
  after?: string
  /** Also list archived rows. Live rows only by default. */
  includeArchived?: boolean
  /** Page size. The server clamps it to 1..100 (default 50). */
  limit?: number
}>

/**
 * One authorized Agent of the account-wide directory. The same Agent in two
 * workspaces is two entries with two stable ids; the name is display data and
 * never an identity.
 */
export type AccountDirectoryAgent = Readonly<{
  avatarRef?: string
  createdAt: string
  id: string
  isWorkspaceLead: boolean
  lifecycleState: AgentLifecycleState
  name: string
  profile: Readonly<{
    id: string
    state: AgentProfileState
    version: string
    revision: number
  }>
  roleSummary?: string
  projectId?: string
  updatedAt: string
  workspaceId: string
}>

export type AccountAgentDirectoryPage = Readonly<{
  agents: readonly AccountDirectoryAgent[]
  /** Cursor for the following page; absent once the directory is exhausted. */
  nextCursor?: string
}>

/**
 * One authorized conversation of the account-wide inbox, with the unread
 * state computed against the caller's own read frontiers. A conversation the
 * caller lost access to simply never appears; denied results are
 * indistinguishable from nonexistent ones.
 */
export type AccountConversationInboxEntry = Readonly<{
  agentId?: string
  createdAt: string
  id: string
  isPrimaryProjectChannel: boolean
  kind: 'project' | 'direct_agent' | 'group'
  /** Sequence of the newest live top-level message, or 0 when there is none. */
  latestTopLevelSequence: number
  lifecycleState: 'active' | 'archived'
  projectId?: string
  sortOrder: number
  taskId?: string
  title: string
  threadUnreadCount: number
  topLevelUnreadCount: number
  /** Unread for the caller: a manual mark or any top-level/thread unread. */
  unread: boolean
  /** Unread top-level messages of this conversation that mention the caller. */
  unreadMentions: number
  updatedAt: string
  version: number
  visibility: 'workspace' | 'participants'
  workspaceId: string
}>

export type AccountConversationInboxPage = Readonly<{
  conversations: readonly AccountConversationInboxEntry[]
  /** Cursor for the following page; absent once the inbox is exhausted. */
  nextCursor?: string
}>
