import { createHash } from 'node:crypto'

import type {
  TaskLifecycleState,
  TaskPriority,
  TaskSummary,
  UserPrincipalRef,
} from '@agent-hq/types'
import { and, asc, eq, inArray, not } from 'drizzle-orm'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { attachTaskContentRef } from './content-refs'
import {
  agents,
  artifacts,
  channels,
  messages,
  rooms,
  taskDependencies,
  taskMutations,
  tasks,
  workspaceEvents,
  workspaceMemberships,
} from './schema'

export type TaskCommand = Readonly<{
  correlationId?: string
  expectedVersion?: number
  idempotencyKey: string
  requestId: string
}>

export type TaskCreateInput = Readonly<{
  agentId?: string
  artifactRefs?: readonly string[]
  controlPlaneExecutionRef?: string
  controlPlaneWorkflowRef?: string
  conversation?: Readonly<{
    channelId?: string
    messageId?: string
    threadRootMessageId?: string
  }>
  dependencyIds?: readonly string[]
  objective?: string
  objectiveContentRefId?: string
  priority?: TaskPriority
  roomId?: string
  title: string
}>

export type TaskUpdateInput = Readonly<{
  controlPlaneExecutionRef?: string | null
  controlPlaneWorkflowRef?: string | null
  objective?: string
  objectiveContentRefId?: string
  priority?: TaskPriority
  title?: string
}>

type Database = AgentHqDatabase | AgentHqTransaction
type TaskRow = typeof tasks.$inferSelect

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)])
    )
  return value
}

function hashPayload(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex')
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
  if (!membership) throw new Error('Task unavailable')
}

async function requireActiveRoom(database: Database, workspaceId: string, roomId: string) {
  const [room] = await database
    .select({ id: rooms.id })
    .from(rooms)
    .where(
      and(
        eq(rooms.id, roomId),
        eq(rooms.workspaceId, workspaceId),
        eq(rooms.lifecycleState, 'active')
      )
    )
    .limit(1)
  if (!room) throw new Error('Room unavailable')
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

async function summarize(database: Database, row: TaskRow): Promise<TaskSummary> {
  const dependencies = await database
    .select({ id: taskDependencies.dependsOnTaskId })
    .from(taskDependencies)
    .where(
      and(eq(taskDependencies.workspaceId, row.workspaceId), eq(taskDependencies.taskId, row.id))
    )
    .orderBy(asc(taskDependencies.dependsOnTaskId))
  return Object.freeze({
    ...(row.agentId ? { agentId: row.agentId } : {}),
    artifactRefs: Object.freeze([...row.artifactRefs]),
    ...(row.controlPlaneExecutionRef
      ? { controlPlaneExecutionRef: row.controlPlaneExecutionRef }
      : {}),
    ...(row.controlPlaneWorkflowRef
      ? { controlPlaneWorkflowRef: row.controlPlaneWorkflowRef }
      : {}),
    conversation: Object.freeze({
      ...(row.channelId ? { channelId: row.channelId } : {}),
      ...(row.messageId ? { messageId: row.messageId } : {}),
      ...(row.threadRootMessageId ? { threadRootMessageId: row.threadRootMessageId } : {}),
    }),
    createdAt: row.createdAt.toISOString(),
    creator: Object.freeze({ kind: 'user' as const, userId: row.creatorUserId }),
    dependencyIds: Object.freeze(dependencies.map(({ id }) => id)),
    id: row.id,
    lifecycleState: row.lifecycleState,
    ...(row.objective ? { objective: row.objective } : {}),
    ...(row.objectiveContentRefId ? { objectiveContentRefId: row.objectiveContentRefId } : {}),
    priority: row.priority,
    ...(row.roomId ? { roomId: row.roomId } : {}),
    title: row.title,
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
    workspaceId: row.workspaceId,
  })
}

async function requireTask(database: Database, workspaceId: string, taskId: string) {
  const [task] = await database
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, workspaceId)))
    .limit(1)
  if (!task) throw new Error('Task unavailable')
  return task
}

function requireExpectedVersion(row: TaskRow, command: TaskCommand) {
  if (!Number.isInteger(command.expectedVersion) || command.expectedVersion !== row.version)
    throw new Error('Task version conflict')
}

function requireUpdated(row: TaskRow | undefined): TaskRow {
  if (!row) throw new Error('Task version conflict')
  return row
}

async function runMutation(
  transaction: AgentHqTransaction,
  workspaceId: string,
  principal: UserPrincipalRef,
  commandType: string,
  eventType: string,
  payload: unknown,
  command: TaskCommand,
  mutate: () => Promise<TaskSummary>
): Promise<TaskSummary> {
  if (!command.idempotencyKey.trim() || !command.requestId.trim())
    throw new Error('Task command metadata invalid')
  const payloadHash = hashPayload(payload)
  const [reservation] = await transaction
    .insert(taskMutations)
    .values({
      commandType,
      correlationId: command.correlationId?.trim() || null,
      idempotencyKey: command.idempotencyKey.trim(),
      payloadHash,
      requestId: command.requestId,
      workspaceId,
    })
    .onConflictDoNothing({ target: [taskMutations.workspaceId, taskMutations.idempotencyKey] })
    .returning({ id: taskMutations.id })
  if (!reservation) {
    const [existing] = await transaction
      .select()
      .from(taskMutations)
      .where(
        and(
          eq(taskMutations.workspaceId, workspaceId),
          eq(taskMutations.idempotencyKey, command.idempotencyKey.trim())
        )
      )
      .limit(1)
    if (
      !existing ||
      existing.commandType !== commandType ||
      existing.payloadHash !== payloadHash ||
      !existing.resultSnapshot
    )
      throw new Error('Task idempotency conflict')
    return Object.freeze(existing.resultSnapshot)
  }
  const result = await mutate()
  await transaction
    .update(taskMutations)
    .set({
      resultSnapshot: result,
      resultingVersion: result.version,
      taskId: result.id,
      updatedAt: new Date(),
    })
    .where(eq(taskMutations.id, reservation.id))
  await transaction.insert(workspaceEvents).values({
    eventType,
    payload: {
      actorUserId: principal.userId,
      correlationId: command.correlationId ?? null,
      idempotencyKey: command.idempotencyKey,
      requestId: command.requestId,
      taskId: result.id,
      version: result.version,
    },
    workspaceId,
  })
  return result
}

async function validateDependencies(
  database: Database,
  workspaceId: string,
  taskId: string,
  dependencyIds: readonly string[]
) {
  if (new Set(dependencyIds).size !== dependencyIds.length || dependencyIds.includes(taskId))
    throw new Error('Task dependency conflict')
  if (dependencyIds.length) {
    const found = await database
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.workspaceId, workspaceId), inArray(tasks.id, [...dependencyIds])))
    if (found.length !== dependencyIds.length) throw new Error('Task dependency unavailable')
  }
  const existing = await database
    .select({ dependsOnTaskId: taskDependencies.dependsOnTaskId, taskId: taskDependencies.taskId })
    .from(taskDependencies)
    .where(eq(taskDependencies.workspaceId, workspaceId))
  const graph = new Map<string, string[]>()
  for (const edge of existing) {
    if (edge.taskId !== taskId)
      graph.set(edge.taskId, [...(graph.get(edge.taskId) ?? []), edge.dependsOnTaskId])
  }
  graph.set(taskId, [...dependencyIds])
  const reachesTask = (node: string, seen: Set<string>): boolean => {
    if (node === taskId) return true
    if (seen.has(node)) return false
    seen.add(node)
    return (graph.get(node) ?? []).some((next) => reachesTask(next, seen))
  }
  if (dependencyIds.some((id) => reachesTask(id, new Set())))
    throw new Error('Task dependency cycle')
}

export async function createTask(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef,
  input: TaskCreateInput,
  command: TaskCommand
): Promise<TaskSummary> {
  return database.transaction(async (transaction) => {
    await requireMembership(transaction, workspaceId, principal)
    return runMutation(
      transaction,
      workspaceId,
      principal,
      'task.create',
      'task.created',
      input,
      command,
      async () => {
        if (Boolean(input.objective?.trim()) === Boolean(input.objectiveContentRefId))
          throw new Error('Task objective invalid')
        if (input.agentId) await requireActiveAgent(transaction, workspaceId, input.agentId)
        if (input.roomId) await requireActiveRoom(transaction, workspaceId, input.roomId)
        const artifactRefs = [...new Set(input.artifactRefs?.map((value) => value.trim()) ?? [])]
        if (artifactRefs.some((value) => !value)) throw new Error('Task Artifact reference invalid')
        const [created] = await transaction
          .insert(tasks)
          .values({
            agentId: input.agentId ?? null,
            artifactRefs,
            channelId: input.conversation?.channelId ?? null,
            controlPlaneExecutionRef: input.controlPlaneExecutionRef?.trim() || null,
            controlPlaneWorkflowRef: input.controlPlaneWorkflowRef?.trim() || null,
            creatorUserId: principal.userId,
            messageId: input.conversation?.messageId ?? null,
            objective: input.objective?.trim() || null,
            objectiveContentRefId: input.objectiveContentRefId ?? null,
            priority: input.priority ?? 'normal',
            roomId: input.roomId ?? null,
            threadRootMessageId: input.conversation?.threadRootMessageId ?? null,
            title: input.title.trim(),
            workspaceId,
          })
          .returning()
        if (!created) throw new Error('Task creation failed')
        if (input.objectiveContentRefId)
          await attachTaskContentRef(
            transaction,
            workspaceId,
            input.objectiveContentRefId,
            created.id,
            'task_objective'
          )
        await validateDependencies(transaction, workspaceId, created.id, input.dependencyIds ?? [])
        if (input.dependencyIds?.length)
          await transaction.insert(taskDependencies).values(
            input.dependencyIds.map((dependsOnTaskId) => ({
              dependsOnTaskId,
              taskId: created.id,
              workspaceId,
            }))
          )
        return summarize(transaction, created)
      }
    )
  })
}

export async function listTasksForUser(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef,
  options: Readonly<{ includeArchived?: boolean }> = {}
): Promise<TaskSummary[]> {
  await requireMembership(database, workspaceId, principal)
  const rows = await database
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.workspaceId, workspaceId),
        ...(options.includeArchived ? [] : [not(eq(tasks.lifecycleState, 'archived'))])
      )
    )
    .orderBy(asc(tasks.createdAt), asc(tasks.id))
  return Promise.all(rows.map((row) => summarize(database, row)))
}

export async function getTaskForUser(
  database: AgentHqDatabase,
  workspaceId: string,
  taskId: string,
  principal: UserPrincipalRef,
  options: Readonly<{ includeArchived?: boolean }> = {}
): Promise<TaskSummary | null> {
  const [row] = await database
    .select({ task: tasks })
    .from(tasks)
    .innerJoin(
      workspaceMemberships,
      and(
        eq(workspaceMemberships.workspaceId, tasks.workspaceId),
        eq(workspaceMemberships.userId, principal.userId)
      )
    )
    .where(
      and(
        eq(tasks.id, taskId),
        eq(tasks.workspaceId, workspaceId),
        ...(options.includeArchived ? [] : [not(eq(tasks.lifecycleState, 'archived'))])
      )
    )
    .limit(1)
  return row ? summarize(database, row.task) : null
}

async function mutateExisting(
  database: AgentHqDatabase,
  workspaceId: string,
  taskId: string,
  principal: UserPrincipalRef,
  commandType: string,
  eventType: string,
  payload: Record<string, unknown>,
  command: TaskCommand,
  mutate: (transaction: AgentHqTransaction, row: TaskRow) => Promise<TaskRow>
): Promise<TaskSummary> {
  return database.transaction(async (transaction) => {
    await requireMembership(transaction, workspaceId, principal)
    return runMutation(
      transaction,
      workspaceId,
      principal,
      commandType,
      eventType,
      { ...payload, expectedVersion: command.expectedVersion, taskId },
      command,
      async () => {
        const row = await requireTask(transaction, workspaceId, taskId)
        requireExpectedVersion(row, command)
        if (row.lifecycleState === 'archived') throw new Error('Task unavailable')
        return summarize(transaction, await mutate(transaction, row))
      }
    )
  })
}

export async function updateTask(
  database: AgentHqDatabase,
  workspaceId: string,
  taskId: string,
  principal: UserPrincipalRef,
  input: TaskUpdateInput,
  command: TaskCommand
) {
  if (input.objective !== undefined && input.objectiveContentRefId !== undefined)
    throw new Error('Task objective invalid')
  if (input.objective !== undefined && !input.objective.trim())
    throw new Error('Task objective invalid')
  return mutateExisting(
    database,
    workspaceId,
    taskId,
    principal,
    'task.update',
    'task.updated',
    { ...input },
    command,
    async (transaction, row) => {
      const [updated] = await transaction
        .update(tasks)
        .set({
          ...(input.controlPlaneExecutionRef !== undefined
            ? { controlPlaneExecutionRef: input.controlPlaneExecutionRef?.trim() || null }
            : {}),
          ...(input.controlPlaneWorkflowRef !== undefined
            ? { controlPlaneWorkflowRef: input.controlPlaneWorkflowRef?.trim() || null }
            : {}),
          ...(input.objective !== undefined ? { objective: input.objective.trim() } : {}),
          ...(input.objective !== undefined ? { objectiveContentRefId: null } : {}),
          ...(input.objectiveContentRefId !== undefined
            ? { objective: null, objectiveContentRefId: input.objectiveContentRefId }
            : {}),
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
          ...(input.title !== undefined ? { title: input.title.trim() } : {}),
          updatedAt: new Date(),
          version: row.version + 1,
        })
        .where(
          and(
            eq(tasks.id, taskId),
            eq(tasks.workspaceId, workspaceId),
            eq(tasks.version, row.version)
          )
        )
        .returning()
      const required = requireUpdated(updated)
      if (input.objectiveContentRefId)
        await attachTaskContentRef(
          transaction,
          workspaceId,
          input.objectiveContentRefId,
          taskId,
          'task_objective'
        )
      return required
    }
  )
}

export async function assignTask(
  database: AgentHqDatabase,
  workspaceId: string,
  taskId: string,
  principal: UserPrincipalRef,
  agentId: string | null,
  command: TaskCommand
) {
  return mutateExisting(
    database,
    workspaceId,
    taskId,
    principal,
    'task.assign',
    'task.assigned',
    { agentId },
    command,
    async (transaction, row) => {
      if (agentId) await requireActiveAgent(transaction, workspaceId, agentId)
      const [updated] = await transaction
        .update(tasks)
        .set({ agentId, updatedAt: new Date(), version: row.version + 1 })
        .where(
          and(
            eq(tasks.id, taskId),
            eq(tasks.workspaceId, workspaceId),
            eq(tasks.version, row.version)
          )
        )
        .returning()
      return requireUpdated(updated)
    }
  )
}

export async function moveTaskToRoom(
  database: AgentHqDatabase,
  workspaceId: string,
  taskId: string,
  principal: UserPrincipalRef,
  roomId: string | null,
  command: TaskCommand
) {
  return mutateExisting(
    database,
    workspaceId,
    taskId,
    principal,
    'task.move_room',
    'task.room_changed',
    { roomId },
    command,
    async (transaction, row) => {
      if (roomId) await requireActiveRoom(transaction, workspaceId, roomId)
      const [updated] = await transaction
        .update(tasks)
        .set({ roomId, updatedAt: new Date(), version: row.version + 1 })
        .where(
          and(
            eq(tasks.id, taskId),
            eq(tasks.workspaceId, workspaceId),
            eq(tasks.version, row.version)
          )
        )
        .returning()
      return requireUpdated(updated)
    }
  )
}

async function transitionTask(
  database: AgentHqDatabase,
  workspaceId: string,
  taskId: string,
  principal: UserPrincipalRef,
  target: TaskLifecycleState,
  command: TaskCommand
) {
  return mutateExisting(
    database,
    workspaceId,
    taskId,
    principal,
    `task.${target}`,
    `task.${target}`,
    { target },
    command,
    async (transaction, row) => {
      const valid: Record<TaskLifecycleState, readonly TaskLifecycleState[]> = {
        archived: [],
        cancelled: ['archived'],
        created: ['queued', 'cancelled', 'archived'],
        queued: ['cancelled', 'archived'],
      }
      if (!valid[row.lifecycleState].includes(target))
        throw new Error('Invalid Task lifecycle transition')
      const [updated] = await transaction
        .update(tasks)
        .set({ lifecycleState: target, updatedAt: new Date(), version: row.version + 1 })
        .where(
          and(
            eq(tasks.id, taskId),
            eq(tasks.workspaceId, workspaceId),
            eq(tasks.version, row.version)
          )
        )
        .returning()
      return requireUpdated(updated)
    }
  )
}

export const queueTask = (
  database: AgentHqDatabase,
  workspaceId: string,
  taskId: string,
  principal: UserPrincipalRef,
  command: TaskCommand
) => transitionTask(database, workspaceId, taskId, principal, 'queued', command)
export const cancelTask = (
  database: AgentHqDatabase,
  workspaceId: string,
  taskId: string,
  principal: UserPrincipalRef,
  command: TaskCommand
) => transitionTask(database, workspaceId, taskId, principal, 'cancelled', command)
export const archiveTask = (
  database: AgentHqDatabase,
  workspaceId: string,
  taskId: string,
  principal: UserPrincipalRef,
  command: TaskCommand
) => transitionTask(database, workspaceId, taskId, principal, 'archived', command)

export async function setTaskDependencies(
  database: AgentHqDatabase,
  workspaceId: string,
  taskId: string,
  principal: UserPrincipalRef,
  dependencyIds: readonly string[],
  command: TaskCommand
) {
  return mutateExisting(
    database,
    workspaceId,
    taskId,
    principal,
    'task.set_dependencies',
    'task.dependencies_changed',
    { dependencyIds },
    command,
    async (transaction, row) => {
      await validateDependencies(transaction, workspaceId, taskId, dependencyIds)
      await transaction
        .delete(taskDependencies)
        .where(
          and(eq(taskDependencies.workspaceId, workspaceId), eq(taskDependencies.taskId, taskId))
        )
      if (dependencyIds.length)
        await transaction
          .insert(taskDependencies)
          .values(
            dependencyIds.map((dependsOnTaskId) => ({ dependsOnTaskId, taskId, workspaceId }))
          )
      const [updated] = await transaction
        .update(tasks)
        .set({ updatedAt: new Date(), version: row.version + 1 })
        .where(
          and(
            eq(tasks.id, taskId),
            eq(tasks.workspaceId, workspaceId),
            eq(tasks.version, row.version)
          )
        )
        .returning()
      return requireUpdated(updated)
    }
  )
}

export async function setTaskArtifactReferences(
  database: AgentHqDatabase,
  workspaceId: string,
  taskId: string,
  principal: UserPrincipalRef,
  artifactRefs: readonly string[],
  command: TaskCommand
) {
  const normalized = [...new Set(artifactRefs.map((value) => value.trim()))]
  if (normalized.some((value) => !value)) throw new Error('Task Artifact reference invalid')
  return mutateExisting(
    database,
    workspaceId,
    taskId,
    principal,
    'task.set_artifacts',
    'task.artifacts_changed',
    { artifactRefs: normalized },
    command,
    async (transaction, row) => {
      if (normalized.length) {
        const availableArtifacts = await transaction
          .select({ id: artifacts.id })
          .from(artifacts)
          .where(
            and(
              eq(artifacts.workspaceId, workspaceId),
              eq(artifacts.deletionState, 'active'),
              inArray(artifacts.id, normalized)
            )
          )
        if (availableArtifacts.length !== normalized.length)
          throw new Error('Task Artifact unavailable')
      }
      const [updated] = await transaction
        .update(tasks)
        .set({ artifactRefs: normalized, updatedAt: new Date(), version: row.version + 1 })
        .where(
          and(
            eq(tasks.id, taskId),
            eq(tasks.workspaceId, workspaceId),
            eq(tasks.version, row.version)
          )
        )
        .returning()
      return requireUpdated(updated)
    }
  )
}

export async function setTaskConversationReferences(
  database: AgentHqDatabase,
  workspaceId: string,
  taskId: string,
  principal: UserPrincipalRef,
  conversation: Readonly<{
    channelId?: string | null
    messageId?: string | null
    threadRootMessageId?: string | null
  }>,
  command: TaskCommand
) {
  return mutateExisting(
    database,
    workspaceId,
    taskId,
    principal,
    'task.set_conversation',
    'task.conversation_changed',
    { ...conversation },
    command,
    async (transaction, row) => {
      let channelId = conversation.channelId ?? null
      if (channelId) {
        const [channel] = await transaction
          .select({ id: channels.id })
          .from(channels)
          .where(
            and(
              eq(channels.id, channelId),
              eq(channels.workspaceId, workspaceId),
              eq(channels.lifecycleState, 'active')
            )
          )
          .limit(1)
        if (!channel) throw new Error('Channel unavailable')
      }
      for (const messageId of [conversation.messageId, conversation.threadRootMessageId]) {
        if (!messageId) continue
        const [message] = await transaction
          .select({ channelId: messages.channelId })
          .from(messages)
          .where(and(eq(messages.id, messageId), eq(messages.workspaceId, workspaceId)))
          .limit(1)
        if (!message || (channelId && message.channelId !== channelId))
          throw new Error('Message unavailable')
        channelId ??= message.channelId
      }
      const [updated] = await transaction
        .update(tasks)
        .set({
          channelId,
          messageId: conversation.messageId ?? null,
          threadRootMessageId: conversation.threadRootMessageId ?? null,
          updatedAt: new Date(),
          version: row.version + 1,
        })
        .where(
          and(
            eq(tasks.id, taskId),
            eq(tasks.workspaceId, workspaceId),
            eq(tasks.version, row.version)
          )
        )
        .returning()
      return requireUpdated(updated)
    }
  )
}
