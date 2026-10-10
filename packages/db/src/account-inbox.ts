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
  hiddenUnreadCountByChannel,
  readHiddenUnreadPublications,
  readVisibleTopLevelFrontiers,
} from './job-outbound-frontier'
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

/**
 * Applies the principal's current publication authority to inbox rows. A hidden unread
 * publication is not an unread message, and the exposed frontier is the newest message the
 * principal can see. Only the rows' own channels are read, so a page costs its channels.
 */
async function withPublicationAuthority(
  database: Database,
  principal: UserPrincipalRef,
  rows: readonly InboxRow[]
): Promise<InboxRow[]> {
  if (!rows.length) return []
  // The frontier message is joined in the row, so this reads only the publications, and only
  // for rows that have an unread one.
  const frontiers = await readVisibleTopLevelFrontiers(
    database,
    principal,
    rows.map((row) => {
      const latestSequence = Number(row.latestTopLevelSequence)
      return {
        channelId: row.id,
        latestSequence,
        top:
          latestSequence > 0
            ? row.topId
              ? {
                  executionRef: row.topExecutionRef,
                  id: row.topId,
                  sequence: latestSequence,
                  senderKind: row.topSenderKind ?? 'user',
                  senderSystemId: row.topSenderSystemId,
                }
              : null
            : undefined,
        workspaceId: row.workspaceId,
      }
    })
  )
  const flagged = rows.filter((row) => row.hasUnreadPublication).map((row) => row.id)
  const hidden = flagged.length
    ? await readHiddenUnreadPublications(database, principal, {
        channelIds: flagged,
        workspaceIds: [...new Set(rows.map((row) => row.workspaceId))],
      })
    : []
  const hiddenByChannel = hiddenUnreadCountByChannel(hidden)
  return rows.map((row) => ({
    ...row,
    latestTopLevelSequence: frontiers.get(row.id) ?? 0,
    topLevelUnreadCount: Math.max(
      0,
      Number(row.topLevelUnreadCount) - (hiddenByChannel.get(row.id) ?? 0)
    ),
  }))
}

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
  /** Exact `updated_at` text at microsecond precision; the cursor's sort key. */
  updatedAtText: string
  latestTopLevelSequence: string | number
  manuallyUnread: boolean
  topLevelUnreadCount: string | number
  threadUnreadCount: string | number
  unreadMentions: string | number
  /** The stored frontier message, joined so the frontier costs no extra read (#1217). */
  topId: string | null
  topExecutionRef: string | null
  topSenderKind: string | null
  topSenderSystemId: string | null
  hasUnreadPublication: boolean
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
// mention lateral runs only for channels unread by sequence. A job publication
// is counted and exposed only while the principal is authorized for it (#1217),
// applied to the page's own rows. Thread unread
// follows the canonical workspace read-state semantics exactly — the sum of
// live replies past each thread's frontier, plus one per manually-unread
// thread — so an inbox row and the workspace read state can never disagree.
// Nothing here names another person.

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
    /* The cursor's ordering key: exact timestamp text at microsecond
       precision, independent of both the driver's Date mapping and the
       session time zone. A Date-normalized cursor would compare .123000
       against stored .123456 rows and skip them after a tie. */
    to_char(channel.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      as "updatedAtText",
    channel.latest_message_sequence as "latestTopLevelSequence",
    top_message.id as "topId",
    top_message.execution_ref as "topExecutionRef",
    top_message.sender_kind as "topSenderKind",
    top_message.sender_system_id as "topSenderSystemId",
    exists (
      select 1 from ${messages} as publication
      where publication.channel_id = channel.id
        and publication.workspace_id = channel.workspace_id
        and publication.thread_root_message_id is null
        and publication.deleted_at is null
        and publication.sender_kind = 'system'
        and publication.sender_system_id like 'job-outbound:v1:%'
        and publication.sequence > coalesce(read_state.last_read_sequence, 0)
    ) as "hasUnreadPublication",
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
    /* Canonical thread semantics, identical to the workspace read state
       (read-state.ts): per thread, the live replies past the thread's read
       frontier, plus one for a manual unread mark — summed across the
       channel. Counting unread THREADS would collapse three unread replies
       into one. */
    (
      select coalesce(sum(thread_entry.unread), 0)
      from (
        select
          count(message.id) filter (
            where message.sequence > coalesce(thread_state.last_read_sequence, 0)
          )
          + case when coalesce(thread_state.manually_unread, false) then 1 else 0 end
            as unread
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
      ) as thread_entry
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
    left join ${messages} as top_message
      on top_message.channel_id = channel.id
      and top_message.workspace_id = channel.workspace_id
      and top_message.sequence = channel.latest_message_sequence
      and top_message.thread_root_message_id is null
      and top_message.deleted_at is null
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
 * or skips one inside a single walk. The cursor carries the boundary row's
 * `updated_at` at PostgreSQL's full microsecond precision (rendered in the
 * query as exact UTC text), because a Date-normalized value would truncate
 * to milliseconds and skip rows that tie across the truncated digit.
 * The ordering key is the channel's own metadata recency, which message
 * writes deliberately leave alone (they advance `latest_message_sequence`,
 * carried on every row, instead); re-ranking by message activity belongs
 * with the inbox UI slice and its own reviewed index migration.
 * `includeArchived` lists archived conversations where their history
 * remains reachable; live ones only by default, and `q` narrows by title
 * inside the authorization — the inbox's authoritative search, answered by
 * the database rather than by whatever pages a client happens to hold.
 */
export async function accountConversationInbox(
  database: Database,
  principal: UserPrincipalRef,
  options: Readonly<AccountDirectoryPageInput> = {}
): Promise<AccountConversationInboxPage> {
  const limit = accountDirectoryPageLimit(options.limit)
  const after = options.after ? decodeAccountInboxCursor(options.after) : null
  const lifecycle = options.includeArchived ? sql`true` : sql`channel.lifecycle_state = 'active'`
  // The search predicate sits INSIDE the authorization statement: it filters
  // rows the caller may see, so a hidden project's or private conversation's
  // title never matches, and it is constant for the whole walk — the keyset
  // cursor stays valid because every page applies the same filter to the same
  // total order over stable ids.
  const search = options.q
    ? sql`and position(lower(${options.q}) in lower(channel.title)) > 0`
    : sql``
  const cursor = after
    ? sql`and (channel.updated_at, channel.id) < (${after.updatedAt}::timestamptz, ${after.id}::uuid)`
    : sql``
  const rows = await database.execute<InboxRow>(sql`
    select ${inboxSelection}
    ${inboxAuthorization(principal.userId)}
    and ${lifecycle}
    ${search}
    ${cursor}
    order by channel.updated_at desc, channel.id desc
    limit ${limit + 1}
  `)
  const pageRows = await withPublicationAuthority(database, principal, [...rows].slice(0, limit))
  const last = pageRows.at(-1)
  return Object.freeze({
    conversations: Object.freeze(pageRows.map(inboxEntry)),
    ...(pageRows.length < rows.length && last
      ? {
          // The exact timestamp text, not a Date-normalized one: PostgreSQL
          // compares microseconds while `Date` holds only milliseconds.
          nextCursor: encodeAccountInboxCursor({
            id: last.id,
            updatedAt: last.updatedAtText,
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
  if (!row) return null
  const [current] = await withPublicationAuthority(database, principal, [row])
  return current ? inboxEntry(current) : null
}
