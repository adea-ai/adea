import type { UserPrincipalRef, WorkspaceSearchPage, WorkspaceSearchResult } from '@adea-ai/types'
import { and, asc, eq, gt, ilike, inArray, isNotNull, isNull, not, or, sql } from 'drizzle-orm'

import type { AgentHqDatabase } from './connection'
import { JOB_OUTBOUND_SENDER_PREFIX } from './job-outbound-binding'
import {
  requireProjectAccessScope,
  visibleProjectCondition,
  visibleTaskCondition,
} from './project-access'
import { filterVisibleMessageRows } from './job-outbound-read'
import { listAccessibleChannelIds } from './read-state'
import { SEARCH_CANDIDATE_LIMIT, searchPageWindow } from './search-paging'
import { agents, artifacts, channels, messages, projects, tasks } from './schema'

function pattern(query: string) {
  return `%${query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
}

function snippet(value: string, query: string) {
  const normalized = value.toLocaleLowerCase()
  const index = normalized.indexOf(query.toLocaleLowerCase())
  if (index < 0) return value.slice(0, 160)
  const start = Math.max(0, index - 60)
  const end = Math.min(value.length, index + query.length + 100)
  return `${start ? '…' : ''}${value.slice(start, end)}${end < value.length ? '…' : ''}`
}

function compare(left: WorkspaceSearchResult, right: WorkspaceSearchResult) {
  return (
    left.label.localeCompare(right.label) ||
    left.kind.localeCompare(right.kind) ||
    left.id.localeCompare(right.id)
  )
}

/** Raw message rows read per page of a search; the scan stops at SEARCH_CANDIDATE_LIMIT rows in all. */
const SEARCH_MESSAGE_PAGE = 100
/** The smallest page, so a small window still reads past a few hidden matches in one page. */
const SEARCH_MIN_PAGE = 25

/** The message fields a search result needs, plus the sequence the scan pages on. */
const messageCandidateFields = {
  bodyText: messages.bodyText,
  channelId: messages.channelId,
  channelTitle: channels.title,
  executionRef: messages.executionRef,
  id: messages.id,
  projectId: channels.projectId,
  senderKind: messages.senderKind,
  senderSystemId: messages.senderSystemId,
  sequence: messages.sequence,
  taskId: messages.taskId,
  threadRootMessageId: messages.threadRootMessageId,
}

/** Whether a message row is a job publication, by its system sender, in SQL. */
const publicationRowCondition = sql`(${messages.senderKind} = 'system' and ${messages.senderSystemId} like ${`${JOB_OUTBOUND_SENDER_PREFIX}%`})`

type MessageCandidate = Readonly<{
  bodyText: string | null
  channelId: string
  channelTitle: string
  executionRef: string | null
  id: string
  projectId: string | null
  senderKind: string
  senderSystemId: string | null
  sequence: number
  taskId: string | null
  threadRootMessageId: string | null
}>

/**
 * The first `needed` matching messages the reader may see, in sequence order. Pages of raw rows
 * are read in keyset order and gated in one bulk pass each. The raw rows scanned are capped at
 * SEARCH_CANDIDATE_LIMIT, so a long run of hidden matches costs its pages, not an unbounded read.
 */
async function visibleMessageCandidates(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef,
  channelIds: readonly string[],
  like: string,
  needed: number
) {
  const visible: MessageCandidate[] = []
  if (!channelIds.length) return visible
  let after = 0
  let scanned = 0
  while (visible.length < needed && scanned < SEARCH_CANDIDATE_LIMIT) {
    // A page is never smaller than a small window, so hidden matches are read past in a few pages.
    const pageSize = Math.min(
      SEARCH_MESSAGE_PAGE,
      Math.max(needed - visible.length, SEARCH_MIN_PAGE),
      SEARCH_CANDIDATE_LIMIT - scanned
    )
    const page: MessageCandidate[] = await database
      .select(messageCandidateFields)
      .from(messages)
      .innerJoin(channels, eq(channels.id, messages.channelId))
      .where(
        and(
          eq(messages.workspaceId, workspaceId),
          inArray(messages.channelId, [...channelIds]),
          isNull(messages.deletedAt),
          isNotNull(messages.bodyText),
          ilike(messages.bodyText, like),
          gt(messages.sequence, after)
        )
      )
      .orderBy(asc(messages.sequence))
      .limit(pageSize)
    if (!page.length) break
    scanned += page.length
    after = page.at(-1)!.sequence
    visible.push(...(await filterVisibleMessageRows(database, page, principal.userId)))
    if (page.length < pageSize) break
  }
  return visible.slice(0, needed)
}

/**
 * Whether the reader can see any message with encrypted content in the searched channels. A
 * top-level message is visible with its channel, so one indexed probe settles it. Replies and job
 * publications are gated, a page at a time, until one is visible or the scan budget is spent.
 */
async function hasVisiblePrivateMessage(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef,
  channelIds: readonly string[]
): Promise<boolean> {
  if (!channelIds.length) return false
  const ordinary = await database
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.workspaceId, workspaceId),
        inArray(messages.channelId, [...channelIds]),
        isNull(messages.deletedAt),
        isNotNull(messages.bodyContentRefId),
        isNull(messages.threadRootMessageId),
        not(publicationRowCondition)
      )
    )
    .limit(1)
  if (ordinary.length) return true
  let after = 0
  let scanned = 0
  while (scanned < SEARCH_CANDIDATE_LIMIT) {
    const pageSize = Math.min(SEARCH_MESSAGE_PAGE, SEARCH_CANDIDATE_LIMIT - scanned)
    const page = await database
      .select({
        executionRef: messages.executionRef,
        id: messages.id,
        senderKind: messages.senderKind,
        senderSystemId: messages.senderSystemId,
        sequence: messages.sequence,
        threadRootMessageId: messages.threadRootMessageId,
      })
      .from(messages)
      .where(
        and(
          eq(messages.workspaceId, workspaceId),
          inArray(messages.channelId, [...channelIds]),
          isNull(messages.deletedAt),
          isNotNull(messages.bodyContentRefId),
          gt(messages.sequence, after),
          or(isNotNull(messages.threadRootMessageId), publicationRowCondition)
        )
      )
      .orderBy(asc(messages.sequence))
      .limit(pageSize)
    if (!page.length) return false
    scanned += page.length
    after = page.at(-1)!.sequence
    if ((await filterVisibleMessageRows(database, page, principal.userId)).length > 0) return true
    if (page.length < pageSize) return false
  }
  return false
}

export async function searchWorkspaceForUser(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef,
  query: string,
  options: Readonly<{ channelId?: string; limit?: number; offset?: number }> = {}
): Promise<WorkspaceSearchPage> {
  const normalized = query.trim()
  if (normalized.length < 2 || normalized.length > 120) throw new Error('Search query invalid')
  const offset = Math.max(options.offset ?? 0, 0)
  // One call derives the clamped limit, the candidate scan, and the next
  // cursor together, so they cannot drift apart again.
  const window = searchPageWindow({ limit: options.limit, offset, resultCount: 0 })
  const limit = window.limit
  const candidateLimit = window.candidateLimit
  const scope = await requireProjectAccessScope(
    database,
    workspaceId,
    principal,
    'Search unavailable'
  )
  // Channel scope already excludes hidden projects' channels (and so their
  // messages); projects, tasks and artifacts are filtered explicitly below.
  const allowed = await listAccessibleChannelIds(database, workspaceId, principal)
  const allowedChannelIds = allowed.map(({ id }) => id)
  if (options.channelId && !allowedChannelIds.includes(options.channelId))
    throw new Error('Search unavailable')
  const scopedChannelIds = options.channelId ? [options.channelId] : allowedChannelIds
  const like = pattern(normalized)

  const [projectRows, channelRows, agentRows, taskRows, artifactRows] = await Promise.all([
    options.channelId
      ? Promise.resolve([])
      : database
          .select({ id: projects.id, label: projects.name })
          .from(projects)
          .where(
            and(
              eq(projects.workspaceId, workspaceId),
              eq(projects.lifecycleState, 'active'),
              visibleProjectCondition(projects.id, scope),
              or(ilike(projects.name, like), ilike(projects.iconKey, like))
            )
          )
          .orderBy(asc(projects.name), asc(projects.id))
          .limit(candidateLimit),
    options.channelId || !allowedChannelIds.length
      ? Promise.resolve([])
      : database
          .select({ id: channels.id, label: channels.title, projectId: channels.projectId })
          .from(channels)
          .where(
            and(
              eq(channels.workspaceId, workspaceId),
              inArray(channels.id, allowedChannelIds),
              ilike(channels.title, like)
            )
          )
          .orderBy(asc(channels.title), asc(channels.id))
          .limit(candidateLimit),
    options.channelId
      ? Promise.resolve([])
      : database
          .select({ id: agents.id, label: agents.name, roleSummary: agents.roleSummary })
          .from(agents)
          .where(
            and(
              eq(agents.workspaceId, workspaceId),
              eq(agents.lifecycleState, 'active'),
              or(ilike(agents.name, like), ilike(agents.roleSummary, like))
            )
          )
          .orderBy(asc(agents.name), asc(agents.id))
          .limit(candidateLimit),
    options.channelId
      ? Promise.resolve([])
      : database
          .select({
            channelId: tasks.channelId,
            id: tasks.id,
            label: tasks.title,
            objective: tasks.objective,
            projectId: tasks.projectId,
          })
          .from(tasks)
          .where(
            and(
              eq(tasks.workspaceId, workspaceId),
              visibleProjectCondition(tasks.projectId, scope),
              or(ilike(tasks.title, like), ilike(tasks.objective, like))
            )
          )
          .orderBy(asc(tasks.title), asc(tasks.id))
          .limit(candidateLimit),
    options.channelId
      ? Promise.resolve([])
      : database
          .select({
            id: artifacts.id,
            label: artifacts.filename,
            mediaType: artifacts.mediaType,
            taskId: artifacts.taskId,
          })
          .from(artifacts)
          .where(
            and(
              eq(artifacts.workspaceId, workspaceId),
              eq(artifacts.deletionState, 'active'),
              visibleTaskCondition(database, artifacts.taskId, scope),
              or(ilike(artifacts.filename, like), ilike(artifacts.mediaType, like))
            )
          )
          .orderBy(asc(artifacts.filename), asc(artifacts.id))
          .limit(candidateLimit),
  ])

  // Messages are matched in sequence order, keeping only the ones the reader may see, until the
  // page's window is full or the scan budget is spent. A hidden job publication never takes a
  // place in the window.
  const messageRows = await visibleMessageCandidates(
    database,
    workspaceId,
    principal,
    scopedChannelIds,
    like,
    offset + limit + 1
  )
  const privateResultsUnavailable = await hasVisiblePrivateMessage(
    database,
    workspaceId,
    principal,
    scopedChannelIds
  )
  const results: WorkspaceSearchResult[] = [
    ...projectRows.map((row) => ({
      id: row.id,
      kind: 'project' as const,
      label: row.label,
      secondary: 'Project',
      workspaceId,
    })),
    ...channelRows.map((row) => ({
      id: row.id,
      kind: 'channel' as const,
      label: row.label,
      ...(row.projectId ? { projectId: row.projectId } : {}),
      secondary: row.projectId ? 'Project conversation' : 'Conversation',
      workspaceId,
    })),
    ...agentRows.map((row) => ({
      id: row.id,
      kind: 'agent' as const,
      label: row.label,
      secondary: row.roleSummary ?? 'Agent',
      workspaceId,
    })),
    ...taskRows.map((row) => ({
      ...(row.channelId ? { channelId: row.channelId } : {}),
      id: row.id,
      kind: 'task' as const,
      label: row.label,
      ...(row.projectId ? { projectId: row.projectId } : {}),
      secondary: row.objective ? snippet(row.objective, normalized) : 'Private objective',
      taskId: row.id,
      workspaceId,
    })),
    ...artifactRows.map((row) => ({
      id: row.id,
      kind: 'artifact' as const,
      label: row.label,
      secondary: row.mediaType,
      ...(row.taskId ? { taskId: row.taskId } : {}),
      workspaceId,
    })),
    ...messageRows.map((row) => ({
      channelId: row.channelId,
      id: row.id,
      kind: 'message' as const,
      label: snippet(row.bodyText!, normalized),
      messageId: row.id,
      ...(row.projectId ? { projectId: row.projectId } : {}),
      secondary: `${row.channelTitle} · ${row.threadRootMessageId ? 'Thread reply' : 'Message'}`,
      ...(row.taskId ? { taskId: row.taskId } : {}),
      ...(row.threadRootMessageId ? { threadRootMessageId: row.threadRootMessageId } : {}),
      workspaceId,
    })),
  ].toSorted(compare)
  const page = results.slice(offset, offset + limit)
  const hasMore =
    searchPageWindow({ limit, offset, resultCount: results.length }).nextOffset !== undefined
  return Object.freeze({
    ...(hasMore ? { nextOffset: offset + limit } : {}),
    privateResultsUnavailable,
    results: Object.freeze(page),
  })
}
