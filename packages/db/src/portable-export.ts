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
// Visibility is the product's own current read authorization, not a copy of it.
// Channels and messages come from `listChannelsForUser` and `listMessagesForUser`,
// the same readers the workspace API serves, so whatever gate those readers apply
// (participant and project scope today, group admission and join points and job
// publication gates when they land) is applied here too. Content refs go through
// `isContentRefVisible`, and tasks and projects use the project predicate that
// their list readers use. Nothing here decides audience on its own.
//
// Rows of the families the export reads are never spread into the document. Each
// record is mapped through the explicit allowlist in `mapPortableContent`. System
// sender identifiers are never exported: a job publication's system identifier
// carries an encoded binding, so every system sender leaves as the opaque label
// `PORTABLE_SYSTEM_SENDER_ID`. Links to any record that was not exported are
// cleared to null, so a document never names a withheld record, and counts are
// never disclosed.
//
// Credentials, sessions, invitations, runtime keys, synchronized ciphertext,
// artifact rows, native runtime state and derived event state are never queried.
// The ledger in `@adea-ai/types` records each excluded class.

import { createHash } from 'node:crypto'

import {
  canonicalPortableJson,
  PORTABLE_WORKSPACE_EXPORT_EXCLUSIONS,
  PORTABLE_WORKSPACE_EXPORT_FORMAT,
  PORTABLE_WORKSPACE_EXPORT_FORMAT_VERSION,
  PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS,
  type ChannelSummary,
  type ConversationParticipantRef,
  type MessageSummary,
  type PortableAgent,
  type PortableChannel,
  type PortableContentRef,
  type PortableExecutionAttempt,
  type PortableMessage,
  type PortableMessageBody,
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
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { listChannelsForUser, listMessagesForUser } from './conversations'
import {
  isContentRefVisible,
  type ProjectAccessScope,
  resolveProjectAccessScope,
  visibleProjectCondition,
} from './project-access'
import {
  agents,
  channelParticipants,
  channels as channelTable,
  contentRefs,
  messageMentions,
  messages as messageTable,
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

/** The only system sender label a document carries. System identifiers may encode bindings, so none leaves as is. */
export const PORTABLE_SYSTEM_SENDER_ID = 'system'

/** Messages are read through the canonical reader in pages of this size; the reader's own limit is 100. */
const MESSAGE_PAGE = 100

export type PortableExportFailureCode = 'denied' | 'invalid_content' | 'too_large'

export class PortableExportError extends Error {
  readonly code: PortableExportFailureCode

  constructor(code: PortableExportFailureCode, message: string) {
    super(message)
    this.name = 'PortableExportError'
    this.code = code
  }
}

/** SHA-256 of the canonical JSON of the content: the digest a document carries and an import verifies. */
export function portableContentDigest(content: PortableWorkspaceExportContent): string {
  return createHash('sha256').update(canonicalPortableJson(content)).digest('hex')
}

const iso = (value: Date) => value.toISOString()

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

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const row of rows) {
    const group = groups.get(key(row))
    if (group) group.push(row)
    else groups.set(key(row), [row])
  }
  return groups
}

function toPortableParticipant(ref: ConversationParticipantRef): PortableParticipant {
  return ref.kind === 'user'
    ? { kind: 'user', userId: ref.userId }
    : { agentId: ref.agentId, kind: 'agent' }
}

type ProjectRow = typeof projects.$inferSelect
type MemberRow = typeof projectMembers.$inferSelect
type TaskRow = typeof tasks.$inferSelect
type ContentRefRow = typeof contentRefs.$inferSelect
type AgentRow = typeof agents.$inferSelect
type WorkspaceRow = typeof workspaces.$inferSelect

/**
 * What one reader produced, before the allowlist mapping. The requester path
 * fills it from the canonical readers; the complete path (used only to verify a
 * restore) fills it from every row of the workspace. Both feed one mapper, so
 * the two cannot drift apart in shape.
 */
type ReadInputs = Readonly<{
  agentRows: readonly AgentRow[]
  channels: readonly ChannelSummary[]
  contentRefRows: readonly ContentRefRow[]
  dependencyRows: readonly (typeof taskDependencies.$inferSelect)[]
  attemptRows: readonly (typeof taskExecutionAttempts.$inferSelect)[]
  memberRows: readonly MemberRow[]
  messages: readonly MessageSummary[]
  projectRows: readonly ProjectRow[]
  taskRows: readonly TaskRow[]
  userRows: readonly { displayName: string | null; id: string }[]
  visibleContentRefIds: ReadonlySet<string>
  workspace: WorkspaceRow
}>

function mapPortableContent(input: ReadInputs): PortableWorkspaceExportContent {
  const projectIds = new Set(input.projectRows.map((row) => row.id))
  const taskIds = new Set(input.taskRows.map((row) => row.id))
  const channelIds = new Set(input.channels.map((channel) => channel.id))
  const agentIds = new Set(input.agentRows.map((row) => row.id))

  // A message whose body is a content ref the reader may not see is withheld
  // whole. Its links go with it, so nothing names a body that is not exported.
  const messageRows = input.messages.filter(
    (message) =>
      message.deleted ||
      !message.bodyContentRefId ||
      input.visibleContentRefIds.has(message.bodyContentRefId)
  )
  const messageIds = new Set(messageRows.map((message) => message.id))
  const messageChannel = new Map(messageRows.map((message) => [message.id, message.channelId]))

  const exportedProjects: PortableProject[] = byKey(
    input.projectRows.map((row) => ({
      createdAt: iso(row.createdAt),
      iconKey: row.iconKey,
      lifecycleState: row.lifecycleState,
      members: byKey(
        input.memberRows
          .filter((member) => member.projectId === row.id)
          .map((member) => ({ role: member.role, userId: member.userId })),
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

  const exportedAgents: PortableAgent[] = byKey(
    input.agentRows.map((row) => ({
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
    input.userRows.map((row) => ({ displayName: row.displayName, userId: row.id })),
    (row) => row.userId
  )

  const exportedChannels: PortableChannel[] = byKey(
    input.channels
      .filter((channel) => !channel.projectId || projectIds.has(channel.projectId))
      .map((channel) => ({
        agentId: channel.agentId && agentIds.has(channel.agentId) ? channel.agentId : null,
        channelId: channel.id,
        createdAt: channel.createdAt,
        isPrimaryProjectChannel: channel.isPrimaryProjectChannel,
        kind: channel.kind,
        lifecycleState: channel.lifecycleState,
        participants: byKey(channel.participants.map(toPortableParticipant), participantKey),
        projectId: channel.projectId ?? null,
        sortOrder: channel.sortOrder,
        taskId: channel.taskId && taskIds.has(channel.taskId) ? channel.taskId : null,
        title: channel.title,
        updatedAt: channel.updatedAt,
        version: channel.version,
        visibility: channel.visibility,
      })),
    (row) => `${String(row.sortOrder).padStart(12, '0')}:${row.channelId}`
  )

  const exportedMessages: PortableMessage[] = byKey(
    byKey(
      messageRows,
      (message) => `${message.channelId}:${String(message.sequence).padStart(12, '0')}`
    ).map((message): PortableMessage => {
      const body: PortableMessageBody = message.deleted
        ? { kind: 'deleted' }
        : message.bodyContentRefId
          ? { contentRefId: message.bodyContentRefId, kind: 'content_ref' }
          : { kind: 'text', text: message.bodyText ?? '' }
      const sender: PortableMessage['sender'] =
        message.sender.kind === 'user'
          ? { kind: 'user', userId: message.sender.userId }
          : message.sender.kind === 'agent'
            ? { agentId: message.sender.agentId, kind: 'agent' }
            : { kind: 'system', systemId: PORTABLE_SYSTEM_SENDER_ID }
      const link = (target: string | undefined) =>
        target && messageIds.has(target) && messageChannel.get(target) === message.channelId
          ? target
          : null
      return {
        body,
        channelId: message.channelId,
        createdAt: message.createdAt,
        deletedAt: message.deletedAt ?? null,
        editedAt: message.editedAt ?? null,
        mentions: byKey(message.mentions.map(toPortableParticipant), participantKey),
        messageId: message.id,
        replyToMessageId: link(message.replyToMessageId),
        sender,
        taskId: message.taskId && taskIds.has(message.taskId) ? message.taskId : null,
        threadRootMessageId: link(message.threadRootMessageId),
        updatedAt: message.updatedAt,
        version: message.version,
      }
    }),
    (row) => `${row.channelId}:${row.messageId}`
  )

  const exportedContentRefs: PortableContentRef[] = byKey(
    input.contentRefRows
      .filter((row) => input.visibleContentRefIds.has(row.id))
      .map((row) => ({
        bodyState: row.availability === 'deleted' ? 'deleted' : 'local_authority',
        contentRefId: row.id,
        contentType: row.contentType,
        createdAt: iso(row.createdAt),
        digestSha256: row.digestSha256,
        keyVersion: row.keyVersion,
        messageId: row.messageId && messageIds.has(row.messageId) ? row.messageId : null,
        revision: row.revision,
        schemaVersion: row.schemaVersion,
        sensitivity: row.sensitivity,
        storagePolicy: row.storagePolicy,
        synchronizationPolicy: row.synchronizationPolicy,
        taskId: row.taskId && taskIds.has(row.taskId) ? row.taskId : null,
        updatedAt: iso(row.updatedAt),
      })),
    (row) => row.contentRefId
  )

  const exportedTasks: PortableTask[] = byKey(
    input.taskRows.map((row) => ({
      agentId: row.agentId && agentIds.has(row.agentId) ? row.agentId : null,
      channelId: row.channelId && channelIds.has(row.channelId) ? row.channelId : null,
      createdAt: iso(row.createdAt),
      creatorUserId: row.creatorUserId,
      kind: row.kind,
      lifecycleState: row.lifecycleState,
      messageId: row.messageId && messageIds.has(row.messageId) ? row.messageId : null,
      objective: row.objective,
      objectiveContentRefId: row.objectiveContentRefId,
      priority: row.priority,
      projectId: row.projectId && projectIds.has(row.projectId) ? row.projectId : null,
      taskId: row.id,
      threadRootMessageId:
        row.threadRootMessageId && messageIds.has(row.threadRootMessageId)
          ? row.threadRootMessageId
          : null,
      title: row.title,
      updatedAt: iso(row.updatedAt),
      version: row.version,
    })),
    (row) => `${row.createdAt}:${row.taskId}`
  )

  const exportedDependencies = byKey(
    input.dependencyRows
      .filter((row) => taskIds.has(row.taskId) && taskIds.has(row.dependsOnTaskId))
      .map((row) => ({ dependsOnTaskId: row.dependsOnTaskId, taskId: row.taskId })),
    (row) => `${row.taskId}>${row.dependsOnTaskId}`
  )

  // Cloud-location attempts only. Runtime-location attempts carry node bindings
  // and are excluded by the ledger.
  const exportedAttempts: PortableExecutionAttempt[] = byKey(
    input.attemptRows
      .filter((row) => taskIds.has(row.taskId) && row.locationKind === 'agent_hq_cloud')
      .map((row) => ({
        attempt: row.attempt,
        change: row.change,
        createdAt: iso(row.createdAt),
        locationKind: 'agent_hq_cloud',
        taskId: row.taskId,
      })),
    (row) => `${row.taskId}#${String(row.attempt).padStart(12, '0')}`
  )

  const portableWorkspace: PortableWorkspace = {
    accent: input.workspace.accent as PortableWorkspace['accent'],
    createdAt: iso(input.workspace.createdAt),
    logoKind: input.workspace.logoKind as PortableWorkspace['logoKind'],
    logoValue: input.workspace.logoValue,
    name: input.workspace.name,
    scene: input.workspace.scene as PortableWorkspace['scene'],
    updatedAt: iso(input.workspace.updatedAt),
    version: input.workspace.version,
    workspaceId: input.workspace.id,
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
    workspace: portableWorkspace,
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
 * Every message the principal can read, through the canonical reader, channel
 * by channel and page by page. Each page re-checks membership and channel
 * access inside the snapshot, so a revocation that lands mid-export denies the
 * next page instead of leaking the rest.
 */
async function readVisibleMessages(
  transaction: AgentHqTransaction,
  workspaceId: string,
  principal: UserPrincipalRef,
  channels: readonly ChannelSummary[]
): Promise<MessageSummary[]> {
  const messages: MessageSummary[] = []
  for (const channel of channels) {
    let afterSequence: number | undefined
    for (;;) {
      const page = await listMessagesForUser(transaction, workspaceId, channel.id, principal, {
        afterSequence,
        limit: MESSAGE_PAGE,
      })
      messages.push(...page.messages)
      bounded(messages, 'messages')
      if (page.nextAfterSequence === undefined) break
      afterSequence = page.nextAfterSequence
    }
  }
  return messages.toSorted(
    (left, right) =>
      (left.channelId < right.channelId ? -1 : left.channelId > right.channelId ? 1 : 0) ||
      left.sequence - right.sequence
  )
}

/**
 * The requester's view. Projects, tasks and content refs use the same predicates
 * the product's readers use; channels and messages come from the canonical readers
 * themselves. Agents and users are included only when a visible record names them.
 */
async function readRequesterInputs(
  transaction: AgentHqTransaction,
  workspace: WorkspaceRow,
  principal: UserPrincipalRef,
  scope: ProjectAccessScope
): Promise<ReadInputs> {
  const workspaceId = workspace.id
  const projectRows = bounded(
    await transaction
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.workspaceId, workspaceId),
          isNull(projects.deletedAt),
          visibleProjectCondition(projects.id, scope)
        )
      )
      .orderBy(asc(projects.sortOrder), asc(projects.id))
      .limit(PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS + 1),
    'projects'
  )
  const projectIds = new Set(projectRows.map((row) => row.id))

  const channels = (await listChannelsForUser(transaction, workspaceId, principal)).filter(
    (channel) => !channel.projectId || projectIds.has(channel.projectId)
  )
  bounded(channels, 'channels')
  const messages = await readVisibleMessages(transaction, workspaceId, principal, channels)

  const taskRows = bounded(
    await transaction
      .select()
      .from(tasks)
      .where(
        and(eq(tasks.workspaceId, workspaceId), visibleProjectCondition(tasks.projectId, scope))
      )
      .orderBy(asc(tasks.createdAt), asc(tasks.id))
      .limit(PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS + 1),
    'tasks'
  ).filter((row) => !row.projectId || projectIds.has(row.projectId))

  // A content ref follows its task or its message's channel. The candidate set is
  // what visible records name; the reader's predicate decides which of them stay.
  const candidateRefIds = [
    ...new Set([
      ...messages.flatMap((message) =>
        message.bodyContentRefId ? [message.bodyContentRefId] : []
      ),
      ...taskRows.flatMap((row) => (row.objectiveContentRefId ? [row.objectiveContentRefId] : [])),
    ]),
  ]
  const visibleContentRefIds = new Set<string>()
  for (const id of candidateRefIds)
    if (await isContentRefVisible(transaction, workspaceId, principal.userId, id))
      visibleContentRefIds.add(id)
  const contentRefRows = visibleContentRefIds.size
    ? await transaction
        .select()
        .from(contentRefs)
        .where(
          and(
            eq(contentRefs.workspaceId, workspaceId),
            inArray(contentRefs.id, [...visibleContentRefIds])
          )
        )
        .limit(PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS + 1)
    : []
  bounded(contentRefRows, 'content refs')

  return finishInputs(transaction, workspace, {
    channels,
    contentRefRows,
    messages,
    projectRows,
    taskRows,
    visibleContentRefIds,
  })
}

/**
 * The complete view of a workspace, read without a principal. It exists only so
 * an import can prove that the restored workspace reproduces the bundle; no
 * request path reaches it.
 */
async function readCompleteInputs(
  transaction: AgentHqTransaction,
  workspace: WorkspaceRow
): Promise<ReadInputs> {
  const workspaceId = workspace.id
  const projectRows = bounded(
    await transaction
      .select()
      .from(projects)
      .where(and(eq(projects.workspaceId, workspaceId), isNull(projects.deletedAt)))
      .orderBy(asc(projects.sortOrder), asc(projects.id))
      .limit(PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS + 1),
    'projects'
  )
  const projectIds = new Set(projectRows.map((row) => row.id))
  const channelRows = bounded(
    await transaction
      .select()
      .from(channelTable)
      .where(eq(channelTable.workspaceId, workspaceId))
      .orderBy(asc(channelTable.sortOrder), asc(channelTable.id))
      .limit(PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS + 1),
    'channels'
  ).filter((row) => !row.projectId || projectIds.has(row.projectId))
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
  const participantsByChannel = groupBy(participantRows, (row) => row.channelId)
  const channelSummaries: ChannelSummary[] = channelRows.map((row) => ({
    ...(row.agentId ? { agentId: row.agentId } : {}),
    createdAt: iso(row.createdAt),
    id: row.id,
    isPrimaryProjectChannel: row.isPrimaryProjectChannel,
    kind: row.kind,
    lifecycleState: row.lifecycleState,
    participants: (participantsByChannel.get(row.id) ?? []).flatMap(
      (participant): ConversationParticipantRef[] =>
        participant.principalKind === 'user' && participant.userId
          ? [{ kind: 'user', userId: participant.userId }]
          : participant.agentId
            ? [{ agentId: participant.agentId, kind: 'agent' }]
            : []
    ),
    ...(row.projectId ? { projectId: row.projectId } : {}),
    sortOrder: row.sortOrder,
    ...(row.taskId ? { taskId: row.taskId } : {}),
    title: row.title,
    updatedAt: iso(row.updatedAt),
    version: row.version,
    visibility: row.visibility,
    workspaceId,
  }))

  const messageRows = channelIds.length
    ? await transaction
        .select()
        .from(messageTable)
        .where(
          and(
            eq(messageTable.workspaceId, workspaceId),
            inArray(messageTable.channelId, channelIds)
          )
        )
        .orderBy(asc(messageTable.channelId), asc(messageTable.sequence))
        .limit(PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS + 1)
    : []
  bounded(messageRows, 'messages')
  const mentionRows = messageRows.length
    ? await transaction
        .select()
        .from(messageMentions)
        .where(
          and(
            eq(messageMentions.workspaceId, workspaceId),
            inArray(
              messageMentions.messageId,
              messageRows.map((row) => row.id)
            )
          )
        )
        .limit(PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS + 1)
    : []
  bounded(mentionRows, 'message mentions')
  const mentionsByMessage = groupBy(mentionRows, (row) => row.messageId)
  const messageSummaries: MessageSummary[] = messageRows.map((row) => ({
    artifactIds: [],
    ...(!row.deletedAt && row.bodyContentRefId ? { bodyContentRefId: row.bodyContentRefId } : {}),
    ...(!row.deletedAt && row.bodyText ? { bodyText: row.bodyText } : {}),
    channelId: row.channelId,
    createdAt: iso(row.createdAt),
    deleted: Boolean(row.deletedAt),
    ...(row.deletedAt ? { deletedAt: iso(row.deletedAt) } : {}),
    ...(row.editedAt ? { editedAt: iso(row.editedAt) } : {}),
    id: row.id,
    mentions: (mentionsByMessage.get(row.id) ?? []).flatMap(
      (mention): ConversationParticipantRef[] =>
        mention.principalKind === 'user' && mention.userId
          ? [{ kind: 'user', userId: mention.userId }]
          : mention.agentId
            ? [{ agentId: mention.agentId, kind: 'agent' }]
            : []
    ),
    ...(row.replyToMessageId ? { replyToMessageId: row.replyToMessageId } : {}),
    sender:
      row.senderKind === 'user'
        ? { kind: 'user', userId: row.senderUserId! }
        : row.senderKind === 'agent'
          ? { agentId: row.senderAgentId!, kind: 'agent' }
          : { kind: 'system', systemId: row.senderSystemId! },
    sequence: row.sequence,
    ...(row.taskId ? { taskId: row.taskId } : {}),
    ...(row.threadRootMessageId ? { threadRootMessageId: row.threadRootMessageId } : {}),
    updatedAt: iso(row.updatedAt),
    version: row.version,
    workspaceId,
  }))

  const taskRows = bounded(
    await transaction
      .select()
      .from(tasks)
      .where(eq(tasks.workspaceId, workspaceId))
      .orderBy(asc(tasks.createdAt), asc(tasks.id))
      .limit(PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS + 1),
    'tasks'
  ).filter((row) => !row.projectId || projectIds.has(row.projectId))
  const candidateRefIds = [
    ...new Set([
      ...messageSummaries.flatMap((message) =>
        message.bodyContentRefId ? [message.bodyContentRefId] : []
      ),
      ...taskRows.flatMap((row) => (row.objectiveContentRefId ? [row.objectiveContentRefId] : [])),
    ]),
  ]
  const contentRefRows = candidateRefIds.length
    ? await transaction
        .select()
        .from(contentRefs)
        .where(
          and(eq(contentRefs.workspaceId, workspaceId), inArray(contentRefs.id, candidateRefIds))
        )
        .limit(PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS + 1)
    : []
  bounded(contentRefRows, 'content refs')

  return finishInputs(transaction, workspace, {
    channels: channelSummaries,
    contentRefRows,
    messages: messageSummaries,
    projectRows,
    taskRows,
    visibleContentRefIds: new Set(candidateRefIds),
  })
}

/**
 * The rows the mapper needs that every reader reads the same way: the references
 * the included records name (agents, users), project members, dependencies and
 * cloud attempts. A reference is loaded only when an included record names it.
 */
async function finishInputs(
  transaction: AgentHqTransaction,
  workspace: WorkspaceRow,
  partial: Pick<
    ReadInputs,
    'channels' | 'contentRefRows' | 'messages' | 'projectRows' | 'taskRows' | 'visibleContentRefIds'
  >
): Promise<ReadInputs> {
  const workspaceId = workspace.id
  const taskIds = partial.taskRows.map((row) => row.id)
  const projectIds = partial.projectRows.map((row) => row.id)

  const agentIds = new Set<string>()
  const userIds = new Set<string>()
  for (const channel of partial.channels) {
    if (channel.agentId) agentIds.add(channel.agentId)
    for (const participant of channel.participants) {
      if (participant.kind === 'user') userIds.add(participant.userId)
      else agentIds.add(participant.agentId)
    }
  }
  for (const message of partial.messages) {
    if (message.sender.kind === 'user') userIds.add(message.sender.userId)
    if (message.sender.kind === 'agent') agentIds.add(message.sender.agentId)
    for (const mention of message.mentions) {
      if (mention.kind === 'user') userIds.add(mention.userId)
      else agentIds.add(mention.agentId)
    }
  }
  for (const row of partial.taskRows) {
    userIds.add(row.creatorUserId)
    if (row.agentId) agentIds.add(row.agentId)
  }

  const memberRows = projectIds.length
    ? await transaction
        .select()
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.workspaceId, workspaceId),
            inArray(projectMembers.projectId, projectIds)
          )
        )
        .limit(PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS + 1)
    : []
  bounded(memberRows, 'project members')
  for (const member of memberRows) userIds.add(member.userId)

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

  const dependencyRows = taskIds.length
    ? await transaction
        .select()
        .from(taskDependencies)
        .where(
          and(
            eq(taskDependencies.workspaceId, workspaceId),
            inArray(taskDependencies.taskId, taskIds)
          )
        )
        .limit(PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS + 1)
    : []
  bounded(dependencyRows, 'task dependencies')
  const attemptRows = taskIds.length
    ? await transaction
        .select()
        .from(taskExecutionAttempts)
        .where(
          and(
            eq(taskExecutionAttempts.workspaceId, workspaceId),
            inArray(taskExecutionAttempts.taskId, taskIds)
          )
        )
        .limit(PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS + 1)
    : []
  bounded(attemptRows, 'execution attempts')

  return {
    agentRows,
    channels: partial.channels,
    contentRefRows: partial.contentRefRows,
    dependencyRows,
    attemptRows,
    memberRows,
    messages: partial.messages,
    projectRows: partial.projectRows,
    taskRows: partial.taskRows,
    userRows,
    visibleContentRefIds: partial.visibleContentRefIds,
    workspace,
  }
}

/**
 * The complete content of one workspace, for verifying a restore. Returns null
 * when the workspace is absent, deleted or being deleted. No request path calls it.
 */
export async function readCompletePortableContent(
  transaction: AgentHqTransaction,
  workspaceId: string
): Promise<PortableWorkspaceExportContent | null> {
  const [workspace] = await transaction
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1)
  if (!workspace || workspace.deletedAt) return null
  return mapPortableContent(await readCompleteInputs(transaction, workspace))
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
    const [workspace] = await transaction
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, input.workspaceId))
      .limit(1)
    if (!workspace || workspace.deletedAt || workspace.deletionRequestedAt)
      throw new PortableExportError('denied', 'Workspace unavailable')
    const content = mapPortableContent(
      await readRequesterInputs(transaction, workspace, input.principal, scope)
    )
    return buildPortableWorkspaceExport(content, {
      exportedAt: input.exportedAt ?? new Date(),
      exportedBy: { role: scope.role, userId: scope.userId },
    })
  }, PORTABLE_EXPORT_TRANSACTION_CONFIG)
}
