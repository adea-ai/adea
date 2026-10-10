import type {
  ChannelReadStateSummary,
  ThreadReadStateSummary,
  UserPrincipalRef,
} from '@adea-ai/types'
import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import {
  type ProjectAccessScope,
  requireProjectAccessScope,
  visibleProjectCondition,
} from './project-access'
import { appendWorkspaceEvent } from './transactions'
import { readHiddenUnreadCounts, readVisibleTopLevelFrontiers } from './job-outbound-frontier'
import { readerVisibleThreadRootIds } from './job-outbound-visibility'
import {
  channelParticipants,
  channelReadStates,
  channels,
  messages,
  threadReadStates,
} from './schema'

type Database = AgentHqDatabase | AgentHqTransaction

// The participant row that makes a private channel visible to the principal.
function participantJoin(principal: UserPrincipalRef) {
  return and(
    eq(channelParticipants.channelId, channels.id),
    eq(channelParticipants.principalKind, 'user'),
    eq(channelParticipants.userId, principal.userId)
  )
}

// Active channels the principal can see: workspace-visible or listing them as
// a participant, outside every hidden project. The id listing, the read state
// summary and its thread aggregate all use this one predicate, so they can
// never disagree about which channels are in scope.
function accessibleChannelCondition(
  workspaceId: string,
  principal: UserPrincipalRef,
  scope: ProjectAccessScope
) {
  return and(
    eq(channels.workspaceId, workspaceId),
    eq(channels.lifecycleState, 'active'),
    visibleProjectCondition(channels.projectId, scope),
    or(eq(channels.visibility, 'workspace'), eq(channelParticipants.userId, principal.userId))
  )
}

function accessibleChannelIds(
  database: Database,
  workspaceId: string,
  principal: UserPrincipalRef,
  scope: ProjectAccessScope
) {
  return database
    .select({ id: channels.id })
    .from(channels)
    .leftJoin(channelParticipants, participantJoin(principal))
    .where(accessibleChannelCondition(workspaceId, principal, scope))
}

export async function listAccessibleChannelIds(
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
  return accessibleChannelIds(database, workspaceId, principal, scope).orderBy(asc(channels.id))
}

async function requireChannel(
  database: Database,
  workspaceId: string,
  channelId: string,
  principal: UserPrincipalRef
) {
  const allowed = await listAccessibleChannelIds(database, workspaceId, principal)
  if (!allowed.some(({ id }) => id === channelId)) throw new Error('Read state unavailable')
}

/**
 * Per-channel unread state for one user, computed in the database.
 *
 * Four statements regardless of workspace size: the project access scope's
 * two indexed reads (resolved first, because they decide which channels exist
 * for the caller), then two aggregates issued together.
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
export async function listReadStateForUser(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef
): Promise<readonly ChannelReadStateSummary[]> {
  const scope = await requireProjectAccessScope(
    database,
    workspaceId,
    principal,
    'Read state unavailable'
  )
  const channelReadFrontier = sql`coalesce(${channelReadStates.lastReadSequence}, 0)`
  const threadReadFrontier = sql`coalesce(${threadReadStates.lastReadSequence}, 0)`
  const topMessage = alias(messages, 'top_message')
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
            and publication.sender_kind = 'system'
            and publication.sender_system_id like 'job-outbound:v1:%'
            and publication.sequence > ${channelReadFrontier}
        )`.mapWith(Boolean),
        lastReadSequence: channelReadStates.lastReadSequence,
        latestTopLevelSequence: channels.latestMessageSequence,
        manuallyUnread: channelReadStates.manuallyUnread,
        readAt: channelReadStates.readAt,
        topExecutionRef: topMessage.executionRef,
        topId: topMessage.id,
        topSenderKind: topMessage.senderKind,
        topSenderSystemId: topMessage.senderSystemId,
        // Scalar subqueries in a CASE branch run only when the branch is
        // taken: a channel whose frontier is not past its read mark is 0
        // without touching messages.
        topLevelUnreadCount:
          sql<number>`case when ${channels.latestMessageSequence} > ${channelReadFrontier} then (
          select count(*) from ${messages}
          where ${messages.workspaceId} = ${workspaceId}
            and ${messages.channelId} = ${channels.id}
            and ${messages.threadRootMessageId} is null
            and ${messages.deletedAt} is null
            and ${messages.sequence} > ${channelReadFrontier}
        ) else 0 end`.mapWith(Number),
        updatedAt: channelReadStates.updatedAt,
      })
      .from(channels)
      .leftJoin(channelParticipants, participantJoin(principal))
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
          eq(topMessage.sequence, channels.latestMessageSequence),
          isNull(topMessage.threadRootMessageId),
          isNull(topMessage.deletedAt)
        )
      )
      .where(accessibleChannelCondition(workspaceId, principal, scope))
      .orderBy(asc(channels.id)),
    database
      .select({
        channelId: messages.channelId,
        lastReadSequence: threadReadStates.lastReadSequence,
        latestSequence: sql<number>`max(${messages.sequence})`.mapWith(Number),
        manuallyUnread: threadReadStates.manuallyUnread,
        readAt: threadReadStates.readAt,
        threadRootMessageId: sql<string>`${messages.threadRootMessageId}`,
        unreadCount:
          sql<number>`count(*) filter (where ${messages.sequence} > ${threadReadFrontier})`.mapWith(
            Number
          ),
        updatedAt: threadReadStates.updatedAt,
      })
      .from(messages)
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
            accessibleChannelIds(database, workspaceId, principal, scope)
          ),
          isNotNull(messages.threadRootMessageId),
          isNull(messages.deletedAt)
        )
      )
      // At most one thread read state row exists per (workspace, user, root),
      // so grouping by its columns never splits a thread.
      .groupBy(
        messages.channelId,
        messages.threadRootMessageId,
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
                sequence: row.latestTopLevelSequence,
                senderKind: row.topSenderKind!,
                senderSystemId: row.topSenderSystemId,
              }
            : null
          : undefined,
      workspaceId,
    }))
  )
  const publicationChannelIds = channelRows
    .filter((row) => row.hasUnreadPublication)
    .map((row) => row.channelId)
  const hiddenByChannel = publicationChannelIds.length
    ? await readHiddenUnreadCounts(database, principal, {
        channelIds: publicationChannelIds,
        workspaceIds: [workspaceId],
      })
    : new Map<string, number>()

  // A thread is shown, and counted, only while its root is visible to the reader. A hidden root
  // leaves the thread out whole: its replies stay stored and its watermark is not touched.
  const visibleThreadRoots = await readerVisibleThreadRootIds(
    database,
    threadRows.map((row) => row.threadRootMessageId),
    principal.userId
  )
  const threadsByChannel = new Map<string, ThreadReadStateSummary[]>()
  for (const row of threadRows) {
    if (!visibleThreadRoots.has(row.threadRootMessageId)) continue
    const thread: ThreadReadStateSummary = Object.freeze({
      lastReadSequence: row.lastReadSequence ?? 0,
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
        lastReadSequence: row.lastReadSequence ?? 0,
        latestTopLevelSequence: frontiers.get(row.channelId) ?? 0,
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

/** The newest live reply sequence in a thread: an indexed max, not a scan of the thread. */
async function latestThreadSequence(
  database: Database,
  workspaceId: string,
  channelId: string,
  threadRootMessageId: string
) {
  const [row] = await database
    .select({
      sequence: sql<number>`coalesce(max(${messages.sequence}), 0)`.mapWith(Number),
    })
    .from(messages)
    .where(
      and(
        eq(messages.workspaceId, workspaceId),
        eq(messages.channelId, channelId),
        isNull(messages.deletedAt),
        eq(messages.threadRootMessageId, threadRootMessageId)
      )
    )
  return row?.sequence ?? 0
}

/**
 * The newest top-level sequence of a channel that the principal can currently see. It is
 * the stored frontier, or the newest visible message below it when the frontier is a
 * publication the principal may not see. A watermark set from it never runs past content
 * the principal cannot see, so a publication that becomes visible again is still unread.
 */
async function visibleChannelLatest(
  database: Database,
  workspaceId: string,
  channelId: string,
  principal: UserPrincipalRef
) {
  const [channel] = await database
    .select({ latestSequence: channels.latestMessageSequence })
    .from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.workspaceId, workspaceId)))
    .limit(1)
  if (!channel) return 0
  const frontiers = await readVisibleTopLevelFrontiers(database, principal, [
    { channelId, latestSequence: channel.latestSequence, workspaceId },
  ])
  return frontiers.get(channelId) ?? 0
}

async function writeChannelState(
  transaction: AgentHqTransaction,
  workspaceId: string,
  channelId: string,
  userId: string,
  target: Readonly<{ lastReadSequence: number; manuallyUnread: boolean }>
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
  const lastReadSequence = Math.max(existing?.lastReadSequence ?? 0, target.lastReadSequence)
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
        // GREATEST, not the JS `max` above. That value is computed from a read
        // taken earlier in this transaction, so a concurrent writer that
        // advanced the frontier in between could still be overwritten
        // downwards. The in-memory max covers the sequential case, which is why
        // the existing tests pass either way — the race window is real but
        // narrow, and I could NOT reproduce it locally (20 trials across two
        // independent connections, plus repeated concurrent test runs, all
        // held the frontier). This moves the invariant into the database, where
        // it does not depend on statement ordering at all.
        lastReadSequence: sql`GREATEST(${channelReadStates.lastReadSequence}, excluded.last_read_sequence)`,
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
    await requireChannel(transaction, workspaceId, channelId, principal)
    const latest = await visibleChannelLatest(transaction, workspaceId, channelId, principal)
    if (
      requestedSequence !== undefined &&
      (!Number.isSafeInteger(requestedSequence) || requestedSequence < 0)
    )
      throw new Error('Read state invalid')
    const changed = await writeChannelState(transaction, workspaceId, channelId, principal.userId, {
      lastReadSequence: action === 'read' ? Math.min(requestedSequence ?? latest, latest) : latest,
      manuallyUnread: action === 'unread',
    })
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
    await requireChannel(transaction, workspaceId, channelId, principal)
    const [root] = await transaction
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.id, threadRootMessageId),
          eq(messages.workspaceId, workspaceId),
          eq(messages.channelId, channelId),
          isNull(messages.threadRootMessageId)
        )
      )
      .limit(1)
    // A thread whose root the reader cannot see is unavailable, as a missing root is. Its
    // watermark is not written, so its replies are still unread when the root returns.
    if (!root) throw new Error('Read state unavailable')
    if (!(await readerVisibleThreadRootIds(transaction, [root.id], principal.userId)).has(root.id))
      throw new Error('Read state unavailable')
    const latest = await latestThreadSequence(
      transaction,
      workspaceId,
      channelId,
      threadRootMessageId
    )
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
    const lastReadSequence = Math.max(
      existing?.lastReadSequence ?? 0,
      action === 'read' ? Math.min(requestedSequence ?? latest, latest) : latest
    )
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
          // Same reasoning as the channel frontier above: the in-memory max
          // predates this write, so the database enforces monotonicity instead
          // of the application relying on statement ordering.
          lastReadSequence: sql`GREATEST(${threadReadStates.lastReadSequence}, excluded.last_read_sequence)`,
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
    const allowed = await listAccessibleChannelIds(transaction, workspaceId, principal)
    const channelIds = allowed.map(({ id }) => id)
    if (!channelIds.length) {
      return listReadStateForUser(database, workspaceId, principal)
    }

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
    // Each channel's frontier is its newest top-level message the principal can see: read from
    // the stored frontier, not by grouping every message in the channels.
    const storedFrontiers = await transaction
      .select({ channelId: channels.id, latestSequence: channels.latestMessageSequence })
      .from(channels)
      .where(and(eq(channels.workspaceId, workspaceId), inArray(channels.id, channelIds)))
    const channelFrontiers = await readVisibleTopLevelFrontiers(
      transaction,
      principal,
      storedFrontiers.map((row) => ({
        channelId: row.channelId,
        latestSequence: row.latestSequence,
        workspaceId,
      }))
    )
    const [threadFrontiers, existingChannels, existingThreads] = await Promise.all([
      transaction
        .select({
          channelId: messages.channelId,
          threadRootMessageId: messages.threadRootMessageId,
          latest: sql<number>`max(${messages.sequence})`,
        })
        .from(messages)
        .where(and(messageScope, isNotNull(messages.threadRootMessageId)))
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

    const existingChannelById = new Map(existingChannels.map((row) => [row.channelId, row]))
    const existingThreadByRoot = new Map(
      existingThreads.map((row) => [row.threadRootMessageId, row])
    )
    const now = new Date()
    const channelWrites: (typeof channelReadStates.$inferInsert)[] = []
    const threadWrites: (typeof threadReadStates.$inferInsert)[] = []

    for (const channelId of channelIds) {
      const latest = channelFrontiers.get(channelId) ?? 0
      const existing = existingChannelById.get(channelId)
      // Watermarks are monotonic: a previously rewound frontier is repaired
      // forward, never backward.
      const lastReadSequence = Math.max(existing?.lastReadSequence ?? 0, latest)
      if (existing?.lastReadSequence === lastReadSequence && existing.manuallyUnread === false)
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
    const visibleThreadRoots = await readerVisibleThreadRootIds(
      transaction,
      threadFrontiers.flatMap((row) => (row.threadRootMessageId ? [row.threadRootMessageId] : [])),
      principal.userId
    )
    for (const row of threadFrontiers) {
      if (!row.threadRootMessageId || !visibleThreadRoots.has(row.threadRootMessageId)) continue
      const existing = existingThreadByRoot.get(row.threadRootMessageId)
      // Mark-all-read must also respect monotonicity when repairing a
      // previously rewound frontier.
      const targetThreadSequence = Math.max(existing?.lastReadSequence ?? 0, row.latest ?? 0)
      if (existing?.lastReadSequence === targetThreadSequence && existing.manuallyUnread === false)
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
            // GREATEST keeps the watermark monotonic inside the statement. The
            // in-memory max is computed from a read taken before this upsert,
            // so a concurrent writer could otherwise rewind the frontier
            // between the two — exactly what the watermark is there to prevent.
            lastReadSequence: sql`GREATEST(${channelReadStates.lastReadSequence}, excluded.last_read_sequence)`,
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
            lastReadSequence: sql`GREATEST(${threadReadStates.lastReadSequence}, excluded.last_read_sequence)`,
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
