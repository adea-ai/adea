import type {
  AccountConversationInboxEntry,
  AccountConversationInboxPage,
  AccountDirectoryPageInput,
} from '@adea-ai/types/account-directory'
import type { UserPrincipalRef } from '@adea-ai/types'
import { sql } from 'drizzle-orm'

import {
  accountDirectoryPageLimit,
  decodeAccountInboxCursor,
  encodeAccountInboxCursor,
  isAccountResourceId,
} from './account-cursor'
import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import {
  channelParticipants,
  channelReadStates,
  channels,
  messageMentions,
  messages,
  projectMembers,
  projects,
  threadReadStates,
  workspaceMemberships,
  workspaces,
} from './schema'

type Database = AgentHqDatabase | AgentHqTransaction

type InboxRow = {
  id: string
  workspaceId: string
  kind: AccountConversationInboxEntry['kind']
  title: string
  projectId: string | null
  agentId: string | null
  taskId: string | null
  isPrimaryProjectChannel: boolean
  visibility: AccountConversationInboxEntry['visibility']
  lifecycleState: AccountConversationInboxEntry['lifecycleState']
  sortOrder: number
  version: number
  createdAt: Date | string
  updatedAt: Date | string
  latestTopLevelSequence: string | number
  manuallyUnread: boolean
  topLevelUnreadCount: string | number
  threadUnreadCount: string | number
  unreadMentions: string | number
}

// The account-wide inbox lists conversations from every workspace the
// principal belongs to in one grouped query, independent of the currently
// selected workspace (M11.03). Its three authorization checks stay distinct
// predicates, mirroring the workspace-scoped modules:
//
// 1. workspace membership — the query starts from the principal's own
//    memberships joined to live workspaces (`deleted_at is null`, which also
//    retires archived workspaces);
// 2. project access (ADR 0012) — a channel of a hidden `members` project is
//    invisible unless the principal owns or administers the workspace; its
//    title never leaves the database;
// 3. private participation — a `participants`-visibility conversation lists
//    the principal as a channel participant, or it does not exist for them.
//
// Unread state reuses the counts-only account summary's contract (ADR 0011):
// the denormalized `channels.latest_message_sequence` frontier gates the
// top-level count, so a read conversation costs no message access; the
// mention lateral runs only for channels unread by sequence. Nothing here
// names another person.

const inboxSelection = sql`
    channel.id as "id",
    channel.workspace_id as "workspaceId",
    channel.kind as "kind",
    channel.title as "title",
    channel.project_id as "projectId",
    channel.agent_id as "agentId",
    channel.task_id as "taskId",
    channel.is_primary_project_channel as "isPrimaryProjectChannel",
    channel.visibility as "visibility",
    channel.lifecycle_state as "lifecycleState",
    channel.sort_order as "sortOrder",
    channel.version as "version",
    channel.created_at as "createdAt",
    channel.updated_at as "updatedAt",
    channel.latest_message_sequence as "latestTopLevelSequence",
    coalesce(read_state.manually_unread, false) as "manuallyUnread",
    (
      case when channel.latest_message_sequence > coalesce(read_state.last_read_sequence, 0) then (
        select count(*)
        from ${messages} as message
        where message.channel_id = channel.id
          and message.thread_root_message_id is null
          and message.deleted_at is null
          and message.sequence > coalesce(read_state.last_read_sequence, 0)
      )
      else 0
      end
    ) as "topLevelUnreadCount",
    (
      select count(*)
      from (
        select message.thread_root_message_id
        from ${messages} as message
        /* Thread state is keyed per (workspace, user, thread root), so the
           join never splits a thread. */
        left join ${threadReadStates} as thread_state
          on thread_state.workspace_id = message.workspace_id
          and thread_state.user_id = membership.user_id
          and thread_state.thread_root_message_id = message.thread_root_message_id
        where message.channel_id = channel.id
          and message.thread_root_message_id is not null
          and message.deleted_at is null
        group by
          message.thread_root_message_id,
          thread_state.last_read_sequence,
          thread_state.manually_unread
        having max(message.sequence) > coalesce(thread_state.last_read_sequence, 0)
          or coalesce(thread_state.manually_unread, false)
      ) as unread_threads
    ) as "threadUnreadCount",
    coalesce(mention.count, 0) as "unreadMentions"
  `

const inboxAuthorization = (userId: string) => sql`
    from ${workspaceMemberships} as membership
    inner join ${workspaces} as workspace
      on workspace.id = membership.workspace_id and workspace.deleted_at is null
    join ${channels} as channel
      on channel.workspace_id = membership.workspace_id
      and (
        channel.visibility = 'workspace'
        or exists (
          select 1 from ${channelParticipants} as participant
          where participant.channel_id = channel.id
            and participant.principal_kind = 'user'
            and participant.user_id = ${userId}
        )
      )
      and (
        channel.project_id is null
        or membership.role in ('owner', 'admin')
        or exists (
          select 1 from ${projects} as project
          where project.id = channel.project_id
            and project.visibility <> 'members'
        )
        or exists (
          select 1 from ${projectMembers} as project_member
          where project_member.project_id = channel.project_id
            and project_member.user_id = ${userId}
        )
      )
    left join ${channelReadStates} as read_state
      on read_state.workspace_id = channel.workspace_id
      and read_state.user_id = ${userId}
      and read_state.channel_id = channel.id
    left join lateral (
      select count(*) as count
      from ${messageMentions} as mentioned
      inner join ${messages} as message on message.id = mentioned.message_id
      where channel.latest_message_sequence > coalesce(read_state.last_read_sequence, 0)
        and mentioned.principal_kind = 'user'
        and mentioned.user_id = membership.user_id
        and message.channel_id = channel.id
        and message.thread_root_message_id is null
        and message.deleted_at is null
        and message.sequence > coalesce(read_state.last_read_sequence, 0)
    ) as mention on true
    where membership.user_id = ${userId}
  `

/**
 * Raw `execute` rows hand timestamps back as driver strings, not `Date`s;
 * normalize both shapes at the mapping boundary.
 */
function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function inboxEntry(row: InboxRow): AccountConversationInboxEntry {
  const topLevelUnreadCount = Number(row.topLevelUnreadCount)
  const threadUnreadCount = Number(row.threadUnreadCount)
  const unreadMentions = Number(row.unreadMentions)
  const manuallyUnread = Boolean(row.manuallyUnread)
  return Object.freeze({
    ...(row.agentId ? { agentId: row.agentId } : {}),
    createdAt: toIso(row.createdAt),
    id: row.id,
    isPrimaryProjectChannel: Boolean(row.isPrimaryProjectChannel),
    kind: row.kind,
    latestTopLevelSequence: Number(row.latestTopLevelSequence),
    lifecycleState: row.lifecycleState,
    ...(row.projectId ? { projectId: row.projectId } : {}),
    sortOrder: Number(row.sortOrder),
    ...(row.taskId ? { taskId: row.taskId } : {}),
    title: row.title,
    threadUnreadCount,
    topLevelUnreadCount,
    unread: manuallyUnread || topLevelUnreadCount > 0 || threadUnreadCount > 0,
    unreadMentions,
    updatedAt: toIso(row.updatedAt),
    version: Number(row.version),
    visibility: row.visibility,
    workspaceId: row.workspaceId,
  })
}

/**
 * Authorized conversations across every workspace the principal belongs to,
 * independent of the currently selected workspace (M11.03). Pages are
 * keyset-paginated on `(updated_at, id)` descending — a total order over
 * stable conversation ids — so rows shifting between pages never duplicates
 * or skips one inside a single walk. The ordering key is the channel's own
 * metadata recency, which message writes deliberately leave alone (they
 * advance `latest_message_sequence`, carried on every row, instead);
 * re-ranking by message activity belongs with the inbox UI slice and its own
 * reviewed index migration. `includeArchived` lists archived conversations
 * where their history remains reachable; live ones only by default.
 */
export async function accountConversationInbox(
  database: Database,
  principal: UserPrincipalRef,
  options: Readonly<AccountDirectoryPageInput> = {}
): Promise<AccountConversationInboxPage> {
  const limit = accountDirectoryPageLimit(options.limit)
  const after = options.after ? decodeAccountInboxCursor(options.after) : null
  const lifecycle = options.includeArchived ? sql`true` : sql`channel.lifecycle_state = 'active'`
  const cursor = after
    ? sql`and (channel.updated_at, channel.id) < (${after.updatedAt}::timestamptz, ${after.id}::uuid)`
    : sql``
  const rows = await database.execute<InboxRow>(sql`
    select ${inboxSelection}
    ${inboxAuthorization(principal.userId)}
    and ${lifecycle}
    ${cursor}
    order by channel.updated_at desc, channel.id desc
    limit ${limit + 1}
  `)
  const page = [...rows].slice(0, limit)
  const last = page.at(-1)
  return Object.freeze({
    conversations: Object.freeze(page.map(inboxEntry)),
    ...(page.length < rows.length && last
      ? {
          nextCursor: encodeAccountInboxCursor({
            id: last.id,
            updatedAt: toIso(last.updatedAt),
          }),
        }
      : {}),
  })
}

/**
 * One inbox conversation by stable id, for account-wide deep links. Archived
 * conversations resolve here by default — deep links must survive archiving —
 * and the lifecycle state travels in the row. Everything the caller cannot
 * see — no membership, hidden project, revoked participation, deleted
 * workspace, or a missing id — is the same `null`; denied is never
 * distinguishable from nonexistent.
 */
export async function findAccountConversation(
  database: Database,
  principal: UserPrincipalRef,
  conversationId: string,
  options: Readonly<{ includeArchived?: boolean }> = {}
): Promise<AccountConversationInboxEntry | null> {
  if (!isAccountResourceId(conversationId)) return null
  const lifecycle =
    options.includeArchived === false ? sql`channel.lifecycle_state = 'active'` : sql`true`
  const [row] = await database.execute<InboxRow>(sql`
    select ${inboxSelection}
    ${inboxAuthorization(principal.userId)}
    and ${lifecycle}
    and channel.id = ${conversationId}::uuid
    limit 1
  `)
  return row ? inboxEntry(row) : null
}
