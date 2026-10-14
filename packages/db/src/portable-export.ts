// Authorized portable workspace export: the readers (M18.02.2, #1226).
//
// The export is the requester's own view of one workspace. Short READ COMMITTED checks
// surround coherent canonical page snapshots; a final snapshot reproves retained authority and
// record bindings. The requester's access is checked when the export starts, before
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
  type PortableWorkspaceExport,
  type PortableWorkspaceExportContent,
} from '@adea-ai/types/portable-export'
import type {
  ChannelSummary,
  ConversationParticipantRef,
  MessageSummary,
  UserPrincipalRef,
} from '@adea-ai/types'
import { and, asc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import {
  PORTABLE_EXPORT_TRANSACTION_CONFIG,
  PORTABLE_EXPORT_PROOF_TRANSACTION_CONFIG,
} from './portable-export-transaction'
import {
  CHANNEL_SUMMARY_PAGE_SIZE,
  ChannelParticipantOverflowError,
  groupParticipantsInForce,
  listChannelIdsForUser,
  listChannelsForUserPage,
  listMessagesForUserForPortableExport,
  readMessagesForUserIdsForPortableExport,
  type ChannelPageCursor,
} from './conversations'
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
const TASK_TEXT_FIELDS_JSON_OVERHEAD_BYTES =
  portableJsonUtf8ByteLength({ objective: '', title: '' }) - 4

type ExportReadBudget = { bytes: number }

function accountExportLowerBound(budget: ExportReadBudget, value: unknown): void {
  budget.bytes += portableJsonUtf8ByteLength(value)
  if (budget.bytes > PORTABLE_WORKSPACE_EXPORT_MAX_BYTES)
    throw new PortableExportError('too_large', 'portable export exceeds the byte bound')
}

/**
 * Test seam. `beforeMessagePage` and `beforeTaskPage` run before each page is read, so a test can
 * pause an export between channel/message/task pages and change authority before the next page.
 * `beforeStep` runs before projects, tasks and content references are read, and before the final
 * access check, so a test can pause an export between those reads and before its last check.
 * Production callers pass no hooks.
 */
export type PortableExportHooks = Readonly<{
  afterChannelPage?: (
    page: Readonly<{
      channelIds: readonly string[]
      participantRowsMaterialized: number
    }>
  ) => void | Promise<void>
  afterAgentPage?: (
    page: Readonly<{ nameJsonBytes: number; roleSummaryJsonBytes: number }>
  ) => void | Promise<void>
  afterMessagePage?: (
    page: Readonly<{
      bodyTextByteBudget: number
      bodyTextJsonBytes: number
      withheldBodyTextRows: number
    }>
  ) => void | Promise<void>
  afterMessageProofPage?: (
    page: Readonly<{
      bodyTextByteBudget: number
      bodyTextJsonBytes: number
      messageCount: number
      withheldBodyTextRows: number
    }>
  ) => void | Promise<void>
  afterTaskPage?: (
    page: Readonly<{
      objectiveJsonBytes: number
      textByteBudget: number
      titleJsonBytes: number
      withheldRows: number
    }>
  ) => void | Promise<void>
  beforeChannelPage?: (
    page: Readonly<{ afterChannelId: string | undefined }>
  ) => void | Promise<void>
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

type Database = AgentHqDatabase | AgentHqTransaction

/** Short orchestration reads release their connection before hooks or canonical page snapshots. */
async function readExportRows<T>(
  database: Database,
  operation: (transaction: AgentHqTransaction) => Promise<T>
): Promise<T> {
  if ('rollback' in database) return operation(database)
  return database.transaction(operation, PORTABLE_EXPORT_TRANSACTION_CONFIG)
}

/** The requester's access now, or null when it is gone. */
async function accessNow(
  transaction: Database,
  workspaceId: string,
  principal: UserPrincipalRef
): Promise<Access | null> {
  if (!('rollback' in transaction))
    return readExportRows(transaction, (snapshot) => accessNow(snapshot, workspaceId, principal))
  const scope = await resolveProjectAccessScope(transaction, workspaceId, principal.userId)
  if (!scope) return null
  const [workspace] = await readExportRows(transaction, (readTransaction) =>
    readTransaction.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
  )
  if (!workspace || workspace.deletedAt || workspace.deletionRequestedAt) return null
  const projectRows = await readExportRows(transaction, (readTransaction) =>
    readTransaction
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
  )
  return {
    projectIds: new Set(bounded(projectRows, 'projects').map((row) => row.id)),
    scope,
    workspace,
  }
}

/** The ids of the channels the canonical reader serves the requester now. */
async function channelIdsNow(
  transaction: Database,
  workspaceId: string,
  principal: UserPrincipalRef
): Promise<Set<string>> {
  try {
    return new Set(
      bounded(await listChannelIdsForUser(transaction, workspaceId, principal), 'channels')
    )
  } catch (error) {
    if (error instanceof ChannelParticipantOverflowError)
      throw new PortableExportError('too_large', 'channel standing exceeds the portable bound')
    if (error instanceof Error && error.message === 'Channel unavailable')
      throw new PortableExportError('denied', 'Workspace unavailable')
    throw error
  }
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
  transaction: Database,
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
  transaction: Database,
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
  transaction: Database,
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
      const page = await listMessagesForUserForPortableExport(
        transaction,
        workspaceId,
        channel.id,
        principal,
        {
          afterSequence,
          authorizationRecordLimit: PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS,
          bodyTextByteBudget: Math.max(0, PORTABLE_WORKSPACE_EXPORT_MAX_BYTES - budget.bytes),
          limit: MESSAGE_PAGE,
        }
      ).catch(async (error: unknown) => {
        await assertStanding(transaction, workspaceId, principal, start)
        if (error instanceof ChannelParticipantOverflowError)
          throw new PortableExportError(
            'too_large',
            'group authorization records exceed the portable bound'
          )
        throw error
      })
      await hooks?.afterMessagePage?.({
        bodyTextByteBudget: page.bodyTextByteBudget,
        bodyTextJsonBytes: page.bodyTextJsonBytes,
        withheldBodyTextRows: page.bodyTextWithheldRows,
      })
      if (!page.bodyTextWithinByteBudget)
        throw new PortableExportError('too_large', 'portable export exceeds the byte bound')
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
  transaction: Database,
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
    await readExportRows(transaction, (readTransaction) =>
      readTransaction
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
        .limit(PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS + 1)
    ),
    'projects'
  )
  const projectIds = new Set(projectRows.map((row) => row.id))
  const readBudget: ExportReadBudget = { bytes: 0 }

  const channels: ChannelSummary[] = []
  const capturedChannelIds = [...start.channelIds].toSorted()
  let afterChannel: ChannelPageCursor | undefined
  for (let offset = 0; offset < capturedChannelIds.length;) {
    const candidateChannelIds = capturedChannelIds.slice(offset, offset + CHANNEL_SUMMARY_PAGE_SIZE)
    for (;;) {
      await hooks?.beforeChannelPage?.({ afterChannelId: afterChannel?.id })
      await assertAccess(transaction, workspaceId, principal, start)
      const page = await listChannelsForUserPage(transaction, workspaceId, principal, {
        after: afterChannel,
        channelIds: candidateChannelIds,
        limit: candidateChannelIds.length,
      }).catch(async (error: unknown) => {
        await assertStanding(transaction, workspaceId, principal, start)
        if (error instanceof ChannelParticipantOverflowError)
          throw new PortableExportError(
            'too_large',
            'channel participants exceed the portable bound'
          )
        throw error
      })
      await hooks?.afterChannelPage?.({
        channelIds: page.channels.map(({ id }) => id),
        participantRowsMaterialized: page.participantRowsMaterialized,
      })
      for (const channel of page.channels) {
        if (channel.projectId && !projectIds.has(channel.projectId)) continue
        // Channel id, title, timestamps and all participants are guaranteed in the output.
        // Check this lower bound before retaining another page of summaries.
        accountExportLowerBound(readBudget, {
          channelId: channel.id,
          createdAt: channel.createdAt,
          participants: channel.participants,
          title: channel.title,
          updatedAt: channel.updatedAt,
        })
        channels.push(channel)
        bounded(channels, 'channels')
      }
      if (!page.nextAfter) break
      afterChannel = page.nextAfter
    }
    afterChannel = { id: candidateChannelIds.at(-1)! }
    offset += candidateChannelIds.length
  }
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
    const textByteBudget = Math.max(0, PORTABLE_WORKSPACE_EXPORT_MAX_BYTES - readBudget.bytes)
    // Count the same compact JSON lower bound as the Worker, using SQL's UTF-8 byte
    // lengths and JSON scalar escaping before either unbounded text column is returned.
    const cumulativeTaskTextBytes = sql`
      sum(
        coalesce(octet_length(to_json(${tasks.objective})::text), 4)
          + octet_length(to_json(${tasks.title})::text)
          + ${TASK_TEXT_FIELDS_JSON_OVERHEAD_BYTES}
      ) over (
        order by ${tasks.id}
        rows between unbounded preceding and current row
      )
    `
    const withinByteBound = sql<boolean>`${cumulativeTaskTextBytes} <= ${textByteBudget}`
    const page = await readExportRows(transaction, (readTransaction) =>
      readTransaction
        .select({
          agentId: tasks.agentId,
          channelId: tasks.channelId,
          createdAt: tasks.createdAt,
          creatorUserId: tasks.creatorUserId,
          id: tasks.id,
          kind: tasks.kind,
          lifecycleState: tasks.lifecycleState,
          messageId: tasks.messageId,
          objective: sql<
            string | null
          >`case when ${withinByteBound} then ${tasks.objective} else null end`,
          objectiveContentRefId: tasks.objectiveContentRefId,
          priority: tasks.priority,
          projectId: tasks.projectId,
          threadRootMessageId: tasks.threadRootMessageId,
          title: sql<string>`case when ${withinByteBound} then ${tasks.title} else null end`,
          updatedAt: tasks.updatedAt,
          version: tasks.version,
          withinByteBound,
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
    )

    const projectedRows = page.filter((row) => row.withinByteBound)
    await hooks?.afterTaskPage?.({
      objectiveJsonBytes: projectedRows.reduce(
        (total, row) => total + portableJsonUtf8ByteLength(row.objective),
        0
      ),
      textByteBudget,
      titleJsonBytes: projectedRows.reduce(
        (total, row) => total + portableJsonUtf8ByteLength(row.title),
        0
      ),
      withheldRows: page.length - projectedRows.length,
    })
    for (const row of page) {
      // Objective and title are always included by the mapper. Their encoded JSON
      // bytes are a lower bound for this task's final contribution, so reject as
      // soon as the accumulated task text alone cannot fit in the portable bundle.
      const { withinByteBound: taskWithinByteBound, ...task } = row
      if (!taskWithinByteBound)
        throw new PortableExportError('too_large', 'portable export exceeds the byte bound')
      accountExportLowerBound(readBudget, {
        objective: task.objective,
        title: task.title,
      })
      taskRows.push(task)
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
    if (
      await readExportRows(transaction, (snapshot) =>
        isContentRefVisible(snapshot, workspaceId, principal.userId, id)
      )
    )
      visibleContentRefIds.add(id)
  const contentRefRows = visibleContentRefIds.size
    ? await readExportRows(transaction, (readTransaction) =>
        readTransaction
          .select()
          .from(contentRefs)
          .where(
            and(
              eq(contentRefs.workspaceId, workspaceId),
              inArray(contentRefs.id, [...visibleContentRefIds])
            )
          )
          .limit(PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS + 1)
      )
    : []
  bounded(contentRefRows, 'content refs')

  return finishInputs(
    transaction,
    workspace,
    {
      channels,
      contentRefRows,
      messages,
      projectRows,
      taskRows,
      readBudget,
      visibleContentRefIds,
    },
    hooks
  )
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
    await readExportRows(transaction, (readTransaction) =>
      readTransaction
        .select()
        .from(projects)
        .where(and(eq(projects.workspaceId, workspaceId), isNull(projects.deletedAt)))
        .orderBy(asc(projects.sortOrder), asc(projects.id))
        .limit(PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS + 1)
    ),
    'projects'
  )
  const projectIds = new Set(projectRows.map((row) => row.id))
  const channelRows = bounded(
    await readExportRows(transaction, (readTransaction) =>
      readTransaction
        .select()
        .from(channelTable)
        .where(eq(channelTable.workspaceId, workspaceId))
        .orderBy(asc(channelTable.sortOrder), asc(channelTable.id))
        .limit(PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS + 1)
    ),
    'channels'
  ).filter((row) => !row.projectId || projectIds.has(row.projectId))
  const channelIds = channelRows.map((row) => row.id)
  const participantRows = channelIds.length
    ? await readExportRows(transaction, (readTransaction) =>
        readTransaction
          .select()
          .from(channelParticipants)
          .where(
            and(
              eq(channelParticipants.workspaceId, workspaceId),
              inArray(channelParticipants.channelId, channelIds)
            )
          )
          .limit(PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS + 1)
      )
    : []
  bounded(participantRows, 'channel participants')
  const participantsByChannel = groupBy(participantRows, (row) => row.channelId)
  // A group's audience is its admissions in force, the rule the product reader applies, not the
  // legacy participant rows. Reading it here makes a restore verify the admissions it wrote.
  const groupParticipants = new Map<string, ConversationParticipantRef[]>()
  for (const row of channelRows)
    if (row.kind === 'group')
      groupParticipants.set(
        row.id,
        await groupParticipantsInForce(transaction, row, {
          authorizationRecordLimit: PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS,
        }).catch(rethrowOverflowAsTooLarge)
      )
  const channelSummaries: ChannelSummary[] = channelRows.map((row) => ({
    ...(row.agentId ? { agentId: row.agentId } : {}),
    createdAt: iso(row.createdAt),
    id: row.id,
    isPrimaryProjectChannel: row.isPrimaryProjectChannel,
    kind: row.kind,
    lifecycleState: row.lifecycleState,
    participants:
      row.kind === 'group'
        ? (groupParticipants.get(row.id) ?? [])
        : (participantsByChannel.get(row.id) ?? []).flatMap(
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
    ? await readExportRows(transaction, (readTransaction) =>
        readTransaction
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
      )
    : []
  bounded(messageRows, 'messages')
  const mentionRows = messageRows.length
    ? await readExportRows(transaction, (readTransaction) =>
        readTransaction
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
      )
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
    await readExportRows(transaction, (readTransaction) =>
      readTransaction
        .select()
        .from(tasks)
        .where(eq(tasks.workspaceId, workspaceId))
        .orderBy(asc(tasks.createdAt), asc(tasks.id))
        .limit(PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS + 1)
    ),
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
    ? await readExportRows(transaction, (readTransaction) =>
        readTransaction
          .select()
          .from(contentRefs)
          .where(
            and(eq(contentRefs.workspaceId, workspaceId), inArray(contentRefs.id, candidateRefIds))
          )
          .limit(PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS + 1)
      )
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
  transaction: Database,
  workspace: WorkspaceRow,
  partial: Pick<
    ReadInputs,
    'channels' | 'contentRefRows' | 'messages' | 'projectRows' | 'taskRows' | 'visibleContentRefIds'
  > &
    Readonly<{ readBudget: ExportReadBudget }>,
  hooks?: PortableExportHooks
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
    ? await readExportRows(transaction, (readTransaction) =>
        readTransaction
          .select()
          .from(projectMembers)
          .where(
            and(
              eq(projectMembers.workspaceId, workspaceId),
              inArray(projectMembers.projectId, projectIds)
            )
          )
          .limit(PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS + 1)
      )
    : []
  bounded(memberRows, 'project members')
  for (const member of memberRows) userIds.add(member.userId)

  const agentRows: AgentRow[] = []
  const referencedAgentIds = [...agentIds]
  for (let offset = 0; offset < referencedAgentIds.length; offset += REFERENCE_PAGE) {
    const remainingBytes = Math.max(
      0,
      PORTABLE_WORKSPACE_EXPORT_MAX_BYTES - partial.readBudget.bytes
    )
    // Names and role summaries are plain text and have no column-level size
    // limit. Bound their cumulative raw UTF-8 size in SQL before transferring
    // those values to the Worker. The exact JSON size is still accounted below.
    const cumulativeTextBytes = sql`
      sum(
        octet_length(${agents.name}) + coalesce(octet_length(${agents.roleSummary}), 0)
      ) over (order by ${agents.id} rows between unbounded preceding and current row)
    `
    const page = await readExportRows(transaction, (readTransaction) =>
      readTransaction
        .select({
          createdAt: agents.createdAt,
          id: agents.id,
          isWorkspaceLead: agents.isWorkspaceLead,
          lifecycleState: agents.lifecycleState,
          name: sql<
            string | null
          >`case when ${cumulativeTextBytes} <= ${remainingBytes} then ${agents.name} else null end`,
          profileId: agents.profileId,
          profileRevision: agents.profileRevision,
          profileState: agents.profileState,
          profileVersion: agents.profileVersion,
          projectId: agents.projectId,
          revision: agents.revision,
          roleSummary: sql<
            string | null
          >`case when ${cumulativeTextBytes} <= ${remainingBytes} then ${agents.roleSummary} else null end`,
          updatedAt: agents.updatedAt,
          withinByteBound: sql<boolean>`${cumulativeTextBytes} <= ${remainingBytes}`,
        })
        .from(agents)
        .where(
          and(
            eq(agents.workspaceId, workspaceId),
            inArray(agents.id, referencedAgentIds.slice(offset, offset + REFERENCE_PAGE))
          )
        )
        .orderBy(asc(agents.id))
        .limit(PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS + 1)
    )

    if (hooks?.afterAgentPage)
      await hooks.afterAgentPage({
        nameJsonBytes: page.reduce(
          (total, row) => total + portableJsonUtf8ByteLength(row.name ?? ''),
          0
        ),
        roleSummaryJsonBytes: page.reduce(
          (total, row) => total + portableJsonUtf8ByteLength(row.roleSummary ?? ''),
          0
        ),
      })

    for (const row of page) {
      // Keep each agent row complete: if SQL withheld either text field because
      // the remaining byte budget was exceeded, refuse the export before retaining it.
      const { withinByteBound, ...agent } = row
      if (!withinByteBound || agent.name === null)
        throw new PortableExportError('too_large', 'portable export exceeds the byte bound')
      accountExportLowerBound(partial.readBudget, {
        name: agent.name,
        roleSummary: agent.roleSummary,
      })
      agentRows.push({ ...agent, name: agent.name })
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
    const page = await readExportRows(transaction, (readTransaction) =>
      readTransaction
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
    )
    for (const row of page) {
      if (!row.withinByteBound)
        throw new PortableExportError('too_large', 'portable export exceeds the byte bound')
      accountExportLowerBound(partial.readBudget, { displayName: row.displayName })
      userRows.push(row)
      bounded(userRows, 'users')
    }
  }

  const dependencyRows = taskIds.length
    ? await readExportRows(transaction, (readTransaction) =>
        readTransaction
          .select()
          .from(taskDependencies)
          .where(
            and(
              eq(taskDependencies.workspaceId, workspaceId),
              inArray(taskDependencies.taskId, taskIds)
            )
          )
          .limit(PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS + 1)
      )
    : []
  bounded(dependencyRows, 'task dependencies')
  const attemptRows = taskIds.length
    ? await readExportRows(transaction, (readTransaction) =>
        readTransaction
          .select()
          .from(taskExecutionAttempts)
          .where(
            and(
              eq(taskExecutionAttempts.workspaceId, workspaceId),
              inArray(taskExecutionAttempts.taskId, taskIds)
            )
          )
          .limit(PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS + 1)
      )
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
  const [workspace] = await readExportRows(transaction, (readTransaction) =>
    readTransaction.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
  )
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
  const access = await accessNow(database, input.workspaceId, input.principal)
  if (!access) throw new PortableExportError('denied', 'Workspace unavailable')
  const start: Standing = {
    ...access,
    channelIds: await channelIdsNow(database, input.workspaceId, input.principal),
  }
  const inputs = await readRequesterInputs(database, input.principal, start, input.hooks)
  await input.hooks?.beforeStep?.({ name: 'final' })
  return database.transaction(async (snapshot) => {
    await assertStanding(snapshot, input.workspaceId, input.principal, start)
    try {
      await proveRetainedRecords(snapshot, input.workspaceId, input.principal, inputs, input.hooks)
    } catch (error) {
      if (
        error instanceof Error &&
        ['Workspace unavailable', 'Channel unavailable', 'Message unavailable'].includes(
          error.message
        )
      )
        denyRetainedExport()
      throw error
    }
    const envelope = {
      exportedAt: input.exportedAt ?? new Date(),
      exportedBy: { role: start.scope.role, userId: start.scope.userId },
    }
    return buildPortableWorkspaceExport(mapPortableContent(inputs, envelope), envelope)
  }, PORTABLE_EXPORT_PROOF_TRANSACTION_CONFIG)
}

/** The final proof refuses an oversized group the way the page reads do, never as a raw error. */
function rethrowOverflowAsTooLarge(error: unknown): never {
  if (error instanceof ChannelParticipantOverflowError)
    throw new PortableExportError(
      'too_large',
      'group authorization records exceed the portable bound'
    )
  throw error
}

/** No buffered record is emitted solely on the authority of an earlier page snapshot. */
async function proveRetainedRecords(
  snapshot: AgentHqTransaction,
  workspaceId: string,
  principal: UserPrincipalRef,
  inputs: ReadInputs,
  hooks?: PortableExportHooks
): Promise<void> {
  const expectedChannels = new Map(inputs.channels.map((channel) => [channel.id, channel]))
  const channelIds = [...expectedChannels.keys()].toSorted()
  for (let offset = 0; offset < channelIds.length; offset += CHANNEL_SUMMARY_PAGE_SIZE) {
    const ids = channelIds.slice(offset, offset + CHANNEL_SUMMARY_PAGE_SIZE)
    let after: ChannelPageCursor | undefined
    const proved = new Set<string>()
    for (;;) {
      const page = await listChannelsForUserPage(snapshot, workspaceId, principal, {
        channelIds: ids,
        limit: ids.length,
        after,
      }).catch(rethrowOverflowAsTooLarge)
      for (const channel of page.channels) {
        if (JSON.stringify(channel) !== JSON.stringify(expectedChannels.get(channel.id)))
          denyRetainedExport()
        proved.add(channel.id)
      }
      if (!page.nextAfter) break
      after = page.nextAfter
    }
    if (proved.size !== ids.length) denyRetainedExport()
  }
  const retainedMessages = inputs.messages.filter(
    (message) =>
      message.deleted ||
      !message.bodyContentRefId ||
      inputs.visibleContentRefIds.has(message.bodyContentRefId)
  )
  // Reassignment or a version change can withdraw a task without changing the
  // workspace's visible-project set. Reprove fixed-size identity fields, not
  // potentially oversized objectives/titles that have already been read.
  for (let offset = 0; offset < inputs.taskRows.length; offset += REFERENCE_PAGE) {
    const expected = inputs.taskRows.slice(offset, offset + REFERENCE_PAGE)
    const current = await snapshot
      .select({
        id: tasks.id,
        version: tasks.version,
        projectId: tasks.projectId,
        objectiveContentRefId: tasks.objectiveContentRefId,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.workspaceId, workspaceId),
          inArray(
            tasks.id,
            expected.map((row) => row.id)
          )
        )
      )
      .limit(expected.length)
    const byId = new Map(current.map((row) => [row.id, row]))
    for (const task of expected) {
      const row = byId.get(task.id)
      if (
        !row ||
        row.version !== task.version ||
        row.projectId !== task.projectId ||
        row.objectiveContentRefId !== task.objectiveContentRefId
      )
        denyRetainedExport()
    }
  }
  const byChannel = groupBy(retainedMessages, (message) => message.channelId)
  const provedMessages = new Set<string>()
  let remainingMessageBodyTextBytes = retainedMessages.reduce(
    (total, message) =>
      message.deleted || message.bodyContentRefId
        ? total
        : total + portableJsonUtf8ByteLength(message.bodyText ?? ''),
    0
  )
  for (const [channelId, messages] of byChannel) {
    for (let offset = 0; offset < messages.length; offset += MESSAGE_PAGE) {
      const expected = messages.slice(offset, offset + MESSAGE_PAGE)
      const page = await readMessagesForUserIdsForPortableExport(
        snapshot,
        workspaceId,
        channelId,
        principal,
        expected.map((message) => message.id),
        {
          authorizationRecordLimit: PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS,
          bodyTextByteBudget: remainingMessageBodyTextBytes,
        }
      ).catch(rethrowOverflowAsTooLarge)
      await hooks?.afterMessageProofPage?.({
        bodyTextByteBudget: page.bodyTextByteBudget,
        bodyTextJsonBytes: page.bodyTextJsonBytes,
        messageCount: page.messages.length,
        withheldBodyTextRows: page.bodyTextWithheldRows,
      })
      if (!page.bodyTextWithinByteBudget) denyRetainedExport()
      remainingMessageBodyTextBytes -= page.bodyTextJsonBytes
      const current = page.messages
      const byId = new Map(current.map((message) => [message.id, message]))
      for (const message of expected) {
        if (JSON.stringify(message) !== JSON.stringify(byId.get(message.id))) denyRetainedExport()
        provedMessages.add(message.id)
      }
    }
  }
  for (const ref of inputs.contentRefRows) {
    if (!inputs.visibleContentRefIds.has(ref.id)) continue
    if (ref.messageId && !provedMessages.has(ref.messageId)) denyRetainedExport()
    if (!(await isContentRefVisible(snapshot, workspaceId, principal.userId, ref.id)))
      denyRetainedExport()
    const [current] = await snapshot
      .select({
        revision: contentRefs.revision,
        messageId: contentRefs.messageId,
        taskId: contentRefs.taskId,
      })
      .from(contentRefs)
      .where(and(eq(contentRefs.workspaceId, workspaceId), eq(contentRefs.id, ref.id)))
      .limit(1)
    if (
      !current ||
      current.revision !== ref.revision ||
      current.messageId !== ref.messageId ||
      current.taskId !== ref.taskId
    )
      denyRetainedExport()
  }
}

function denyRetainedExport(): never {
  throw new PortableExportError('denied', 'Workspace unavailable')
}
