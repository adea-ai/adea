/*
 * Write side of job outbound results (M15 #1217).
 *
 * The grant-locked authorization scope and the canonical publication write. The
 * publication is written by the existing `createMessage` inside the authorization
 * transaction, so a message exists only if its authorization committed with it.
 * Read helpers live in `job-outbound-read` and are re-exported here.
 */
import { and, eq } from 'drizzle-orm'

import {
  ArtifactReferenceGrantError,
  withArtifactReferenceGrantLocks,
} from './artifact-reference-grants'
import { createMessage } from './conversations'
import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { encodeJobOutboundBinding, jobOutboundMessageKey } from './job-outbound-binding'
import {
  sourceAccessCurrent,
  type JobOutboundArtifactPolicy,
  type JobOutboundPublicationDecision,
} from './job-outbound-result-policy'
import {
  createJobOutboundResultService,
  type JobOutboundAuthorizationContext,
  type JobOutboundAuthorize,
  type JobOutboundPrepare,
  type JobOutboundPublishInput,
  type JobOutboundPublishResult,
  type JobOutboundResultService,
} from './job-outbound-result-service'
import {
  jobOutboundReadsFor,
  readJobOutboundPublicationMessageId,
  resolveJobOutboundDelivery,
} from './job-outbound-read'
import type { UserPrincipalRef } from '@adea-ai/types'
import { artifactReferenceGrants, artifacts, channels, messageArtifactReferences } from './schema'
import { completeTask, type TaskCommand } from './tasks'

export {
  jobOutboundReadsFor,
  readJobOutboundAccess,
  readJobOutboundAudience,
  readJobOutboundPublication,
  readJobOutboundSource,
  resolveJobOutboundDelivery,
} from './job-outbound-read'

/**
 * The authorization scope over the database. A grant scope runs under the #1207
 * registration lock; without one, the run is a plain transaction. Both pass the
 * transaction to the callback, so a publication write joins the same transaction.
 */
/**
 * The #1207 lock refuses an artifact it cannot lock as livable (deleted, quarantined,
 * unknown, or in an inactive workspace). Those refusals mean no authority, so the
 * scope falls back to a plain transaction with no grant state: the gates then deny
 * or omit by name, rather than the caller receiving an exception.
 */
const UNLIVABLE_ARTIFACT_CODES: ReadonlySet<string> = new Set([
  'grant_artifact_deleted',
  'grant_artifact_quarantined',
  'grant_artifact_unknown',
  'grant_workspace_inactive',
])

export function createJobOutboundAuthorizer(
  database: AgentHqDatabase
): JobOutboundAuthorize<AgentHqTransaction> {
  return async (scope, run) => {
    if (!scope) {
      return database.transaction((transaction) =>
        run({ grantState: null, reads: jobOutboundReadsFor(transaction), transaction })
      )
    }
    try {
      return await withArtifactReferenceGrantLocks(database, scope, (transaction, grantState) =>
        run({ grantState, reads: jobOutboundReadsFor(transaction), transaction })
      )
    } catch (error) {
      if (
        !(error instanceof ArtifactReferenceGrantError) ||
        !UNLIVABLE_ARTIFACT_CODES.has(error.code)
      )
        throw error
      return database.transaction((transaction) =>
        run({ grantState: null, reads: jobOutboundReadsFor(transaction), transaction })
      )
    }
  }
}

/**
 * Writes the canonical publication inside the authorization transaction. The
 * artifact row is locked first, so the link cannot point at a row that changes or
 * disappears before commit. The message and its link commit with the decision. A job
 * has one publication per destination: when one is already written, it is returned
 * and nothing is written, so a retry cannot add a second message.
 */
export async function writeJobOutboundPublication(
  transaction: AgentHqTransaction,
  decision: Extract<JobOutboundPublicationDecision, { action: 'publish' }>
): Promise<string> {
  const { binding, destination, jobId, result } = decision
  const existing = await readJobOutboundPublicationMessageId(transaction, {
    channelId: destination.channelId,
    jobId,
    workspaceId: destination.workspaceId,
  })
  if (existing) return existing
  const artifact = binding.artifact
  if (artifact) {
    const [locked] = await transaction
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(
        and(
          eq(artifacts.id, artifact.artifactId),
          eq(artifacts.workspaceId, artifact.sourceWorkspaceId)
        )
      )
      .limit(1)
      .for('share')
    if (!locked) throw new Error('artifact_unavailable')
  }
  const message = await createMessage(
    transaction,
    destination.workspaceId,
    destination.channelId,
    { kind: 'user', userId: binding.actorUserId },
    {
      bodyText: result.summary,
      executionRef: jobId,
      idempotencyKey: jobOutboundMessageKey(binding),
      sender: { kind: 'system', systemId: encodeJobOutboundBinding(binding) },
    }
  )
  if (artifact) {
    await transaction
      .insert(messageArtifactReferences)
      .values({
        artifactId: artifact.artifactId,
        messageId: message.id,
        workspaceId: destination.workspaceId,
      })
      .onConflictDoNothing()
  }
  return message.id
}

/** The service bound to the database: authorization scope, trusted clock, and delivery resolution. */
export function createJobOutboundStoreService(
  database: AgentHqDatabase,
  clock: () => string = () => new Date().toISOString()
): JobOutboundResultService<AgentHqTransaction> {
  return createJobOutboundResultService<AgentHqTransaction>({
    authorize: createJobOutboundAuthorizer(database),
    clock,
    resolveDelivery: (input) => resolveJobOutboundDelivery(database, input),
  })
}

/**
 * Publishes through the authorization transaction. The decision and the canonical
 * message commit together, or neither does.
 */
export async function publishJobOutboundMessage<TPrepared = null>(
  service: JobOutboundResultService<AgentHqTransaction>,
  input: JobOutboundPublishInput,
  prepare?: JobOutboundPrepare<AgentHqTransaction, TPrepared>
): Promise<JobOutboundPublishResult<TPrepared>> {
  return service.publish(
    input,
    ({ transaction }, decision) => writeJobOutboundPublication(transaction, decision),
    prepare
  )
}

/**
 * The outbound part of a job completion. The artifact is named by id and grant only:
 * its registration and facts come from the registry, so the request carries no
 * authority of its own. The destination is the named group channel.
 */
export type JobOutboundCompletionRequest = Readonly<{
  artifact: Readonly<{ artifactId: string; grantId: string }> | null
  artifactPolicy: JobOutboundArtifactPolicy
  channelId: string
  summary: string
}>

export type JobOutboundCompletionOutcome = Readonly<{
  publication: Pick<JobOutboundPublishResult, 'decision' | 'messageId'>
  task: Awaited<ReturnType<typeof completeTask>>
}>

/**
 * Production completion with its outbound result. The request is validated before
 * the task completes: an unknown destination, or an artifact name with no live
 * registration in this workspace, completes nothing. The task then completes through
 * the existing transition, and the result is published through the same authorization
 * transaction as every other publication. A retry converges on the same publication
 * because its idempotency key derives from the binding.
 */
export async function completeTaskAndPublishOutboundResult(
  database: AgentHqDatabase,
  workspaceId: string,
  taskId: string,
  principal: UserPrincipalRef,
  command: TaskCommand,
  request: JobOutboundCompletionRequest
): Promise<JobOutboundCompletionOutcome> {
  const [channel] = await database
    .select({ id: channels.id, workspaceId: channels.workspaceId })
    .from(channels)
    .where(eq(channels.id, request.channelId))
    .limit(1)
  if (!channel) throw new Error('Destination unavailable')

  let registration: Awaited<ReturnType<typeof presentedRegistration>> = null
  if (request.artifact) {
    registration = await presentedRegistration(
      database,
      workspaceId,
      request.artifact.artifactId,
      request.artifact.grantId
    )
    if (!registration) throw new Error('Artifact grant unavailable')
  }

  // The completion runs inside the publication's authorization scope. The decision and
  // the canonical message commit with the completion, or none of them do. The outbound
  // request is hashed into the completion's idempotency payload, so a retried key can
  // never replay this completion with a different summary, destination or artifact.
  const outboundRequest = canonicalOutboundRequest(request)
  const { decision, messageId, prepared } = await publishJobOutboundMessage(
    createJobOutboundStoreService(database),
    {
      artifact: registration
        ? { authority: registration.authority, grant: registration.grant }
        : null,
      artifactPolicy: request.artifactPolicy,
      destination: { channelId: channel.id, workspaceId: channel.workspaceId },
      jobId: taskId,
      result: {
        ...(registration
          ? {
              artifact: {
                artifactId: registration.grant.artifactId,
                audienceWorkspaceId: registration.row.audienceWorkspaceId,
                checksumSha256: registration.row.checksumSha256,
                sourceWorkspaceId: workspaceId,
                version: registration.row.version,
              },
            }
          : {}),
        jobId: taskId,
        summary: request.summary,
      },
    },
    (context) =>
      completeForPublication(context, {
        channelId: channel.id,
        command,
        destinationWorkspaceId: channel.workspaceId,
        outboundRequest,
        principal,
        taskId,
        workspaceId,
      })
  )
  if (!prepared) throw new Error('Task completion unavailable')
  return { publication: { decision, messageId }, task: prepared }
}

/** The outbound request as the idempotency payload hashes it. Every field is present, so a changed one changes the hash. */
function canonicalOutboundRequest(request: JobOutboundCompletionRequest) {
  return {
    artifact: request.artifact
      ? { artifactId: request.artifact.artifactId, grantId: request.artifact.grantId }
      : null,
    artifactPolicy: request.artifactPolicy,
    channelId: request.channelId,
    summary: request.summary,
  }
}

/**
 * The caller's own authority for this job, checked inside the scope before the Task
 * completes. The caller must be the job's original actor or a current owner or admin of
 * its source workspace, and a current member of the destination workspace. The message
 * is authored as the original actor, so the publication cannot borrow a broader standing
 * than the caller holds. Any refusal throws, which rolls the completion back with it.
 */
async function completeForPublication(
  context: JobOutboundAuthorizationContext<AgentHqTransaction>,
  input: Readonly<{
    channelId: string
    command: TaskCommand
    destinationWorkspaceId: string
    outboundRequest: ReturnType<typeof canonicalOutboundRequest>
    principal: UserPrincipalRef
    taskId: string
    workspaceId: string
  }>
) {
  const { reads, transaction } = context
  const { command, principal, taskId, workspaceId } = input
  const job = await reads.readJobSource(taskId)
  if (!job || job.sourceWorkspaceId !== workspaceId) throw new Error('Job outbound unavailable')
  if (
    job.originalActorUserId !== principal.userId &&
    !sourceAccessCurrent(
      await reads.readAccess({ userId: principal.userId, workspaceId: job.sourceWorkspaceId })
    )
  )
    throw new Error('Job outbound unavailable')
  // Exclusive, like the publication's own audience read: the destination revision must not move under the caller check.
  const audience = await reads.readAudience({
    channelId: input.channelId,
    forWrite: true,
    userId: principal.userId,
    workspaceId: input.destinationWorkspaceId,
  })
  if (!audience.workspaceLive || audience.workspaceRole === null)
    throw new Error('Job outbound unavailable')
  return completeTask(transaction, workspaceId, taskId, principal, command, {
    outboundRequest: input.outboundRequest,
  })
}

/**
 * The registration a request names, as the policy presents it: the identity the
 * caller named, read from the registry under this workspace. Null when no such
 * registration exists here.
 */
async function presentedRegistration(
  database: AgentHqDatabase,
  workspaceId: string,
  artifactId: string,
  grantId: string
) {
  const [row] = await database
    .select()
    .from(artifactReferenceGrants)
    .where(
      and(
        eq(artifactReferenceGrants.grantId, grantId),
        eq(artifactReferenceGrants.artifactId, artifactId),
        eq(artifactReferenceGrants.sourceWorkspaceId, workspaceId)
      )
    )
    .limit(1)
  if (!row) return null
  const grant = {
    artifactId: row.artifactId,
    audienceWorkspaceId: row.audienceWorkspaceId,
    checksumSha256: row.checksumSha256,
    expiresAt: row.expiresAt,
    grantId: row.grantId,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    revision: row.revision,
    sourceWorkspaceId: row.sourceWorkspaceId,
    version: row.version,
  }
  return { authority: { kind: 'workspace_grant' as const }, grant, row }
}
