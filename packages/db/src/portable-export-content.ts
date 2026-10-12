// Portable workspace export content (M18.02.2, #1226): the pure part of the export.
//
// Everything here is a function of already-read rows and canonical reader output. It
// decides what a document may contain (the allowlist mapping, link clearing, the
// withheld-body rules and the system-sender label), builds the document, and digests it.
// It touches no database, so the unit lane measures it. The readers that decide which
// rows a principal may see live in `portable-export.ts` and are covered by the
// integration lane.

import { createHash } from 'node:crypto'

import {
  canonicalPortableJson,
  PORTABLE_WORKSPACE_EXPORT_EXCLUSIONS,
  PORTABLE_WORKSPACE_EXPORT_FORMAT,
  PORTABLE_WORKSPACE_EXPORT_FORMAT_VERSION,
  PORTABLE_WORKSPACE_EXPORT_MAX_BYTES,
  PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS,
  portableJsonUtf8ByteLength,
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
  validatePortableWorkspaceExport,
} from '@adea-ai/types'

import type {
  agents,
  contentRefs,
  projectMembers,
  projects,
  taskDependencies,
  taskExecutionAttempts,
  tasks,
  workspaces,
} from './schema'

/** The only system sender label a document carries. System identifiers may encode bindings, so none leaves as is. */
export const PORTABLE_SYSTEM_SENDER_ID = 'system'

export type PortableExportFailureCode = 'denied' | 'invalid_content' | 'too_large'

export class PortableExportError extends Error {
  readonly code: PortableExportFailureCode

  constructor(code: PortableExportFailureCode, message: string) {
    super(message)
    this.name = 'PortableExportError'
    this.code = code
  }
}

type PortableExportEnvelope = Readonly<{
  exportedAt: Date
  exportedBy: PortableWorkspaceExport['exportedBy']
}>

/**
 * Start with the exact document envelope and empty content arrays, then account
 * each mapped record as its family is built. The digest placeholder has the
 * same UTF-8 width as the eventual SHA-256 hex digest.
 */
class PortableExportSizeBudget {
  private bytes: number

  constructor(workspace: PortableWorkspace, envelope: PortableExportEnvelope) {
    this.bytes = portableJsonUtf8ByteLength({
      content: {
        agents: [],
        channels: [],
        contentRefs: [],
        executionAttempts: [],
        messages: [],
        projects: [],
        taskDependencies: [],
        tasks: [],
        users: [],
        workspace,
      },
      contentDigest: { algorithm: 'sha256', value: '0'.repeat(64) },
      exclusions: PORTABLE_WORKSPACE_EXPORT_EXCLUSIONS,
      exportedAt: iso(envelope.exportedAt),
      exportedBy: envelope.exportedBy,
      format: PORTABLE_WORKSPACE_EXPORT_FORMAT,
      formatVersion: PORTABLE_WORKSPACE_EXPORT_FORMAT_VERSION,
    })
    this.assertWithinLimit()
  }

  addRecord(record: unknown, index: number) {
    this.bytes += portableJsonUtf8ByteLength(record) + (index === 0 ? 0 : 1)
    this.assertWithinLimit()
  }

  private assertWithinLimit() {
    if (this.bytes > PORTABLE_WORKSPACE_EXPORT_MAX_BYTES)
      throw new PortableExportError('too_large', 'portable export exceeds the byte bound')
  }
}

function mapWithBudget<T, U>(
  rows: readonly T[],
  map: (row: T) => U,
  sizeBudget: PortableExportSizeBudget | undefined
): U[] {
  const mapped: U[] = []
  for (const row of rows) {
    const record = map(row)
    sizeBudget?.addRecord(record, mapped.length)
    mapped.push(record)
  }
  return mapped
}

function mapByKeyWithBudget<T, U>(
  rows: readonly T[],
  map: (row: T) => U,
  key: (row: U) => string,
  sizeBudget: PortableExportSizeBudget | undefined
): U[] {
  return byKey(mapWithBudget(rows, map, sizeBudget), key)
}

/** SHA-256 of the canonical JSON of the content: the digest a document carries and an import verifies. */
export function portableContentDigest(content: PortableWorkspaceExportContent): string {
  return createHash('sha256').update(canonicalPortableJson(content)).digest('hex')
}

export const iso = (value: Date) => value.toISOString()

export function bounded<T>(rows: readonly T[], family: string): readonly T[] {
  if (rows.length > PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS)
    throw new PortableExportError('too_large', `${family} exceeds the portable export bound`)
  return rows
}

export function byKey<T>(rows: readonly T[], key: (row: T) => string): T[] {
  return rows.toSorted((left, right) => {
    const a = key(left)
    const b = key(right)
    return a < b ? -1 : a > b ? 1 : 0
  })
}

export function participantKey(participant: PortableParticipant) {
  return participant.kind === 'user' ? `user:${participant.userId}` : `agent:${participant.agentId}`
}

export function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const row of rows) {
    const group = groups.get(key(row))
    if (group) group.push(row)
    else groups.set(key(row), [row])
  }
  return groups
}

export function toPortableParticipant(ref: ConversationParticipantRef): PortableParticipant {
  return ref.kind === 'user'
    ? { kind: 'user', userId: ref.userId }
    : { agentId: ref.agentId, kind: 'agent' }
}

export type ProjectRow = typeof projects.$inferSelect
export type MemberRow = typeof projectMembers.$inferSelect
export type TaskRow = typeof tasks.$inferSelect
export type ContentRefRow = typeof contentRefs.$inferSelect
export type AgentRow = typeof agents.$inferSelect
export type WorkspaceRow = typeof workspaces.$inferSelect

/**
 * What one reader produced, before the allowlist mapping. The requester path
 * fills it from the canonical readers; the complete path (used only to verify a
 * restore) fills it from every row of the workspace. Both feed one mapper, so
 * the two cannot drift apart in shape.
 */
export type ReadInputs = Readonly<{
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

export function mapPortableContent(
  input: ReadInputs,
  sizeEnvelope?: PortableExportEnvelope
): PortableWorkspaceExportContent {
  const projectIds = new Set(input.projectRows.map((row) => row.id))
  const taskIds = new Set(input.taskRows.map((row) => row.id))
  const channelIds = new Set(input.channels.map((channel) => channel.id))
  const agentIds = new Set(input.agentRows.map((row) => row.id))

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
  const sizeBudget = sizeEnvelope
    ? new PortableExportSizeBudget(portableWorkspace, sizeEnvelope)
    : undefined

  // A message whose body is a content ref the reader may not see is withheld
  // whole. Its links go with it, so nothing names a body that is not exported.
  const messageRows = input.messages.filter(
    (message) =>
      channelIds.has(message.channelId) &&
      (message.deleted ||
        !message.bodyContentRefId ||
        input.visibleContentRefIds.has(message.bodyContentRefId))
  )
  const messageIds = new Set(messageRows.map((message) => message.id))
  const messageChannel = new Map(messageRows.map((message) => [message.id, message.channelId]))

  const exportedProjects: PortableProject[] = byKey(
    mapWithBudget(
      input.projectRows,
      (row) => ({
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
      }),
      sizeBudget
    ),
    (row) => `${String(row.sortOrder).padStart(12, '0')}:${row.projectId}`
  )

  const exportedAgents: PortableAgent[] = byKey(
    mapWithBudget(
      input.agentRows,
      (row) => ({
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
      }),
      sizeBudget
    ),
    (row) => row.agentId
  )

  const exportedUsers: PortableUser[] = mapByKeyWithBudget(
    input.userRows,
    (row) => ({ displayName: row.displayName, userId: row.id }),
    (row) => row.userId,
    sizeBudget
  )

  const exportedChannels: PortableChannel[] = byKey(
    mapWithBudget(
      input.channels.filter((channel) => !channel.projectId || projectIds.has(channel.projectId)),
      (channel) => ({
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
      }),
      sizeBudget
    ),
    (row) => `${String(row.sortOrder).padStart(12, '0')}:${row.channelId}`
  )

  // Conversation order is explicit in the document. Messages sort by channel and then by the source
  // sequence, and channelOrder numbers each channel's messages from 1 in that order. Neither the
  // identifier nor the order of the input decides it.
  const orderedMessages = messageRows.toSorted(
    (left, right) =>
      (left.channelId < right.channelId ? -1 : left.channelId > right.channelId ? 1 : 0) ||
      left.sequence - right.sequence
  )
  let channelOrder = 0
  let channelOf: string | undefined
  const exportedMessages: PortableMessage[] = mapWithBudget(
    orderedMessages,
    (message): PortableMessage => {
      channelOrder = message.channelId === channelOf ? channelOrder + 1 : 1
      channelOf = message.channelId
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
        channelOrder,
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
    },
    sizeBudget
  )

  const exportedContentRefs: PortableContentRef[] = mapByKeyWithBudget(
    input.contentRefRows.filter((row) => input.visibleContentRefIds.has(row.id)),
    (row) => ({
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
    }),
    (row) => row.contentRefId,
    sizeBudget
  )

  const exportedTasks: PortableTask[] = mapByKeyWithBudget(
    input.taskRows,
    (row) => ({
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
    }),
    (row) => `${row.createdAt}:${row.taskId}`,
    sizeBudget
  )

  const exportedDependencies = mapByKeyWithBudget(
    input.dependencyRows.filter(
      (row) => taskIds.has(row.taskId) && taskIds.has(row.dependsOnTaskId)
    ),
    (row) => ({ dependsOnTaskId: row.dependsOnTaskId, taskId: row.taskId }),
    (row) => `${row.taskId}>${row.dependsOnTaskId}`,
    sizeBudget
  )

  // Cloud-location attempts only. Runtime-location attempts carry node bindings
  // and are excluded by the ledger.
  const exportedAttempts: PortableExecutionAttempt[] = mapByKeyWithBudget(
    input.attemptRows.filter(
      (row) => taskIds.has(row.taskId) && row.locationKind === 'agent_hq_cloud'
    ),
    (row) => ({
      attempt: row.attempt,
      change: row.change,
      createdAt: iso(row.createdAt),
      locationKind: 'agent_hq_cloud',
      taskId: row.taskId,
    }),
    (row) => `${row.taskId}#${String(row.attempt).padStart(12, '0')}`,
    sizeBudget
  )

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
  envelope: PortableExportEnvelope
): PortableWorkspaceExport {
  const exportedAt = iso(envelope.exportedAt)
  const size = portableJsonUtf8ByteLength({
    content,
    contentDigest: { algorithm: 'sha256', value: '0'.repeat(64) },
    exclusions: PORTABLE_WORKSPACE_EXPORT_EXCLUSIONS,
    exportedAt,
    exportedBy: envelope.exportedBy,
    format: PORTABLE_WORKSPACE_EXPORT_FORMAT,
    formatVersion: PORTABLE_WORKSPACE_EXPORT_FORMAT_VERSION,
  })
  if (size > PORTABLE_WORKSPACE_EXPORT_MAX_BYTES)
    throw new PortableExportError('too_large', 'portable export exceeds the byte bound')

  const document: PortableWorkspaceExport = {
    content,
    contentDigest: { algorithm: 'sha256', value: portableContentDigest(content) },
    exclusions: PORTABLE_WORKSPACE_EXPORT_EXCLUSIONS,
    exportedAt,
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
