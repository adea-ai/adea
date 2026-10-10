/*
 * Persistence adapters for the job outbound result service (M15 #1217).
 *
 * A job is a Task in its source workspace. Its original authorized actor is the
 * single distinct actor of its submissions, and its completion is the
 * `task.completed` mutation. The canonical publication is a channel message written
 * by `createMessage` inside the authorization transaction. Its system sender
 * carries the encoded binding, and any artifact is a link row written in the same
 * transaction. Destination standing is the exact channel's participant row, and the
 * channel's revision is its version. An artifact is authorized through the #1207
 * registration lock.
 *
 * Every read is shared-locked inside the scope. The publication, its link and its
 * artifact row are locked together with the grant, so a concurrent revocation,
 * availability change, or roster change waits for the scope to finish.
 */
import { and, desc, eq, isNull } from 'drizzle-orm'

import { readArtifactReferenceEvidence } from './artifact-reference-policy'
import {
  ArtifactReferenceGrantError,
  withArtifactReferenceGrantLocks,
} from './artifact-reference-grants'
import { createMessage } from './conversations'
import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import {
  decodeJobOutboundBinding,
  encodeJobOutboundBinding,
  jobOutboundMessageKey,
} from './job-outbound-binding'
import type {
  JobOutboundAccess,
  JobOutboundAudience,
  JobOutboundJobSource,
  JobOutboundPublication,
  JobOutboundPublicationDecision,
} from './job-outbound-result-policy'
import {
  createJobOutboundResultService,
  type JobOutboundAuthorize,
  type JobOutboundDeliveryResolution,
  type JobOutboundPublishInput,
  type JobOutboundPublishResult,
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

/** The source-workspace job for one Task id, or null when the Task or its original actor is not provable. */
export async function readJobOutboundSource(
  database: Database,
  jobId: string
): Promise<JobOutboundJobSource | null> {
  if (!isUuid(jobId)) return null
  const [task] = await database
    .select({ id: tasks.id, lifecycleState: tasks.lifecycleState, workspaceId: tasks.workspaceId })
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
 * A principal's standing in one exact channel, with the channel's current revision.
 * The channel is matched by id and by its own workspace, so a row for any other
 * channel cannot stand in for it.
 */
export async function readJobOutboundAudience(
  database: Database,
  input: Readonly<{ channelId: string; forWrite?: boolean; userId: string; workspaceId: string }>
): Promise<JobOutboundAudience> {
  const none: JobOutboundAudience = {
    channelId: null,
    channelIsGroup: false,
    channelLive: false,
    channelVersion: null,
    participant: false,
    workspaceLive: false,
    workspaceRole: null,
  }
  if (!isUuid(input.channelId) || !isUuid(input.userId) || !isUuid(input.workspaceId)) return none
  const [workspace] = await database
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.id, input.workspaceId), isNull(workspaces.deletedAt)))
    .limit(1)
    .for('share')
  const [channel] = await database
    .select({
      id: channels.id,
      kind: channels.kind,
      lifecycleState: channels.lifecycleState,
      version: channels.version,
    })
    .from(channels)
    .where(and(eq(channels.id, input.channelId), eq(channels.workspaceId, input.workspaceId)))
    .limit(1)
    .for(input.forWrite ? 'update' : 'share')
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
  // The publish path never reads participant standing: its write is checked by the message
  // write itself. Skipping the lock keeps it from waiting on a concurrent roster write.
  const [participant] =
    channel && !input.forWrite
      ? await database
          .select({ id: channelParticipants.id })
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
    channelVersion: channel?.version ?? null,
    participant: Boolean(participant),
    workspaceLive: Boolean(workspace),
    workspaceRole: membership?.role ?? null,
  }
}

/**
 * The canonical publication: the message as stored, its links and the linked
 * artifact row, each shared-locked. A link whose artifact row is missing is returned
 * as a link with a null artifact, so the gate can refuse it.
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
    .for('share')
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
      .for('share')
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
    idempotencyKey: message.idempotencyKey,
    channelId: message.channelId,
    deleted: message.deletedAt !== null,
    edited: message.editedAt !== null || message.version !== 1,
    executionRef: message.executionRef,
    messageId: message.id,
    senderKind: message.senderKind,
    senderSystemId: message.senderSystemId,
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
 * The unlocked first step of delivery. It decodes the publication's binding and
 * resolves the grant the binding names. A grant that is missing, revoked, or
 * revised is still resolved by identity, so the locked check denies it by name.
 */
export async function resolveJobOutboundDelivery(
  database: AgentHqDatabase,
  input: Readonly<{ jobId: string; messageId: string }>
): Promise<JobOutboundDeliveryResolution | null> {
  const publication = await readJobOutboundPublication(database, input)
  if (!publication) return null
  const binding = decodeJobOutboundBinding(
    publication.senderKind === 'system' ? publication.senderSystemId : null
  )
  if (!binding) return null
  if (!binding.artifact || !binding.grant) return { claim: null, scope: null }
  const [row] = await database
    .select()
    .from(artifactReferenceGrants)
    .where(eq(artifactReferenceGrants.grantId, binding.grant.grantId))
    .limit(1)
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
        revision: binding.grant.revision,
        sourceWorkspaceId: row.sourceWorkspaceId,
        version: row.version,
      },
    },
    scope: {
      artifactId: binding.artifact.artifactId,
      grantId: binding.grant.grantId,
      revision: binding.grant.revision,
      sourceWorkspaceId: binding.artifact.sourceWorkspaceId,
    },
  }
}

/**
 * Writes the canonical publication inside the authorization transaction. The
 * artifact row is locked first, so the link cannot point at a row that changes or
 * disappears before commit. The message and its link commit with the decision.
 */
export async function writeJobOutboundPublication(
  transaction: AgentHqTransaction,
  decision: Extract<JobOutboundPublicationDecision, { action: 'publish' }>
): Promise<string> {
  const { binding, destination, jobId, result } = decision
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
export async function publishJobOutboundMessage(
  service: JobOutboundResultService<AgentHqTransaction>,
  input: JobOutboundPublishInput
): Promise<JobOutboundPublishResult> {
  return service.publish(input, ({ transaction }, decision) =>
    writeJobOutboundPublication(transaction, decision)
  )
}
