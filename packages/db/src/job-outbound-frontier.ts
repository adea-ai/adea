/*
 * Current-authority read facts for job publications (#1217): the newest top-level
 * sequence a reader can see in a channel, and the unread job publications a reader is
 * no longer authorized for. Unread counts, the exposed frontier, mark-read and the
 * account summaries all use these, so a publication counts only while it is visible to
 * the reader. Visibility is decided by the canonical publication gates that history and
 * delivery apply (`filterVisibleJobOutboundRows`); nothing here widens access.
 *
 * Bounds. Every read is a page, and each page is gated in one bulk pass, so the statement
 * count grows with pages, never with publications.
 * - The stored frontier `channels.latest_message_sequence` is the starting point and is
 *   indexed. A channel whose newest top-level message is ordinary costs nothing more.
 * - A walk past hidden publications reads the channel index downwards in batches of
 *   WALK_BATCH, gates each batch once, and stops at the first ordinary message or visible
 *   publication. It costs the hidden publications at the top of that channel, in batches.
 * - Unread publications are scanned in keyset pages of UNREAD_PUBLICATION_PAGE, in message
 *   sequence order. Only per-channel counts are kept between pages, never the rows.
 * Nothing reads history below a reader's watermark or above a visible message.
 */
import type { UserPrincipalRef } from '@adea-ai/types'
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, like, lt, sql } from 'drizzle-orm'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { JOB_OUTBOUND_SENDER_PREFIX, isJobOutboundSenderValue } from './job-outbound-binding'
import { filterVisibleJobOutboundRows } from './job-outbound-read'
import { readerVisibleThreadRootIds } from './job-outbound-visibility'
import { channelReadStates, channels, messages, threadReadStates } from './schema'

type Database = AgentHqDatabase | AgentHqTransaction

/** Walk batch size: one indexed read and one bulk gate per batch of top-level messages. */
export const WALK_BATCH = 64

/** Unread publications read and gated per page of a scan. */
export const UNREAD_PUBLICATION_PAGE = 200

type MessageFact = Readonly<{
  channelId: string
  executionRef: string | null
  id: string
  sequence: number
  senderKind: string
  senderSystemId: string | null
  workspaceId: string
}>

const messageFact = {
  channelId: messages.channelId,
  executionRef: messages.executionRef,
  id: messages.id,
  sequence: messages.sequence,
  senderKind: messages.senderKind,
  senderSystemId: messages.senderSystemId,
  workspaceId: messages.workspaceId,
}

function isPublication(row: Pick<TopMessage, 'senderKind' | 'senderSystemId'>): boolean {
  return row.senderKind === 'system' && isJobOutboundSenderValue(row.senderSystemId)
}

/**
 * The stored frontier message of a channel: the newest live top-level message. A caller
 * that already joined it in its own query passes it, so the frontier costs no extra read.
 */
export type TopMessage = Readonly<{
  executionRef: string | null
  id: string
  sequence: number
  senderKind: string
  senderSystemId: string | null
}>

/** The ids of the publications in `rows` the reader is currently authorized for. */
async function authorizedPublicationIds(
  database: Database,
  readerUserId: string,
  rows: readonly Pick<TopMessage, 'executionRef' | 'id' | 'senderKind' | 'senderSystemId'>[]
): Promise<ReadonlySet<string>> {
  const publications = rows.filter(isPublication)
  if (!publications.length) return new Set()
  const visible = await filterVisibleJobOutboundRows(database, publications, readerUserId)
  return new Set(visible.map((row) => row.id))
}

/**
 * The newest top-level sequence in one channel that the reader can see, starting below
 * `below`. Ordinary messages are always visible; a publication is visible only when the
 * reader is authorized for it. Returns 0 when nothing visible remains.
 */
async function walkVisibleFrom(
  database: Database,
  principal: UserPrincipalRef,
  channel: Readonly<{ channelId: string; workspaceId: string }>,
  below: number
): Promise<number> {
  let cursor = below
  for (;;) {
    const batch: MessageFact[] = await database
      .select(messageFact)
      .from(messages)
      .where(
        and(
          eq(messages.workspaceId, channel.workspaceId),
          eq(messages.channelId, channel.channelId),
          isNull(messages.threadRootMessageId),
          isNull(messages.deletedAt),
          lt(messages.sequence, cursor)
        )
      )
      .orderBy(desc(messages.sequence))
      .limit(WALK_BATCH)
    if (!batch.length) return 0
    // Newest first, the walk stops at the first ordinary message, so only the run of publications
    // above it is gated, in one bulk pass. Nothing below that message is read or gated.
    const run: MessageFact[] = []
    for (const row of batch) {
      run.push(row)
      if (!isPublication(row)) break
    }
    const visible = new Set(
      (await filterVisibleJobOutboundRows(database, run, principal.userId)).map((row) => row.id)
    )
    for (const row of run) if (visible.has(row.id)) return row.sequence
    cursor = batch.at(-1)!.sequence
  }
}

/**
 * The newest top-level sequence each channel exposes to the reader. `latestSequence` is
 * the stored frontier. The result is that frontier, or the newest visible message below
 * it when the stored frontier is a publication the reader may not see.
 */
export async function readVisibleTopLevelFrontiers(
  database: Database,
  principal: UserPrincipalRef,
  channelRows: ReadonlyArray<
    Readonly<{
      channelId: string
      latestSequence: number
      /**
       * The stored frontier message when the caller joined it (`null` if the frontier is stale).
       * Omit it to have it looked up here.
       */
      top?: TopMessage | null
      workspaceId: string
    }>
  >
): Promise<Map<string, number>> {
  const frontiers = new Map<string, number>()
  const pending = channelRows.filter((row) => row.latestSequence > 0)
  for (const row of channelRows) if (row.latestSequence <= 0) frontiers.set(row.channelId, 0)
  if (!pending.length) return frontiers

  // Sequence is globally unique, so one indexed lookup finds the stored frontier message of
  // every pending channel that did not join it.
  const unjoined = pending.filter((row) => row.top === undefined)
  const looked: TopMessage[] = unjoined.length
    ? await database
        .select({
          executionRef: messages.executionRef,
          id: messages.id,
          sequence: messages.sequence,
          senderKind: messages.senderKind,
          senderSystemId: messages.senderSystemId,
        })
        .from(messages)
        .where(
          and(
            inArray(
              messages.sequence,
              unjoined.map((row) => row.latestSequence)
            ),
            isNull(messages.threadRootMessageId),
            isNull(messages.deletedAt)
          )
        )
    : []
  const lookedByChannel = new Map<string, TopMessage>()
  for (const row of looked) {
    const channel = unjoined.find((candidate) => candidate.latestSequence === row.sequence)
    if (channel) lookedByChannel.set(channel.channelId, row)
  }
  const tops = new Map<string, TopMessage | null>()
  for (const row of pending) {
    tops.set(
      row.channelId,
      row.top !== undefined ? row.top : (lookedByChannel.get(row.channelId) ?? null)
    )
  }
  const authorized = await authorizedPublicationIds(
    database,
    principal.userId,
    [...tops.values()].filter((top): top is TopMessage => top !== null)
  )

  for (const row of pending) {
    const top = tops.get(row.channelId) ?? null
    if (top && (!isPublication(top) || authorized.has(top.id))) {
      frontiers.set(row.channelId, top.sequence)
      continue
    }
    // A stored frontier with no live message is stale: walk from just above it. A hidden
    // publication walks from just below it.
    frontiers.set(
      row.channelId,
      await walkVisibleFrom(
        database,
        principal,
        { channelId: row.channelId, workspaceId: row.workspaceId },
        top ? top.sequence : row.latestSequence + 1
      )
    )
  }
  return frontiers
}

/** One page of a scan: the publications read, and the ids of those the reader may still see. */
export type UnreadPublicationPage = Readonly<{
  rows: readonly MessageFact[]
  visibleIds: ReadonlySet<string>
}>

/**
 * Walks the job publications past each channel's read watermark in pages of
 * UNREAD_PUBLICATION_PAGE, in message sequence order, and gates each page in one bulk pass.
 * `visit` receives each page and returns true to stop. Only one page is held at a time.
 * `workspaceIds` bounds the scan; `channelIds`, when given, narrows it further.
 */
export async function scanUnreadJobPublications(
  database: Database,
  principal: UserPrincipalRef,
  scope: Readonly<{ channelIds?: readonly string[]; workspaceIds: readonly string[] }>,
  visit: (page: UnreadPublicationPage) => boolean
): Promise<void> {
  if (!scope.workspaceIds.length || scope.channelIds?.length === 0) return
  // Starts from the channels that have unread, so the scan covers the unread range of those
  // channels and nothing older. The message sequence is unique, so it pages without ties.
  let after = 0
  for (;;) {
    const rows: MessageFact[] = await database
      .select(messageFact)
      .from(channels)
      .leftJoin(
        channelReadStates,
        and(
          eq(channelReadStates.workspaceId, channels.workspaceId),
          eq(channelReadStates.userId, principal.userId),
          eq(channelReadStates.channelId, channels.id)
        )
      )
      .innerJoin(
        messages,
        and(
          eq(messages.channelId, channels.id),
          eq(messages.workspaceId, channels.workspaceId),
          sql`${messages.sequence} > coalesce(${channelReadStates.lastReadSequence}, 0)`
        )
      )
      .where(
        and(
          inArray(channels.workspaceId, [...scope.workspaceIds]),
          ...(scope.channelIds ? [inArray(channels.id, [...scope.channelIds])] : []),
          sql`${channels.latestMessageSequence} > coalesce(${channelReadStates.lastReadSequence}, 0)`,
          isNull(messages.threadRootMessageId),
          isNull(messages.deletedAt),
          eq(messages.senderKind, 'system'),
          like(messages.senderSystemId, `${JOB_OUTBOUND_SENDER_PREFIX}%`),
          gt(messages.sequence, after)
        )
      )
      .orderBy(asc(messages.sequence))
      .limit(UNREAD_PUBLICATION_PAGE)
    if (!rows.length) return
    const visibleIds = new Set(
      (await filterVisibleJobOutboundRows(database, rows, principal.userId)).map((row) => row.id)
    )
    if (visit({ rows, visibleIds })) return
    if (rows.length < UNREAD_PUBLICATION_PAGE) return
    after = rows[rows.length - 1]!.sequence
  }
}

/**
 * Unread job publications the reader may no longer see, counted per channel. Only the counts
 * are kept, page by page, so the memory held does not grow with the number of publications.
 */
export async function readHiddenUnreadCounts(
  database: Database,
  principal: UserPrincipalRef,
  scope: Readonly<{ channelIds?: readonly string[]; workspaceIds: readonly string[] }>
): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  await scanUnreadJobPublications(database, principal, scope, ({ rows, visibleIds }) => {
    for (const row of rows)
      if (!visibleIds.has(row.id)) counts.set(row.channelId, (counts.get(row.channelId) ?? 0) + 1)
    return false
  })
  return counts
}

/**
 * Of `channelIds`, the channels with at least one unread job publication the reader is still
 * authorized for. The scan stops once every channel has one.
 */
export async function readChannelsWithVisibleUnreadPublication(
  database: Database,
  principal: UserPrincipalRef,
  scope: Readonly<{ channelIds: readonly string[]; workspaceIds: readonly string[] }>
): Promise<Set<string>> {
  const pending = new Set(scope.channelIds)
  const found = new Set<string>()
  if (!pending.size) return found
  await scanUnreadJobPublications(
    database,
    principal,
    { channelIds: [...pending], workspaceIds: scope.workspaceIds },
    ({ rows, visibleIds }) => {
      for (const row of rows) if (visibleIds.has(row.id)) found.add(row.channelId)
      return found.size === pending.size
    }
  )
  return found
}

/**
 * Unread thread replies the reader may no longer see, per channel. A thread counts as read state
 * counts it: the replies past its watermark, plus one for a manual mark. Only the threads with
 * unread are read, one row each, and their roots are decided in one batch. A visible thread is
 * left to the caller's own count, so this returns only what must be subtracted.
 */
export async function readHiddenThreadUnreadCounts(
  database: Database,
  principal: UserPrincipalRef,
  scope: Readonly<{ channelIds: readonly string[]; workspaceIds: readonly string[] }>
): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  if (!scope.channelIds.length || !scope.workspaceIds.length) return counts
  const threads = await database
    .select({
      channelId: messages.channelId,
      manuallyUnread: threadReadStates.manuallyUnread,
      threadRootMessageId: messages.threadRootMessageId,
      unread:
        sql<number>`count(*) filter (where ${messages.sequence} > coalesce(${threadReadStates.lastReadSequence}, 0))`.mapWith(
          Number
        ),
    })
    .from(messages)
    .leftJoin(
      threadReadStates,
      and(
        eq(threadReadStates.workspaceId, messages.workspaceId),
        eq(threadReadStates.userId, principal.userId),
        eq(threadReadStates.threadRootMessageId, messages.threadRootMessageId)
      )
    )
    .where(
      and(
        inArray(messages.workspaceId, [...scope.workspaceIds]),
        inArray(messages.channelId, [...scope.channelIds]),
        isNotNull(messages.threadRootMessageId),
        isNull(messages.deletedAt)
      )
    )
    .groupBy(
      messages.channelId,
      messages.threadRootMessageId,
      threadReadStates.lastReadSequence,
      threadReadStates.manuallyUnread
    )
    .having(
      sql`count(*) filter (where ${messages.sequence} > coalesce(${threadReadStates.lastReadSequence}, 0)) > 0 or coalesce(${threadReadStates.manuallyUnread}, false)`
    )
  const visibleRoots = await readerVisibleThreadRootIds(
    database,
    threads.map((thread) => thread.threadRootMessageId!),
    principal.userId
  )
  for (const thread of threads) {
    if (visibleRoots.has(thread.threadRootMessageId!)) continue
    const unread = thread.unread + (thread.manuallyUnread ? 1 : 0)
    counts.set(thread.channelId, (counts.get(thread.channelId) ?? 0) + unread)
  }
  return counts
}
