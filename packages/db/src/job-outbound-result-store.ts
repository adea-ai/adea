/*
 * Persistence adapters for the job outbound result service (M15 #1217).
 *
 * Reads are shared-locked inside the authorization scope, so a revocation or
 * completion change waits for the release to finish, and a release never sees
 * a half-applied change. A job is a Task in its source workspace. Its original
 * authorized actor is the single distinct actor of its submissions, and its
 * completion is the `task.completed` mutation. Destination standing is the exact
 * channel's participant row in the destination workspace. An artifact claim is
 * authorized through the #1207 registration lock, so the grant state read is
 * the registration under that lock.
 *
 * Nothing here writes. The release write is supplied by the caller and runs in
 * the same transaction as these reads.
 */
import { and, desc, eq, isNull } from 'drizzle-orm'

import { readArtifactReferenceEvidence } from './artifact-reference-policy'
import { withArtifactReferenceGrantLocks } from './artifact-reference-grants'
import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import type {
  JobOutboundAccess,
  JobOutboundAudience,
  JobOutboundJobSource,
} from './job-outbound-result-policy'
import type { JobOutboundAuthorize, JobOutboundReads } from './job-outbound-result-service'
import {
  channelParticipants,
  channels,
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
 * its original actor is not one provable principal. Several actors, or a legacy
 * submission with no actor, leave no provable authority.
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

/**
 * One principal's current role in one workspace, and whether that workspace is
 * live. A malformed identifier reads as no access.
 */
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
 * A recipient's standing in one exact channel. The channel is matched by id and
 * by its own workspace, so a participant row for any other channel cannot stand
 * in for it. Malformed identifiers read as no standing.
 */
export async function readJobOutboundAudience(
  database: Database,
  input: Readonly<{ channelId: string; userId: string; workspaceId: string }>
): Promise<JobOutboundAudience> {
  const none: JobOutboundAudience = {
    channelId: null,
    channelIsGroup: false,
    channelLive: false,
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
    participant: Boolean(participant),
    workspaceLive: Boolean(workspace),
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
  }
}

/**
 * The authorization scope over the database. A grant scope runs under the #1207
 * registration lock: the artifact and grant rows are locked for the whole run,
 * and the grant state is the registration under that lock. Without a grant
 * scope the run is a plain transaction with no grant state.
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
