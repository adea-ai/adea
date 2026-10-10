/*
 * Current-authority read facts for job publications (#1217): the newest top-level
 * sequence a reader can see in a channel, and the unread job publications a reader is
 * no longer authorized for. Unread counts, the exposed frontier, mark-read and the
 * account summaries all use these, so a publication counts only while it is visible to
 * the reader. Visibility is decided by the canonical publication gates that history and
 * delivery apply (`filterVisibleJobOutboundRows`); nothing here widens access.
 *
 * Bounds. The stored frontier `channels.latest_message_sequence` is the starting point and
 * is indexed. A channel whose newest top-level message is ordinary costs nothing more. A
 * walk past hidden publications reads the channel index downwards in batches of
 * WALK_BATCH and stops at the first ordinary message or visible publication, so it costs
 * the hidden publications at the top of that channel. Hidden unread publications come from
 * the unread range of channels that have unread, the same range the unread count scans.
 * Nothing reads history below a reader's watermark or above a visible message.
 */
import type { UserPrincipalRef } from '@adea-ai/types'
import { and, desc, eq, inArray, isNull, like, lt, sql } from 'drizzle-orm'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { isJobOutboundSenderValue, JOB_OUTBOUND_SENDER_PREFIX } from './job-outbound-binding'
import { filterVisibleJobOutboundRows } from './job-outbound-read'
import { channelReadStates, channels, messages } from './schema'

type Database = AgentHqDatabase | AgentHqTransaction

/** Walk batch size: one indexed read per batch of the channel's top-level messages. */
const WALK_BATCH = 16

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
    // Newest first, and each publication gated only when reached: the walk stops at the first
    // ordinary message or visible publication, so it never gates the rest of the batch.
    for (const row of batch) {
      if (!isPublication(row)) return row.sequence
      if ((await authorizedPublicationIds(database, principal.userId, [row])).has(row.id))
        return row.sequence
    }
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

/**
 * Unread job publications the reader may no longer see, per channel: the live top-level
 * publications past the reader's read watermark that fail the publication gates. Ordinary
 * messages are never returned. `workspaceIds` bounds the scan; `channelIds`, when given,
 * narrows it further.
 */
export async function readHiddenUnreadPublications(
  database: Database,
  principal: UserPrincipalRef,
  scope: Readonly<{ channelIds?: readonly string[]; workspaceIds: readonly string[] }>
): Promise<ReadonlyArray<Readonly<{ channelId: string; messageId: string; sequence: number }>>> {
  if (!scope.workspaceIds.length) return []
  // Starts from the channels that have unread, so the message scan is the unread range of
  // those channels and nothing older.
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
        like(messages.senderSystemId, `${JOB_OUTBOUND_SENDER_PREFIX}%`)
      )
    )
  const authorized = await authorizedPublicationIds(database, principal.userId, rows)
  return rows
    .filter((row) => !authorized.has(row.id))
    .map((row) => ({ channelId: row.channelId, messageId: row.id, sequence: row.sequence }))
}

/** Hidden unread publication counts per channel, from `readHiddenUnreadPublications`. */
export function hiddenUnreadCountByChannel(
  hidden: ReadonlyArray<Readonly<{ channelId: string }>>
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const row of hidden) counts.set(row.channelId, (counts.get(row.channelId) ?? 0) + 1)
  return counts
}
