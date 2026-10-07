import { createHash, randomUUID } from 'node:crypto'

import type { TaskSubmissionSummary, UserPrincipalRef } from '@adea-ai/types'
import { MAX_REMOTE_CONTENT_TTL_MS, parseRemoteContentEnvelope } from '@adea-ai/remote-content'
import { and, eq, isNull, or, sql } from 'drizzle-orm'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { controlPlaneScopeIds } from './control-plane-identifiers'
import { requireProjectAccessScope, requireProjectWrite } from './project-access'
import { RUNTIME_NODE_STALE_AFTER_MS } from './runtime-nodes'
import {
  agents,
  channels,
  commandOutbox,
  contentRefs,
  messages,
  projectMembers,
  projects,
  runtimeNodeKeys,
  runtimeNodes,
  taskSubmissions,
  tasks,
  workspaceMemberships,
  workspaces,
} from './schema'
import type { TaskCommand } from './tasks'
import { appendWorkspaceEvent } from './transactions'

export type TaskSubmissionInput = Readonly<{
  runtimeNodeId: string
  queueWhenOffline: boolean
  profile: Readonly<{ id: string; version: string; revision: number }>
  envelope: unknown
}>

export class TaskSubmissionError extends Error {
  constructor(
    readonly code:
      | 'invalid'
      | 'unavailable'
      | 'version_conflict'
      | 'profile_conflict'
      | 'node_offline'
      | 'key_unavailable'
      | 'idempotency_conflict'
      | 'already_submitted'
      | 'expired'
  ) {
    super(`Task submission refused: ${code}`)
    this.name = 'TaskSubmissionError'
  }
}

type SubmissionRow = typeof taskSubmissions.$inferSelect

function summary(row: SubmissionRow): TaskSubmissionSummary {
  return Object.freeze({
    id: row.id,
    workspaceId: row.workspaceId,
    taskId: row.taskId,
    requestId: row.requestId,
    runtimeNodeId: row.runtimeNodeId,
    locationKind: row.locationKind,
    state: Date.now() >= row.expiresAt.getTime() ? 'expired' : row.state,
    profile: Object.freeze({
      id: row.profileId,
      version: row.profileVersion,
      revision: row.profileRevision,
    }),
    taskVersion: row.taskVersion,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  })
}

export async function authorizeTaskSubmission(
  transaction: AgentHqTransaction,
  workspaceId: string,
  taskId: string,
  principal: UserPrincipalRef
) {
  // Hold membership, workspace, task and project authorization through commit.
  // Revocation/deletion or moving a task cannot race queue admission.
  const [membership] = await transaction
    .select({ role: workspaceMemberships.role })
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, principal.userId)
      )
    )
    .for('share')
  if (!membership || (membership.role !== 'owner' && membership.role !== 'admin'))
    throw new TaskSubmissionError('unavailable')
  const [workspace] = await transaction
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)))
    .for('share')
  if (!workspace) throw new TaskSubmissionError('unavailable')
  const [task] = await transaction
    .select({
      id: tasks.id,
      agentId: tasks.agentId,
      projectId: tasks.projectId,
      version: tasks.version,
      lifecycleState: tasks.lifecycleState,
      controlPlaneTaskId: tasks.controlPlaneTaskId,
      controlPlaneExecutionRef: tasks.controlPlaneExecutionRef,
      channelId: tasks.channelId,
      messageId: tasks.messageId,
      threadRootMessageId: tasks.threadRootMessageId,
      objectiveContentRefId: tasks.objectiveContentRefId,
    })
    .from(tasks)
    .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, taskId)))
    .for('update')
  if (!task) throw new TaskSubmissionError('unavailable')
  if (task.projectId) {
    const [project] = await transaction
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.workspaceId, workspaceId),
          eq(projects.id, task.projectId),
          isNull(projects.deletedAt),
          eq(projects.lifecycleState, 'active')
        )
      )
      .for('share')
    if (!project) throw new TaskSubmissionError('unavailable')
    await transaction
      .select({ id: projectMembers.id })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, task.projectId),
          eq(projectMembers.userId, principal.userId)
        )
      )
      .for('share')
  }
  requireProjectWrite(
    await requireProjectAccessScope(transaction, workspaceId, principal, 'Task unavailable'),
    task.projectId,
    'Task unavailable'
  )
  return task
}

export async function submissionConversation(
  transaction: AgentHqTransaction,
  workspaceId: string,
  task: Readonly<{
    channelId: string | null
    messageId: string | null
    threadRootMessageId: string | null
  }>
) {
  let channelId = task.channelId
  for (const messageId of [task.messageId, task.threadRootMessageId]) {
    if (!messageId) continue
    const [message] = await transaction
      .select({ channelId: messages.channelId })
      .from(messages)
      .where(and(eq(messages.workspaceId, workspaceId), eq(messages.id, messageId)))
      .for('share')
    if (!message || (channelId && channelId !== message.channelId))
      throw new TaskSubmissionError('unavailable')
    channelId ??= message.channelId
  }
  if (channelId) {
    const [channel] = await transaction
      .select({ id: channels.id })
      .from(channels)
      .where(
        and(
          eq(channels.workspaceId, workspaceId),
          eq(channels.id, channelId),
          eq(channels.lifecycleState, 'active')
        )
      )
      .for('share')
    if (!channel) throw new TaskSubmissionError('unavailable')
  }
  return { channelId, messageId: task.messageId, threadRootMessageId: task.threadRootMessageId }
}

/** Atomically preserve delivery intent and one opaque ciphertext command. No runtime call. */
export async function enqueueTaskSubmission(
  database: AgentHqDatabase,
  workspaceId: string,
  taskId: string,
  principal: UserPrincipalRef,
  input: TaskSubmissionInput,
  command: TaskCommand
): Promise<TaskSubmissionSummary> {
  let envelope
  try {
    envelope = parseRemoteContentEnvelope(input.envelope)
  } catch {
    throw new TaskSubmissionError('invalid')
  }
  if (
    !command.idempotencyKey.trim() ||
    command.idempotencyKey.length > 128 ||
    !Number.isInteger(command.expectedVersion) ||
    envelope.aad.workspaceId !== workspaceId ||
    envelope.aad.runtimeNodeId !== input.runtimeNodeId ||
    envelope.aad.requestId !== command.requestId ||
    envelope.aad.payloadType !== 'command.input' ||
    typeof input.queueWhenOffline !== 'boolean' ||
    !Number.isInteger(input.profile.revision) ||
    input.profile.revision < 0
  )
    throw new TaskSubmissionError('invalid')
  // Construct, rather than spread caller metadata: prompt/context/extra fields
  // cannot enter the queue. Canonical envelope ordering comes from its parser.
  const canonicalInput = {
    taskId,
    runtimeNodeId: input.runtimeNodeId,
    queueWhenOffline: input.queueWhenOffline,
    profile: {
      id: input.profile.id,
      version: input.profile.version,
      revision: input.profile.revision,
    },
    expectedVersion: command.expectedVersion,
    requestId: command.requestId,
    envelope,
  }
  const payloadHash = createHash('sha256').update(JSON.stringify(canonicalInput)).digest('hex')
  return database.transaction(async (transaction) => {
    // Serialize same workspace/key even when racing requests name different
    // tasks. A hash collision only serializes unrelated keys; identity and
    // payload comparison still use the complete values below.
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`adea-task-submit:${workspaceId}:${command.idempotencyKey.trim()}`}, 0))`
    )
    // A request UUID can race under different idempotency keys. Lock both
    // namespaces in this order so the loser receives a typed conflict.
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`adea-task-submit-request:${workspaceId}:${command.requestId}`}, 0))`
    )
    const task = await authorizeTaskSubmission(transaction, workspaceId, taskId, principal)
    const idempotencyKey = command.idempotencyKey.trim()
    const [existing] = await transaction
      .select()
      .from(taskSubmissions)
      .where(
        and(
          eq(taskSubmissions.workspaceId, workspaceId),
          or(
            eq(taskSubmissions.taskId, taskId),
            eq(taskSubmissions.idempotencyKey, idempotencyKey),
            eq(taskSubmissions.requestId, command.requestId)
          )
        )
      )
    if (existing) {
      if (
        existing.taskId !== taskId ||
        existing.idempotencyKey !== idempotencyKey ||
        existing.payloadHash !== payloadHash
      )
        throw new TaskSubmissionError(
          existing.taskId === taskId && existing.idempotencyKey !== idempotencyKey
            ? 'already_submitted'
            : 'idempotency_conflict'
        )
      return summary(existing)
    }
    if (task.version !== command.expectedVersion) throw new TaskSubmissionError('version_conflict')
    if (
      !task.agentId ||
      !task.projectId ||
      task.controlPlaneExecutionRef ||
      !['created', 'queued'].includes(task.lifecycleState)
    )
      throw new TaskSubmissionError('unavailable')
    const conversation = await submissionConversation(transaction, workspaceId, task)
    if (task.objectiveContentRefId) {
      const [reference] = await transaction
        .select({ taskId: contentRefs.taskId })
        .from(contentRefs)
        .where(
          and(
            eq(contentRefs.workspaceId, workspaceId),
            eq(contentRefs.id, task.objectiveContentRefId),
            eq(contentRefs.contentType, 'task_objective')
          )
        )
        .for('share')
      if (!reference || (reference.taskId && reference.taskId !== taskId))
        throw new TaskSubmissionError('unavailable')
    }
    const [agent] = await transaction
      .select({
        profileId: agents.profileId,
        profileVersion: agents.profileVersion,
        profileRevision: agents.profileRevision,
        profileState: agents.profileState,
        lifecycleState: agents.lifecycleState,
        controlPlaneAgentId: agents.controlPlaneAgentId,
      })
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, task.agentId)))
      .for('share')
    if (
      !agent ||
      agent.lifecycleState !== 'active' ||
      agent.profileState !== 'available' ||
      agent.profileId !== input.profile.id ||
      agent.profileVersion !== input.profile.version ||
      agent.profileRevision !== input.profile.revision ||
      !/^prf_[0-9A-HJKMNP-TV-Z]{26}$/u.test(agent.profileId) ||
      !/^pfv_[0-9A-HJKMNP-TV-Z]{26}$/u.test(agent.profileVersion)
    )
      throw new TaskSubmissionError('profile_conflict')
    const [node] = await transaction
      .select()
      .from(runtimeNodes)
      .where(
        and(eq(runtimeNodes.workspaceId, workspaceId), eq(runtimeNodes.id, input.runtimeNodeId))
      )
      .for('share')
    if (!node || node.pairingState !== 'paired') throw new TaskSubmissionError('unavailable')
    const keys = await transaction
      .select()
      .from(runtimeNodeKeys)
      .where(and(eq(runtimeNodeKeys.runtimeNodeId, node.id), isNull(runtimeNodeKeys.retiredAt)))
      .for('share')
    const signing = keys.find(
      (key) => key.role === 'signing' && key.algorithm === 'ed25519' && key.verifiedAt
    )
    const encryption = keys.find(
      (key) =>
        key.role === 'command_encryption' &&
        key.algorithm === 'x25519' &&
        key.verifiedAt &&
        key.id === envelope.keyId
    )
    if (!signing || !encryption) throw new TaskSubmissionError('key_unavailable')
    const now = Date.now()
    const issuedAt = Date.parse(envelope.aad.issuedAt)
    const expiresAt = Date.parse(envelope.aad.expiresAt)
    if (now >= expiresAt) throw new TaskSubmissionError('expired')
    if (
      expiresAt <= issuedAt ||
      expiresAt - issuedAt > MAX_REMOTE_CONTENT_TTL_MS ||
      issuedAt > now + 30_000
    )
      throw new TaskSubmissionError('invalid')
    const online =
      node.lastProofAt !== null && now - node.lastProofAt.getTime() <= RUNTIME_NODE_STALE_AFTER_MS
    if (!online && !input.queueWhenOffline) throw new TaskSubmissionError('node_offline')
    const scope = await controlPlaneScopeIds(transaction, {
      workspaceId,
      projectId: task.projectId,
    })
    if (!scope?.projectId) throw new TaskSubmissionError('unavailable')
    const commandId = randomUUID()
    const submissionId = randomUUID()
    // This explicit, fixed projection is coordination metadata, not a prompt,
    // ContextPackage, runtime acceptance or canonical conversation history.
    await transaction.insert(commandOutbox).values({
      id: commandId,
      workspaceId,
      requestId: command.requestId,
      idempotencyKey: `task.submit:${idempotencyKey}`,
      commandType: 'task.submit',
      payload: {
        version: 1,
        submissionId,
        taskId,
        agentId: task.agentId,
        runtimeNodeId: node.id,
        profile: canonicalInput.profile,
        taskVersion: task.version,
        controlPlane: {
          ...scope,
          taskId: task.controlPlaneTaskId,
          agentId: agent.controlPlaneAgentId,
          runtimeNodeRefId: node.controlPlaneRuntimeNodeRefId,
        },
        conversation,
        objectiveContentRefId: task.objectiveContentRefId,
        envelope,
      },
    })
    const [row] = await transaction
      .insert(taskSubmissions)
      .values({
        id: submissionId,
        commandId,
        workspaceId,
        taskId,
        requestId: command.requestId,
        agentId: task.agentId,
        actorUserId: principal.userId,
        runtimeNodeId: node.id,
        locationKind: node.kind,
        state: online ? 'pending_delivery' : 'queued_for_node',
        taskVersion: task.version,
        profileId: agent.profileId,
        profileVersion: agent.profileVersion,
        profileRevision: agent.profileRevision,
        payloadHash,
        idempotencyKey,
        expiresAt: new Date(expiresAt),
      })
      .returning()
    if (!row) throw new TaskSubmissionError('unavailable')
    await appendWorkspaceEvent(transaction, {
      eventType: 'task.submission_queued',
      workspaceId,
      payload: {
        taskId,
        submissionId,
        runtimeNodeId: node.id,
        requestId: command.requestId,
        actorUserId: principal.userId,
        state: row.state,
      },
    })
    return summary(row)
  })
}

export async function getTaskSubmissionForUser(
  database: AgentHqDatabase,
  workspaceId: string,
  taskId: string,
  principal: UserPrincipalRef
): Promise<TaskSubmissionSummary | null> {
  return database.transaction(async (transaction) => {
    await authorizeTaskSubmission(transaction, workspaceId, taskId, principal)
    const [row] = await transaction
      .select()
      .from(taskSubmissions)
      .where(and(eq(taskSubmissions.workspaceId, workspaceId), eq(taskSubmissions.taskId, taskId)))
    return row ? summary(row) : null
  })
}
