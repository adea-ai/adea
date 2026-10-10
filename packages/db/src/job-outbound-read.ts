/*
 * Read side of job outbound results (M15 #1217).
 *
 * Every function here reads current state and decides nothing that it persists. It
 * is shared by the production readers and by the message history readers, so that
 * ordinary channel history applies the same current authorization as delivery. This
 * module does not import the message write path, which keeps the history readers in
 * `conversations` free of an import cycle.
 */
import { and, desc, eq, isNull, like } from 'drizzle-orm'

import { readCurrentArtifactReferenceGrant } from './artifact-reference-grants'
import { readArtifactReferenceEvidence } from './artifact-reference-policy'
import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import {
  decodeJobOutboundBinding,
  isJobOutboundSenderValue,
  jobOutboundMessageKeyPrefix,
} from './job-outbound-binding'
import type {
  JobOutboundAccess,
  JobOutboundAudience,
  JobOutboundJobSource,
  JobOutboundPublication,
} from './job-outbound-result-policy'
import {
  createJobOutboundResultService,
  type JobOutboundDeliveryResolution,
  type JobOutboundReads,
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

export type Database = AgentHqDatabase | AgentHqTransaction

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
 * The unlocked first step of delivery. It decodes the publication's binding and
 * resolves the grant the binding names. A grant that is missing, revoked, or
 * revised is still resolved by identity, so the locked check denies it by name.
 */
export async function resolveJobOutboundDelivery(
  database: Database,
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
 * The publication already written for a job in one destination channel, if any. A
 * Task completes once, so a job has one publication per destination. A retry reads
 * that message back instead of writing another, even after the channel revision has
 * moved and the current binding's key would differ.
 */
export async function readJobOutboundPublicationMessageId(
  database: Database,
  input: Readonly<{ channelId: string; jobId: string; workspaceId: string }>
): Promise<string | null> {
  if (!isUuid(input.channelId) || !isUuid(input.jobId) || !isUuid(input.workspaceId)) return null
  const [row] = await database
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.workspaceId, input.workspaceId),
        eq(messages.channelId, input.channelId),
        eq(messages.executionRef, input.jobId),
        eq(messages.senderKind, 'system'),
        like(messages.idempotencyKey, `${jobOutboundMessageKeyPrefix(input.jobId)}%`)
      )
    )
    .limit(1)
  return row?.id ?? null
}

/** The history label for a job publication's system sender. The binding itself is never shown. */
export const JOB_OUTBOUND_HISTORY_SYSTEM_ID = 'job-outbound'

/**
 * Whether one job publication may be shown to one reader now. History is a read,
 * so it runs the delivery gates without a lock and reflects current state at the
 * read instant: a revoked grant, a removed membership, a lost source authority, a
 * roster change, or an edited or deleted publication all hide it. Delivery remains
 * the locked gate that releases an artifact.
 */
export async function isJobOutboundPublicationVisible(
  database: Database,
  input: Readonly<{ jobId: string; messageId: string; readerUserId: string }>
): Promise<boolean> {
  const service = createJobOutboundResultService<Database>({
    authorize: async (scope, run) => {
      const grantState = scope
        ? await readCurrentArtifactReferenceGrant(database, {
            grantId: scope.grantId,
            revision: scope.revision,
          })
        : null
      return run({ grantState, reads: jobOutboundReadsFor(database), transaction: database })
    },
    clock: () => new Date().toISOString(),
    resolveDelivery: (resolution) => resolveJobOutboundDelivery(database, resolution),
  })
  const decision = await service.deliver(
    { jobId: input.jobId, messageId: input.messageId, recipientUserId: input.readerUserId },
    async () => {}
  )
  return decision.action === 'deliver'
}

/**
 * Keeps the rows a reader may see. Job publications are shown only while the reader
 * is currently authorized for them, using the same gates as delivery; every other
 * message passes unchanged. The row shape is the subset the gate needs.
 */
export async function filterVisibleJobOutboundRows<
  T extends {
    executionRef: string | null
    id: string
    senderKind: string
    senderSystemId: string | null
  },
>(database: Database, rows: readonly T[], readerUserId: string): Promise<T[]> {
  const visible: T[] = []
  for (const row of rows) {
    if (row.senderKind !== 'system' || !isJobOutboundSenderValue(row.senderSystemId)) {
      visible.push(row)
    } else if (
      row.executionRef &&
      (await isJobOutboundPublicationVisible(database, {
        jobId: row.executionRef,
        messageId: row.id,
        readerUserId,
      }))
    ) {
      visible.push(row)
    }
  }
  return visible
}
