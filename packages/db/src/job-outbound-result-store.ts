/*
 * Persistence adapters for the job outbound result service (M15 #1217).
 *
 * A job is a Task in its source workspace. Its original authorized actor is the
 * single distinct actor of its submissions, and its completion is the
 * `task.completed` mutation. The canonical publication is the channel message
 * that the existing message flow wrote for the job: it carries the job id as
 * its execution reference, the original actor as sender, and any artifact
 * as a linked attachment. Destination standing is the exact channel's participant
 * row. An artifact is authorized through the #1207 registration lock.
 *
 * Reads are shared-locked inside the authorization scope, so a revocation or
 * completion change waits for the release. The publish write is the existing
 * `createMessage`, and it runs after the publish decision, outside the scope.
 * The deliver gate re-reads the publication under lock, so a publication written
 * after a revocation is never released.
 */
import { and, desc, eq, isNull } from 'drizzle-orm'

import { readArtifactReferenceEvidence } from './artifact-reference-policy'
import { withArtifactReferenceGrantLocks } from './artifact-reference-grants'
import { createMessage } from './conversations'
import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import type {
  JobOutboundAccess,
  JobOutboundAudience,
  JobOutboundDestination,
  JobOutboundJobSource,
  JobOutboundPublication,
  JobOutboundPublicationDecision,
} from './job-outbound-result-policy'
import {
  createJobOutboundResultService,
  type JobOutboundAuthorize,
  type JobOutboundDeliveryResolution,
  type JobOutboundPublishInput,
  type JobOutboundReads,
  type JobOutboundResultService,
} from './job-outbound-result-service'
import {
  artifactReferenceGrants,
  artifacts,
  channelParticipants,
  channels,
  messageArtifactReferences,
  messages,
  taskMutations,
  taskSubmissions,
  tasks,
  workspaceMemberships,
  workspaces,
} from './schema'

/** Either a connection or an open transaction; both carry the same query surface. */
type Database = AgentHqDatabase | AgentHqTransaction

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Identifier shape checks only; they decide whether a read can name a row, never authority. */
function isUuid(value: string): boolean {
  return UUID.test(value)
}

/**
 * The source-workspace job for one Task id, or null when the Task is missing or
 * its original actor is not one provable principal.
 */
export async function readJobOutboundSource(
  database: Database,
  jobId: string
): Promise<JobOutboundJobSource | null> {
  if (!isUuid(jobId)) return null
  const [task] = await database
    .select({
      id: tasks.id,
      lifecycleState: tasks.lifecycleState,
      workspaceId: tasks.workspaceId,
    })
    .from(tasks)
    .where(eq(tasks.id, jobId))
    .limit(1)
    .for('share')
  if (!task) return null

  const actors = await database
    .selectDistinct({ actorUserId: taskSubmissions.actorUserId })
    .from(taskSubmissions)
    .where(
      and(eq(taskSubmissions.workspaceId, task.workspaceId), eq(taskSubmissions.taskId, task.id))
    )
  const [actor] = actors
  if (actors.length !== 1 || !actor?.actorUserId) return null

  const [completion] = await database
    .select({ createdAt: taskMutations.createdAt })
    .from(taskMutations)
    .where(
      and(
        eq(taskMutations.workspaceId, task.workspaceId),
        eq(taskMutations.taskId, task.id),
        eq(taskMutations.commandType, 'task.completed')
      )
    )
    .orderBy(desc(taskMutations.createdAt))
    .limit(1)
  const completed = task.lifecycleState === 'completed' || task.lifecycleState === 'archived'
  return {
    completedAt: completed && completion ? completion.createdAt.toISOString() : null,
    jobId: task.id,
    originalActorUserId: actor.actorUserId,
    sourceWorkspaceId: task.workspaceId,
  }
}

/** One principal's current role in one workspace, and whether that workspace is live. */
export async function readJobOutboundAccess(
  database: Database,
  input: Readonly<{ userId: string; workspaceId: string }>
): Promise<JobOutboundAccess> {
  if (!isUuid(input.userId) || !isUuid(input.workspaceId))
    return { role: null, workspaceLive: false }
  const [membership] = await database
    .select({ role: workspaceMemberships.role })
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, input.workspaceId),
        eq(workspaceMemberships.userId, input.userId)
      )
    )
    .limit(1)
    .for('share')
  const [workspace] = await database
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.id, input.workspaceId), isNull(workspaces.deletedAt)))
    .limit(1)
    .for('share')
  return { role: membership?.role ?? null, workspaceLive: Boolean(workspace) }
}

/**
 * A recipient's standing in one exact channel, including when they joined it.
 * The channel is matched by id and by its own workspace, so a participant row
 * for any other channel cannot stand in for it.
 */
export async function readJobOutboundAudience(
  database: Database,
  input: Readonly<{ channelId: string; userId: string; workspaceId: string }>
): Promise<JobOutboundAudience> {
  const none: JobOutboundAudience = {
    channelId: null,
    channelIsGroup: false,
    channelLive: false,
    joinedAt: null,
    participant: false,
    workspaceLive: false,
  }
  if (!isUuid(input.channelId) || !isUuid(input.userId) || !isUuid(input.workspaceId)) return none
  const [workspace] = await database
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.id, input.workspaceId), isNull(workspaces.deletedAt)))
    .limit(1)
    .for('share')
  const [channel] = await database
    .select({ id: channels.id, kind: channels.kind, lifecycleState: channels.lifecycleState })
    .from(channels)
    .where(and(eq(channels.id, input.channelId), eq(channels.workspaceId, input.workspaceId)))
    .limit(1)
    .for('share')
  const [participant] = channel
    ? await database
        .select({ createdAt: channelParticipants.createdAt })
        .from(channelParticipants)
        .where(
          and(
            eq(channelParticipants.workspaceId, input.workspaceId),
            eq(channelParticipants.channelId, channel.id),
            eq(channelParticipants.principalKind, 'user'),
            eq(channelParticipants.userId, input.userId)
          )
        )
        .limit(1)
        .for('share')
    : []
  return {
    channelId: channel?.id ?? null,
    channelIsGroup: channel?.kind === 'group',
    channelLive: channel?.lifecycleState === 'active',
    joinedAt: participant ? participant.createdAt.toISOString() : null,
    participant: Boolean(participant),
    workspaceLive: Boolean(workspace),
  }
}

/**
 * The canonical publication: the message written for this job. A message that
 * belongs to another job, another agent, or another workspace is still returned
 * as read, so the gate can name the mismatch. Only a missing message is null.
 */
export async function readJobOutboundPublication(
  database: Database,
  input: Readonly<{ jobId: string; messageId: string }>
): Promise<JobOutboundPublication | null> {
  if (!isUuid(input.jobId) || !isUuid(input.messageId)) return null
  const [message] = await database
    .select()
    .from(messages)
    .where(eq(messages.id, input.messageId))
    .limit(1)
    .for('share')
  if (!message) return null

  const links = await database
    .select({ artifactId: messageArtifactReferences.artifactId })
    .from(messageArtifactReferences)
    .where(eq(messageArtifactReferences.messageId, message.id))
  let artifact: JobOutboundPublication['artifact'] = null
  if (links.length === 1) {
    const [row] = await database
      .select({
        checksumSha256: artifacts.checksumSha256,
        id: artifacts.id,
        version: artifacts.version,
        workspaceId: artifacts.workspaceId,
      })
      .from(artifacts)
      .where(eq(artifacts.id, links[0]!.artifactId))
      .limit(1)
    if (row) {
      artifact = {
        artifactId: row.id,
        audienceWorkspaceId: message.workspaceId,
        checksumSha256: row.checksumSha256,
        sourceWorkspaceId: row.workspaceId,
        version: row.version,
      }
    }
  }
  return {
    artifact,
    artifactLinkCount: links.length,
    bodyText: message.bodyText,
    channelId: message.channelId,
    createdAt: message.createdAt.toISOString(),
    deleted: message.deletedAt !== null,
    edited: message.editedAt !== null || message.version !== 1,
    executionRef: message.executionRef,
    messageId: message.id,
    senderUserId: message.senderUserId,
    senderKind: message.senderKind,
    taskId: message.taskId,
    workspaceId: message.workspaceId,
  }
}

/** Artifact evidence read as the job's original actor. Malformed identifiers read as no evidence. */
async function readEvidence(
  database: Database,
  input: Readonly<{ artifactId: string; principalUserId: string; workspaceId: string }>
) {
  if (!isUuid(input.artifactId) || !isUuid(input.principalUserId) || !isUuid(input.workspaceId))
    return null
  // Both connection and transaction carry the artifact access helper's query surface.
  return readArtifactReferenceEvidence(
    database as AgentHqDatabase,
    input.workspaceId,
    input.artifactId,
    { kind: 'user', userId: input.principalUserId }
  )
}

/** The read surface bound to one connection or transaction. */
export function jobOutboundReadsFor(database: Database): JobOutboundReads {
  return {
    readAccess: (input) => readJobOutboundAccess(database, input),
    readArtifactEvidence: (input) => readEvidence(database, input),
    readAudience: (input) => readJobOutboundAudience(database, input),
    readJobSource: (jobId) => readJobOutboundSource(database, jobId),
    readPublication: (input) => readJobOutboundPublication(database, input),
  }
}

/**
 * The authorization scope over the database. A grant scope runs under the #1207
 * registration lock; without one, the run is a plain transaction.
 */
export function createJobOutboundAuthorizer(
  database: AgentHqDatabase
): JobOutboundAuthorize<AgentHqTransaction> {
  return async (scope, run) => {
    if (!scope) {
      return database.transaction((transaction) =>
        run({ grantState: null, reads: jobOutboundReadsFor(transaction), transaction })
      )
    }
    return withArtifactReferenceGrantLocks(database, scope, (transaction, grantState) =>
      run({ grantState, reads: jobOutboundReadsFor(transaction), transaction })
    )
  }
}

/**
 * The unlocked first step of delivery. It resolves the canonical publication's
 * artifact registration: the single live grant for this artifact and destination
 * workspace. Zero or several live grants resolve to no grant, which the gate
 * refuses. The grant lock is then taken on that exact identity.
 */
export async function resolveJobOutboundDelivery(
  database: AgentHqDatabase,
  input: Readonly<{ jobId: string; messageId: string }>
): Promise<JobOutboundDeliveryResolution | null> {
  const publication = await readJobOutboundPublication(database, input)
  if (!publication) return null
  if (!publication.artifact) return { claim: null, scope: null }
  const target = publication.artifact
  const live = await database
    .select()
    .from(artifactReferenceGrants)
    .where(
      and(
        eq(artifactReferenceGrants.sourceWorkspaceId, target.sourceWorkspaceId),
        eq(artifactReferenceGrants.artifactId, target.artifactId),
        eq(artifactReferenceGrants.audienceWorkspaceId, target.audienceWorkspaceId),
        isNull(artifactReferenceGrants.revokedAt)
      )
    )
    .limit(2)
  const [row] = live.length === 1 ? live : []
  if (!row) return { claim: { authority: { kind: 'workspace_grant' }, grant: null }, scope: null }
  return {
    claim: {
      authority: { kind: 'workspace_grant' },
      grant: {
        artifactId: row.artifactId,
        audienceWorkspaceId: row.audienceWorkspaceId,
        checksumSha256: row.checksumSha256,
        expiresAt: row.expiresAt,
        grantId: row.grantId,
        revokedAt: null,
        revision: row.revision,
        sourceWorkspaceId: row.sourceWorkspaceId,
        version: row.version,
      },
    },
    scope: {
      artifactId: row.artifactId,
      grantId: row.grantId,
      revision: row.revision,
      sourceWorkspaceId: row.sourceWorkspaceId,
    },
  }
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
 * Publishes an approved decision through the existing message flow. The message
 * is the canonical publication: job id as task and execution reference, the job's
 * actor as sender and posting principal, and the artifact as a
 * linked attachment. The write is idempotent per job and channel.
 */
export async function publishJobOutboundMessage(
  database: AgentHqDatabase,
  service: JobOutboundResultService<AgentHqTransaction>,
  input: Omit<JobOutboundPublishInput, 'destination'> & { destination: JobOutboundDestination }
): Promise<JobOutboundPublicationDecision & { messageId?: string }> {
  const decision = await service.publish(input)
  if (decision.action !== 'publish') return decision
  const job = await readJobOutboundSource(database, input.jobId)
  if (!job)
    return {
      action: 'hold',
      gate: 'job',
      jobId: input.jobId,
      producerEffect: 'unaffected',
      reason: 'job_unavailable',
    }
  const message = await createMessage(
    database,
    decision.destination.workspaceId,
    decision.destination.channelId,
    { kind: 'user', userId: job.originalActorUserId },
    {
      artifactIds: decision.result.artifact ? [decision.result.artifact.artifactId] : [],
      bodyText: decision.result.summary,
      executionRef: input.jobId,
      idempotencyKey: `job-outbound:${input.jobId}:${decision.destination.channelId}`,
      sender: { kind: 'user', userId: job.originalActorUserId },
    }
  )
  return { ...decision, messageId: message.id }
}
