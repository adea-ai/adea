import type {
  ChannelReadStateSummary,
  ThreadReadStateSummary,
  UserPrincipalRef,
} from '@adea-ai/types'
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import {
  ABSENT_GRANT_WINDOW,
  admissionFromRow,
  admissionInForce,
  audienceGrantFromRow,
  type GroupHistoryAccess,
  groupChannelIdsInForce,
  groupHistoryAccessByUser,
  groupHistoryMessageAndThreadVisibleCondition,
  groupSummaryMessageAndThreadVisibleCondition,
  groupSummaryMessageVisibleCondition,
  resolveAdmissionWindow,
  userChannelVisibility,
} from './group-participation-store'
import {
  type ProjectAccessScope,
  requireProjectAccessScope,
  visibleProjectCondition,
} from './project-access'
import { appendWorkspaceEvent, inReadSnapshot } from './transactions'
import { readHiddenUnreadCounts, readVisibleTopLevelFrontiers } from './job-outbound-frontier'
import { filterVisibleMessageRows } from './job-outbound-read'
import {
  channelReadStates,
  channels,
  groupAdmissions,
  groupAudienceGrants,
  groupSharingGrants,
  messages,
  threadReadStates,
} from './schema'

type Database = AgentHqDatabase | AgentHqTransaction

// Active channels the principal can see: workspace-visible or listing them as
// a participant (groups by canonical admission), outside every hidden project.
// The id listing, the read state summary and its thread aggregate all use this
// one predicate, so they can never disagree about which channels are in scope.
function accessibleChannelCondition(
  workspaceId: string,
  principal: UserPrincipalRef,
  scope: ProjectAccessScope,
  inForceGroupIds: readonly string[]
) {
  return and(
    eq(channels.workspaceId, workspaceId),
    eq(channels.lifecycleState, 'active'),
    visibleProjectCondition(channels.projectId, scope),
    userChannelVisibility({
      channelId: sql`${channels.id}`,
      inForceGroupIds,
      kind: sql`${channels.kind}`,
      userId: principal.userId,
      visibility: sql`${channels.visibility}`,
    })
  )
}

function accessibleChannelIds(
  database: Database,
  workspaceId: string,
  principal: UserPrincipalRef,
  scope: ProjectAccessScope,
  inForceGroupIds: readonly string[]
) {
  return database
    .select({ id: channels.id })
    .from(channels)
    .where(accessibleChannelCondition(workspaceId, principal, scope, inForceGroupIds))
}

export function listAccessibleChannelIds(
  database: Database,
  workspaceId: string,
  principal: UserPrincipalRef
) {
  return inReadSnapshot(database, (snapshot) =>
    queryAccessibleChannelIds(snapshot, workspaceId, principal)
  )
}

async function queryAccessibleChannelIds(
  database: Database,
  workspaceId: string,
  principal: UserPrincipalRef
) {
  // Hidden projects' channels are not accessible, so their read state, unread
  // counts and search scope never reach a principal who cannot see them.
  const scope = await requireProjectAccessScope(
    database,
    workspaceId,
    principal,
    'Read state unavailable'
  )
  const inForce = [
    ...(await groupChannelIdsInForce(
      database,
      principal.userId,
      new Date().toISOString(),
      workspaceId
    )),
  ]
  return accessibleChannelIds(database, workspaceId, principal, scope, inForce).orderBy(
    asc(channels.id)
  )
}

/**
 * Lock and revalidate candidate group access for a read-state write. Candidate
 * ids come from the caller's existing READ COMMITTED write transaction, so
 * this second, locked decision orders a racing grant revoke before or after
 * the state write. This helper locks channel, admission, then grant rows;
 * group posts also lock the channel before resolving standing, while grant
 * revocation updates only the grant row.
 */
async function lockCurrentGroupChannelIdsForReadStateWrite(
  transaction: AgentHqTransaction,
  workspaceId: string,
  channelIds: readonly string[],
  principal: UserPrincipalRef
): Promise<Readonly<{ groupIds: ReadonlySet<string>; inForceGroupIds: ReadonlySet<string> }>> {
  if (!channelIds.length) return { groupIds: new Set(), inForceGroupIds: new Set() }

  const lockedChannels = await transaction
    .select({ id: channels.id, lifecycleState: channels.lifecycleState })
    .from(channels)
    .where(
      and(
        eq(channels.workspaceId, workspaceId),
        eq(channels.kind, 'group'),
        inArray(channels.id, [...channelIds])
      )
    )
    .orderBy(asc(channels.id))
    .for('update')
  const groupIds = new Set(lockedChannels.map(({ id }) => id))
  const activeGroupIds = lockedChannels
    .filter(({ lifecycleState }) => lifecycleState === 'active')
    .map(({ id }) => id)
  if (!activeGroupIds.length) return { groupIds, inForceGroupIds: new Set() }

  const admissions = await transaction
    .select()
    .from(groupAdmissions)
    .where(
      and(
        eq(groupAdmissions.workspaceId, workspaceId),
        eq(groupAdmissions.principalKind, 'user'),
        eq(groupAdmissions.userId, principal.userId),
        inArray(groupAdmissions.channelId, activeGroupIds)
      )
    )
    .orderBy(
      asc(groupAdmissions.channelId),
      asc(groupAdmissions.createdAt),
      asc(groupAdmissions.id)
    )
    .for('update')
  const grantIds = [...new Set(admissions.map(({ authGrantId }) => authGrantId))]
  const grants = grantIds.length
    ? await transaction
        .select()
        .from(groupAudienceGrants)
        .where(
          and(
            eq(groupAudienceGrants.workspaceId, workspaceId),
            inArray(groupAudienceGrants.channelId, activeGroupIds),
            inArray(groupAudienceGrants.grantId, grantIds)
          )
        )
        .orderBy(asc(groupAudienceGrants.channelId), asc(groupAudienceGrants.grantId))
        .for('update')
    : []
  if (activeGroupIds.length)
    await transaction
      .select({ id: groupSharingGrants.id })
      .from(groupSharingGrants)
      .where(
        and(
          eq(groupSharingGrants.workspaceId, workspaceId),
          inArray(groupSharingGrants.channelId, activeGroupIds)
        )
      )
      .orderBy(asc(groupSharingGrants.channelId), asc(groupSharingGrants.grantId))
      .for('update')
  const grantByBinding = new Map(
    grants.map((grant) => [JSON.stringify([grant.channelId, grant.grantId]), grant])
  )
  const now = new Date().toISOString()
  const inForceGroupIds = new Set<string>()
  for (const row of admissions) {
    const grantRow = grantByBinding.get(JSON.stringify([row.channelId, row.authGrantId]))
    const audienceGrant = grantRow ? audienceGrantFromRow(row.channelId, grantRow) : null
    const grantWindow = audienceGrant
      ? resolveAdmissionWindow(
          {
            authorization: {
              groupId: row.authGroupId,
              grantId: row.authGrantId,
              revision: row.authRevision,
            },
            participant: { kind: 'user', userId: principal.userId },
          },
          { audience: [audienceGrant], enlistment: [] },
          row.channelId
        )
      : ABSENT_GRANT_WINDOW
    const admission = admissionFromRow(row.channelId, row, grantWindow)
    if (admissionInForce(admission, row.channelId, now)) inForceGroupIds.add(row.channelId)
  }
  return { groupIds, inForceGroupIds }
}

async function requireChannel(
  database: AgentHqTransaction,
  workspaceId: string,
  channelId: string,
  principal: UserPrincipalRef
) {
  // This is a write-side authorization gate inside the mutation's existing
  // transaction, not a product read. Keep its READ COMMITTED semantics. Its
  // row locks make the standing decision serialize with a racing grant revoke.
  const allowed = await queryAccessibleChannelIds(database, workspaceId, principal)
  if (!allowed.some(({ id }) => id === channelId)) throw new Error('Read state unavailable')
  const locked = await lockCurrentGroupChannelIdsForReadStateWrite(
    database,
    workspaceId,
    [channelId],
    principal
  )
  if (locked.groupIds.has(channelId) && !locked.inForceGroupIds.has(channelId))
    throw new Error('Read state unavailable')
  return locked.groupIds.has(channelId)
}

/**
 * Per-channel unread state for one user, computed in the database.
 *
 * Five data reads regardless of workspace size: the project access scope's
 * two indexed reads, one canonical group admission/grant lookup, then two
 * aggregates issued together. A root call also uses one read-only snapshot.
 *
 * - Channels. Each accessible channel with its read state row. The stored newest
 *   live top-level sequence is `channels.latest_message_sequence`, which message
 *   create and delete maintain in their own transactions. The exposed frontier
 *   is the newest one the reader can see, and the top-level unread count drops
 *   job publications the reader is not authorized for (#1217, see
 *   job-outbound-frontier). The top-level unread count is only computed when the
 *   stored frontier is past the read frontier, and then it is an index range scan
 *   over the unread messages alone, so a read channel costs no message access.
 * - Threads. One row per thread root with at least one live reply, grouped by
 *   (channel, thread root) with that user's thread read state, carrying the
 *   newest reply sequence and the replies past the thread's read frontier. A thread
 *   whose root the reader cannot currently see (a job publication) is left out
 *   whole, with its unread count; its replies and watermark are kept, not reset.
 *
 * This used to load every live message of every accessible channel into the
 * application and count there, on every GET and after every mark.
 */
export function listReadStateForUser(
  database: Database,
  workspaceId: string,
  principal: UserPrincipalRef
): Promise<readonly ChannelReadStateSummary[]> {
  return inReadSnapshot(database, (snapshot) =>
    listReadStateForUserInSnapshot(snapshot, workspaceId, principal)
  )
}

async function listReadStateForUserInSnapshot(
  database: Database,
  workspaceId: string,
  principal: UserPrincipalRef
): Promise<readonly ChannelReadStateSummary[]> {
  const scope = await requireProjectAccessScope(
    database,
    workspaceId,
    principal,
    'Read state unavailable'
  )
  const historyAccess = await groupHistoryAccessByUser(
    database,
    principal.userId,
    new Date().toISOString(),
    workspaceId
  )
  const inForce = [...historyAccess.keys()]
  const channelReadFrontier = sql`coalesce(${channelReadStates.lastReadSequence}, 0)`
  const threadReadFrontier = sql`coalesce(${threadReadStates.lastReadSequence}, 0)`
  const groupChannelIds = [...historyAccess.keys()]
  const visibleSummaryMessage = groupSummaryMessageVisibleCondition({
    channelId: sql`${messages.channelId}`,
    sequence: sql`${messages.sequence}`,
    access: historyAccess,
  })
  const topMessage = alias(messages, 'top_message')
  const visibleSummaryTopLevel = groupChannelIds.length
    ? sql`(
        ${messages.channelId} not in (${sql.join(
          groupChannelIds.map((id) => sql`${id}::uuid`),
          sql`, `
        )})
        or (
          ${visibleSummaryMessage}
          and ${groupHistoryMessageAndThreadVisibleCondition({
            channelId: sql`${messages.channelId}`,
            sequence: sql`${messages.sequence}`,
            threadRootMessageId: sql`${messages.threadRootMessageId}`,
            access: historyAccess,
          })}
        )
      )`
    : sql`true`
  // Earlier-summary sharing may expose unread aggregates without allowing the
  // reader to see earlier messages or use their sequences as a read frontier.
  const aggregateVisibleSummaryTopLevel = groupChannelIds.length
    ? sql`(
        ${messages.channelId} not in (${sql.join(
          groupChannelIds.map((id) => sql`${id}::uuid`),
          sql`, `
        )})
        or ${groupSummaryMessageAndThreadVisibleCondition({
          channelId: sql`${messages.channelId}`,
          sequence: sql`${messages.sequence}`,
          threadRootMessageId: sql`${messages.threadRootMessageId}`,
          access: historyAccess,
        })}
      )`
    : sql`true`
  const visibleGroupThreadAggregate = groupChannelIds.length
    ? sql`(
        ${messages.channelId} not in (${sql.join(
          groupChannelIds.map((id) => sql`${id}::uuid`),
          sql`, `
        )})
        or (
          ${groupHistoryMessageAndThreadVisibleCondition({
            channelId: sql`${messages.channelId}`,
            sequence: sql`${messages.sequence}`,
            threadRootMessageId: sql`${messages.threadRootMessageId}`,
            access: historyAccess,
          })}
          and ${groupSummaryMessageAndThreadVisibleCondition({
            channelId: sql`${messages.channelId}`,
            sequence: sql`${messages.sequence}`,
            threadRootMessageId: sql`${messages.threadRootMessageId}`,
            access: historyAccess,
          })}
        )
      )`
    : sql`true`
  const latestVisibleTopLevel = sql<number>`coalesce((
    select max(${messages.sequence}) from ${messages}
    where ${messages.workspaceId} = ${workspaceId}
      and ${messages.channelId} = ${channels.id}
      and ${messages.threadRootMessageId} is null
      and ${messages.deletedAt} is null
      and (${channels.kind} <> 'group' or ${visibleSummaryTopLevel})
  ), 0)`.mapWith(Number)
  // This private frontier keeps the conditional aggregate query useful for
  // summary-only readers whose earlier messages are outside the visible
  // history frontier. It is never returned as a message sequence.
  const latestAggregateTopLevel = sql<number>`coalesce((
    select max(${messages.sequence}) from ${messages}
    where ${messages.workspaceId} = ${workspaceId}
      and ${messages.channelId} = ${channels.id}
      and ${messages.threadRootMessageId} is null
      and ${messages.deletedAt} is null
      and (${channels.kind} <> 'group' or ${aggregateVisibleSummaryTopLevel})
  ), 0)`.mapWith(Number)
  const threadRoot = alias(messages, 'read_state_thread_root')
  const [channelRows, threadRows] = await Promise.all([
    database
      .select({
        channelId: channels.id,
        // The stored frontier message, joined here so the frontier costs no extra read.
        hasUnreadPublication: sql<boolean>`exists (
          select 1 from ${messages} as publication
          where publication.channel_id = ${channels.id}
            and publication.workspace_id = ${channels.workspaceId}
            and publication.thread_root_message_id is null
            and publication.deleted_at is null
            and (
              publication.reply_to_message_id is not null
              or (
                publication.sender_kind = 'system'
                and publication.sender_system_id like 'job-outbound:v1:%'
              )
            )
            and publication.sequence > ${channelReadFrontier}
        )`.mapWith(Boolean),
        lastReadSequence: channelReadStates.lastReadSequence,
        latestTopLevelSequence: latestVisibleTopLevel,
        manuallyUnread: channelReadStates.manuallyUnread,
        readAt: channelReadStates.readAt,
        topExecutionRef: topMessage.executionRef,
        topId: topMessage.id,
        topReplyToMessageId: topMessage.replyToMessageId,
        topSenderKind: topMessage.senderKind,
        topSenderSystemId: topMessage.senderSystemId,
        // Scalar subqueries in a CASE branch run only when the branch is
        // taken: a channel whose frontier is not past its read mark is 0
        // without touching messages.
        topLevelUnreadCount:
          sql<number>`case when ${latestAggregateTopLevel} > ${channelReadFrontier} then (
          select count(*) from ${messages}
          where ${messages.workspaceId} = ${workspaceId}
            and ${messages.channelId} = ${channels.id}
            and ${messages.threadRootMessageId} is null
            and ${messages.deletedAt} is null
            and ${messages.sequence} > ${channelReadFrontier}
            and (${channels.kind} <> 'group' or ${aggregateVisibleSummaryTopLevel})
        ) else 0 end`.mapWith(Number),
        updatedAt: channelReadStates.updatedAt,
      })
      .from(channels)
      .leftJoin(
        channelReadStates,
        and(
          eq(channelReadStates.workspaceId, workspaceId),
          eq(channelReadStates.userId, principal.userId),
          eq(channelReadStates.channelId, channels.id)
        )
      )
      .leftJoin(
        topMessage,
        and(
          eq(topMessage.channelId, channels.id),
          eq(topMessage.workspaceId, workspaceId),
          eq(topMessage.sequence, latestVisibleTopLevel),
          isNull(topMessage.threadRootMessageId),
          isNull(topMessage.deletedAt)
        )
      )
      .where(accessibleChannelCondition(workspaceId, principal, scope, inForce))
      .orderBy(asc(channels.id)),
    database
      .select({
        channelId: messages.channelId,
        lastReadSequence: threadReadStates.lastReadSequence,
        latestSequence: sql<number>`max(${messages.sequence})`.mapWith(Number),
        manuallyUnread: threadReadStates.manuallyUnread,
        readAt: threadReadStates.readAt,
        rootExecutionRef: threadRoot.executionRef,
        rootId: threadRoot.id,
        rootReplyToMessageId: threadRoot.replyToMessageId,
        rootSenderKind: threadRoot.senderKind,
        rootSenderSystemId: threadRoot.senderSystemId,
        threadRootMessageId: sql<string>`${messages.threadRootMessageId}`,
        unreadCount:
          sql<number>`count(*) filter (where ${messages.sequence} > ${threadReadFrontier})`.mapWith(
            Number
          ),
        updatedAt: threadReadStates.updatedAt,
      })
      .from(messages)
      .innerJoin(
        threadRoot,
        and(
          eq(threadRoot.id, messages.threadRootMessageId),
          eq(threadRoot.workspaceId, messages.workspaceId),
          eq(threadRoot.channelId, messages.channelId),
          isNull(threadRoot.threadRootMessageId),
          isNull(threadRoot.deletedAt)
        )
      )
      .leftJoin(
        threadReadStates,
        and(
          eq(threadReadStates.workspaceId, workspaceId),
          eq(threadReadStates.userId, principal.userId),
          eq(threadReadStates.threadRootMessageId, messages.threadRootMessageId)
        )
      )
      .where(
        and(
          eq(messages.workspaceId, workspaceId),
          inArray(
            messages.channelId,
            accessibleChannelIds(database, workspaceId, principal, scope, inForce)
          ),
          isNotNull(messages.threadRootMessageId),
          isNull(messages.deletedAt),
          visibleGroupThreadAggregate
        )
      )
      // At most one thread read state row exists per (workspace, user, root),
      // so grouping by its columns never splits a thread.
      .groupBy(
        messages.channelId,
        messages.threadRootMessageId,
        threadRoot.executionRef,
        threadRoot.id,
        threadRoot.replyToMessageId,
        threadRoot.senderKind,
        threadRoot.senderSystemId,
        threadReadStates.lastReadSequence,
        threadReadStates.manuallyUnread,
        threadReadStates.readAt,
        threadReadStates.updatedAt
      ),
  ])
  if (!channelRows.length) return Object.freeze([])

  // Job publications count only while the reader is authorized for them. The exposed
  // frontier is the newest message the reader can see, and unread counts drop publications
  // the reader may no longer see. See job-outbound-frontier for the bounds.
  // A channel with no publication past its watermark needs no publication read: the joined
  // frontier message is ordinary, so the common case costs no statement here at all.
  const frontiers = await readVisibleTopLevelFrontiers(
    database,
    principal,
    channelRows.map((row) => ({
      channelId: row.channelId,
      latestSequence: row.latestTopLevelSequence,
      top:
        row.latestTopLevelSequence > 0
          ? row.topId
            ? {
                executionRef: row.topExecutionRef,
                id: row.topId,
                replyToMessageId: row.topReplyToMessageId,
                sequence: row.latestTopLevelSequence,
                senderKind: row.topSenderKind!,
                senderSystemId: row.topSenderSystemId,
                threadRootMessageId: null,
              }
            : null
          : undefined,
      workspaceId,
      topIsGroupVisible: historyAccess.has(row.channelId),
    })),
    historyAccess
  )
  const publicationChannelIds = channelRows
    .filter((row) => row.hasUnreadPublication)
    .map((row) => row.channelId)
  const hiddenByChannel = publicationChannelIds.length
    ? await readHiddenUnreadCounts(database, principal, {
        channelIds: publicationChannelIds,
        groupHistory: historyAccess,
        workspaceIds: [workspaceId],
      })
    : new Map<string, number>()

  // A thread is shown, and counted, only while its root is visible to the reader. A hidden root
  // leaves the thread out whole: its replies stay stored and its watermark is not touched.
  const visibleThreadRoots = new Set(
    (
      await filterVisibleMessageRows(
        database,
        threadRows.map((row) => ({
          executionRef: row.rootExecutionRef,
          id: row.rootId,
          replyToMessageId: row.rootReplyToMessageId,
          senderKind: row.rootSenderKind,
          senderSystemId: row.rootSenderSystemId,
          threadRootMessageId: null,
        })),
        principal.userId
      )
    ).map((row) => row.id)
  )
  const threadsByChannel = new Map<string, ThreadReadStateSummary[]>()
  for (const row of threadRows) {
    if (!visibleThreadRoots.has(row.threadRootMessageId)) continue
    const thread: ThreadReadStateSummary = Object.freeze({
      lastReadSequence: Math.min(row.lastReadSequence ?? 0, row.latestSequence),
      latestSequence: row.latestSequence,
      manuallyUnread: row.manuallyUnread ?? false,
      ...(row.readAt ? { readAt: row.readAt.toISOString() } : {}),
      threadRootMessageId: row.threadRootMessageId,
      unreadCount: row.unreadCount,
      ...(row.updatedAt ? { updatedAt: row.updatedAt.toISOString() } : {}),
    })
    const bucket = threadsByChannel.get(row.channelId)
    if (bucket) bucket.push(thread)
    else threadsByChannel.set(row.channelId, [thread])
  }

  return Object.freeze(
    channelRows.map((row) => {
      const threads = (threadsByChannel.get(row.channelId) ?? []).toSorted(
        (left, right) =>
          right.latestSequence - left.latestSequence ||
          left.threadRootMessageId.localeCompare(right.threadRootMessageId)
      )
      const threadUnreadCount = threads.reduce(
        (total, thread) => total + thread.unreadCount + (thread.manuallyUnread ? 1 : 0),
        0
      )
      const manuallyUnread = row.manuallyUnread ?? false
      const topLevelUnreadCount = Math.max(
        0,
        row.topLevelUnreadCount - (hiddenByChannel.get(row.channelId) ?? 0)
      )
      return Object.freeze({
        channelId: row.channelId,
        latestTopLevelSequence: frontiers.get(row.channelId) ?? 0,
        lastReadSequence: Math.min(row.lastReadSequence ?? 0, frontiers.get(row.channelId) ?? 0),
        manuallyUnread,
        ...(row.readAt ? { readAt: row.readAt.toISOString() } : {}),
        threadUnreadCount,
        threads: Object.freeze(threads),
        topLevelUnreadCount,
        unread: manuallyUnread || topLevelUnreadCount > 0 || threadUnreadCount > 0,
        ...(row.updatedAt ? { updatedAt: row.updatedAt.toISOString() } : {}),
        workspaceId,
      })
    })
  )
}

/** The newest group-authorized sequence in one thread, or at channel top level. */
async function latestSequence(
  database: Database,
  workspaceId: string,
  channelId: string,
  threadRootMessageId?: string,
  options: Readonly<{
    group?: boolean
    historyAccess?: ReadonlyMap<string, GroupHistoryAccess>
    historyScope?: 'history' | 'summary'
  }> = {}
) {
  const access = options.historyAccess ?? new Map()
  const groupVisible = options.group
    ? threadRootMessageId
      ? and(
          groupHistoryMessageAndThreadVisibleCondition({
            channelId: sql`${messages.channelId}`,
            sequence: sql`${messages.sequence}`,
            threadRootMessageId: sql`${messages.threadRootMessageId}`,
            access,
          }),
          groupSummaryMessageAndThreadVisibleCondition({
            channelId: sql`${messages.channelId}`,
            sequence: sql`${messages.sequence}`,
            threadRootMessageId: sql`${messages.threadRootMessageId}`,
            access,
          })
        )
      : and(
          groupSummaryMessageVisibleCondition({
            channelId: sql`${messages.channelId}`,
            sequence: sql`${messages.sequence}`,
            access,
          }),
          groupHistoryMessageAndThreadVisibleCondition({
            channelId: sql`${messages.channelId}`,
            sequence: sql`${messages.sequence}`,
            threadRootMessageId: sql`${messages.threadRootMessageId}`,
            access,
          })
        )
    : null
  const rows = await database
    .select({ latest: sql<number>`coalesce(max(${messages.sequence}), 0)`.mapWith(Number) })
    .from(messages)
    .where(
      and(
        eq(messages.workspaceId, workspaceId),
        eq(messages.channelId, channelId),
        isNull(messages.deletedAt),
        threadRootMessageId
          ? eq(messages.threadRootMessageId, threadRootMessageId)
          : isNull(messages.threadRootMessageId),
        ...(groupVisible ? [groupVisible] : [])
      )
    )
  return rows[0]?.latest ?? 0
}

/** A user's newest currently visible top-level message, capped by live group history. */
async function visibleChannelLatest(
  database: Database,
  workspaceId: string,
  channelId: string,
  principal: UserPrincipalRef,
  historyAccess: ReadonlyMap<string, GroupHistoryAccess>
) {
  const latest = await latestSequence(database, workspaceId, channelId, undefined, {
    group: historyAccess.has(channelId),
    historyAccess,
  })
  const frontiers = await readVisibleTopLevelFrontiers(
    database,
    principal,
    [{ channelId, latestSequence: latest, workspaceId }],
    historyAccess
  )
  return frontiers.get(channelId) ?? 0
}

async function writeChannelState(
  transaction: AgentHqTransaction,
  workspaceId: string,
  channelId: string,
  userId: string,
  target: Readonly<{ lastReadSequence: number; manuallyUnread: boolean }>,
  maxVisibleSequence: number,
  isGroup: boolean
) {
  const [existing] = await transaction
    .select()
    .from(channelReadStates)
    .where(
      and(
        eq(channelReadStates.workspaceId, workspaceId),
        eq(channelReadStates.userId, userId),
        eq(channelReadStates.channelId, channelId)
      )
    )
    .limit(1)
  // Watermarks are monotonic: a client reporting a stale sequence (for example
  // from a partially loaded message window) must never rewind the frontier and
  // resurrect notifications. Explicit unread is tracked with the manuallyUnread
  // flag instead.
  const monotonicSequence = Math.max(existing?.lastReadSequence ?? 0, target.lastReadSequence)
  const lastReadSequence = isGroup
    ? Math.min(monotonicSequence, maxVisibleSequence)
    : monotonicSequence
  if (
    existing?.lastReadSequence === lastReadSequence &&
    existing.manuallyUnread === target.manuallyUnread
  )
    return false
  const now = new Date()
  await transaction
    .insert(channelReadStates)
    .values({
      channelId,
      lastReadSequence,
      manuallyUnread: target.manuallyUnread,
      readAt: target.manuallyUnread ? existing?.readAt : now,
      userId,
      workspaceId,
    })
    .onConflictDoUpdate({
      target: [
        channelReadStates.workspaceId,
        channelReadStates.userId,
        channelReadStates.channelId,
      ],
      set: {
        // The in-memory max uses a frontier read earlier in this transaction.
        // A normal channel has no row lock to serialize concurrent writers, so
        // PostgreSQL must merge with the current row. Group writes retain their
        // visible-sequence cap; their admission locks serialize that frontier.
        lastReadSequence: isGroup
          ? sql`LEAST(GREATEST(${channelReadStates.lastReadSequence}, excluded.last_read_sequence), ${maxVisibleSequence})`
          : sql`GREATEST(${channelReadStates.lastReadSequence}, excluded.last_read_sequence)`,
        manuallyUnread: target.manuallyUnread,
        readAt: target.manuallyUnread ? existing?.readAt : now,
        updatedAt: now,
        version: sql`${channelReadStates.version} + 1`,
      },
    })
  return true
}

export async function markChannelReadState(
  database: AgentHqDatabase,
  workspaceId: string,
  channelId: string,
  principal: UserPrincipalRef,
  action: 'read' | 'unread',
  requestedSequence?: number
) {
  await database.transaction(async (transaction) => {
    const isGroup = await requireChannel(transaction, workspaceId, channelId, principal)
    const historyAccess = isGroup
      ? await groupHistoryAccessByUser(
          transaction,
          principal.userId,
          new Date().toISOString(),
          workspaceId
        )
      : new Map()
    const latest = await visibleChannelLatest(
      transaction,
      workspaceId,
      channelId,
      principal,
      historyAccess
    )
    if (
      requestedSequence !== undefined &&
      (!Number.isSafeInteger(requestedSequence) || requestedSequence < 0)
    )
      throw new Error('Read state invalid')
    const changed = await writeChannelState(
      transaction,
      workspaceId,
      channelId,
      principal.userId,
      {
        lastReadSequence:
          action === 'read' ? Math.min(requestedSequence ?? latest, latest) : latest,
        manuallyUnread: action === 'unread',
      },
      latest,
      isGroup
    )
    if (changed)
      await appendWorkspaceEvent(transaction, {
        eventType: `channel.${action}`,
        payload: { actorUserId: principal.userId, channelId },
        workspaceId,
      })
  })
  return listReadStateForUser(database, workspaceId, principal)
}

export async function markThreadReadState(
  database: AgentHqDatabase,
  workspaceId: string,
  channelId: string,
  threadRootMessageId: string,
  principal: UserPrincipalRef,
  action: 'read' | 'unread',
  requestedSequence?: number
) {
  await database.transaction(async (transaction) => {
    const isGroup = await requireChannel(transaction, workspaceId, channelId, principal)
    const historyAccess = isGroup
      ? await groupHistoryAccessByUser(
          transaction,
          principal.userId,
          new Date().toISOString(),
          workspaceId
        )
      : new Map()
    const rootVisible = isGroup
      ? groupHistoryMessageAndThreadVisibleCondition({
          channelId: sql`${messages.channelId}`,
          sequence: sql`${messages.sequence}`,
          threadRootMessageId: sql`${messages.threadRootMessageId}`,
          access: historyAccess,
        })
      : null
    const [root] = await transaction
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.id, threadRootMessageId),
          eq(messages.workspaceId, workspaceId),
          eq(messages.channelId, channelId),
          isNull(messages.threadRootMessageId),
          ...(rootVisible ? [rootVisible] : [])
        )
      )
      .limit(1)
    // A thread whose root the reader cannot see is unavailable, as a missing root is. Its
    // watermark is not written, so its replies are still unread when the root returns.
    if (!root) throw new Error('Read state unavailable')
    const latest = await latestSequence(transaction, workspaceId, channelId, threadRootMessageId, {
      group: isGroup,
      historyAccess,
      historyScope: 'history',
    })
    if ((await filterVisibleMessageRows(transaction, [root], principal.userId)).length === 0)
      throw new Error('Read state unavailable')
    if (
      requestedSequence !== undefined &&
      (!Number.isSafeInteger(requestedSequence) || requestedSequence < 0)
    )
      throw new Error('Read state invalid')
    const [existing] = await transaction
      .select()
      .from(threadReadStates)
      .where(
        and(
          eq(threadReadStates.workspaceId, workspaceId),
          eq(threadReadStates.userId, principal.userId),
          eq(threadReadStates.threadRootMessageId, threadRootMessageId)
        )
      )
      .limit(1)
    // Thread frontiers are monotonic for the same reason as channel frontiers:
    // stale client sequences must not rewind them.
    const monotonicSequence = Math.max(
      existing?.lastReadSequence ?? 0,
      action === 'read' ? Math.min(requestedSequence ?? latest, latest) : latest
    )
    const lastReadSequence = isGroup ? Math.min(monotonicSequence, latest) : monotonicSequence
    const target = {
      lastReadSequence,
      manuallyUnread: action === 'unread',
    }
    if (
      existing?.lastReadSequence === target.lastReadSequence &&
      existing.manuallyUnread === target.manuallyUnread
    )
      return
    const now = new Date()
    await transaction
      .insert(threadReadStates)
      .values({
        channelId,
        lastReadSequence: target.lastReadSequence,
        manuallyUnread: target.manuallyUnread,
        readAt: target.manuallyUnread ? existing?.readAt : now,
        threadRootMessageId,
        userId: principal.userId,
        workspaceId,
      })
      .onConflictDoUpdate({
        target: [
          threadReadStates.workspaceId,
          threadReadStates.userId,
          threadReadStates.threadRootMessageId,
        ],
        set: {
          // The in-memory max predates this write, so PostgreSQL merges with the
          // current row for normal channels. Group writes keep the visible
          // frontier cap while their admission locks serialize the update.
          lastReadSequence: isGroup
            ? sql`LEAST(GREATEST(${threadReadStates.lastReadSequence}, excluded.last_read_sequence), ${latest})`
            : sql`GREATEST(${threadReadStates.lastReadSequence}, excluded.last_read_sequence)`,
          manuallyUnread: target.manuallyUnread,
          readAt: target.manuallyUnread ? existing?.readAt : now,
          updatedAt: now,
          version: sql`${threadReadStates.version} + 1`,
        },
      })
    await appendWorkspaceEvent(transaction, {
      eventType: `thread.${action}`,
      payload: { actorUserId: principal.userId, channelId, threadRootMessageId },
      workspaceId,
    })
  })
  return listReadStateForUser(database, workspaceId, principal)
}

export async function markAllChannelsRead(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef
) {
  await database.transaction(async (transaction) => {
    const allowed = await queryAccessibleChannelIds(transaction, workspaceId, principal)
    const lockedGroups = await lockCurrentGroupChannelIdsForReadStateWrite(
      transaction,
      workspaceId,
      allowed.map(({ id }) => id),
      principal
    )
    const channelIds = allowed
      .filter(({ id }) => !lockedGroups.groupIds.has(id) || lockedGroups.inForceGroupIds.has(id))
      .map(({ id }) => id)
    if (!channelIds.length) {
      return listReadStateForUser(database, workspaceId, principal)
    }

    const historyAccess = await groupHistoryAccessByUser(
      transaction,
      principal.userId,
      new Date().toISOString(),
      workspaceId
    )
    const visibleGroupTopLevel = groupSummaryMessageVisibleCondition({
      channelId: sql`${messages.channelId}`,
      sequence: sql`${messages.sequence}`,
      access: historyAccess,
    })
    const visibleGroupThread = groupHistoryMessageAndThreadVisibleCondition({
      channelId: sql`${messages.channelId}`,
      sequence: sql`${messages.sequence}`,
      threadRootMessageId: sql`${messages.threadRootMessageId}`,
      access: historyAccess,
    })

    // Batched by construction. This used to issue four round trips per channel
    // and three per thread inside one transaction, so a workspace with 30
    // channels and 300 threads cost roughly a thousand sequential queries —
    // invisible on a local socket, seconds over a remote database. Everything
    // below is a fixed number of statements regardless of workspace size.
    const messageScope = and(
      eq(messages.workspaceId, workspaceId),
      inArray(messages.channelId, channelIds),
      isNull(messages.deletedAt)
    )
    const [channelFrontiers, threadFrontiers, existingChannels, existingThreads] =
      await Promise.all([
        transaction
          .select({
            channelId: messages.channelId,
            latest: sql<number>`max(${messages.sequence})`.mapWith(Number),
          })
          .from(messages)
          .innerJoin(channels, eq(channels.id, messages.channelId))
          .where(
            and(
              messageScope,
              isNull(messages.threadRootMessageId),
              sql`(${channels.kind} <> 'group' or ${visibleGroupTopLevel})`
            )
          )
          .groupBy(messages.channelId),
        transaction
          .select({
            channelId: messages.channelId,
            threadRootMessageId: messages.threadRootMessageId,
            latest: sql<number>`max(${messages.sequence})`.mapWith(Number),
          })
          .from(messages)
          .innerJoin(channels, eq(channels.id, messages.channelId))
          .where(
            and(
              messageScope,
              isNotNull(messages.threadRootMessageId),
              sql`(${channels.kind} <> 'group' or ${visibleGroupThread})`
            )
          )
          .groupBy(messages.channelId, messages.threadRootMessageId),
        transaction
          .select()
          .from(channelReadStates)
          .where(
            and(
              eq(channelReadStates.workspaceId, workspaceId),
              eq(channelReadStates.userId, principal.userId),
              inArray(channelReadStates.channelId, channelIds)
            )
          ),
        transaction
          .select()
          .from(threadReadStates)
          .where(
            and(
              eq(threadReadStates.workspaceId, workspaceId),
              eq(threadReadStates.userId, principal.userId),
              inArray(threadReadStates.channelId, channelIds)
            )
          ),
      ])
    const visibleChannelFrontiers = await readVisibleTopLevelFrontiers(
      transaction,
      principal,
      channelFrontiers.map((row) => ({
        channelId: row.channelId,
        latestSequence: row.latest,
        workspaceId,
      })),
      historyAccess
    )

    const existingChannelById = new Map(existingChannels.map((row) => [row.channelId, row]))
    const existingThreadByRoot = new Map(
      existingThreads.map((row) => [row.threadRootMessageId, row])
    )
    const now = new Date()
    const channelWrites: (typeof channelReadStates.$inferInsert)[] = []
    const threadWrites: (typeof threadReadStates.$inferInsert)[] = []

    for (const channelId of channelIds) {
      const latest = visibleChannelFrontiers.get(channelId) ?? 0
      const existing = existingChannelById.get(channelId)
      // The current visible window is the cap, even if a stale persisted
      // frontier was written before the participant's history narrowed.
      const lastReadSequence = latest
      const isGroup = historyAccess.has(channelId)
      if (
        existing &&
        existing.manuallyUnread === false &&
        (isGroup
          ? existing.lastReadSequence === lastReadSequence
          : existing.lastReadSequence >= lastReadSequence)
      )
        continue
      channelWrites.push({
        channelId,
        lastReadSequence,
        manuallyUnread: false,
        readAt: now,
        userId: principal.userId,
        workspaceId,
      })
    }

    // Mark-all does not run past a thread whose root the reader cannot see: its watermark stays,
    // so its replies are unread again when the root is visible.
    const threadRootRows = await transaction
      .select()
      .from(messages)
      .where(
        and(
          inArray(
            messages.id,
            threadFrontiers.flatMap((row) =>
              row.threadRootMessageId ? [row.threadRootMessageId] : []
            )
          ),
          isNull(messages.threadRootMessageId)
        )
      )
    const visibleThreadRoots = new Set(
      (await filterVisibleMessageRows(transaction, threadRootRows, principal.userId)).map(
        (row) => row.id
      )
    )
    for (const row of threadFrontiers) {
      if (!row.threadRootMessageId || !visibleThreadRoots.has(row.threadRootMessageId)) continue
      const existing = existingThreadByRoot.get(row.threadRootMessageId)
      // Hidden roots have no visible thread frontier to advance or retain.
      const targetThreadSequence = row.latest ?? 0
      const isGroup = historyAccess.has(row.channelId)
      if (
        existing &&
        existing.manuallyUnread === false &&
        (isGroup
          ? existing.lastReadSequence === targetThreadSequence
          : existing.lastReadSequence >= targetThreadSequence)
      )
        continue
      threadWrites.push({
        channelId: row.channelId,
        lastReadSequence: targetThreadSequence,
        manuallyUnread: false,
        readAt: now,
        threadRootMessageId: row.threadRootMessageId,
        userId: principal.userId,
        workspaceId,
      })
    }

    const groupChannelCaps = channelIds
      .filter((channelId) => historyAccess.has(channelId))
      .map((channelId) => ({
        channelId,
        latest: visibleChannelFrontiers.get(channelId) ?? 0,
      }))
    const groupThreadCaps = threadFrontiers.filter((row) => historyAccess.has(row.channelId))
    const channelFrontierWrite = groupChannelCaps.length
      ? sql`case
          when excluded.channel_id in (${sql.join(
            groupChannelCaps.map(({ channelId }) => sql`${channelId}::uuid`),
            sql`, `
          )}) then least(
            greatest(${channelReadStates.lastReadSequence}, excluded.last_read_sequence),
            case ${sql.join(
              groupChannelCaps.map(
                ({ channelId, latest }) =>
                  sql`when excluded.channel_id = ${channelId}::uuid then ${latest}`
              ),
              sql` `
            )} else 0 end
          )
          else greatest(${channelReadStates.lastReadSequence}, excluded.last_read_sequence)
        end`
      : sql`greatest(${channelReadStates.lastReadSequence}, excluded.last_read_sequence)`
    const threadFrontierWrite = groupThreadCaps.length
      ? sql`case
          when excluded.thread_root_message_id in (${sql.join(
            groupThreadCaps.map(({ threadRootMessageId }) => sql`${threadRootMessageId}::uuid`),
            sql`, `
          )}) then least(
            greatest(${threadReadStates.lastReadSequence}, excluded.last_read_sequence),
            case ${sql.join(
              groupThreadCaps.map(
                ({ threadRootMessageId, latest }) =>
                  sql`when excluded.thread_root_message_id = ${threadRootMessageId}::uuid then ${latest ?? 0}`
              ),
              sql` `
            )} else 0 end
          )
          else greatest(${threadReadStates.lastReadSequence}, excluded.last_read_sequence)
        end`
      : sql`greatest(${threadReadStates.lastReadSequence}, excluded.last_read_sequence)`

    if (channelWrites.length > 0) {
      await transaction
        .insert(channelReadStates)
        .values(channelWrites)
        .onConflictDoUpdate({
          target: [
            channelReadStates.workspaceId,
            channelReadStates.userId,
            channelReadStates.channelId,
          ],
          set: {
            lastReadSequence: channelFrontierWrite,
            manuallyUnread: false,
            readAt: now,
            updatedAt: now,
            version: sql`${channelReadStates.version} + 1`,
          },
        })
    }
    if (threadWrites.length > 0) {
      await transaction
        .insert(threadReadStates)
        .values(threadWrites)
        .onConflictDoUpdate({
          target: [
            threadReadStates.workspaceId,
            threadReadStates.userId,
            threadReadStates.threadRootMessageId,
          ],
          set: {
            lastReadSequence: threadFrontierWrite,
            manuallyUnread: false,
            readAt: now,
            updatedAt: now,
            version: sql`${threadReadStates.version} + 1`,
          },
        })
    }

    if (channelWrites.length > 0 || threadWrites.length > 0)
      await appendWorkspaceEvent(transaction, {
        eventType: 'workspace.read_all',
        payload: { actorUserId: principal.userId },
        workspaceId,
      })
  })
  return listReadStateForUser(database, workspaceId, principal)
}
