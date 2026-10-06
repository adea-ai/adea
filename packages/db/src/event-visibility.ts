// Per-principal filtering of the durable workspace event log (ADR 0012).
//
// The log is shared by the whole workspace, but a `members` project and
// everything inside it is visible only to its project members plus the
// workspace's owners and admins. Before the stream sends an event it is
// classified for the subscriber against CURRENT access state, so a replay or a
// resumed cursor is filtered exactly like live delivery.

import { and, eq, inArray } from 'drizzle-orm'

import type { AgentHqDatabase } from './connection'
import type { WorkspaceEventView } from './event-log'
import { resolveProjectAccessScope } from './project-access'
import { artifacts, channels, contentRefs, messages, tasks } from './schema'

/**
 * How one event reaches one subscriber.
 *
 * - `deliver`: as logged (a `project.reordered` list is narrowed to the
 *   projects the subscriber can see).
 * - `redacted`: an access change that removes something from the subscriber's
 *   view. They need to refresh, so the type is kept, but the payload, aggregate
 *   id and actor are dropped.
 * - `withheld`: the event belongs to a project the subscriber cannot see. Only
 *   its sequence is sent, so the client advances its cursor without reading a
 *   gap as lost history.
 */
export type WorkspaceEventDelivery =
  | Readonly<{ kind: 'deliver'; event: WorkspaceEventView }>
  | Readonly<{ kind: 'redacted'; event: WorkspaceEventView }>
  | Readonly<{ kind: 'withheld'; workspaceSequence: number }>

/** Events that change what a subscriber can see; a hidden one is redacted, not withheld. */
const ACCESS_CHANGE_EVENTS = new Set([
  'project.members_changed',
  'project.visibility_changed',
  'task.project_changed',
])

function stringField(payload: Readonly<Record<string, unknown>>, key: string) {
  const value = payload[key]
  return typeof value === 'string' ? value : null
}

function projectOf(rows: readonly { id: string; projectId: string | null }[]) {
  return new Map(rows.map((row) => [row.id, row.projectId]))
}

function family(eventType: string) {
  return eventType.split('.')[0] ?? ''
}

/**
 * Classify a page of events for one user. Returns `null` when the user is no
 * longer a workspace member, so the caller ends the stream.
 *
 * Cost: one or two indexed reads for the access scope. When the subscriber can
 * see every project (owners, admins, or a workspace without hidden projects for
 * them) that is all. Otherwise each page adds at most four batched lookups —
 * channels, messages, tasks, and artifacts/content refs — keyed by the ids in
 * the page's payloads, never one query per event.
 */
export async function classifyWorkspaceEventsForUser(
  database: AgentHqDatabase,
  workspaceId: string,
  userId: string,
  events: readonly WorkspaceEventView[]
): Promise<readonly WorkspaceEventDelivery[] | null> {
  const scope = await resolveProjectAccessScope(database, workspaceId, userId)
  if (!scope) return null
  if (!scope.hiddenProjectIds.length || !events.length)
    return events.map((event) => ({ kind: 'deliver', event }))
  const hidden = new Set(scope.hiddenProjectIds)

  const channelIds = new Set<string>()
  const messageIds = new Set<string>()
  const taskIds = new Set<string>()
  const artifactIds = new Set<string>()
  const contentRefIds = new Set<string>()
  for (const { eventType, payload } of events) {
    const channelId = stringField(payload, 'channelId')
    if (channelId) channelIds.add(channelId)
    const messageId = stringField(payload, 'messageId')
    if (messageId && !channelId) messageIds.add(messageId)
    const taskId = stringField(payload, 'taskId')
    if (taskId) taskIds.add(taskId)
    if (family(eventType) === 'artifact') {
      const artifactId = stringField(payload, 'artifactId')
      if (artifactId) artifactIds.add(artifactId)
    }
    const contentRefId = stringField(payload, 'contentRefId')
    if (contentRefId) contentRefIds.add(contentRefId)
  }

  const [channelRows, messageRows, taskRows, artifactRows, contentRows] = await Promise.all([
    channelIds.size
      ? database
          .select({ id: channels.id, projectId: channels.projectId })
          .from(channels)
          .where(and(eq(channels.workspaceId, workspaceId), inArray(channels.id, [...channelIds])))
      : [],
    messageIds.size
      ? database
          .select({ id: messages.id, projectId: channels.projectId })
          .from(messages)
          .innerJoin(channels, eq(channels.id, messages.channelId))
          .where(and(eq(messages.workspaceId, workspaceId), inArray(messages.id, [...messageIds])))
      : [],
    taskIds.size
      ? database
          .select({ id: tasks.id, projectId: tasks.projectId })
          .from(tasks)
          .where(and(eq(tasks.workspaceId, workspaceId), inArray(tasks.id, [...taskIds])))
      : [],
    artifactIds.size
      ? database
          .select({ id: artifacts.id, projectId: tasks.projectId })
          .from(artifacts)
          .leftJoin(tasks, eq(tasks.id, artifacts.taskId))
          .where(
            and(eq(artifacts.workspaceId, workspaceId), inArray(artifacts.id, [...artifactIds]))
          )
      : [],
    contentRefIds.size
      ? database
          .select({
            channelProjectId: channels.projectId,
            id: contentRefs.id,
            taskProjectId: tasks.projectId,
          })
          .from(contentRefs)
          .leftJoin(tasks, eq(tasks.id, contentRefs.taskId))
          .leftJoin(messages, eq(messages.id, contentRefs.messageId))
          .leftJoin(channels, eq(channels.id, messages.channelId))
          .where(
            and(
              eq(contentRefs.workspaceId, workspaceId),
              inArray(contentRefs.id, [...contentRefIds])
            )
          )
      : [],
  ])
  const channelProject = projectOf(channelRows)
  const messageProject = projectOf(messageRows)
  const taskProject = projectOf(taskRows)
  const artifactProject = projectOf(artifactRows)
  const contentProject = new Map(
    contentRows.map((row) => [row.id, row.taskProjectId ?? row.channelProjectId])
  )

  return events.map((event): WorkspaceEventDelivery => {
    const { eventType, payload } = event
    if (eventType === 'project.reordered' && Array.isArray(payload.projectIds)) {
      return {
        event: {
          ...event,
          payload: {
            ...payload,
            projectIds: payload.projectIds.filter(
              (id) => typeof id !== 'string' || !hidden.has(id)
            ),
          },
        },
        kind: 'deliver',
      }
    }
    const touched: (string | null | undefined)[] = [stringField(payload, 'projectId')]
    if (event.aggregateType === 'project') touched.push(event.aggregateId)
    const channelId = stringField(payload, 'channelId')
    if (channelId) touched.push(channelProject.get(channelId))
    const messageId = stringField(payload, 'messageId')
    if (messageId && !channelId) touched.push(messageProject.get(messageId))
    const taskId = stringField(payload, 'taskId')
    if (taskId) touched.push(taskProject.get(taskId))
    const artifactId = stringField(payload, 'artifactId')
    if (artifactId && family(eventType) === 'artifact')
      touched.push(artifactProject.get(artifactId))
    const contentRefId = stringField(payload, 'contentRefId')
    if (contentRefId) touched.push(contentProject.get(contentRefId))

    if (!touched.some((projectId) => projectId && hidden.has(projectId)))
      return { event, kind: 'deliver' }
    // Agents are workspace-level: an agent assigned into a hidden project is
    // still the subscriber's agent, so they refresh without learning where.
    if (ACCESS_CHANGE_EVENTS.has(eventType) || family(eventType) === 'agent') {
      return {
        event: { ...event, actor: null, aggregateId: null, correlationId: null, payload: {} },
        kind: 'redacted',
      }
    }
    return { kind: 'withheld', workspaceSequence: event.workspaceSequence }
  })
}
