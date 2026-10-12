// Authorized portable workspace export: the readers (M18.02.2, #1226).
//
// The export is the requester's own view of one workspace, read inside a READ COMMITTED,
// READ WRITE transaction. The requester's access is checked when the export starts, before
// every message and task page, and after the last read (`assertAccess` and `assertStanding`), so a
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
  PORTABLE_WORKSPACE_EXPORT_MAX_BYTES,
  PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS,
  portableJsonUtf8ByteLength,
  type ChannelSummary,
  type ConversationParticipantRef,
  type MessageSummary,
  type PortableWorkspaceExport,
  type PortableWorkspaceExportContent,
  type UserPrincipalRef,
} from '@adea-ai/types'
import { and, asc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { PORTABLE_EXPORT_TRANSACTION_CONFIG } from './portable-export-transaction'
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
  toPortableParticipant,
  type AgentRow,
  type ReadInputs,
  type TaskRow,
  type WorkspaceRow,
} from './portable-export-content'

/** Messages are read through the canonical reader in pages of this size; the reader's own limit is 100. */
const MESSAGE_PAGE = 100
const TASK_PAGE = 25
const REFERENCE_PAGE = 100

type ExportReadBudget = { bytes: number }

function accountExportLowerBound(budget: ExportReadBudget, value: unknown): void {
  budget.bytes += portableJsonUtf8ByteLength(value)
  if (budget.bytes > PORTABLE_WORKSPACE_EXPORT_MAX_BYTES)
    throw new PortableExportError('too_large', 'portable export exceeds the byte bound')
}

/**
 * Test seam. `beforeMessagePage` and `beforeTaskPage` run before each page is read, so a test can
 * pause an export between pages and change authority before the next page. `beforeStep` runs
 * before projects, tasks and content references are read, and before the final
 * access check, so a test can pause an export between those reads and before its last check.
 * Production callers pass no hooks.
 */
export type PortableExportHooks = Readonly<{
  beforeMessagePage?: (
    page: Readonly<{ afterSequence: number | undefined; channelId: string }>
  ) => void | Promise<void>
  beforeTaskPage?: (page: Readonly<{ afterId: string | undefined }>) => void | Promise<void>
  beforeStep?: (
    step: Readonly<{ name: 'contentRefs' | 'final' | 'projects' | 'tasks' }>
  ) => void | Promise<void>
}>

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
  hooks: PortableExportHooks | undefined,
  budget: ExportReadBudget
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
      for (const message of page.messages) {
        // Text bodies and mentions are guaranteed to remain in every exported
        // text/deleted message. Their encoded JSON is a lower bound for the final
        // document, so crossing the cap proves it cannot fit and lets us refuse
        // before reading another page. Content-ref messages may be withheld, so
        // they are counted later after their visibility is known.
        if (message.deleted || !message.bodyContentRefId) {
          if (!message.deleted) accountExportLowerBound(budget, message.bodyText ?? '')
          accountExportLowerBound(budget, message.mentions.map(toPortableParticipant))
        }
      }
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
  await hooks?.beforeStep?.({ name: 'projects' })
  const baselineProjectIds = [...start.projectIds]
  const baselineProjectCondition = baselineProjectIds.length
    ? inArray(projects.id, baselineProjectIds)
    : sql`false`
  const projectRows = bounded(
    await transaction
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.workspaceId, workspaceId),
          eq(projects.lifecycleState, 'active'),
          isNull(projects.deletedAt),
          baselineProjectCondition,
          visibleProjectCondition(projects.id, scope)
        )
      )
      .orderBy(asc(projects.sortOrder), asc(projects.id))
      .limit(PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS + 1),
    'projects'
  )
  const projectIds = new Set(projectRows.map((row) => row.id))
  const readBudget: ExportReadBudget = { bytes: 0 }

  const channels = (await listChannelsForUser(transaction, workspaceId, principal)).filter(
    (channel) =>
      start.channelIds.has(channel.id) && (!channel.projectId || projectIds.has(channel.projectId))
  )
  bounded(channels, 'channels')
  const messages = await readVisibleMessages(
    transaction,
    workspaceId,
    principal,
    channels,
    start,
    hooks,
    readBudget
  )

  await hooks?.beforeStep?.({ name: 'tasks' })
  const taskRows: TaskRow[] = []
  let afterId: string | undefined
  for (;;) {
    await hooks?.beforeTaskPage?.({ afterId })
    await assertAccess(transaction, workspaceId, principal, start)
    const projectCondition = projectIds.size
      ? or(isNull(tasks.projectId), inArray(tasks.projectId, [...projectIds]))
      : isNull(tasks.projectId)
    const afterCondition = afterId ? gt(tasks.id, afterId) : undefined
    const pageLimit = Math.min(
      TASK_PAGE,
      PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS + 1 - taskRows.length
    )
    const page = await transaction
      .select({
        agentId: tasks.agentId,
        channelId: tasks.channelId,
        createdAt: tasks.createdAt,
        creatorUserId: tasks.creatorUserId,
        id: tasks.id,
        kind: tasks.kind,
        lifecycleState: tasks.lifecycleState,
        messageId: tasks.messageId,
        objective: tasks.objective,
        objectiveContentRefId: tasks.objectiveContentRefId,
        priority: tasks.priority,
        projectId: tasks.projectId,
        threadRootMessageId: tasks.threadRootMessageId,
        title: tasks.title,
        updatedAt: tasks.updatedAt,
        version: tasks.version,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.workspaceId, workspaceId),
          visibleProjectCondition(tasks.projectId, scope),
          projectCondition,
          afterCondition
        )
      )
      .orderBy(asc(tasks.id))
      .limit(pageLimit)

    for (const row of page) {
      // Objective and title are always included by the mapper. Their encoded JSON
      // bytes are a lower bound for this task's final contribution, so reject as
      // soon as the accumulated tasks alone cannot fit in the portable bundle.
      accountExportLowerBound(readBudget, {
        objective: row.objective,
        title: row.title,
      })
      taskRows.push(row)
      bounded(taskRows, 'tasks')
    }
    if (page.length < pageLimit) break
    const last = page.at(-1)
    if (!last) break
    afterId = last.id
  }

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
    readBudget,
    visibleContentRefIds,
  })
}

/**
 * The complete view of a workspace, read without a principal. It exists only so
 * an import can verify restored workspace content and referenced user ids; the
 * importer normalizes destination display names to bundle snapshots for digest
 * verification. No request path reaches it.
 */
async function readCompleteInputs(
  transaction: AgentHqTransaction,
  workspace: WorkspaceRow
): Promise<ReadInputs> {
  const workspaceId = workspace.id
  const readBudget: ExportReadBudget = { bytes: 0 }
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
    readBudget,
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
  > &
    Readonly<{ readBudget: ExportReadBudget }>
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

  const agentRows: AgentRow[] = []
  const referencedAgentIds = [...agentIds]
  for (let offset = 0; offset < referencedAgentIds.length; offset += REFERENCE_PAGE) {
    const page = await transaction
      .select({
        createdAt: agents.createdAt,
        id: agents.id,
        isWorkspaceLead: agents.isWorkspaceLead,
        lifecycleState: agents.lifecycleState,
        name: agents.name,
        profileId: agents.profileId,
        profileRevision: agents.profileRevision,
        profileState: agents.profileState,
        profileVersion: agents.profileVersion,
        projectId: agents.projectId,
        revision: agents.revision,
        roleSummary: agents.roleSummary,
        updatedAt: agents.updatedAt,
      })
      .from(agents)
      .where(
        and(
          eq(agents.workspaceId, workspaceId),
          inArray(agents.id, referencedAgentIds.slice(offset, offset + REFERENCE_PAGE))
        )
      )
      .limit(PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS + 1)
    for (const row of page) {
      // The two potentially large agent strings are always exported. Check their
      // encoded lower bound before retaining another batch in memory.
      accountExportLowerBound(partial.readBudget, {
        name: row.name,
        roleSummary: row.roleSummary,
      })
      agentRows.push(row)
      bounded(agentRows, 'agents')
    }
  }
  const userRows: { displayName: string | null; id: string }[] = []
  const referencedUserIds = [...userIds]
  for (let offset = 0; offset < referencedUserIds.length; offset += REFERENCE_PAGE) {
    const remainingBytes = Math.max(
      0,
      PORTABLE_WORKSPACE_EXPORT_MAX_BYTES - partial.readBudget.bytes
    )
    // A user name can come from an external identity provider and is not bounded
    // by a local API field limit. Use SQL byte lengths and a cumulative JSON
    // lower bound to avoid transferring a page of oversized names into the Worker.
    const cumulativeLowerBound = sql`
      sum(
        case
          when ${users.displayName} is null then 20
          else octet_length(${users.displayName}) + 18
        end
      ) over (order by ${users.id} rows between unbounded preceding and current row)
    `
    const page = await transaction
      .select({
        displayName: sql<
          string | null
        >`case when ${cumulativeLowerBound} <= ${remainingBytes} then ${users.displayName} else null end`,
        id: users.id,
        withinByteBound: sql<boolean>`${cumulativeLowerBound} <= ${remainingBytes}`,
      })
      .from(users)
      .where(inArray(users.id, referencedUserIds.slice(offset, offset + REFERENCE_PAGE)))
      .orderBy(asc(users.id))
      .limit(PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS + 1)
    for (const row of page) {
      if (!row.withinByteBound)
        throw new PortableExportError('too_large', 'portable export exceeds the byte bound')
      accountExportLowerBound(partial.readBudget, { displayName: row.displayName })
      userRows.push(row)
      bounded(userRows, 'users')
    }
  }

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
    const envelope = {
      exportedAt: input.exportedAt ?? new Date(),
      exportedBy: { role: start.scope.role, userId: start.scope.userId },
    }
    return buildPortableWorkspaceExport(mapPortableContent(inputs, envelope), envelope)
  }, PORTABLE_EXPORT_TRANSACTION_CONFIG)
}
