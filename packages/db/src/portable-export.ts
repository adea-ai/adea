// Authorized portable workspace export: the readers (M18.02.2, #1226).
//
// The export is the requester's own view of one workspace, read inside a READ COMMITTED,
// READ ONLY transaction. The requester's access is checked when the export starts, before
// every message page, and after the last read (`assertAccess` and `assertStanding`), so a
// revocation committed mid-export denies it. A principal with no current membership, a
// removed membership, or a deleted or being-deleted workspace all fail with the same
// "Workspace unavailable" error, so an export never reveals that the workspace exists. A
// hidden project is not an error; its records are simply absent.
//
// Visibility is the product's own current read authorization, not a copy of it. Channels
// and messages come from `listChannelsForUser` and `listMessagesForUser`, the readers the
// workspace API serves, so whatever gate those readers apply reaches the export. Content
// refs go through `isContentRefVisible`, and tasks and projects use the project predicate
// the product list readers use. The mapping to the document lives in
// `portable-export-content.ts`.

import {
  PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS,
  type ChannelSummary,
  type ConversationParticipantRef,
  type MessageSummary,
  type PortableWorkspaceExport,
  type PortableWorkspaceExportContent,
  type UserPrincipalRef,
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
import {
  buildPortableWorkspaceExport,
  bounded,
  groupBy,
  iso,
  mapPortableContent,
  PortableExportError,
  type ReadInputs,
  type WorkspaceRow,
} from './portable-export-content'

/** Messages are read through the canonical reader in pages of this size; the reader's own limit is 100. */
const MESSAGE_PAGE = 100

/**
 * Test seam. `beforeMessagePage` runs before each message page is read, so a test can pause
 * an export between pages and change authority before the next page. `beforeStep` runs before
 * the tasks are read, before the content references are checked, and before the final access
 * check, so a test can pause an export between those reads and before its last check. Production
 * callers pass no hooks.
 */
export type PortableExportHooks = Readonly<{
  beforeMessagePage?: (
    page: Readonly<{ afterSequence: number | undefined; channelId: string }>
  ) => void | Promise<void>
  beforeStep?: (step: Readonly<{ name: 'contentRefs' | 'final' | 'tasks' }>) => void | Promise<void>
}>

/**
 * READ COMMITTED, so each statement sees the commits made before it. Under REPEATABLE READ the
 * snapshot is fixed at the first statement, and a revocation committed mid-export would be
 * invisible to every later check. The families are therefore not one point-in-time snapshot;
 * the requester's access is checked before every message page and after the last read instead.
 *
 * READ WRITE, and it writes nothing. The canonical authority readers (#1237) take share row locks
 * (`FOR SHARE`) on the artifact and grant rows they depend on, and Postgres refuses row locks in
 * a READ ONLY transaction. The export holds those share locks until it commits or rolls back.
 * A revocation takes its grant row `FOR UPDATE`, so it waits for an export that holds the share
 * lock. An export that reads a grant before a revocation commits is therefore ordered before that
 * revocation, and a revocation committed before the read is observed and withholds the record. A
 * later export sees every revocation committed before it starts. A lock wait can delay the export
 * or the revocation; it cannot produce a partial document. A deadlock fails the export with its
 * own error and returns no document.
 */
export const PORTABLE_EXPORT_TRANSACTION_CONFIG = Object.freeze({
  accessMode: 'read write',
  isolationLevel: 'read committed',
} as const)

/** The requester's access to the workspace: role, workspace row and the projects they can read. */
type Access = Readonly<{
  projectIds: ReadonlySet<string>
  scope: ProjectAccessScope
  workspace: WorkspaceRow
}>

/** The requester's access when the export began, and the channels the canonical reader served them. */
type Standing = Access & Readonly<{ channelIds: ReadonlySet<string> }>

/** The requester's access now, or null when it is gone. */
async function accessNow(
  transaction: AgentHqTransaction,
  workspaceId: string,
  principal: UserPrincipalRef
): Promise<Access | null> {
  const scope = await resolveProjectAccessScope(transaction, workspaceId, principal.userId)
  if (!scope) return null
  const [workspace] = await transaction
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1)
  if (!workspace || workspace.deletedAt || workspace.deletionRequestedAt) return null
  const projectRows = await transaction
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.workspaceId, workspaceId),
        eq(projects.lifecycleState, 'active'),
        isNull(projects.deletedAt),
        visibleProjectCondition(projects.id, scope)
      )
    )
    .limit(PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS + 1)
  return {
    projectIds: new Set(bounded(projectRows, 'projects').map((row) => row.id)),
    scope,
    workspace,
  }
}

/** The ids of the channels the canonical reader serves the requester now. */
async function channelIdsNow(
  transaction: AgentHqTransaction,
  workspaceId: string,
  principal: UserPrincipalRef
): Promise<Set<string>> {
  const channelRows = await listChannelsForUser(transaction, workspaceId, principal)
  return new Set(channelRows.map((channel) => channel.id))
}

function containsAll(current: ReadonlySet<string>, required: ReadonlySet<string>): boolean {
  for (const id of required) if (!current.has(id)) return false
  return true
}

/**
 * Throws `denied` unless the requester still has the access the export started with: the same
 * role, and every project they could read. The check reads committed state, so a revocation
 * committed before it is observed.
 */
async function assertAccess(
  transaction: AgentHqTransaction,
  workspaceId: string,
  principal: UserPrincipalRef,
  start: Access
): Promise<void> {
  const now = await accessNow(transaction, workspaceId, principal)
  if (!now || now.scope.role !== start.scope.role || !containsAll(now.projectIds, start.projectIds))
    throw new PortableExportError('denied', 'Workspace unavailable')
}

/** `assertAccess`, and every channel the canonical reader served at the start is still served. */
async function assertStanding(
  transaction: AgentHqTransaction,
  workspaceId: string,
  principal: UserPrincipalRef,
  start: Standing
): Promise<void> {
  await assertAccess(transaction, workspaceId, principal, start)
  const channelIds = await channelIdsNow(transaction, workspaceId, principal)
  if (!containsAll(channelIds, start.channelIds))
    throw new PortableExportError('denied', 'Workspace unavailable')
}

/**
 * Every message the principal can read, through the canonical reader, channel by channel and
 * page by page. Before each page the access the export started with is checked again, after
 * the test seam. A reader that refuses mid-page is a denial when the standing has gone, and
 * its own error otherwise.
 */
async function readVisibleMessages(
  transaction: AgentHqTransaction,
  workspaceId: string,
  principal: UserPrincipalRef,
  channels: readonly ChannelSummary[],
  start: Standing,
  hooks: PortableExportHooks | undefined
): Promise<MessageSummary[]> {
  const messages: MessageSummary[] = []
  for (const channel of channels) {
    let afterSequence: number | undefined
    for (;;) {
      await hooks?.beforeMessagePage?.({ afterSequence, channelId: channel.id })
      await assertAccess(transaction, workspaceId, principal, start)
      const page = await listMessagesForUser(transaction, workspaceId, channel.id, principal, {
        afterSequence,
        limit: MESSAGE_PAGE,
      }).catch(async (error: unknown) => {
        await assertStanding(transaction, workspaceId, principal, start)
        throw error
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
  principal: UserPrincipalRef,
  start: Standing,
  hooks: PortableExportHooks | undefined
): Promise<ReadInputs> {
  const { scope, workspace } = start
  const workspaceId = workspace.id
  const projectRows = bounded(
    await transaction
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.workspaceId, workspaceId),
          eq(projects.lifecycleState, 'active'),
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
  const messages = await readVisibleMessages(
    transaction,
    workspaceId,
    principal,
    channels,
    start,
    hooks
  )

  await hooks?.beforeStep?.({ name: 'tasks' })
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
  await hooks?.beforeStep?.({ name: 'contentRefs' })
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
 * membership. The requester's access is checked when the export starts, before every
 * message page, and after the last read: a revocation committed before any of those
 * checks denies the export, and no partial document is returned.
 */
export async function exportPortableWorkspace(
  database: AgentHqDatabase,
  input: Readonly<{
    exportedAt?: Date
    hooks?: PortableExportHooks
    principal: UserPrincipalRef
    workspaceId: string
  }>
): Promise<PortableWorkspaceExport> {
  return database.transaction(async (transaction) => {
    const access = await accessNow(transaction, input.workspaceId, input.principal)
    if (!access) throw new PortableExportError('denied', 'Workspace unavailable')
    const start: Standing = {
      ...access,
      channelIds: await channelIdsNow(transaction, input.workspaceId, input.principal),
    }
    const inputs = await readRequesterInputs(transaction, input.principal, start, input.hooks)
    // The families above are read statement by statement, so a revocation can land between
    // them. Checking once more after the last read denies the export before anything is built.
    await input.hooks?.beforeStep?.({ name: 'final' })
    await assertStanding(transaction, input.workspaceId, input.principal, start)
    return buildPortableWorkspaceExport(mapPortableContent(inputs), {
      exportedAt: input.exportedAt ?? new Date(),
      exportedBy: { role: start.scope.role, userId: start.scope.userId },
    })
  }, PORTABLE_EXPORT_TRANSACTION_CONFIG)
}
