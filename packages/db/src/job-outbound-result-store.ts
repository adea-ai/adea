/*
 * Persistence adapters for the job outbound result service (M15 #1217).
 *
 * Reads only. A job is a Task in its source workspace. Its original authorized
 * actor is the single distinct actor of its submissions, and its completion
 * instant is the `task.completed` mutation. Access comes from the existing
 * membership and workspace rows, and artifact evidence from the existing
 * artifact access helper read as the original actor. Nothing here writes, and
 * the artifact grant registry is not read: that port stays injected until the
 * #1207 registration store is on this branch's base.
 */
import { and, desc, eq, isNull } from 'drizzle-orm'

import { readArtifactReferenceEvidence } from './artifact-reference-policy'
import type { AgentHqDatabase } from './connection'
import type { JobOutboundAccess, JobOutboundJobSource } from './job-outbound-result-policy'
import type { JobOutboundPorts } from './job-outbound-result-service'
import { taskMutations, taskSubmissions, tasks, workspaceMemberships, workspaces } from './schema'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const COMPLETED_LIFECYCLE_STATES = ['completed', 'archived'] as const

/** Ports this adapter provides; the grant registry port is supplied separately. */
export type JobOutboundStorePorts = Omit<JobOutboundPorts, 'readArtifactGrantState'>

/**
 * The source-workspace job for one Task id, or null when the Task is missing or
 * its original actor is not provably one principal. A Task with several actors,
 * or with a legacy submission that has no actor, has no provable authority.
 */
export async function readJobOutboundSource(
  database: AgentHqDatabase,
  jobId: string
): Promise<JobOutboundJobSource | null> {
  if (!UUID.test(jobId)) return null
  return database.transaction(async (transaction) => {
    const [task] = await transaction
      .select({
        id: tasks.id,
        lifecycleState: tasks.lifecycleState,
        workspaceId: tasks.workspaceId,
      })
      .from(tasks)
      .where(eq(tasks.id, jobId))
      .limit(1)
    if (!task) return null

    const actors = await transaction
      .selectDistinct({ actorUserId: taskSubmissions.actorUserId })
      .from(taskSubmissions)
      .where(
        and(eq(taskSubmissions.workspaceId, task.workspaceId), eq(taskSubmissions.taskId, task.id))
      )
    const [actor] = actors
    if (actors.length !== 1 || !actor?.actorUserId) return null

    const [completion] = await transaction
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
    const completed = (COMPLETED_LIFECYCLE_STATES as readonly string[]).includes(
      task.lifecycleState
    )
    return {
      completedAt: completed && completion ? completion.createdAt.toISOString() : null,
      jobId: task.id,
      originalActorUserId: actor.actorUserId,
      sourceWorkspaceId: task.workspaceId,
    }
  })
}

/**
 * One principal's current role in one workspace and whether that workspace is
 * live. Malformed identifiers read as no access, never as an error.
 */
export async function readJobOutboundAccess(
  database: AgentHqDatabase,
  input: Readonly<{ userId: string; workspaceId: string }>
): Promise<JobOutboundAccess> {
  const none: JobOutboundAccess = { role: null, workspaceLive: false }
  if (!UUID.test(input.userId) || !UUID.test(input.workspaceId)) return none
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
  const [workspace] = await database
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.id, input.workspaceId), isNull(workspaces.deletedAt)))
    .limit(1)
  return { role: membership?.role ?? null, workspaceLive: Boolean(workspace) }
}

/** Store-backed ports for every read except the artifact grant registry. */
export function createJobOutboundStorePorts(database: AgentHqDatabase): JobOutboundStorePorts {
  return {
    readAccess: (input) => readJobOutboundAccess(database, input),
    async readArtifactEvidence({ artifactId, principalUserId, workspaceId }) {
      if (!UUID.test(artifactId) || !UUID.test(principalUserId) || !UUID.test(workspaceId))
        return null
      return readArtifactReferenceEvidence(database, workspaceId, artifactId, {
        kind: 'user',
        userId: principalUserId,
      })
    },
    readJobSource: (jobId) => readJobOutboundSource(database, jobId),
  }
}
