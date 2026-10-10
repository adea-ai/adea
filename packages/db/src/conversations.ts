import { createHash, randomUUID } from 'node:crypto'

import type {
  ChannelSummary,
  ConversationParticipantRef,
  MessageSenderRef,
  MessageSummary,
  UserPrincipalRef,
} from '@adea-ai/types'
import { and, asc, eq, gt, inArray, isNull, max, sql } from 'drizzle-orm'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { attachMessageContentRef } from './content-refs'
import {
  canReadProject,
  canWriteProject,
  requireProjectAccessScope,
  requireProjectWrite,
  visibleProjectCondition,
} from './project-access'
import { isJobOutboundSenderValue } from './job-outbound-binding'
import { filterVisibleJobOutboundRows, JOB_OUTBOUND_HISTORY_SYSTEM_ID } from './job-outbound-read'
import { reopenTasksForChannelMessage } from './tasks'
import { appendWorkspaceEvent } from './transactions'
import {
  agents,
  artifacts,
  channelParticipants,
  channels,
  messageArtifactReferences,
  messageMentions,
  messages,
  projects,
  tasks,
  workspaceMemberships,
} from './schema'

type Database = AgentHqDatabase | AgentHqTransaction
type ChannelRow = typeof channels.$inferSelect
type MessageRow = typeof messages.$inferSelect

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)])
    )
  return value
}

function hashPayload(value: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex')
}

/**
 * Canonical key for a structurally-identical value. `JSON.stringify` alone is
 * key-ORDER dependent, so two equal mentions written `{ kind, userId }` and
 * `{ userId, kind }` produced different strings: the participant/mention
 * de-duplication below would keep both, and the sorts would order them by
 * spelling rather than by value. `stableValue` sorts keys first, so equal
 * values always produce one key.
 */
function stableKey(value: unknown): string {
  return JSON.stringify(stableValue(value))
}

function compareByStableKey(left: unknown, right: unknown): number {
  return stableKey(left).localeCompare(stableKey(right))
}

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
  if (!membership) throw new Error('Channel unavailable')
}

async function requireActiveProject(database: Database, workspaceId: string, projectId: string) {
  const [project] = await database
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.workspaceId, workspaceId),
        eq(projects.lifecycleState, 'active')
      )
    )
    .limit(1)
  if (!project) throw new Error('Project unavailable')
  return project
}

async function requireActiveAgent(database: Database, workspaceId: string, agentId: string) {
  const [agent] = await database
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.id, agentId),
        eq(agents.workspaceId, workspaceId),
        eq(agents.lifecycleState, 'active')
      )
    )
    .limit(1)
  if (!agent) throw new Error('Agent unavailable')
}

async function requireWorkspaceUser(database: Database, workspaceId: string, userId: string) {
  const [membership] = await database
    .select({ id: workspaceMemberships.id })
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, userId)
      )
    )
    .limit(1)
  if (!membership) throw new Error('Conversation participant unavailable')
}

async function validateParticipant(
  database: Database,
  workspaceId: string,
  participant: ConversationParticipantRef
) {
  if (participant.kind === 'user')
    await requireWorkspaceUser(database, workspaceId, participant.userId)
  else await requireActiveAgent(database, workspaceId, participant.agentId)
}

async function channelSummary(database: Database, row: ChannelRow): Promise<ChannelSummary> {
  const participantRows = await database
    .select()
    .from(channelParticipants)
    .where(
      and(
        eq(channelParticipants.workspaceId, row.workspaceId),
        eq(channelParticipants.channelId, row.id)
      )
    )
  const participants = participantRows
    .map((participant): ConversationParticipantRef =>
      participant.principalKind === 'user'
        ? { kind: 'user', userId: participant.userId! }
        : { agentId: participant.agentId!, kind: 'agent' }
    )
    .toSorted(compareByStableKey)
  return Object.freeze({
    ...(row.agentId ? { agentId: row.agentId } : {}),
    createdAt: row.createdAt.toISOString(),
    id: row.id,
    isPrimaryProjectChannel: row.isPrimaryProjectChannel,
    kind: row.kind,
    lifecycleState: row.lifecycleState,
    participants: Object.freeze(participants),
    ...(row.projectId ? { projectId: row.projectId } : {}),
    sortOrder: row.sortOrder,
    ...(row.taskId ? { taskId: row.taskId } : {}),
    title: row.title,
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
    visibility: row.visibility,
    workspaceId: row.workspaceId,
  })
}

async function requireChannel(
  database: Database,
  workspaceId: string,
  channelId: string,
  includeArchived = false
) {
  const [channel] = await database
    .select()
    .from(channels)
    .where(
      and(
        eq(channels.id, channelId),
        eq(channels.workspaceId, workspaceId),
        ...(includeArchived ? [] : [eq(channels.lifecycleState, 'active')])
      )
    )
    .limit(1)
  if (!channel) throw new Error('Channel unavailable')
  return channel
}

/**
 * A channel the principal can read, or — with `mode: 'write'` — post into. A
 * channel of a hidden project is answered like a missing one; a viewer of a
 * members-only project reads but cannot write (`Project read-only`).
 */
export async function requireChannelAccess(
  database: Database,
  workspaceId: string,
  channelId: string,
  principal: UserPrincipalRef,
  mode: 'read' | 'write' = 'read',
  includeArchived = false
) {
  const scope = await requireProjectAccessScope(
    database,
    workspaceId,
    principal,
    'Channel unavailable'
  )
  const channel = await requireChannel(database, workspaceId, channelId, includeArchived)
  if (!canReadProject(scope, channel.projectId)) throw new Error('Channel unavailable')
  if (mode === 'write' && !canWriteProject(scope, channel.projectId))
    throw new Error('Project read-only')
  if (channel.visibility === 'participants') {
    const [participant] = await database
      .select({ id: channelParticipants.id })
      .from(channelParticipants)
      .where(
        and(
          eq(channelParticipants.workspaceId, workspaceId),
          eq(channelParticipants.channelId, channelId),
          eq(channelParticipants.principalKind, 'user'),
          eq(channelParticipants.userId, principal.userId)
        )
      )
      .limit(1)
    if (!participant) throw new Error('Channel unavailable')
  }
  return channel
}

/** Project-level write check for channel management (rename, archive, participants). */
async function requireChannelProjectWrite(
  database: Database,
  workspaceId: string,
  channel: ChannelRow,
  principal: UserPrincipalRef
) {
  const scope = await requireProjectAccessScope(
    database,
    workspaceId,
    principal,
    'Channel unavailable'
  )
  requireProjectWrite(scope, channel.projectId, 'Channel unavailable')
}

/** A task the principal can see; a task of a hidden project is unavailable. */
async function requireVisibleTask(
  database: Database,
  workspaceId: string,
  taskId: string,
  principal: UserPrincipalRef
) {
  const [task] = await database
    .select({ id: tasks.id, projectId: tasks.projectId })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, workspaceId)))
    .limit(1)
  if (!task) throw new Error('Task unavailable')
  const scope = await requireProjectAccessScope(
    database,
    workspaceId,
    principal,
    'Task unavailable'
  )
  if (!canReadProject(scope, task.projectId)) throw new Error('Task unavailable')
}

async function nextChannelSortOrder(database: Database, workspaceId: string) {
  const [position] = await database
    .select({ value: max(channels.sortOrder) })
    .from(channels)
    .where(eq(channels.workspaceId, workspaceId))
  return (position?.value ?? -1) + 1
}

async function findActiveDefaultDirectAgentChannel(
  database: Database,
  workspaceId: string,
  agentId: string
) {
  const [row] = await database
    .select()
    .from(channels)
    .where(
      and(
        eq(channels.workspaceId, workspaceId),
        eq(channels.agentId, agentId),
        eq(channels.kind, 'direct_agent'),
        eq(channels.lifecycleState, 'active'),
        sql`${channels.idempotencyKey} like 'direct-agent:%'`
      )
    )
    .orderBy(asc(channels.createdAt), asc(channels.id))
    .limit(1)
  return row ?? null
}

export async function provisionPrimaryProjectChannelInTransaction(
  transaction: AgentHqTransaction,
  workspaceId: string,
  projectId: string,
  projectName: string
): Promise<ChannelSummary> {
  const idempotencyKey = `primary-project:${projectId}`
  const [created] = await transaction
    .insert(channels)
    .values({
      idempotencyKey,
      isPrimaryProjectChannel: true,
      kind: 'project',
      projectId,
      sortOrder: await nextChannelSortOrder(transaction, workspaceId),
      title: projectName.trim(),
      visibility: 'workspace',
      workspaceId,
    })
    .onConflictDoNothing({ target: [channels.workspaceId, channels.idempotencyKey] })
    .returning()
  if (created) {
    await appendWorkspaceEvent(transaction, {
      eventType: 'channel.created',
      payload: { channelId: created.id, kind: 'project', projectId },
      workspaceId,
    })
    return channelSummary(transaction, created)
  }
  const [existing] = await transaction
    .select()
    .from(channels)
    .where(and(eq(channels.workspaceId, workspaceId), eq(channels.idempotencyKey, idempotencyKey)))
    .limit(1)
  if (!existing || existing.kind !== 'project' || existing.projectId !== projectId)
    throw new Error('Primary Project Channel conflict')
  if (existing.lifecycleState === 'archived') {
    const [restored] = await transaction
      .update(channels)
      .set({ lifecycleState: 'active', updatedAt: new Date(), version: existing.version + 1 })
      .where(and(eq(channels.id, existing.id), eq(channels.version, existing.version)))
      .returning()
    if (!restored) throw new Error('Channel version conflict')
    return channelSummary(transaction, restored)
  }
  return channelSummary(transaction, existing)
}

export async function provisionPrimaryProjectChannel(
  database: AgentHqDatabase,
  workspaceId: string,
  projectId: string,
  principal: UserPrincipalRef
) {
  return database.transaction(async (transaction) => {
    await requireMembership(transaction, workspaceId, principal)
    requireProjectWrite(
      await requireProjectAccessScope(transaction, workspaceId, principal, 'Project unavailable'),
      projectId,
      'Project unavailable'
    )
    const project = await requireActiveProject(transaction, workspaceId, projectId)
    return provisionPrimaryProjectChannelInTransaction(
      transaction,
      workspaceId,
      projectId,
      project.name
    )
  })
}

async function createChannel(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef,
  input: Readonly<{
    agentId?: string
    createPayloadHash?: string
    idempotencyKey: string
    kind: 'project' | 'direct_agent' | 'group'
    projectId?: string
    taskId?: string
    title: string
    visibility: 'workspace' | 'participants'
  }>
) {
  return database.transaction(async (transaction) => {
    await requireMembership(transaction, workspaceId, principal)
    if (input.projectId) {
      requireProjectWrite(
        await requireProjectAccessScope(transaction, workspaceId, principal, 'Project unavailable'),
        input.projectId,
        'Project unavailable'
      )
      await requireActiveProject(transaction, workspaceId, input.projectId)
    }
    if (input.agentId) await requireActiveAgent(transaction, workspaceId, input.agentId)
    if (input.taskId) await requireVisibleTask(transaction, workspaceId, input.taskId, principal)
    const [created] = await transaction
      .insert(channels)
      .values({
        agentId: input.agentId ?? null,
        createPayloadHash: input.createPayloadHash ?? null,
        idempotencyKey: input.idempotencyKey.trim(),
        kind: input.kind,
        projectId: input.projectId ?? null,
        sortOrder: await nextChannelSortOrder(transaction, workspaceId),
        taskId: input.taskId ?? null,
        title: input.title.trim(),
        visibility: input.visibility,
        workspaceId,
      })
      .onConflictDoNothing({ target: [channels.workspaceId, channels.idempotencyKey] })
      .returning()
    let channel = created
    if (!channel) {
      ;[channel] = await transaction
        .select()
        .from(channels)
        .where(
          and(
            eq(channels.workspaceId, workspaceId),
            eq(channels.idempotencyKey, input.idempotencyKey.trim())
          )
        )
        .limit(1)
      if (
        !channel ||
        (input.createPayloadHash
          ? channel.createPayloadHash !== input.createPayloadHash
          : channel.kind !== input.kind ||
            channel.projectId !== (input.projectId ?? null) ||
            channel.agentId !== (input.agentId ?? null) ||
            channel.taskId !== (input.taskId ?? null) ||
            channel.title !== input.title.trim() ||
            channel.visibility !== input.visibility)
      )
        throw new Error('Channel idempotency conflict')
      if (input.createPayloadHash)
        await requireChannelAccess(transaction, workspaceId, channel.id, principal, 'read', true)
    } else {
      await appendWorkspaceEvent(transaction, {
        eventType: 'channel.created',
        payload: { actorUserId: principal.userId, channelId: channel.id, kind: channel.kind },
        workspaceId,
      })
    }
    if (created && channel.visibility === 'participants') {
      await transaction.insert(channelParticipants).values([
        {
          channelId: channel.id,
          principalKind: 'user',
          userId: principal.userId,
          workspaceId,
        },
        ...(channel.agentId
          ? [
              {
                agentId: channel.agentId,
                channelId: channel.id,
                principalKind: 'agent' as const,
                workspaceId,
              },
            ]
          : []),
      ])
    }
    return channelSummary(transaction, channel)
  })
}

export const createProjectChannel = (
  database: AgentHqDatabase,
  workspaceId: string,
  projectId: string,
  principal: UserPrincipalRef,
  input: Readonly<{ idempotencyKey: string; taskId?: string; title: string }>
) =>
  createChannel(database, workspaceId, principal, {
    ...input,
    kind: 'project',
    projectId,
    visibility: 'workspace',
  })

/** Open the optional legacy default lane. This never selects an explicit topic. */
export const createDirectAgentChannel = async (
  database: AgentHqDatabase,
  workspaceId: string,
  agentId: string,
  principal: UserPrincipalRef
) => {
  await requireMembership(database, workspaceId, principal)
  await requireActiveAgent(database, workspaceId, agentId)
  const live = await findActiveDefaultDirectAgentChannel(database, workspaceId, agentId)
  if (live) {
    await requireChannelAccess(database, workspaceId, live.id, principal)
    return channelSummary(database, live)
  }
  try {
    const existing = await createChannel(database, workspaceId, principal, {
      agentId,
      idempotencyKey: `direct-agent:${agentId}`,
      kind: 'direct_agent',
      title: 'Direct conversation',
      visibility: 'participants',
    })
    if (existing.lifecycleState === 'active') {
      await requireChannelAccess(database, workspaceId, existing.id, principal)
      return existing
    }
    // A deleted conversation stays deleted: opening a new one starts fresh
    // history under a unique key instead of resurrecting the archived row.
    return await createChannel(database, workspaceId, principal, {
      agentId,
      idempotencyKey: `direct-agent:${agentId}:${randomUUID()}`,
      kind: 'direct_agent',
      title: 'Direct conversation',
      visibility: 'participants',
    })
  } catch (error) {
    // A concurrent open may have inserted the live row after the lookup above.
    // Return it instead of surfacing the unique violation as a generic error.
    if (
      error instanceof Error &&
      error.message.includes('channels_active_default_direct_agent_unique')
    ) {
      const retry = await findActiveDefaultDirectAgentChannel(database, workspaceId, agentId)
      if (retry) {
        await requireChannelAccess(database, workspaceId, retry.id, principal)
        return channelSummary(database, retry)
      }
    }
    throw error
  }
}

/** New topics have independent history and caller-scoped immutable retry identity. */
export const createDirectAgentTopic = (
  database: AgentHqDatabase,
  workspaceId: string,
  agentId: string,
  principal: UserPrincipalRef,
  input: Readonly<{ idempotencyKey: string; title: string }>
) => {
  const requestKey = input.idempotencyKey.trim()
  const title = input.title.trim()
  if (!requestKey || requestKey.length > 128 || !title || input.title.length > 120)
    throw new Error('Invalid topic request')
  return createChannel(database, workspaceId, principal, {
    agentId,
    createPayloadHash: hashPayload({ agentId, principal, title, workspaceId }),
    idempotencyKey: `direct-topic:${principal.userId}:${requestKey}`,
    kind: 'direct_agent',
    title,
    visibility: 'participants',
  })
}

export const createGroupChannel = (
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef,
  input: Readonly<{ idempotencyKey: string; taskId?: string; title: string }>
) =>
  createChannel(database, workspaceId, principal, {
    ...input,
    kind: 'group',
    visibility: 'participants',
  })

export async function listChannelsForUser(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef,
  options: Readonly<{ includeArchived?: boolean }> = {}
) {
  const scope = await requireProjectAccessScope(
    database,
    workspaceId,
    principal,
    'Channel unavailable'
  )
  const rows = await database
    .select()
    .from(channels)
    .where(
      and(
        eq(channels.workspaceId, workspaceId),
        visibleProjectCondition(channels.projectId, scope),
        ...(options.includeArchived ? [] : [eq(channels.lifecycleState, 'active')])
      )
    )
    .orderBy(asc(channels.sortOrder), asc(channels.id))
  const summaries = await Promise.all(rows.map((row) => channelSummary(database, row)))
  return summaries.filter(
    (channel) =>
      channel.visibility === 'workspace' ||
      channel.participants.some(
        (participant) => participant.kind === 'user' && participant.userId === principal.userId
      )
  )
}

export async function getChannelForUser(
  database: AgentHqDatabase,
  workspaceId: string,
  channelId: string,
  principal: UserPrincipalRef
) {
  await requireMembership(database, workspaceId, principal)
  const channel = await requireChannelAccess(database, workspaceId, channelId, principal)
  return channelSummary(database, channel)
}

export async function updateChannel(
  database: AgentHqDatabase,
  workspaceId: string,
  channelId: string,
  principal: UserPrincipalRef,
  input: Readonly<{
    taskId?: string | null
    title?: string
    visibility?: 'workspace' | 'participants'
  }>,
  expectedVersion: number
) {
  return database.transaction(async (transaction) => {
    await requireMembership(transaction, workspaceId, principal)
    const channel = await requireChannel(transaction, workspaceId, channelId)
    if (channel.kind === 'direct_agent' && channel.createPayloadHash)
      await requireChannelAccess(transaction, workspaceId, channelId, principal, 'write')
    await requireChannelProjectWrite(transaction, workspaceId, channel, principal)
    if (channel.version !== expectedVersion) throw new Error('Channel version conflict')
    if (input.taskId) await requireVisibleTask(transaction, workspaceId, input.taskId, principal)
    const [updated] = await transaction
      .update(channels)
      .set({
        ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
        ...(input.title !== undefined ? { title: input.title.trim() } : {}),
        ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
        updatedAt: new Date(),
        version: channel.version + 1,
      })
      .where(
        and(
          eq(channels.id, channelId),
          eq(channels.workspaceId, workspaceId),
          eq(channels.version, expectedVersion)
        )
      )
      .returning()
    if (!updated) throw new Error('Channel version conflict')
    await appendWorkspaceEvent(transaction, {
      eventType: 'channel.updated',
      payload: {
        actorUserId: principal.userId,
        channelId,
        previousVisibility: channel.visibility,
        visibility: updated.visibility,
        version: updated.version,
      },
      workspaceId,
    })
    return channelSummary(transaction, updated)
  })
}

export async function archiveChannel(
  database: AgentHqDatabase,
  workspaceId: string,
  channelId: string,
  principal: UserPrincipalRef,
  expectedVersion: number
) {
  return database.transaction(async (transaction) => {
    await requireMembership(transaction, workspaceId, principal)
    const channel = await requireChannel(transaction, workspaceId, channelId)
    if (channel.kind === 'direct_agent' && channel.createPayloadHash)
      await requireChannelAccess(transaction, workspaceId, channelId, principal, 'write')
    await requireChannelProjectWrite(transaction, workspaceId, channel, principal)
    if (channel.version !== expectedVersion) throw new Error('Channel version conflict')
    if (channel.isPrimaryProjectChannel && channel.projectId) {
      const [project] = await transaction
        .select({ lifecycleState: projects.lifecycleState })
        .from(projects)
        .where(and(eq(projects.id, channel.projectId), eq(projects.workspaceId, workspaceId)))
        .limit(1)
      if (project?.lifecycleState === 'active') throw new Error('Primary Project Channel required')
    }
    const [archived] = await transaction
      .update(channels)
      .set({ lifecycleState: 'archived', updatedAt: new Date(), version: channel.version + 1 })
      .where(
        and(
          eq(channels.id, channelId),
          eq(channels.workspaceId, workspaceId),
          eq(channels.version, expectedVersion)
        )
      )
      .returning()
    if (!archived) throw new Error('Channel version conflict')
    await appendWorkspaceEvent(transaction, {
      eventType: 'channel.archived',
      payload: { actorUserId: principal.userId, channelId, version: archived.version },
      workspaceId,
    })
    return channelSummary(transaction, archived)
  })
}

export async function setChannelParticipants(
  database: AgentHqDatabase,
  workspaceId: string,
  channelId: string,
  principal: UserPrincipalRef,
  participants: readonly ConversationParticipantRef[],
  expectedVersion: number
) {
  return database.transaction(async (transaction) => {
    await requireMembership(transaction, workspaceId, principal)
    const channel = await requireChannel(transaction, workspaceId, channelId)
    await requireChannelProjectWrite(transaction, workspaceId, channel, principal)
    if (channel.version !== expectedVersion) throw new Error('Channel version conflict')
    if (channel.kind !== 'group') throw new Error('Channel participant policy conflict')
    const unique = new Map(participants.map((entry) => [stableKey(entry), entry])).values()
    const normalized = [...unique]
    for (const participant of normalized)
      await validateParticipant(transaction, workspaceId, participant)
    await transaction
      .delete(channelParticipants)
      .where(
        and(
          eq(channelParticipants.workspaceId, workspaceId),
          eq(channelParticipants.channelId, channelId)
        )
      )
    if (normalized.length)
      await transaction.insert(channelParticipants).values(
        normalized.map((participant) => ({
          agentId: participant.kind === 'agent' ? participant.agentId : null,
          channelId,
          principalKind: participant.kind,
          userId: participant.kind === 'user' ? participant.userId : null,
          workspaceId,
        }))
      )
    const [updated] = await transaction
      .update(channels)
      .set({ updatedAt: new Date(), version: channel.version + 1 })
      .where(
        and(
          eq(channels.id, channelId),
          eq(channels.workspaceId, workspaceId),
          eq(channels.version, expectedVersion)
        )
      )
      .returning()
    if (!updated) throw new Error('Channel version conflict')
    return channelSummary(transaction, updated)
  })
}

/** Single-message convenience wrapper; page reads use the batched read instead. */
async function messageSummary(database: Database, row: MessageRow): Promise<MessageSummary> {
  const reads = await readMessageChildReads(database, row.workspaceId, [row.id])
  return messageSummaryFrom(row, reads.get(row.id) ?? { mentions: [], artifactIds: [] })
}

type MessageChildReads = Readonly<{
  mentions: readonly (typeof messageMentions.$inferSelect)[]
  artifactIds: readonly string[]
}>

/**
 * Mention and artifact-reference reads for a whole page, in two queries.
 * `listMessagesForUser` was 2 queries per message; the page is capped at 100,
 * so a full page cost ~204 round trips.
 */
async function readMessageChildReads(
  database: Database,
  workspaceId: string,
  messageIds: readonly string[]
): Promise<Map<string, MessageChildReads>> {
  const byMessage = new Map<
    string,
    { mentions: (typeof messageMentions.$inferSelect)[]; artifactIds: string[] }
  >()
  if (messageIds.length === 0) return byMessage
  for (const id of messageIds) byMessage.set(id, { mentions: [], artifactIds: [] })
  const [mentionRows, artifactRows] = await Promise.all([
    database
      .select()
      .from(messageMentions)
      .where(
        and(
          eq(messageMentions.workspaceId, workspaceId),
          inArray(messageMentions.messageId, [...messageIds])
        )
      ),
    database
      .select({
        artifactId: messageArtifactReferences.artifactId,
        messageId: messageArtifactReferences.messageId,
      })
      .from(messageArtifactReferences)
      .where(
        and(
          eq(messageArtifactReferences.workspaceId, workspaceId),
          inArray(messageArtifactReferences.messageId, [...messageIds])
        )
      )
      .orderBy(asc(messageArtifactReferences.artifactId)),
  ])
  for (const row of mentionRows) byMessage.get(row.messageId)?.mentions.push(row)
  for (const row of artifactRows) byMessage.get(row.messageId)?.artifactIds.push(row.artifactId)
  return byMessage
}

function messageSummaryFrom(row: MessageRow, reads: MessageChildReads): MessageSummary {
  const { mentions: mentionRows, artifactIds } = reads
  const mentions = mentionRows
    .map((mention): ConversationParticipantRef =>
      mention.principalKind === 'user'
        ? { kind: 'user', userId: mention.userId! }
        : { agentId: mention.agentId!, kind: 'agent' }
    )
    .toSorted(compareByStableKey)
  let sender: MessageSenderRef
  if (row.senderKind === 'user') sender = { kind: 'user', userId: row.senderUserId! }
  else if (row.senderKind === 'agent') sender = { agentId: row.senderAgentId!, kind: 'agent' }
  else
    sender = {
      kind: 'system',
      // A job publication's system value encodes its binding; history shows only a label.
      systemId: isJobOutboundSenderValue(row.senderSystemId)
        ? JOB_OUTBOUND_HISTORY_SYSTEM_ID
        : row.senderSystemId!,
    }
  return Object.freeze({
    artifactIds: Object.freeze([...artifactIds]),
    ...(!row.deletedAt && row.bodyContentRefId ? { bodyContentRefId: row.bodyContentRefId } : {}),
    ...(!row.deletedAt && row.bodyText ? { bodyText: row.bodyText } : {}),
    channelId: row.channelId,
    createdAt: row.createdAt.toISOString(),
    deleted: Boolean(row.deletedAt),
    ...(row.deletedAt ? { deletedAt: row.deletedAt.toISOString() } : {}),
    ...(row.editedAt ? { editedAt: row.editedAt.toISOString() } : {}),
    ...(row.executionRef ? { executionRef: row.executionRef } : {}),
    ...(row.externalSessionRef ? { externalSessionRef: row.externalSessionRef } : {}),
    id: row.id,
    mentions: Object.freeze(mentions),
    ...(row.replyToMessageId ? { replyToMessageId: row.replyToMessageId } : {}),
    sender: Object.freeze(sender),
    sequence: row.sequence,
    ...(row.taskId ? { taskId: row.taskId } : {}),
    ...(row.threadRootMessageId ? { threadRootMessageId: row.threadRootMessageId } : {}),
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
    workspaceId: row.workspaceId,
  })
}

async function requireMessage(database: Database, workspaceId: string, messageId: string) {
  const [message] = await database
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.workspaceId, workspaceId)))
    .limit(1)
  if (!message) throw new Error('Message unavailable')
  return message
}

async function validateSender(database: Database, workspaceId: string, sender: MessageSenderRef) {
  if (sender.kind === 'user') await requireWorkspaceUser(database, workspaceId, sender.userId)
  else if (sender.kind === 'agent') await requireActiveAgent(database, workspaceId, sender.agentId)
  else if (!sender.systemId.trim()) throw new Error('Message sender invalid')
}

/**
 * Keeps `channels.latest_message_sequence` equal to the newest live top-level
 * message. GREATEST makes concurrent inserts commit-order independent: identity
 * sequences may commit out of order, and the frontier must never move back.
 */
async function advanceChannelLatestSequence(
  transaction: AgentHqTransaction,
  channelId: string,
  sequence: number
) {
  await transaction
    .update(channels)
    .set({
      latestMessageSequence: sql`GREATEST(${channels.latestMessageSequence}, ${sequence})`,
      // A message is not a channel metadata change; keep `$onUpdate` off it.
      updatedAt: sql`${channels.updatedAt}`,
    })
    .where(eq(channels.id, channelId))
}

/**
 * Deleting the newest top-level message moves the frontier back to the newest
 * remaining live one (read state already ignores deleted messages). Deleting
 * any older message leaves it alone; the guard on the current value makes a
 * concurrent newer insert win.
 */
async function retreatChannelLatestSequence(
  transaction: AgentHqTransaction,
  channelId: string,
  deletedSequence: number
) {
  await transaction
    .update(channels)
    .set({
      latestMessageSequence: sql`coalesce((select max(${messages.sequence}) from ${messages} where ${messages.channelId} = ${channelId} and ${messages.threadRootMessageId} is null and ${messages.deletedAt} is null), 0)`,
      updatedAt: sql`${channels.updatedAt}`,
    })
    .where(and(eq(channels.id, channelId), eq(channels.latestMessageSequence, deletedSequence)))
}

type CreateMessageInput = Readonly<{
  artifactIds?: readonly string[]
  bodyContentRefId?: string
  bodyText?: string
  executionRef?: string
  externalSessionRef?: string
  idempotencyKey: string
  /** Explicit admission mode participates in retry identity; legacy requests omit it. */
  leadTurn?: true
  mentions?: readonly ConversationParticipantRef[]
  replyToMessageId?: string
  sender: MessageSenderRef
  taskId?: string
  threadRootMessageId?: string
}>

export function createMessage(
  database: Database,
  workspaceId: string,
  channelId: string,
  principal: UserPrincipalRef,
  input: CreateMessageInput
) {
  return createMessageWithTextPolicy(database, workspaceId, channelId, principal, input, false)
}

/** Server-only terminal publication; never expose this text policy as a caller input. */
export function createRuntimeResultMessage(
  database: Database,
  workspaceId: string,
  channelId: string,
  principal: UserPrincipalRef,
  input: Readonly<{
    bodyText: string
    executionRef: string
    externalSessionRef: string
    idempotencyKey: string
    sender: Extract<MessageSenderRef, { kind: 'agent' }>
  }>
) {
  return createMessageWithTextPolicy(database, workspaceId, channelId, principal, input, true)
}

async function createMessageWithTextPolicy(
  database: Database,
  workspaceId: string,
  channelId: string,
  principal: UserPrincipalRef,
  input: CreateMessageInput,
  preserveText: boolean
) {
  return database.transaction(async (transaction) => {
    await requireMembership(transaction, workspaceId, principal)
    await requireChannelAccess(transaction, workspaceId, channelId, principal, 'write')
    await validateSender(transaction, workspaceId, input.sender)
    if (Boolean(input.bodyText?.trim()) === Boolean(input.bodyContentRefId))
      throw new Error('Message body invalid')
    const artifactIds = [...new Set(input.artifactIds ?? [])].toSorted()
    if (artifactIds.length) {
      const availableArtifacts = await transaction
        .select({ id: artifacts.id })
        .from(artifacts)
        .where(
          and(
            eq(artifacts.workspaceId, workspaceId),
            eq(artifacts.deletionState, 'active'),
            inArray(artifacts.id, artifactIds)
          )
        )
      if (availableArtifacts.length !== artifactIds.length) throw new Error('Artifact unavailable')
    }
    const mentions = [
      ...new Map((input.mentions ?? []).map((entry) => [stableKey(entry), entry])).values(),
    ].toSorted(compareByStableKey)
    for (const mention of mentions) await validateParticipant(transaction, workspaceId, mention)
    let reply: MessageRow | undefined
    if (input.replyToMessageId) {
      reply = await requireMessage(transaction, workspaceId, input.replyToMessageId)
      if (reply.channelId !== channelId || reply.deletedAt)
        throw new Error('Message reply conflict')
    }
    if (input.threadRootMessageId) {
      const root = await requireMessage(transaction, workspaceId, input.threadRootMessageId)
      if (root.channelId !== channelId || root.threadRootMessageId)
        throw new Error('Message thread conflict')
      if (reply && (reply.threadRootMessageId ?? reply.id) !== root.id)
        throw new Error('Message thread conflict')
    }
    if (input.taskId) await requireVisibleTask(transaction, workspaceId, input.taskId, principal)
    const bodyText = preserveText ? input.bodyText : input.bodyText?.trim()
    const normalized = {
      ...input,
      artifactIds,
      bodyText: bodyText || undefined,
      mentions,
    }
    const payloadHash = hashPayload(normalized)
    const [created] = await transaction
      .insert(messages)
      .values({
        bodyContentRefId: input.bodyContentRefId ?? null,
        bodyText: bodyText || null,
        channelId,
        createPayloadHash: payloadHash,
        executionRef: input.executionRef?.trim() || null,
        externalSessionRef: input.externalSessionRef?.trim() || null,
        idempotencyKey: input.idempotencyKey.trim(),
        replyToMessageId: input.replyToMessageId ?? null,
        senderAgentId: input.sender.kind === 'agent' ? input.sender.agentId : null,
        senderKind: input.sender.kind,
        senderSystemId: input.sender.kind === 'system' ? input.sender.systemId.trim() : null,
        senderUserId: input.sender.kind === 'user' ? input.sender.userId : null,
        taskId: input.taskId ?? null,
        threadRootMessageId: input.threadRootMessageId ?? null,
        workspaceId,
      })
      .onConflictDoNothing({ target: [messages.channelId, messages.idempotencyKey] })
      .returning()
    if (!created) {
      const [existing] = await transaction
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.channelId, channelId),
            eq(messages.idempotencyKey, input.idempotencyKey.trim())
          )
        )
        .limit(1)
      if (!existing || existing.createPayloadHash !== payloadHash)
        throw new Error('Message idempotency conflict')
      await reopenTasksForChannelMessage(
        transaction,
        workspaceId,
        channelId,
        existing.id,
        principal
      )
      return messageSummary(transaction, existing)
    }
    if (!created.threadRootMessageId)
      await advanceChannelLatestSequence(transaction, channelId, created.sequence)
    if (input.bodyContentRefId)
      await attachMessageContentRef(transaction, workspaceId, input.bodyContentRefId, created.id)
    if (mentions.length)
      await transaction.insert(messageMentions).values(
        mentions.map((mention) => ({
          agentId: mention.kind === 'agent' ? mention.agentId : null,
          messageId: created.id,
          principalKind: mention.kind,
          userId: mention.kind === 'user' ? mention.userId : null,
          workspaceId,
        }))
      )
    if (artifactIds.length)
      await transaction
        .insert(messageArtifactReferences)
        .values(
          artifactIds.map((artifactId) => ({ artifactId, messageId: created.id, workspaceId }))
        )
    // A job publication is written by the system. Its event names no acting user: the
    // original actor is in the binding, which only publication delivery reads.
    const jobPublication =
      input.sender.kind === 'system' && isJobOutboundSenderValue(input.sender.systemId.trim())
    await appendWorkspaceEvent(transaction, {
      eventType: 'message.created',
      payload: {
        channelId,
        messageId: created.id,
        sequence: created.sequence,
        ...(jobPublication ? {} : { actorUserId: principal.userId }),
      },
      workspaceId,
    })
    await reopenTasksForChannelMessage(transaction, workspaceId, channelId, created.id, principal)
    return messageSummary(transaction, created)
  })
}

export async function listMessagesForUser(
  database: AgentHqDatabase,
  workspaceId: string,
  channelId: string,
  principal: UserPrincipalRef,
  options: Readonly<{ afterSequence?: number; limit?: number; threadRootMessageId?: string }> = {}
) {
  await requireMembership(database, workspaceId, principal)
  await requireChannelAccess(database, workspaceId, channelId, principal)
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100)
  const rows = await database
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.workspaceId, workspaceId),
        eq(messages.channelId, channelId),
        ...(options.afterSequence !== undefined
          ? [gt(messages.sequence, options.afterSequence)]
          : []),
        ...(options.threadRootMessageId
          ? [eq(messages.threadRootMessageId, options.threadRootMessageId)]
          : [])
      )
    )
    .orderBy(asc(messages.sequence))
    .limit(limit + 1)
  const hasMore = rows.length > limit
  const page = rows.slice(0, limit)
  const visible = await filterVisibleJobOutboundRows(database, page, principal.userId)
  const reads = await readMessageChildReads(
    database,
    workspaceId,
    visible.map((row) => row.id)
  )
  return Object.freeze({
    messages: Object.freeze(
      visible.map((row) =>
        messageSummaryFrom(row, reads.get(row.id) ?? { mentions: [], artifactIds: [] })
      )
    ),
    ...(hasMore && page.length ? { nextAfterSequence: page.at(-1)!.sequence } : {}),
  })
}

export async function getMessageForUser(
  database: AgentHqDatabase,
  workspaceId: string,
  messageId: string,
  principal: UserPrincipalRef
) {
  await requireMembership(database, workspaceId, principal)
  const message = await requireMessage(database, workspaceId, messageId)
  await requireChannelAccess(database, workspaceId, message.channelId, principal)
  // A publication the reader is no longer authorized for is indistinguishable from a missing message.
  if ((await filterVisibleJobOutboundRows(database, [message], principal.userId)).length === 0)
    throw new Error('Message unavailable')
  return messageSummary(database, message)
}

export async function editMessage(
  database: AgentHqDatabase,
  workspaceId: string,
  messageId: string,
  principal: UserPrincipalRef,
  input: Readonly<{ bodyContentRefId?: string | null; bodyText?: string | null }>,
  expectedVersion: number
) {
  return database.transaction(async (transaction) => {
    await requireMembership(transaction, workspaceId, principal)
    const message = await requireMessage(transaction, workspaceId, messageId)
    await requireChannelAccess(transaction, workspaceId, message.channelId, principal, 'write')
    if (message.deletedAt) throw new Error('Message unavailable')
    if (message.version !== expectedVersion) throw new Error('Message version conflict')
    if (Boolean(input.bodyText?.trim()) === Boolean(input.bodyContentRefId))
      throw new Error('Message body invalid')
    const [updated] = await transaction
      .update(messages)
      .set({
        bodyContentRefId: input.bodyContentRefId ?? null,
        bodyText: input.bodyText?.trim() || null,
        editedAt: new Date(),
        updatedAt: new Date(),
        version: message.version + 1,
      })
      .where(
        and(
          eq(messages.id, messageId),
          eq(messages.workspaceId, workspaceId),
          eq(messages.version, expectedVersion),
          isNull(messages.deletedAt)
        )
      )
      .returning()
    if (!updated) throw new Error('Message version conflict')
    if (input.bodyContentRefId)
      await attachMessageContentRef(transaction, workspaceId, input.bodyContentRefId, messageId)
    await appendWorkspaceEvent(transaction, {
      eventType: 'message.updated',
      payload: { actorUserId: principal.userId, messageId, version: updated.version },
      workspaceId,
    })
    return messageSummary(transaction, updated)
  })
}

export async function deleteMessage(
  database: AgentHqDatabase,
  workspaceId: string,
  messageId: string,
  principal: UserPrincipalRef,
  expectedVersion: number
) {
  return database.transaction(async (transaction) => {
    await requireMembership(transaction, workspaceId, principal)
    const message = await requireMessage(transaction, workspaceId, messageId)
    await requireChannelAccess(transaction, workspaceId, message.channelId, principal, 'write')
    if (message.deletedAt) throw new Error('Message unavailable')
    if (message.version !== expectedVersion) throw new Error('Message version conflict')
    const now = new Date()
    const [deleted] = await transaction
      .update(messages)
      .set({
        bodyContentRefId: null,
        bodyText: null,
        deletedAt: now,
        updatedAt: now,
        version: message.version + 1,
      })
      .where(
        and(
          eq(messages.id, messageId),
          eq(messages.workspaceId, workspaceId),
          eq(messages.version, expectedVersion)
        )
      )
      .returning()
    if (!deleted) throw new Error('Message version conflict')
    if (!deleted.threadRootMessageId)
      await retreatChannelLatestSequence(transaction, deleted.channelId, deleted.sequence)
    await appendWorkspaceEvent(transaction, {
      eventType: 'message.deleted',
      payload: { actorUserId: principal.userId, messageId, version: deleted.version },
      workspaceId,
    })
    return messageSummary(transaction, deleted)
  })
}
