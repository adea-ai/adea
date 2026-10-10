// Authorized portable workspace export (M18.02.2, #1226).
//
// The export is the requester's own view of one workspace, read inside ONE
// REPEATABLE READ, READ ONLY transaction so every family is observed at a
// single database snapshot. Authority is re-checked on every call: a principal
// with no current membership, a removed membership, or a deleted or
// being-deleted workspace all fail with the same "Workspace unavailable" error,
// so an export never reveals that the workspace exists. A hidden project is not
// an error; its records are simply absent.
//
// Audience is the product's own read model, not a second copy of it:
// - projects follow `resolveProjectAccessScope` (members-only projects are
//   visible to their members, owners and admins);
// - channels follow the project scope plus `participants` visibility;
// - tasks follow the project scope (as `listTasksForUser` does);
// - messages, mentions and content refs follow their channel or task.
// Soft-deleted projects are never exported, and every link to a record that
// was not exported (a hidden task, a participant-only channel, a hidden project)
// is cleared to null, so a document never names a withheld record. Counts are
// never disclosed.
//
// Credentials, sessions, invitations, runtime keys, synchronized ciphertext,
// artifact rows, native runtime state and derived event state are never queried.
// Rows of the families the export does read are mapped through explicit
// allowlists in `readPortableWorkspaceContent`; no row is ever spread into the
// document.
// The ledger in `@adea-ai/types` records each excluded class.

import { createHash } from 'node:crypto'

import {
  canonicalPortableJson,
  PORTABLE_WORKSPACE_EXPORT_EXCLUSIONS,
  PORTABLE_WORKSPACE_EXPORT_FORMAT,
  PORTABLE_WORKSPACE_EXPORT_FORMAT_VERSION,
  PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS,
  type PortableAgent,
  type PortableChannel,
  type PortableContentRef,
  type PortableExecutionAttempt,
  type PortableMessage,
  type PortableParticipant,
  type PortableProject,
  type PortableTask,
  type PortableUser,
  type PortableWorkspace,
  type PortableWorkspaceExport,
  type PortableWorkspaceExportContent,
  type UserPrincipalRef,
  validatePortableWorkspaceExport,
} from '@adea-ai/types'
import { and, asc, eq, inArray } from 'drizzle-orm'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import {
  canReadProject,
  type ProjectAccessScope,
  resolveProjectAccessScope,
} from './project-access'
import {
  agents,
  channelParticipants,
  channels,
  contentRefs,
  messageMentions,
  messages,
  projectMembers,
  projects,
  taskDependencies,
  taskExecutionAttempts,
  tasks,
  users,
  workspaces,
} from './schema'

/** One snapshot for the whole document; the export never reads a family outside it. */
export const PORTABLE_EXPORT_TRANSACTION_CONFIG = Object.freeze({
  accessMode: 'read only',
  isolationLevel: 'repeatable read',
} as const)

export type PortableExportFailureCode = 'denied' | 'invalid_content' | 'too_large'

export class PortableExportError extends Error {
  readonly code: PortableExportFailureCode

  constructor(code: PortableExportFailureCode, message: string) {
    super(message)
    this.name = 'PortableExportError'
    this.code = code
  }
}

/**
 * Who the content is read for. `requester` applies the product audience;
 * `complete` reads every record of a workspace and exists only so an import can
 * prove its restored workspace matches the bundle. It is never reachable from a
 * principal.
 */
export type PortableAudience =
  | Readonly<{ kind: 'complete' }>
  | Readonly<{ kind: 'requester'; scope: ProjectAccessScope }>

/** SHA-256 of the canonical JSON of the content: the digest a document carries and an import verifies. */
export function portableContentDigest(content: PortableWorkspaceExportContent): string {
  return createHash('sha256').update(canonicalPortableJson(content)).digest('hex')
}

const iso = (value: Date) => value.toISOString()
const isoOrNull = (value: Date | null) => (value ? value.toISOString() : null)

function bounded<T>(rows: readonly T[], family: string): readonly T[] {
  if (rows.length > PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS)
    throw new PortableExportError('too_large', `${family} exceeds the portable export bound`)
  return rows
}

function byKey<T>(rows: readonly T[], key: (row: T) => string): T[] {
  return rows.toSorted((left, right) => {
    const a = key(left)
    const b = key(right)
    return a < b ? -1 : a > b ? 1 : 0
  })
}

function participantKey(participant: PortableParticipant) {
  return participant.kind === 'user' ? `user:${participant.userId}` : `agent:${participant.agentId}`
}

/** Group once so each record looks up its children in constant time. */
function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const row of rows) {
    const group = groups.get(key(row))
    if (group) group.push(row)
    else groups.set(key(row), [row])
  }
  return groups
}

/**
 * Read the portable content of one workspace for an audience. Returns null
 * when the workspace is absent, deleted or being deleted. Every read is scoped
 * by `workspaceId`; rows leave this function only through the explicit mappings
 * below.
 */
export async function readPortableWorkspaceContent(
  transaction: AgentHqTransaction,
  workspaceId: string,
  audience: PortableAudience
): Promise<PortableWorkspaceExportContent | null> {
  const [workspaceRow] = await transaction
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1)
  if (!workspaceRow || workspaceRow.deletedAt) return null
  if (audience.kind === 'requester' && workspaceRow.deletionRequestedAt) return null

  // Projects: a soft-deleted project is never visible; `requester` audiences
  // drop the members-only projects the principal is not listed on.
  const projectRows = bounded(
    await transaction
      .select()
      .from(projects)
      .where(and(eq(projects.workspaceId, workspaceId)))
      .orderBy(asc(projects.sortOrder), asc(projects.id))
      .limit(PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS + 1),
    'projects'
  ).filter((row) => !row.deletedAt)
  const visibleProjects = projectRows.filter((row) =>
    audience.kind === 'complete' ? true : canReadProject(audience.scope, row.id)
  )
  const projectIds = new Set(visibleProjects.map((row) => row.id))

  const memberRows = projectIds.size
    ? await transaction
        .select()
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.workspaceId, workspaceId),
            inArray(projectMembers.projectId, [...projectIds])
          )
        )
        .limit(PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS + 1)
    : []
  bounded(memberRows, 'project members')

  // Channels: visible project, and `participants` channels only for their
  // participants. Archived channels stay: archive preserves history.
  const channelRows = bounded(
    await transaction
      .select()
      .from(channels)
      .where(eq(channels.workspaceId, workspaceId))
      .orderBy(asc(channels.sortOrder), asc(channels.id))
      .limit(PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS + 1),
    'channels'
  ).filter((row) => row.projectId === null || projectIds.has(row.projectId))
  const channelIds = channelRows.map((row) => row.id)
  const participantRows = channelIds.length
    ? await transaction
        .select()
        .from(channelParticipants)
        .where(
          and(
            eq(channelParticipants.workspaceId, workspaceId),
            inArray(channelParticipants.channelId, channelIds)
          )
        )
        .limit(PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS + 1)
    : []
  bounded(participantRows, 'channel participants')
  const requesterId = audience.kind === 'requester' ? audience.scope.userId : null
  const participatedChannels = new Set(
    participantRows
      .filter((row) => row.principalKind === 'user' && row.userId === requesterId)
      .map((row) => row.channelId)
  )
  const visibleChannels = channelRows.filter(
    (row) =>
      audience.kind === 'complete' ||
      row.visibility === 'workspace' ||
      participatedChannels.has(row.id)
  )
  const channelSet = new Set(visibleChannels.map((row) => row.id))

  const messageRows = channelSet.size
    ? await transaction
        .select()
        .from(messages)
        .where(
          and(eq(messages.workspaceId, workspaceId), inArray(messages.channelId, [...channelSet]))
        )
        .orderBy(asc(messages.channelId), asc(messages.sequence))
        .limit(PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS + 1)
    : []
  bounded(messageRows, 'messages')
  const messageSet = new Set(messageRows.map((row) => row.id))
  const mentionRows = messageSet.size
    ? await transaction
        .select()
        .from(messageMentions)
        .where(
          and(
            eq(messageMentions.workspaceId, workspaceId),
            inArray(messageMentions.messageId, [...messageSet])
          )
        )
        .limit(PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS + 1)
    : []
  bounded(mentionRows, 'message mentions')

  // Tasks follow the project scope, as the product's task list does.
  const taskRows = bounded(
    await transaction
      .select()
      .from(tasks)
      .where(eq(tasks.workspaceId, workspaceId))
      .orderBy(asc(tasks.createdAt), asc(tasks.id))
      .limit(PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS + 1),
    'tasks'
  ).filter((row) => row.projectId === null || projectIds.has(row.projectId))
  const taskSet = new Set(taskRows.map((row) => row.id))

  const dependencyRows = taskSet.size
    ? await transaction
        .select()
        .from(taskDependencies)
        .where(
          and(
            eq(taskDependencies.workspaceId, workspaceId),
            inArray(taskDependencies.taskId, [...taskSet])
          )
        )
        .limit(PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS + 1)
    : []
  bounded(dependencyRows, 'task dependencies')

  // Cloud-location attempts only. Runtime-location attempts carry node bindings
  // and are excluded by the ledger.
  const attemptRows = taskSet.size
    ? await transaction
        .select()
        .from(taskExecutionAttempts)
        .where(
          and(
            eq(taskExecutionAttempts.workspaceId, workspaceId),
            inArray(taskExecutionAttempts.taskId, [...taskSet]),
            eq(taskExecutionAttempts.locationKind, 'agent_hq_cloud')
          )
        )
        .limit(PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS + 1)
    : []
  bounded(attemptRows, 'execution attempts')

  // Content refs are metadata only; their bodies are in the local authority.
  const contentRefIds = [
    ...new Set([
      ...messageRows.flatMap((row) => (row.bodyContentRefId ? [row.bodyContentRefId] : [])),
      ...taskRows.flatMap((row) => (row.objectiveContentRefId ? [row.objectiveContentRefId] : [])),
    ]),
  ]
  const contentRefRows = contentRefIds.length
    ? await transaction
        .select()
        .from(contentRefs)
        .where(
          and(eq(contentRefs.workspaceId, workspaceId), inArray(contentRefs.id, contentRefIds))
        )
        .limit(PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS + 1)
    : []
  bounded(contentRefRows, 'content refs')

  // Agents and users are included only when a visible record names them.
  const agentIds = new Set<string>()
  const userIds = new Set<string>()
  for (const row of memberRows) userIds.add(row.userId)
  for (const row of participantRows) {
    if (!channelSet.has(row.channelId)) continue
    if (row.principalKind === 'user' && row.userId) userIds.add(row.userId)
    if (row.principalKind === 'agent' && row.agentId) agentIds.add(row.agentId)
  }
  for (const row of visibleChannels) if (row.agentId) agentIds.add(row.agentId)
  for (const row of messageRows) {
    if (row.senderUserId) userIds.add(row.senderUserId)
    if (row.senderAgentId) agentIds.add(row.senderAgentId)
  }
  for (const row of mentionRows) {
    if (row.userId) userIds.add(row.userId)
    if (row.agentId) agentIds.add(row.agentId)
  }
  for (const row of taskRows) {
    userIds.add(row.creatorUserId)
    if (row.agentId) agentIds.add(row.agentId)
  }

  const agentRows = agentIds.size
    ? await transaction
        .select()
        .from(agents)
        .where(and(eq(agents.workspaceId, workspaceId), inArray(agents.id, [...agentIds])))
        .limit(PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS + 1)
    : []
  bounded(agentRows, 'agents')
  const userRows = userIds.size
    ? await transaction
        .select({ displayName: users.displayName, id: users.id })
        .from(users)
        .where(inArray(users.id, [...userIds]))
        .limit(PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS + 1)
    : []
  bounded(userRows, 'users')

  const membersByProject = groupBy(memberRows, (row) => row.projectId)
  const exportedProjects: PortableProject[] = byKey(
    visibleProjects.map((row) => ({
      createdAt: iso(row.createdAt),
      iconKey: row.iconKey,
      lifecycleState: row.lifecycleState,
      members: byKey(
        (membersByProject.get(row.id) ?? []).map((member) => ({
          role: member.role,
          userId: member.userId,
        })),
        (member) => member.userId
      ),
      name: row.name,
      projectId: row.id,
      sortOrder: row.sortOrder,
      sourceKind: row.sourceKind,
      updatedAt: iso(row.updatedAt),
      visibility: row.visibility,
    })),
    (row) => `${String(row.sortOrder).padStart(12, '0')}:${row.projectId}`
  )

  const taskIdsExported = taskSet
  const participantsByChannel = groupBy(participantRows, (row) => row.channelId)
  const exportedChannels: PortableChannel[] = byKey(
    visibleChannels.map((row) => ({
      agentId: row.agentId,
      channelId: row.id,
      createdAt: iso(row.createdAt),
      isPrimaryProjectChannel: row.isPrimaryProjectChannel,
      kind: row.kind,
      lifecycleState: row.lifecycleState,
      participants: byKey(
        (participantsByChannel.get(row.id) ?? []).flatMap((participant): PortableParticipant[] =>
          participant.principalKind === 'user' && participant.userId
            ? [{ kind: 'user', userId: participant.userId }]
            : participant.agentId
              ? [{ agentId: participant.agentId, kind: 'agent' }]
              : []
        ),
        participantKey
      ),
      projectId: row.projectId && projectIds.has(row.projectId) ? row.projectId : null,
      sortOrder: row.sortOrder,
      taskId: row.taskId && taskIdsExported.has(row.taskId) ? row.taskId : null,
      title: row.title,
      updatedAt: iso(row.updatedAt),
      version: row.version,
      visibility: row.visibility,
    })),
    (row) => `${String(row.sortOrder).padStart(12, '0')}:${row.channelId}`
  )

  const threadTargets = new Map(messageRows.map((row) => [row.id, row] as const))
  const mentionsByMessage = groupBy(mentionRows, (row) => row.messageId)
  const exportedMessages: PortableMessage[] = messageRows.map((row) => {
    const deleted = row.deletedAt !== null
    const sender: PortableMessage['sender'] =
      row.senderKind === 'user'
        ? { kind: 'user', userId: row.senderUserId! }
        : row.senderKind === 'agent'
          ? { agentId: row.senderAgentId!, kind: 'agent' }
          : { kind: 'system', systemId: row.senderSystemId! }
    const body: PortableMessage['body'] = deleted
      ? { kind: 'deleted' }
      : row.bodyContentRefId
        ? { contentRefId: row.bodyContentRefId, kind: 'content_ref' }
        : { kind: 'text', text: row.bodyText! }
    const link = (target: string | null) =>
      target && messageSet.has(target) && threadTargets.get(target)?.channelId === row.channelId
        ? target
        : null
    return {
      body,
      channelId: row.channelId,
      createdAt: iso(row.createdAt),
      deletedAt: isoOrNull(row.deletedAt),
      editedAt: isoOrNull(row.editedAt),
      mentions: byKey(
        (mentionsByMessage.get(row.id) ?? []).flatMap((mention): PortableParticipant[] =>
          mention.principalKind === 'user' && mention.userId
            ? [{ kind: 'user', userId: mention.userId }]
            : mention.agentId
              ? [{ agentId: mention.agentId, kind: 'agent' }]
              : []
        ),
        participantKey
      ),
      messageId: row.id,
      replyToMessageId: link(row.replyToMessageId),
      sender,
      taskId: row.taskId && taskIdsExported.has(row.taskId) ? row.taskId : null,
      threadRootMessageId: link(row.threadRootMessageId),
      updatedAt: iso(row.updatedAt),
      version: row.version,
    }
  })

  const exportedContentRefs: PortableContentRef[] = byKey(
    contentRefRows.map((row) => ({
      bodyState: row.availability === 'deleted' ? 'deleted' : 'local_authority',
      contentRefId: row.id,
      contentType: row.contentType,
      createdAt: iso(row.createdAt),
      digestSha256: row.digestSha256,
      keyVersion: row.keyVersion,
      messageId: row.messageId && messageSet.has(row.messageId) ? row.messageId : null,
      revision: row.revision,
      schemaVersion: row.schemaVersion,
      sensitivity: row.sensitivity,
      storagePolicy: row.storagePolicy,
      synchronizationPolicy: row.synchronizationPolicy,
      taskId: row.taskId && taskIdsExported.has(row.taskId) ? row.taskId : null,
      updatedAt: iso(row.updatedAt),
    })),
    (row) => row.contentRefId
  )

  const exportedTasks: PortableTask[] = byKey(
    taskRows.map((row) => ({
      agentId: row.agentId && agentIds.has(row.agentId) ? row.agentId : null,
      channelId: row.channelId && channelSet.has(row.channelId) ? row.channelId : null,
      createdAt: iso(row.createdAt),
      creatorUserId: row.creatorUserId,
      kind: row.kind,
      lifecycleState: row.lifecycleState,
      messageId: row.messageId && messageSet.has(row.messageId) ? row.messageId : null,
      objective: row.objective,
      objectiveContentRefId: row.objectiveContentRefId,
      priority: row.priority,
      projectId: row.projectId && projectIds.has(row.projectId) ? row.projectId : null,
      taskId: row.id,
      threadRootMessageId:
        row.threadRootMessageId && messageSet.has(row.threadRootMessageId)
          ? row.threadRootMessageId
          : null,
      title: row.title,
      updatedAt: iso(row.updatedAt),
      version: row.version,
    })),
    (row) => `${row.createdAt}:${row.taskId}`
  )

  const exportedAgents: PortableAgent[] = byKey(
    agentRows.map((row) => ({
      agentId: row.id,
      createdAt: iso(row.createdAt),
      isWorkspaceLead: row.isWorkspaceLead,
      lifecycleState: row.lifecycleState,
      name: row.name,
      profileId: row.profileId,
      profileRevision: row.profileRevision,
      profileState: row.profileState,
      profileVersion: row.profileVersion,
      projectId: row.projectId && projectIds.has(row.projectId) ? row.projectId : null,
      revision: row.revision,
      roleSummary: row.roleSummary,
      updatedAt: iso(row.updatedAt),
    })),
    (row) => row.agentId
  )

  const exportedUsers: PortableUser[] = byKey(
    userRows.map((row) => ({ displayName: row.displayName, userId: row.id })),
    (row) => row.userId
  )

  const exportedAttempts: PortableExecutionAttempt[] = byKey(
    attemptRows.map((row) => ({
      attempt: row.attempt,
      change: row.change,
      createdAt: iso(row.createdAt),
      locationKind: 'agent_hq_cloud',
      taskId: row.taskId,
    })),
    (row) => `${row.taskId}#${String(row.attempt).padStart(12, '0')}`
  )

  // Both ends must be exported: an edge to a hidden task would name it.
  const exportedDependencies = byKey(
    dependencyRows
      .filter((row) => taskSet.has(row.dependsOnTaskId))
      .map((row) => ({ dependsOnTaskId: row.dependsOnTaskId, taskId: row.taskId })),
    (row) => `${row.taskId}>${row.dependsOnTaskId}`
  )

  const workspace: PortableWorkspace = {
    accent: workspaceRow.accent as PortableWorkspace['accent'],
    createdAt: iso(workspaceRow.createdAt),
    logoKind: workspaceRow.logoKind as PortableWorkspace['logoKind'],
    logoValue: workspaceRow.logoValue,
    name: workspaceRow.name,
    scene: workspaceRow.scene as PortableWorkspace['scene'],
    updatedAt: iso(workspaceRow.updatedAt),
    version: workspaceRow.version,
    workspaceId: workspaceRow.id,
  }

  return {
    agents: exportedAgents,
    channels: exportedChannels,
    contentRefs: exportedContentRefs,
    executionAttempts: exportedAttempts,
    messages: exportedMessages,
    projects: exportedProjects,
    taskDependencies: exportedDependencies,
    tasks: exportedTasks,
    users: exportedUsers,
    workspace,
  }
}

/** Assemble and self-check a version-1 document. A failed self-check is a builder bug, never a partial export. */
export function buildPortableWorkspaceExport(
  content: PortableWorkspaceExportContent,
  envelope: Readonly<{ exportedAt: Date; exportedBy: PortableWorkspaceExport['exportedBy'] }>
): PortableWorkspaceExport {
  const document: PortableWorkspaceExport = {
    content,
    contentDigest: { algorithm: 'sha256', value: portableContentDigest(content) },
    exclusions: PORTABLE_WORKSPACE_EXPORT_EXCLUSIONS,
    exportedAt: iso(envelope.exportedAt),
    exportedBy: envelope.exportedBy,
    format: PORTABLE_WORKSPACE_EXPORT_FORMAT,
    formatVersion: PORTABLE_WORKSPACE_EXPORT_FORMAT_VERSION,
  }
  const validation = validatePortableWorkspaceExport(document)
  if (!validation.ok)
    throw new PortableExportError(
      'invalid_content',
      'the built export failed its own contract check'
    )
  return document
}

/**
 * Export one workspace as the principal may see it. Denies with the same
 * indistinguishable error for every reason of no access, including a removed
 * membership: the membership is read inside the export's snapshot, so a
 * revocation committed before the export is always observed.
 */
export async function exportPortableWorkspace(
  database: AgentHqDatabase,
  input: Readonly<{ exportedAt?: Date; principal: UserPrincipalRef; workspaceId: string }>
): Promise<PortableWorkspaceExport> {
  return database.transaction(async (transaction) => {
    const scope = await resolveProjectAccessScope(
      transaction,
      input.workspaceId,
      input.principal.userId
    )
    if (!scope) throw new PortableExportError('denied', 'Workspace unavailable')
    const content = await readPortableWorkspaceContent(transaction, input.workspaceId, {
      kind: 'requester',
      scope,
    })
    if (!content) throw new PortableExportError('denied', 'Workspace unavailable')
    return buildPortableWorkspaceExport(content, {
      exportedAt: input.exportedAt ?? new Date(),
      exportedBy: { role: scope.role, userId: scope.userId },
    })
  }, PORTABLE_EXPORT_TRANSACTION_CONFIG)
}
