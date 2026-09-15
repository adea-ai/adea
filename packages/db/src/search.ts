import type { UserPrincipalRef, WorkspaceSearchPage, WorkspaceSearchResult } from '@adea-ai/types'
import { and, asc, eq, ilike, inArray, isNotNull, isNull, or } from 'drizzle-orm'

import type { AgentHqDatabase } from './connection'
import { listAccessibleChannelIds } from './read-state'
import { agents, artifacts, channels, messages, rooms, tasks } from './schema'

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

export async function searchWorkspaceForUser(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef,
  query: string,
  options: Readonly<{ channelId?: string; limit?: number; offset?: number }> = {}
): Promise<WorkspaceSearchPage> {
  const normalized = query.trim()
  if (normalized.length < 2 || normalized.length > 120) throw new Error('Search query invalid')
  const limit = Math.min(Math.max(options.limit ?? 30, 1), 50)
  const offset = Math.max(options.offset ?? 0, 0)
  if (!Number.isSafeInteger(offset) || offset > 5_000) throw new Error('Search query invalid')
  const allowed = await listAccessibleChannelIds(database, workspaceId, principal)
  const allowedChannelIds = allowed.map(({ id }) => id)
  if (options.channelId && !allowedChannelIds.includes(options.channelId))
    throw new Error('Search unavailable')
  const scopedChannelIds = options.channelId ? [options.channelId] : allowedChannelIds
  const like = pattern(normalized)
  const candidateLimit = Math.min(offset + limit + 1, 5_051)

  const [roomRows, channelRows, agentRows, taskRows, artifactRows, messageRows, privateRows] =
    await Promise.all([
      options.channelId
        ? Promise.resolve([])
        : database
            .select({ id: rooms.id, label: rooms.name })
            .from(rooms)
            .where(
              and(
                eq(rooms.workspaceId, workspaceId),
                eq(rooms.lifecycleState, 'active'),
                or(ilike(rooms.name, like), ilike(rooms.functionKey, like))
              )
            )
            .orderBy(asc(rooms.name), asc(rooms.id))
            .limit(candidateLimit),
      options.channelId || !allowedChannelIds.length
        ? Promise.resolve([])
        : database
            .select({ id: channels.id, label: channels.title, roomId: channels.roomId })
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
              roomId: tasks.roomId,
            })
            .from(tasks)
            .where(
              and(
                eq(tasks.workspaceId, workspaceId),
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
                or(ilike(artifacts.filename, like), ilike(artifacts.mediaType, like))
              )
            )
            .orderBy(asc(artifacts.filename), asc(artifacts.id))
            .limit(candidateLimit),
      !scopedChannelIds.length
        ? Promise.resolve([])
        : database
            .select({
              bodyText: messages.bodyText,
              channelId: messages.channelId,
              channelTitle: channels.title,
              id: messages.id,
              roomId: channels.roomId,
              taskId: messages.taskId,
              threadRootMessageId: messages.threadRootMessageId,
            })
            .from(messages)
            .innerJoin(channels, eq(channels.id, messages.channelId))
            .where(
              and(
                eq(messages.workspaceId, workspaceId),
                inArray(messages.channelId, scopedChannelIds),
                isNull(messages.deletedAt),
                isNotNull(messages.bodyText),
                ilike(messages.bodyText, like)
              )
            )
            .orderBy(asc(messages.sequence), asc(messages.id))
            .limit(candidateLimit),
      !scopedChannelIds.length
        ? Promise.resolve([])
        : database
            .select({ id: messages.id })
            .from(messages)
            .where(
              and(
                eq(messages.workspaceId, workspaceId),
                inArray(messages.channelId, scopedChannelIds),
                isNull(messages.deletedAt),
                isNotNull(messages.bodyContentRefId)
              )
            )
            .limit(1),
    ])

  const results: WorkspaceSearchResult[] = [
    ...roomRows.map((row) => ({
      id: row.id,
      kind: 'room' as const,
      label: row.label,
      secondary: 'Room',
      workspaceId,
    })),
    ...channelRows.map((row) => ({
      id: row.id,
      kind: 'channel' as const,
      label: row.label,
      ...(row.roomId ? { roomId: row.roomId } : {}),
      secondary: row.roomId ? 'Room conversation' : 'Conversation',
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
      ...(row.roomId ? { roomId: row.roomId } : {}),
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
      ...(row.roomId ? { roomId: row.roomId } : {}),
      secondary: `${row.channelTitle} · ${row.threadRootMessageId ? 'Thread reply' : 'Message'}`,
      ...(row.taskId ? { taskId: row.taskId } : {}),
      ...(row.threadRootMessageId ? { threadRootMessageId: row.threadRootMessageId } : {}),
      workspaceId,
    })),
  ].toSorted(compare)
  const page = results.slice(offset, offset + limit)
  return Object.freeze({
    ...(offset + limit < results.length ? { nextOffset: offset + limit } : {}),
    privateResultsUnavailable: privateRows.length > 0,
    results: Object.freeze(page),
  })
}
