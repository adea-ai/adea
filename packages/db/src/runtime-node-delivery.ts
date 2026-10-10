import {
  parseRuntimeNodePullRequest,
  parseRuntimeNodeRetentionReceiptRequest,
  verifyRuntimeNodePull,
  verifyRuntimeNodeRetentionReceipt,
  RUNTIME_NODE_PULL_WINDOW_MS,
  RUNTIME_NODE_PULL_FUTURE_MS,
  RUNTIME_NODE_PULLS_PER_MINUTE,
  type RuntimeNodeDeliveryScope,
  type RuntimeNodePullRequest,
} from '@adea-ai/types/runtime-node-delivery'
import { parseRemoteContentEnvelope } from '@adea-ai/remote-content'
import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { controlPlaneScopeIds } from './control-plane-identifiers'
import {
  agents,
  commandOutbox,
  projects,
  runtimeNodeDeliveryRequests,
  runtimeNodeKeys,
  runtimeNodes,
  taskSubmissions,
  tasks,
  workspaceMemberships,
  workspaces,
} from './schema'
import {
  authorizeTaskSubmission,
  submissionConversation,
  TaskSubmissionError,
} from './task-submissions'
import { appendWorkspaceEvent } from './transactions'
import { recordRetentionCleanupReceipt } from './retention-cleanup'
import type { RetentionCategory } from './retention-policy'

export class RuntimeNodeDeliveryError extends Error {
  constructor(readonly code: 'unavailable' | 'replayed' | 'rate_limited') {
    super('Runtime node delivery unavailable')
    this.name = 'RuntimeNodeDeliveryError'
  }
}

/** Operator retention only; never prune a live proof or its full rate window. */
export async function pruneRuntimeNodeDeliveryRequests(
  database: AgentHqDatabase,
  limit = 1000
): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new Error('Invalid node request retention limit')
  const deleted = await database.execute(sql`with expired as (
    select id from ${runtimeNodeDeliveryRequests}
    where expires_at <= now() and created_at <= now() - interval '60 seconds'
    order by expires_at, id for update skip locked limit ${limit}
  ) delete from ${runtimeNodeDeliveryRequests} where id in (select id from expired) returning id`)
  return deleted.length
}
function withinWindow(input: RuntimeNodePullRequest, now: number) {
  const issued = Date.parse(input.issuedAt)
  return now < issued + RUNTIME_NODE_PULL_WINDOW_MS && issued <= now + RUNTIME_NODE_PULL_FUTURE_MS
}
async function signingKey(
  database: AgentHqDatabase | AgentHqTransaction,
  scope: RuntimeNodeDeliveryScope,
  keyId: string
) {
  const [key] = await database
    .select({ id: runtimeNodeKeys.id, publicKey: runtimeNodeKeys.publicKey })
    .from(runtimeNodeKeys)
    .innerJoin(runtimeNodes, eq(runtimeNodes.id, runtimeNodeKeys.runtimeNodeId))
    .innerJoin(workspaces, eq(workspaces.id, runtimeNodes.workspaceId))
    .where(
      and(
        eq(runtimeNodes.workspaceId, scope.workspaceId),
        eq(runtimeNodes.id, scope.runtimeNodeId),
        eq(runtimeNodes.pairingState, 'paired'),
        isNull(workspaces.deletedAt),
        eq(runtimeNodeKeys.id, keyId),
        eq(runtimeNodeKeys.role, 'signing'),
        eq(runtimeNodeKeys.algorithm, 'ed25519'),
        isNull(runtimeNodeKeys.retiredAt),
        sql`${runtimeNodeKeys.verifiedAt} is not null`
      )
    )
  return key
}

/** At-least-once ciphertext pull. Neither pulling nor transport authentication accepts execution. */
export async function pullRuntimeNodeCommand(
  database: AgentHqDatabase,
  scope: RuntimeNodeDeliveryScope,
  value: unknown
) {
  const input = parseRuntimeNodePullRequest(value)
  if (!input || !withinWindow(input, Date.now())) throw new RuntimeNodeDeliveryError('unavailable')
  const preliminary = await signingKey(database, scope, input.keyId)
  if (!preliminary || !(await verifyRuntimeNodePull(scope, input, preliminary.publicKey)))
    throw new RuntimeNodeDeliveryError('unavailable')
  return database.transaction(async (transaction) => {
    // Serialize only this node's pulls, including empty polls and replay/rate checks.
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`adea-node-pull:${scope.runtimeNodeId}`}, 0))`
    )
    const [candidate] = await transaction
      .select({ submission: taskSubmissions })
      .from(taskSubmissions)
      .innerJoin(
        tasks,
        and(
          eq(tasks.id, taskSubmissions.taskId),
          eq(tasks.workspaceId, taskSubmissions.workspaceId)
        )
      )
      .innerJoin(
        agents,
        and(
          eq(agents.id, taskSubmissions.agentId),
          eq(agents.workspaceId, taskSubmissions.workspaceId)
        )
      )
      .innerJoin(
        projects,
        and(eq(projects.id, tasks.projectId), eq(projects.workspaceId, taskSubmissions.workspaceId))
      )
      .innerJoin(
        workspaceMemberships,
        and(
          eq(workspaceMemberships.workspaceId, taskSubmissions.workspaceId),
          eq(workspaceMemberships.userId, taskSubmissions.actorUserId)
        )
      )
      .innerJoin(
        commandOutbox,
        and(
          eq(commandOutbox.id, taskSubmissions.commandId),
          eq(commandOutbox.workspaceId, taskSubmissions.workspaceId)
        )
      )
      .where(
        and(
          eq(taskSubmissions.workspaceId, scope.workspaceId),
          eq(taskSubmissions.runtimeNodeId, scope.runtimeNodeId),
          gt(taskSubmissions.expiresAt, new Date()),
          inArray(workspaceMemberships.role, ['owner', 'admin']),
          eq(tasks.version, taskSubmissions.taskVersion),
          eq(tasks.agentId, taskSubmissions.agentId),
          inArray(tasks.lifecycleState, ['created', 'queued']),
          isNull(tasks.controlPlaneExecutionRef),
          eq(agents.lifecycleState, 'active'),
          eq(agents.profileState, 'available'),
          eq(agents.profileId, taskSubmissions.profileId),
          eq(agents.profileVersion, taskSubmissions.profileVersion),
          eq(agents.profileRevision, taskSubmissions.profileRevision),
          isNull(projects.deletedAt),
          eq(projects.lifecycleState, 'active'),
          eq(commandOutbox.commandType, 'task.submit'),
          eq(commandOutbox.status, 'pending')
        )
      )
      .orderBy(asc(taskSubmissions.createdAt), asc(taskSubmissions.id))
      .limit(1)
    // Preserve admission's membership/workspace -> Task -> Agent -> node -> keys lock order.
    let task: Awaited<ReturnType<typeof authorizeTaskSubmission>> | undefined
    let agent: typeof agents.$inferSelect | undefined
    if (candidate?.submission.actorUserId) {
      try {
        task = await authorizeTaskSubmission(
          transaction,
          scope.workspaceId,
          candidate.submission.taskId,
          { kind: 'user', userId: candidate.submission.actorUserId }
        )
      } catch (error) {
        if (!(error instanceof TaskSubmissionError)) throw error
      }
      if (task)
        [agent] = await transaction
          .select()
          .from(agents)
          .where(
            and(
              eq(agents.workspaceId, scope.workspaceId),
              eq(agents.id, candidate.submission.agentId)
            )
          )
          .for('share')
    }
    const [workspace] = await transaction
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.id, scope.workspaceId), isNull(workspaces.deletedAt)))
      .for('share')
    const [node] = await transaction
      .select()
      .from(runtimeNodes)
      .where(
        and(
          eq(runtimeNodes.workspaceId, scope.workspaceId),
          eq(runtimeNodes.id, scope.runtimeNodeId)
        )
      )
      .for('update')
    if (!node || node.pairingState !== 'paired') throw new RuntimeNodeDeliveryError('unavailable')
    const keys = await transaction
      .select()
      .from(runtimeNodeKeys)
      .where(eq(runtimeNodeKeys.runtimeNodeId, node.id))
      .for('share')
    const key = keys.find(
      (row) =>
        row.id === input.keyId &&
        row.role === 'signing' &&
        row.algorithm === 'ed25519' &&
        row.verifiedAt &&
        !row.retiredAt
    )
    if (
      !workspace ||
      !key ||
      !withinWindow(input, Date.now()) ||
      !(await verifyRuntimeNodePull(scope, input, key.publicKey))
    )
      throw new RuntimeNodeDeliveryError('unavailable')
    const [rate] = await transaction
      .select({ count: sql<number>`count(*)::int` })
      .from(runtimeNodeDeliveryRequests)
      .where(
        and(
          eq(runtimeNodeDeliveryRequests.runtimeNodeId, node.id),
          gt(runtimeNodeDeliveryRequests.createdAt, new Date(Date.now() - 60_000))
        )
      )
    if ((rate?.count ?? 0) >= RUNTIME_NODE_PULLS_PER_MINUTE)
      throw new RuntimeNodeDeliveryError('rate_limited')
    const seenAt = new Date()
    const claimed = await transaction
      .insert(runtimeNodeDeliveryRequests)
      .values({
        workspaceId: scope.workspaceId,
        runtimeNodeId: node.id,
        signingKeyId: key.id,
        nonce: input.nonce,
        // Database now() is transaction start; lock waits must not backdate admission.
        createdAt: seenAt,
        // Keep rate accounting for a full minute even when an old proof expires sooner.
        expiresAt: new Date(
          Math.max(
            Date.parse(input.issuedAt) + RUNTIME_NODE_PULL_WINDOW_MS,
            seenAt.getTime() + 60_000
          )
        ),
      })
      .onConflictDoNothing()
      .returning({ id: runtimeNodeDeliveryRequests.id })
    if (!claimed.length) throw new RuntimeNodeDeliveryError('replayed')
    await transaction
      .update(runtimeNodes)
      .set({ lastProofAt: seenAt, lastSeenAt: seenAt, updatedAt: seenAt })
      .where(eq(runtimeNodes.id, node.id))
    // Publish the first proof per minute; each pull remains audited in the nonce ledger.
    if (!node.lastProofAt || seenAt.getTime() - node.lastProofAt.getTime() >= 60_000)
      await appendWorkspaceEvent(transaction, {
        eventType: 'runtime_node.proof_accepted',
        workspaceId: scope.workspaceId,
        actor: { kind: 'runtime_node', id: node.id },
        correlationId: input.nonce,
        payload: {
          runtimeNodeId: node.id,
          requestId: input.nonce,
          signingKeyFingerprint: key.fingerprint,
        },
      })
    const deliver = async () => {
      const row = candidate?.submission
      if (
        !row ||
        !task ||
        !agent ||
        task.version !== row.taskVersion ||
        task.agentId !== row.agentId ||
        task.controlPlaneExecutionRef ||
        !['created', 'queued'].includes(task.lifecycleState) ||
        agent.lifecycleState !== 'active' ||
        agent.profileState !== 'available' ||
        agent.profileId !== row.profileId ||
        agent.profileVersion !== row.profileVersion ||
        agent.profileRevision !== row.profileRevision ||
        Date.now() >= row.expiresAt.getTime()
      )
        return null
      const [outbox] = await transaction
        .select()
        .from(commandOutbox)
        .where(
          and(eq(commandOutbox.id, row.commandId), eq(commandOutbox.workspaceId, scope.workspaceId))
        )
        .for('share')
      if (!outbox || outbox.status !== 'pending' || outbox.commandType !== 'task.submit')
        return null
      let envelope
      try {
        envelope = parseRemoteContentEnvelope(outbox.payload.envelope)
      } catch {
        return null
      }
      const encryption = keys.find(
        (item) =>
          item.id === envelope.keyId &&
          item.role === 'command_encryption' &&
          item.algorithm === 'x25519' &&
          item.verifiedAt
      )
      // Rotation permits only an already-admitted envelope within its own expiry and the 24h key grace.
      if (
        !encryption ||
        (encryption.retiredAt &&
          (Date.parse(envelope.aad.issuedAt) > encryption.retiredAt.getTime() ||
            Date.now() >= encryption.retiredAt.getTime() + 86_400_000)) ||
        envelope.aad.workspaceId !== scope.workspaceId ||
        envelope.aad.runtimeNodeId !== node.id ||
        envelope.aad.requestId !== row.requestId ||
        envelope.aad.payloadType !== 'command.input' ||
        Date.now() >= Date.parse(envelope.aad.expiresAt)
      )
        return null
      const publicScope = await controlPlaneScopeIds(transaction, {
        workspaceId: scope.workspaceId,
        projectId: task.projectId!,
      })
      const controlPlane = {
        ...publicScope,
        taskId: task.controlPlaneTaskId,
        agentId: agent.controlPlaneAgentId,
        runtimeNodeRefId: node.controlPlaneRuntimeNodeRefId,
      }
      const storedScope = outbox.payload.controlPlane as Record<string, unknown> | undefined
      const storedConversation = outbox.payload.conversation as Record<string, unknown> | undefined
      let conversation
      try {
        conversation = await submissionConversation(transaction, scope.workspaceId, task)
      } catch (error) {
        if (!(error instanceof TaskSubmissionError)) throw error
        return null
      }
      // Do not silently adopt a newer reference or forward an arbitrary stored JSON payload.
      if (
        !publicScope?.projectId ||
        !storedScope ||
        Object.keys(storedScope).length !== 5 ||
        Object.entries(controlPlane).some(
          ([field, reference]) => storedScope[field] !== reference
        ) ||
        outbox.payload.taskId !== row.taskId ||
        outbox.payload.agentId !== row.agentId ||
        outbox.payload.submissionId !== row.id ||
        outbox.payload.runtimeNodeId !== node.id ||
        outbox.payload.taskVersion !== row.taskVersion ||
        !storedConversation ||
        Object.entries(conversation).some(
          ([field, reference]) => storedConversation[field] !== reference
        ) ||
        outbox.payload.objectiveContentRefId !== task.objectiveContentRefId
      )
        return null
      if (!withinWindow(input, Date.now())) throw new RuntimeNodeDeliveryError('unavailable')
      return {
        commandId: row.commandId,
        version: 1 as const,
        submissionId: row.id,
        taskId: row.taskId,
        agentId: row.agentId,
        runtimeNodeId: node.id,
        requestId: row.requestId,
        profile: { id: row.profileId, version: row.profileVersion, revision: row.profileRevision },
        taskVersion: row.taskVersion,
        controlPlane,
        conversation: {
          channelId: conversation.channelId as string | null,
          messageId: task.messageId,
          threadRootMessageId: task.threadRootMessageId,
        },
        objectiveContentRefId: task.objectiveContentRefId,
        envelope,
      }
    }
    const command = await deliver()
    if (!withinWindow(input, Date.now())) throw new RuntimeNodeDeliveryError('unavailable')
    return command
  })
}

/**
 * Node-authenticated trusted cleanup receipt (#1221). Envelope authentication is
 * the pull path's: the node's active signing key, the bounded issuance window,
 * and a signature over the body digest. Every envelope failure gives the same
 * `unavailable` answer as a pull, so an unknown, unpaired, or revoked node looks
 * like a bad signature. The envelope nonce is the receipt's idempotency key, so
 * a replay of the same body is a replay and a different body under that nonce
 * conflicts.
 */
export async function recordRuntimeNodeRetentionReceipt(
  database: AgentHqDatabase,
  scope: RuntimeNodeDeliveryScope,
  value: unknown
) {
  const body = parseRuntimeNodeRetentionReceiptRequest(value)
  if (!body || !withinWindow(body.envelope, Date.now()))
    throw new RuntimeNodeDeliveryError('unavailable')
  const key = await signingKey(database, scope, body.envelope.keyId)
  if (!key || !(await verifyRuntimeNodeRetentionReceipt(scope, body, key.publicKey)))
    throw new RuntimeNodeDeliveryError('unavailable')
  return recordRetentionCleanupReceipt(database, {
    category: body.category as RetentionCategory,
    executor: { kind: 'runtime_node', runtimeNodeId: scope.runtimeNodeId },
    idempotencyKey: body.envelope.nonce,
    receipt: { ...body.receipt, category: body.category },
    workspaceId: scope.workspaceId,
  })
}
