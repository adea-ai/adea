// Per-principal filtering of the durable workspace event log (ADR 0012).
//
// The log is shared by the whole workspace, but a `members` project and
// everything inside it is visible only to its project members plus the
// workspace's owners and admins. Before the stream sends an event it is
// classified for the subscriber against CURRENT access state, so a replay or a
// resumed cursor is filtered exactly like live delivery.

import { and, eq, inArray, sql } from 'drizzle-orm'

import type { AgentHqDatabase } from './connection'
import type { WorkspaceEventView } from './event-log'
import { isJobOutboundSenderValue } from './job-outbound-binding'
import { filterVisibleJobOutboundRows } from './job-outbound-read'
import { resolveProjectAccessScope } from './project-access'
import { artifacts, channelParticipants, channels, contentRefs, messages, tasks } from './schema'

/**
 * How one event reaches one subscriber.
 *
 * - `deliver`: as logged (a `project.reordered` list is narrowed to the
 *   projects the subscriber can see).
 * - `redacted`: an access change that removes something from the subscriber's
 *   view. They need to refresh, so the type is kept, but the payload, aggregate
 *   id and actor are dropped.
 * - `audience_changed`: a formerly public conversation is now inaccessible.
 *   Only the sequence travels; the client clears cached content and selection.
 * - `withheld`: the event belongs to a project the subscriber cannot see. Only
 *   its sequence is sent, so the client advances its cursor without reading a
 *   gap as lost history.
 */
export type WorkspaceEventDelivery =
  | Readonly<{ kind: 'deliver'; event: WorkspaceEventView }>
  | Readonly<{ kind: 'redacted'; event: WorkspaceEventView }>
  | Readonly<{ kind: 'audience_changed'; workspaceSequence: number }>
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

function conversationReferences(event: WorkspaceEventView) {
  const references = (keys: readonly string[], aggregateType: string) => {
    const ids = keys
      .map((key) => stringField(event.payload, key))
      .filter((id): id is string => !!id)
    if (event.aggregateType === aggregateType && event.aggregateId) ids.push(event.aggregateId)
    return [...new Set(ids)]
  }
  return {
    channelIds: references(['channelId'], 'channel'),
    messageIds: references(['messageId', 'threadRootMessageId', 'replyToMessageId'], 'message'),
    contentRefIds: references(['contentRefId'], 'content_ref'),
  }
}

/**
 * Classify a page of events for one user. Returns `null` when the user is no
 * longer a workspace member, so the caller ends the stream.
 *
 * Cost: one or two indexed reads for the access scope. When the subscriber can
 * see every project, channel/message/content audiences still need checking.
 * Each page adds at most five batched lookups keyed by its referenced ids,
 * never one query per event. Participant checks use indexed EXISTS inside
 * those lookups; owner/admin project privileges do not bypass a private channel.
 */
export async function classifyWorkspaceEventsForUser(
  database: AgentHqDatabase,
  workspaceId: string,
  userId: string,
  events: readonly WorkspaceEventView[]
): Promise<readonly WorkspaceEventDelivery[] | null> {
  const scope = await resolveProjectAccessScope(database, workspaceId, userId)
  if (!scope) return null
  if (!events.length) return []
  const hidden = new Set(scope.hiddenProjectIds)

  const channelIds = new Set<string>()
  const messageIds = new Set<string>()
  const taskIds = new Set<string>()
  const artifactIds = new Set<string>()
  const contentRefIds = new Set<string>()
  const eventReferences = events.map(conversationReferences)
  for (const [index, { eventType, payload }] of events.entries()) {
    const references = eventReferences[index]!
    for (const id of references.channelIds) channelIds.add(id)
    for (const id of references.messageIds) messageIds.add(id)
    for (const id of references.contentRefIds) contentRefIds.add(id)
    const taskId = stringField(payload, 'taskId')
    if (taskId) taskIds.add(taskId)
    if (family(eventType) === 'artifact') {
      const artifactId = stringField(payload, 'artifactId')
      if (artifactId) artifactIds.add(artifactId)
    }
  }

  const canReadChannel = sql<boolean>`coalesce(${channels.visibility} = 'workspace' or exists (
    select 1 from ${channelParticipants}
    where ${channelParticipants.workspaceId} = ${workspaceId}
      -- Keep the outer-table qualifier in single-table Drizzle projections.
      and ${channelParticipants.channelId} = ${channels}.${sql.identifier('id')}
      and ${channelParticipants.principalKind} = 'user'
      and ${channelParticipants.userId} = ${userId}
  ), false)`

  const [channelRows, messageRows, taskRows, artifactRows, contentRows] = await Promise.all([
    channelIds.size
      ? database
          .select({ id: channels.id, projectId: channels.projectId, canReadChannel })
          .from(channels)
          .where(and(eq(channels.workspaceId, workspaceId), inArray(channels.id, [...channelIds])))
      : [],
    messageIds.size
      ? database
          .select({
            id: messages.id,
            executionRef: messages.executionRef,
            projectId: channels.projectId,
            senderKind: messages.senderKind,
            senderSystemId: messages.senderSystemId,
            canReadChannel,
          })
          .from(messages)
          .innerJoin(
            channels,
            and(eq(channels.id, messages.channelId), eq(channels.workspaceId, workspaceId))
          )
          .where(and(eq(messages.workspaceId, workspaceId), inArray(messages.id, [...messageIds])))
      : [],
    hidden.size && taskIds.size
      ? database
          .select({ id: tasks.id, projectId: tasks.projectId })
          .from(tasks)
          .where(and(eq(tasks.workspaceId, workspaceId), inArray(tasks.id, [...taskIds])))
      : [],
    hidden.size && artifactIds.size
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
            messageId: contentRefs.messageId,
            canReadChannel,
          })
          .from(contentRefs)
          .leftJoin(
            tasks,
            and(eq(tasks.id, contentRefs.taskId), eq(tasks.workspaceId, workspaceId))
          )
          .leftJoin(
            messages,
            and(eq(messages.id, contentRefs.messageId), eq(messages.workspaceId, workspaceId))
          )
          .leftJoin(
            channels,
            and(eq(channels.id, messages.channelId), eq(channels.workspaceId, workspaceId))
          )
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
    contentRows.map((row) => [row.id, [row.taskProjectId, row.channelProjectId]])
  )
  const readableChannels = new Map(channelRows.map((row) => [row.id, row.canReadChannel]))
  // A job publication is readable only while the subscriber is currently authorized for it:
  // the same gates history and delivery apply. Its channel audience alone does not admit it.
  const publications = messageRows.filter(
    (row) => row.senderKind === 'system' && isJobOutboundSenderValue(row.senderSystemId)
  )
  const authorizedPublications = new Set(
    (await filterVisibleJobOutboundRows(database, publications, userId)).map((row) => row.id)
  )
  const readableMessages = new Map(
    messageRows.map((row) => [
      row.id,
      row.canReadChannel && (!publications.includes(row) || authorizedPublications.has(row.id)),
    ])
  )
  const readableContent = new Map(
    contentRows.map((row) => [row.id, !row.messageId || row.canReadChannel])
  )

  return events.map((event, index): WorkspaceEventDelivery => {
    const { eventType, payload } = event
    const references = eventReferences[index]!
    if (
      (event.aggregateType === 'channel' && !references.channelIds.length) ||
      (event.aggregateType === 'message' && !references.messageIds.length) ||
      (event.aggregateType === 'content_ref' && !references.contentRefIds.length) ||
      references.channelIds.some((id) => !readableChannels.get(id)) ||
      references.messageIds.some((id) => !readableMessages.get(id)) ||
      references.contentRefIds.some((id) => !readableContent.get(id))
    ) {
      // A formerly workspace-visible channel may already be in this reader's
      // cache. Its revocation must clear that cache, but no now-private event
      // identity or payload may travel. Private-from-creation channels and
      // hidden projects continue to disclose only a withheld sequence.
      const channelId = references.channelIds.length === 1 ? references.channelIds[0] : null
      if (
        eventType === 'channel.updated' &&
        event.schemaVersion === 2 &&
        payload.previousVisibility === 'workspace' &&
        payload.visibility === 'participants' &&
        channelId &&
        event.aggregateType === 'channel' &&
        event.aggregateId === channelId &&
        !references.messageIds.length &&
        !references.contentRefIds.length &&
        readableChannels.get(channelId) === false &&
        channelProject.has(channelId) &&
        !hidden.has(channelProject.get(channelId) ?? '')
      )
        return { kind: 'audience_changed', workspaceSequence: event.workspaceSequence }
      return { kind: 'withheld', workspaceSequence: event.workspaceSequence }
    }
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
    for (const id of references.channelIds) touched.push(channelProject.get(id))
    for (const id of references.messageIds) touched.push(messageProject.get(id))
    const taskId = stringField(payload, 'taskId')
    if (taskId) touched.push(taskProject.get(taskId))
    const artifactId = stringField(payload, 'artifactId')
    if (artifactId && family(eventType) === 'artifact')
      touched.push(artifactProject.get(artifactId))
    for (const id of references.contentRefIds) touched.push(...(contentProject.get(id) ?? []))

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
