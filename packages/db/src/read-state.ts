import type {
  ChannelReadStateSummary,
  ThreadReadStateSummary,
  UserPrincipalRef,
} from '@adea-ai/types'
import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { appendWorkspaceEvent } from './transactions'
import {
  channelParticipants,
  channelReadStates,
  channels,
  messages,
  threadReadStates,
  workspaceMemberships,
} from './schema'

type Database = AgentHqDatabase | AgentHqTransaction

async function requireMembership(
  database: Database,
  workspaceId: string,
  principal: UserPrincipalRef
) {
  const [membership] = await database
    .select({ id: workspaceMemberships.id })
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, principal.userId)
      )
    )
    .limit(1)
  if (!membership) throw new Error('Read state unavailable')
}

export async function listAccessibleChannelIds(
  database: Database,
  workspaceId: string,
  principal: UserPrincipalRef
) {
  await requireMembership(database, workspaceId, principal)
  return database
    .select({ id: channels.id })
    .from(channels)
    .leftJoin(
      channelParticipants,
      and(
        eq(channelParticipants.channelId, channels.id),
        eq(channelParticipants.principalKind, 'user'),
        eq(channelParticipants.userId, principal.userId)
      )
    )
    .where(
      and(
        eq(channels.workspaceId, workspaceId),
        eq(channels.lifecycleState, 'active'),
        or(eq(channels.visibility, 'workspace'), eq(channelParticipants.userId, principal.userId))
      )
    )
    .orderBy(asc(channels.id))
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

export async function listReadStateForUser(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef
): Promise<readonly ChannelReadStateSummary[]> {
  const allowed = await listAccessibleChannelIds(database, workspaceId, principal)
  const channelIds = allowed.map(({ id }) => id)
  if (!channelIds.length) return Object.freeze([])
  const [channelStates, threadStates, messageRows] = await Promise.all([
    database
      .select()
      .from(channelReadStates)
      .where(
        and(
          eq(channelReadStates.workspaceId, workspaceId),
          eq(channelReadStates.userId, principal.userId),
          inArray(channelReadStates.channelId, channelIds)
        )
      ),
    database
      .select()
      .from(threadReadStates)
      .where(
        and(
          eq(threadReadStates.workspaceId, workspaceId),
          eq(threadReadStates.userId, principal.userId),
          inArray(threadReadStates.channelId, channelIds)
        )
      ),
    database
      .select({
        channelId: messages.channelId,
        id: messages.id,
        sequence: messages.sequence,
        threadRootMessageId: messages.threadRootMessageId,
      })
      .from(messages)
      .where(
        and(
          eq(messages.workspaceId, workspaceId),
          inArray(messages.channelId, channelIds),
          isNull(messages.deletedAt)
        )
      )
      .orderBy(asc(messages.sequence)),
  ])
  const channelStateById = new Map(channelStates.map((state) => [state.channelId, state]))
  const threadStateByRoot = new Map(threadStates.map((state) => [state.threadRootMessageId, state]))
  // Group the message window by channel once, up front. Filtering the full
  // window inside the per-channel map below was O(channels x messages), and
  // `rows.at(-1)` / `topLevel.filter` re-walked each channel's slice again for
  // every read — all invisible at fixture sizes, quadratic on a real workspace.
  const messagesByChannel = new Map<string, typeof messageRows>()
  for (const message of messageRows) {
    const bucket = messagesByChannel.get(message.channelId)
    if (bucket) bucket.push(message)
    else messagesByChannel.set(message.channelId, [message])
  }

  return Object.freeze(
    channelIds.map((channelId) => {
      const channelState = channelStateById.get(channelId)
      const channelMessages = messagesByChannel.get(channelId) ?? []
      const topLevel = channelMessages.filter((message) => !message.threadRootMessageId)
      const lastReadSequence = channelState?.lastReadSequence ?? 0
      const latestTopLevelSequence = topLevel.at(-1)?.sequence ?? 0
      const topLevelUnreadCount = topLevel.filter(
        ({ sequence }) => sequence > lastReadSequence
      ).length
      const repliesByRoot = new Map<string, (typeof channelMessages)[number][]>()
      for (const message of channelMessages) {
        if (!message.threadRootMessageId) continue
        const bucket = repliesByRoot.get(message.threadRootMessageId)
        // Push, never rebuild: `[...existing, message]` copied the whole
        // bucket per reply, so a thread with R replies cost O(R^2).
        if (bucket) bucket.push(message)
        else repliesByRoot.set(message.threadRootMessageId, [message])
      }
      const threads: ThreadReadStateSummary[] = [...repliesByRoot.entries()]
        .map(([threadRootMessageId, replies]) => {
          const threadState = threadStateByRoot.get(threadRootMessageId)
          const effectiveReadSequence = threadState?.lastReadSequence ?? 0
          const latestReplySequence = replies.at(-1)?.sequence ?? 0
          return Object.freeze({
            lastReadSequence: threadState?.lastReadSequence ?? 0,
            latestSequence: latestReplySequence,
            manuallyUnread: threadState?.manuallyUnread ?? false,
            ...(threadState?.readAt ? { readAt: threadState.readAt.toISOString() } : {}),
            threadRootMessageId,
            unreadCount: replies.filter(({ sequence }) => sequence > effectiveReadSequence).length,
            ...(threadState?.updatedAt ? { updatedAt: threadState.updatedAt.toISOString() } : {}),
          })
        })
        .toSorted(
          (left, right) =>
            right.latestSequence - left.latestSequence ||
            left.threadRootMessageId.localeCompare(right.threadRootMessageId)
        )
      const threadUnreadCount = threads.reduce(
        (total, thread) => total + thread.unreadCount + (thread.manuallyUnread ? 1 : 0),
        0
      )
      const manuallyUnread = channelState?.manuallyUnread ?? false
      return Object.freeze({
        channelId,
        lastReadSequence,
        latestTopLevelSequence,
        manuallyUnread,
        ...(channelState?.readAt ? { readAt: channelState.readAt.toISOString() } : {}),
        threadUnreadCount,
        threads: Object.freeze(threads),
        topLevelUnreadCount,
        unread: manuallyUnread || topLevelUnreadCount > 0 || threadUnreadCount > 0,
        ...(channelState?.updatedAt ? { updatedAt: channelState.updatedAt.toISOString() } : {}),
        workspaceId,
      })
    })
  )
}

async function latestSequence(
  database: Database,
  workspaceId: string,
  channelId: string,
  threadRootMessageId?: string
) {
  const rows = await database
    .select({ sequence: messages.sequence })
    .from(messages)
    .where(
      and(
        eq(messages.workspaceId, workspaceId),
        eq(messages.channelId, channelId),
        isNull(messages.deletedAt),
        threadRootMessageId
          ? eq(messages.threadRootMessageId, threadRootMessageId)
          : isNull(messages.threadRootMessageId)
      )
    )
    .orderBy(asc(messages.sequence))
  return rows.at(-1)?.sequence ?? 0
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
        lastReadSequence,
        manuallyUnread: target.manuallyUnread,
        readAt: target.manuallyUnread ? existing?.readAt : now,
        updatedAt: now,
        version: (existing?.version ?? 0) + 1,
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
    const latest = await latestSequence(transaction, workspaceId, channelId)
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
    if (!root) throw new Error('Read state unavailable')
    const latest = await latestSequence(transaction, workspaceId, channelId, threadRootMessageId)
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
          lastReadSequence: target.lastReadSequence,
          manuallyUnread: target.manuallyUnread,
          readAt: target.manuallyUnread ? existing?.readAt : now,
          updatedAt: now,
          version: (existing?.version ?? 0) + 1,
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
    const [channelFrontiers, threadFrontiers, existingChannels, existingThreads] =
      await Promise.all([
        transaction
          .select({
            channelId: messages.channelId,
            latest: sql<number>`max(${messages.sequence})`,
          })
          .from(messages)
          .where(and(messageScope, isNull(messages.threadRootMessageId)))
          .groupBy(messages.channelId),
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
      const latest = channelFrontiers.find((row) => row.channelId === channelId)?.latest ?? 0
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

    for (const row of threadFrontiers) {
      if (!row.threadRootMessageId) continue
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
