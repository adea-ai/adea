/*
 * Batch current-authority gate for job publications (#1217).
 *
 * A reader sees a job publication only while the same delivery gates that release it still
 * allow it. This module decides a page of publications at once. Each fact is read by one
 * statement that covers every publication in the page, and the canonical policy
 * (`decideJobOutboundDelivery`) then runs once per publication on those facts. The statement
 * count depends on the page's distinct workspaces, grants and artifacts, never on how many
 * publications the page holds.
 *
 * A fact that is absent, malformed or cannot be proven reaches the policy as absent, so the
 * policy denies it. Nothing unknown is treated as visible.
 */
import type { ArtifactReferenceGrant, ArtifactReferenceGrantState } from '@adea-ai/types'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'

import { currentGrantStateOf } from './artifact-reference-grants'
import {
  artifactEvidenceKey,
  readArtifactReferenceEvidenceBatch,
  type ArtifactEvidenceRequest,
} from './artifact-reference-policy'
import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import {
  decodeJobOutboundBinding,
  isJobOutboundSenderValue,
  type JobOutboundBinding,
} from './job-outbound-binding'
import {
  decideJobOutboundDelivery,
  type JobOutboundAccess,
  type JobOutboundArtifactClaim,
  type JobOutboundArtifactCurrent,
  type JobOutboundAudience,
  type JobOutboundJobSource,
  type JobOutboundPublication,
} from './job-outbound-result-policy'
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

type Database = AgentHqDatabase | AgentHqTransaction

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Identifier shape checks only. They decide whether a read can name a row, never authority. */
function isUuid(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID.test(value)
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}

/** The message fields the gate needs. The page row may carry more; only these decide. */
export type PublicationRow = Readonly<{
  executionRef: string | null
  id: string
  senderKind: string
  senderSystemId: string | null
}>

/** Whether a message is a job publication: a system message under the outbound sender. */
export function isJobPublicationRow(row: Pick<PublicationRow, 'senderKind' | 'senderSystemId'>) {
  return row.senderKind === 'system' && isJobOutboundSenderValue(row.senderSystemId)
}

const NO_AUDIENCE = (workspaceLive: boolean, workspaceRole: JobOutboundAudience['workspaceRole']) =>
  ({
    channelId: null,
    channelIsGroup: false,
    channelLive: false,
    channelVersion: null,
    participant: false,
    workspaceLive,
    workspaceRole,
  }) satisfies JobOutboundAudience

/**
 * The delivery claim a publication's binding names, built from its grant row. It is the same
 * claim the locked delivery path reads, so both gates judge one registration.
 */
export function deliveryClaimFor(
  binding: JobOutboundBinding | null,
  grant: typeof artifactReferenceGrants.$inferSelect | undefined
): JobOutboundArtifactClaim | null {
  if (!binding || !binding.artifact || !binding.grant) return null
  if (!grant) return { authority: { kind: 'workspace_grant' }, grant: null }
  return {
    authority: { kind: 'workspace_grant' },
    grant: {
      artifactId: grant.artifactId,
      audienceWorkspaceId: grant.audienceWorkspaceId,
      checksumSha256: grant.checksumSha256,
      expiresAt: grant.expiresAt,
      grantId: grant.grantId,
      revokedAt: null,
      revision: binding.grant.revision,
      sourceWorkspaceId: grant.sourceWorkspaceId,
      version: grant.version,
    } satisfies ArtifactReferenceGrant,
  }
}

async function readPublications(
  database: Database,
  messageIds: readonly string[]
): Promise<Map<string, JobOutboundPublication>> {
  const publications = new Map<string, JobOutboundPublication>()
  if (!messageIds.length) return publications
  const messageRows = await database
    .select({
      bodyText: messages.bodyText,
      channelId: messages.channelId,
      deletedAt: messages.deletedAt,
      editedAt: messages.editedAt,
      executionRef: messages.executionRef,
      id: messages.id,
      idempotencyKey: messages.idempotencyKey,
      senderKind: messages.senderKind,
      senderSystemId: messages.senderSystemId,
      version: messages.version,
      workspaceId: messages.workspaceId,
    })
    .from(messages)
    .where(inArray(messages.id, [...messageIds]))
    .for('share')
  const links = await database
    .select({
      artifactId: messageArtifactReferences.artifactId,
      messageId: messageArtifactReferences.messageId,
    })
    .from(messageArtifactReferences)
    .where(inArray(messageArtifactReferences.messageId, [...messageIds]))
    .for('share')
  const linkCount = new Map<string, number>()
  const linkedArtifact = new Map<string, string>()
  for (const link of links) {
    linkCount.set(link.messageId, (linkCount.get(link.messageId) ?? 0) + 1)
    linkedArtifact.set(link.messageId, link.artifactId)
  }
  // An artifact is read only through a message with exactly one link, as the single read does.
  const artifactIds = unique(
    [...linkCount]
      .filter(([, count]) => count === 1)
      .map(([messageId]) => linkedArtifact.get(messageId)!)
      .filter(isUuid)
  )
  const artifactRows = artifactIds.length
    ? await database
        .select({
          checksumSha256: artifacts.checksumSha256,
          id: artifacts.id,
          version: artifacts.version,
          workspaceId: artifacts.workspaceId,
        })
        .from(artifacts)
        .where(inArray(artifacts.id, artifactIds))
        .for('share')
    : []
  const artifactById = new Map(artifactRows.map((row) => [row.id, row]))
  for (const message of messageRows) {
    const count = linkCount.get(message.id) ?? 0
    const row = count === 1 ? artifactById.get(linkedArtifact.get(message.id)!) : undefined
    publications.set(message.id, {
      artifact: row
        ? {
            artifactId: row.id,
            audienceWorkspaceId: message.workspaceId,
            checksumSha256: row.checksumSha256,
            sourceWorkspaceId: row.workspaceId,
            version: row.version,
          }
        : null,
      artifactLinkCount: count,
      bodyText: message.bodyText,
      channelId: message.channelId,
      deleted: message.deletedAt !== null,
      edited: message.editedAt !== null || message.version !== 1,
      executionRef: message.executionRef,
      idempotencyKey: message.idempotencyKey,
      messageId: message.id,
      senderKind: message.senderKind,
      senderSystemId: message.senderSystemId,
      workspaceId: message.workspaceId,
    })
  }
  return publications
}

/**
 * The source job of each job id, as `readJobOutboundSource` reads it: the Task, its one
 * original actor in its own workspace, and its latest completion in that workspace.
 */
async function readJobSources(
  database: Database,
  jobIds: readonly string[]
): Promise<Map<string, JobOutboundJobSource>> {
  const jobs = new Map<string, JobOutboundJobSource>()
  if (!jobIds.length) return jobs
  const taskRows = await database
    .select({ id: tasks.id, lifecycleState: tasks.lifecycleState, workspaceId: tasks.workspaceId })
    .from(tasks)
    .where(inArray(tasks.id, [...jobIds]))
    .for('share')
  if (!taskRows.length) return jobs
  const taskIds = taskRows.map((task) => task.id)
  const actorRows = await database
    .selectDistinct({
      actorUserId: taskSubmissions.actorUserId,
      taskId: taskSubmissions.taskId,
      workspaceId: taskSubmissions.workspaceId,
    })
    .from(taskSubmissions)
    .where(inArray(taskSubmissions.taskId, taskIds))
  // One row per Task: its latest completion, in the Task's own workspace.
  const completionRows = await database
    .selectDistinctOn([taskMutations.taskId], {
      createdAt: taskMutations.createdAt,
      taskId: taskMutations.taskId,
    })
    .from(taskMutations)
    .innerJoin(
      tasks,
      and(eq(tasks.id, taskMutations.taskId), eq(tasks.workspaceId, taskMutations.workspaceId))
    )
    .where(
      and(inArray(taskMutations.taskId, taskIds), eq(taskMutations.commandType, 'task.completed'))
    )
    .orderBy(taskMutations.taskId, desc(taskMutations.createdAt))
  const completedAt = new Map(completionRows.map((row) => [row.taskId, row.createdAt]))
  for (const task of taskRows) {
    const actors = unique(
      actorRows
        .filter((row) => row.taskId === task.id && row.workspaceId === task.workspaceId)
        .map((row) => row.actorUserId)
    )
    const [actor] = actors
    if (actors.length !== 1 || !actor) continue
    const completed = task.lifecycleState === 'completed' || task.lifecycleState === 'archived'
    const completion = completedAt.get(task.id)
    jobs.set(task.id, {
      completedAt: completed && completion ? completion.toISOString() : null,
      jobId: task.id,
      originalActorUserId: actor,
      sourceWorkspaceId: task.workspaceId,
    })
  }
  return jobs
}

const accessKey = (workspaceId: string, userId: string) => `${workspaceId}\u0000${userId}`

/** Each (user, workspace) pair's role and whether the workspace is live, as `readJobOutboundAccess` reads it. */
async function readAccesses(
  database: Database,
  pairs: readonly Readonly<{ userId: string; workspaceId: string }>[]
): Promise<Map<string, JobOutboundAccess>> {
  const valid = pairs.filter((pair) => isUuid(pair.userId) && isUuid(pair.workspaceId))
  const accesses = new Map<string, JobOutboundAccess>()
  if (!valid.length) return accesses
  const workspaceIds = unique(valid.map((pair) => pair.workspaceId))
  const userIds = unique(valid.map((pair) => pair.userId))
  const memberships = await database
    .select({
      role: workspaceMemberships.role,
      userId: workspaceMemberships.userId,
      workspaceId: workspaceMemberships.workspaceId,
    })
    .from(workspaceMemberships)
    .where(
      and(
        inArray(workspaceMemberships.workspaceId, workspaceIds),
        inArray(workspaceMemberships.userId, userIds)
      )
    )
    .for('share')
  const live = await database
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(inArray(workspaces.id, workspaceIds), isNull(workspaces.deletedAt)))
    .for('share')
  const liveIds = new Set(live.map((row) => row.id))
  const roles = new Map(
    memberships.map((row) => [accessKey(row.workspaceId, row.userId), row.role])
  )
  for (const pair of valid) {
    accesses.set(accessKey(pair.workspaceId, pair.userId), {
      role: roles.get(accessKey(pair.workspaceId, pair.userId)) ?? null,
      workspaceLive: liveIds.has(pair.workspaceId),
    })
  }
  return accesses
}

/**
 * The reader's standing in each (workspace, channel) pair, as `readJobOutboundAudience` reads it
 * for the reader. An invalid id or a channel outside its workspace is no audience at all.
 */
async function readAudiences(
  database: Database,
  readerUserId: string,
  pairs: readonly Readonly<{ channelId: string; workspaceId: string }>[]
): Promise<Map<string, JobOutboundAudience>> {
  const audiences = new Map<string, JobOutboundAudience>()
  const workspaceIds = unique(pairs.map((pair) => pair.workspaceId).filter(isUuid))
  const channelIds = unique(pairs.map((pair) => pair.channelId).filter(isUuid))
  const live = workspaceIds.length
    ? await database
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(and(inArray(workspaces.id, workspaceIds), isNull(workspaces.deletedAt)))
        .for('share')
    : []
  const liveIds = new Set(live.map((row) => row.id))
  const memberships = workspaceIds.length
    ? await database
        .select({ role: workspaceMemberships.role, workspaceId: workspaceMemberships.workspaceId })
        .from(workspaceMemberships)
        .where(
          and(
            eq(workspaceMemberships.userId, readerUserId),
            inArray(workspaceMemberships.workspaceId, workspaceIds)
          )
        )
        .for('share')
    : []
  const roles = new Map(memberships.map((row) => [row.workspaceId, row.role]))
  const channelRows = channelIds.length
    ? await database
        .select({
          id: channels.id,
          kind: channels.kind,
          lifecycleState: channels.lifecycleState,
          version: channels.version,
          workspaceId: channels.workspaceId,
        })
        .from(channels)
        .where(inArray(channels.id, channelIds))
        .for('share')
    : []
  const participantRows = channelIds.length
    ? await database
        .select({
          channelId: channelParticipants.channelId,
          workspaceId: channelParticipants.workspaceId,
        })
        .from(channelParticipants)
        .where(
          and(
            eq(channelParticipants.principalKind, 'user'),
            eq(channelParticipants.userId, readerUserId),
            inArray(channelParticipants.workspaceId, workspaceIds),
            inArray(channelParticipants.channelId, channelIds)
          )
        )
        .for('share')
    : []
  const channelByKey = new Map(channelRows.map((row) => [accessKey(row.workspaceId, row.id), row]))
  const participating = new Set(
    participantRows.map((row) => accessKey(row.workspaceId, row.channelId))
  )
  for (const pair of pairs) {
    const key = accessKey(pair.workspaceId, pair.channelId)
    if (!isUuid(pair.workspaceId) || !isUuid(pair.channelId)) {
      audiences.set(key, NO_AUDIENCE(false, null))
      continue
    }
    const channel = channelByKey.get(key)
    audiences.set(
      key,
      channel
        ? {
            channelId: channel.id,
            channelIsGroup: channel.kind === 'group',
            channelLive: channel.lifecycleState === 'active',
            channelVersion: channel.version,
            participant: participating.has(key),
            workspaceLive: liveIds.has(pair.workspaceId),
            workspaceRole: roles.get(pair.workspaceId) ?? null,
          }
        : NO_AUDIENCE(liveIds.has(pair.workspaceId), roles.get(pair.workspaceId) ?? null)
    )
  }
  return audiences
}

/**
 * Whether each publication in `rows` may be shown to `readerUserId` now. Returns the ids of the
 * visible publications. Rows that are not publications are not judged here. Each read covers the
 * whole page, and the decision for each publication is the canonical delivery decision.
 */
export async function readerVisiblePublicationIds(
  database: Database,
  rows: readonly PublicationRow[],
  readerUserId: string
): Promise<ReadonlySet<string>> {
  const candidates = rows.filter((row) => isJobPublicationRow(row) && row.executionRef)
  if (!candidates.length || !isUuid(readerUserId)) return new Set()

  const publications = await readPublications(
    database,
    unique(candidates.map((row) => row.id).filter(isUuid))
  )
  // A job id that is not a UUID names no readable publication, as the single read did.
  const readable = candidates.flatMap((row) => {
    const publication = publications.get(row.id)
    return isUuid(row.executionRef) && publication
      ? [{ executionRef: row.executionRef, publication, rowId: row.id }]
      : []
  })
  if (!readable.length) return new Set()

  const bindings = new Map(
    readable.map((item) => [
      item.rowId,
      decodeJobOutboundBinding(
        item.publication.senderKind === 'system' ? item.publication.senderSystemId : null
      ),
    ])
  )
  const jobs = await readJobSources(database, unique(readable.map((item) => item.executionRef)))

  const grantIds = unique(
    [...bindings.values()].flatMap((binding) =>
      binding?.artifact && binding.grant ? [binding.grant.grantId] : []
    )
  )
  const grantRows = grantIds.length
    ? await database
        .select()
        .from(artifactReferenceGrants)
        .where(inArray(artifactReferenceGrants.grantId, grantIds))
    : []
  const grantById = new Map(grantRows.map((row) => [row.grantId, row]))

  const accesses = await readAccesses(
    database,
    [...jobs.values()].map((job) => ({
      userId: job.originalActorUserId,
      workspaceId: job.sourceWorkspaceId,
    }))
  )
  const destinations = new Map<string, { channelId: string; workspaceId: string }>()
  for (const { publication } of readable)
    destinations.set(accessKey(publication.workspaceId, publication.channelId), {
      channelId: publication.channelId,
      workspaceId: publication.workspaceId,
    })
  const audiences = await readAudiences(database, readerUserId, [...destinations.values()])

  // Each publication's facts, before the reads of its artifact evidence.
  const facts = readable.map((item) => {
    const binding = bindings.get(item.rowId) ?? null
    const grant = binding?.grant ? grantById.get(binding.grant.grantId) : undefined
    const job = jobs.get(item.executionRef) ?? null
    const claim = deliveryClaimFor(binding, grant)
    const artifact = item.publication.artifact
    const evidenceRequest: ArtifactEvidenceRequest | null =
      claim && artifact && job
        ? {
            artifactId: artifact.artifactId,
            principalUserId: job.originalActorUserId,
            workspaceId: artifact.sourceWorkspaceId,
          }
        : null
    return { binding, claim, evidenceRequest, grant, item, job }
  })
  const evidence = await readArtifactReferenceEvidenceBatch(
    database as AgentHqDatabase,
    facts.flatMap((fact) =>
      fact.evidenceRequest &&
      isUuid(fact.evidenceRequest.artifactId) &&
      isUuid(fact.evidenceRequest.principalUserId) &&
      isUuid(fact.evidenceRequest.workspaceId)
        ? [fact.evidenceRequest]
        : []
    )
  )

  // Sampled after every read, as the release gate samples it.
  const now = new Date().toISOString()
  const visible = new Set<string>()
  for (const { binding, claim, evidenceRequest, grant, item, job } of facts) {
    const { publication } = item
    const grantState: ArtifactReferenceGrantState | null =
      binding?.artifact && binding.grant && grant
        ? currentGrantStateOf(grant, binding.grant.revision)
        : null
    const artifact: (JobOutboundArtifactClaim & JobOutboundArtifactCurrent) | null = claim
      ? {
          authority: claim.authority,
          evidence: evidenceRequest
            ? (evidence.get(artifactEvidenceKey(evidenceRequest)) ?? null)
            : null,
          grant: claim.grant,
          grantState,
        }
      : null
    const decision = decideJobOutboundDelivery({
      artifact,
      job,
      jobId: item.executionRef,
      now,
      publication,
      recipientAudience:
        audiences.get(accessKey(publication.workspaceId, publication.channelId)) ?? null,
      sourceAccess: job
        ? (accesses.get(accessKey(job.sourceWorkspaceId, job.originalActorUserId)) ?? {
            role: null,
            workspaceLive: false,
          })
        : null,
    })
    if (decision.action === 'deliver') visible.add(item.rowId)
  }
  return visible
}

/**
 * The thread roots among `rootIds` that the reader may see now. An ordinary root stays visible
 * as before. A job publication root is visible only while the publication gate admits it, the
 * same decision history applies to the root itself. A root that is missing, is not top-level,
 * or cannot be proven fails closed: it is absent from the result. One statement reads the roots,
 * and the publication gate runs once for all of them.
 */
export async function readerVisibleThreadRootIds(
  database: Database,
  rootIds: readonly string[],
  readerUserId: string
): Promise<ReadonlySet<string>> {
  const ids = unique(rootIds.filter(isUuid))
  if (!ids.length || !isUuid(readerUserId)) return new Set()
  const roots = await database
    .select({
      executionRef: messages.executionRef,
      id: messages.id,
      senderKind: messages.senderKind,
      senderSystemId: messages.senderSystemId,
    })
    .from(messages)
    .where(and(inArray(messages.id, ids), isNull(messages.threadRootMessageId)))
  const visiblePublications = await readerVisiblePublicationIds(
    database,
    roots.filter(isJobPublicationRow),
    readerUserId
  )
  return new Set(
    roots
      .filter((root) => !isJobPublicationRow(root) || visiblePublications.has(root.id))
      .map((root) => root.id)
  )
}
