import type { ContentRefSummary, UserPrincipalRef } from '@agent-hq/types'
import { and, eq, isNull, or } from 'drizzle-orm'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { contentRefs, workspaceMemberships } from './schema'

type Database = AgentHqDatabase | AgentHqTransaction
type ContentRefRow = typeof contentRefs.$inferSelect

export type ContentRefCreateInput = Readonly<{
  availability: Exclude<ContentRefSummary['availability'], 'deleted'>
  contentType: ContentRefSummary['contentType']
  digestSha256: string
  id: string
  keyVersion: number
  messageId?: string
  schemaVersion: number
  sensitivity: ContentRefSummary['sensitivity']
  storagePolicy: ContentRefSummary['storagePolicy']
  synchronizationPolicy: ContentRefSummary['synchronizationPolicy']
  taskId?: string
}>

export type ContentRefUpdateInput = Readonly<{
  availability: ContentRefSummary['availability']
  digestSha256: string
  expectedRevision: number
  keyVersion: number
  revision: number
}>

const digestPattern = /^[0-9a-f]{64}$/

async function requireMembership(
  database: Database,
  workspaceId: string,
  principal: UserPrincipalRef
) {
  const [membership] = await database
    .select({ id: workspaceMemberships.id })
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, principal.userId)
      )
    )
    .limit(1)
  if (!membership) throw new Error('Content unavailable')
}

function validateCreate(input: ContentRefCreateInput) {
  if (
    !digestPattern.test(input.digestSha256) ||
    !Number.isInteger(input.schemaVersion) ||
    input.schemaVersion < 1 ||
    !Number.isInteger(input.keyVersion) ||
    input.keyVersion < 1
  )
    throw new Error('Content metadata invalid')
  const taskContent = input.contentType === 'task_objective' || input.contentType === 'task_input'
  const messageContent = input.contentType === 'message_body'
  if (
    (taskContent && input.messageId !== undefined) ||
    (messageContent && input.taskId !== undefined)
  )
    throw new Error('Content metadata invalid')
}

function summarize(row: ContentRefRow): ContentRefSummary {
  return Object.freeze({
    availability: row.availability,
    contentType: row.contentType,
    createdAt: row.createdAt.toISOString(),
    ...(row.deletedAt ? { deletedAt: row.deletedAt.toISOString() } : {}),
    digestSha256: row.digestSha256,
    id: row.id,
    keyVersion: row.keyVersion,
    ...(row.messageId ? { messageId: row.messageId } : {}),
    revision: row.revision,
    schemaVersion: row.schemaVersion,
    sensitivity: row.sensitivity,
    storagePolicy: row.storagePolicy,
    synchronizationPolicy: row.synchronizationPolicy,
    ...(row.taskId ? { taskId: row.taskId } : {}),
    updatedAt: row.updatedAt.toISOString(),
    workspaceId: row.workspaceId,
  })
}

function matchesCreate(row: ContentRefRow, input: ContentRefCreateInput) {
  return (
    row.availability !== 'deleted' &&
    row.contentType === input.contentType &&
    row.digestSha256 === input.digestSha256 &&
    row.keyVersion === input.keyVersion &&
    (input.messageId === undefined || row.messageId === null || row.messageId === input.messageId) &&
    row.revision === 1 &&
    row.schemaVersion === input.schemaVersion &&
    row.sensitivity === input.sensitivity &&
    row.storagePolicy === input.storagePolicy &&
    row.synchronizationPolicy === input.synchronizationPolicy &&
    (input.taskId === undefined || row.taskId === null || row.taskId === input.taskId)
  )
}

async function selectContentRef(database: Database, workspaceId: string, contentId: string) {
  const [row] = await database
    .select()
    .from(contentRefs)
    .where(and(eq(contentRefs.id, contentId), eq(contentRefs.workspaceId, workspaceId)))
    .limit(1)
  return row
}

export async function createContentRef(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef,
  input: ContentRefCreateInput
): Promise<ContentRefSummary> {
  validateCreate(input)
  return database.transaction(async (transaction) => {
    await requireMembership(transaction, workspaceId, principal)
    const [created] = await transaction
      .insert(contentRefs)
      .values({ ...input, workspaceId })
      .onConflictDoNothing({ target: contentRefs.id })
      .returning()
    if (created) return summarize(created)
    const existing = await selectContentRef(transaction, workspaceId, input.id)
    if (!existing || !matchesCreate(existing, input)) throw new Error('Content metadata conflict')
    return summarize(existing)
  })
}

export async function getContentRefForUser(
  database: AgentHqDatabase,
  workspaceId: string,
  contentId: string,
  principal: UserPrincipalRef
): Promise<ContentRefSummary | null> {
  const [row] = await database
    .select({ contentRef: contentRefs })
    .from(contentRefs)
    .innerJoin(
      workspaceMemberships,
      and(
        eq(workspaceMemberships.workspaceId, contentRefs.workspaceId),
        eq(workspaceMemberships.userId, principal.userId)
      )
    )
    .where(and(eq(contentRefs.id, contentId), eq(contentRefs.workspaceId, workspaceId)))
    .limit(1)
  return row ? summarize(row.contentRef) : null
}

export async function updateContentRef(
  database: AgentHqDatabase,
  workspaceId: string,
  contentId: string,
  principal: UserPrincipalRef,
  input: ContentRefUpdateInput
): Promise<ContentRefSummary> {
  if (
    !digestPattern.test(input.digestSha256) ||
    !Number.isInteger(input.expectedRevision) ||
    input.expectedRevision < 1 ||
    !Number.isInteger(input.keyVersion) ||
    input.keyVersion < 1 ||
    !Number.isInteger(input.revision) ||
    input.revision < input.expectedRevision ||
    input.revision > input.expectedRevision + 1
  )
    throw new Error('Content metadata invalid')
  return database.transaction(async (transaction) => {
    await requireMembership(transaction, workspaceId, principal)
    const nextRevision = input.revision
    const now = new Date()
    const [updated] = await transaction
      .update(contentRefs)
      .set({
        availability: input.availability,
        deletedAt: input.availability === 'deleted' ? now : null,
        digestSha256: input.digestSha256,
        keyVersion: input.keyVersion,
        revision: nextRevision,
        updatedAt: now,
      })
      .where(
        and(
          eq(contentRefs.id, contentId),
          eq(contentRefs.workspaceId, workspaceId),
          eq(contentRefs.revision, input.expectedRevision)
        )
      )
      .returning()
    if (updated) return summarize(updated)
    const existing = await selectContentRef(transaction, workspaceId, contentId)
    if (
      existing?.revision === nextRevision &&
      existing.availability === input.availability &&
      existing.digestSha256 === input.digestSha256 &&
      existing.keyVersion === input.keyVersion
    )
      return summarize(existing)
    if (!existing) throw new Error('Content unavailable')
    throw new Error('Content metadata version conflict')
  })
}

async function attach(
  transaction: AgentHqTransaction,
  workspaceId: string,
  contentId: string,
  association: Readonly<{ messageId?: string; taskId?: string }>,
  expectedType: ContentRefSummary['contentType']
) {
  const [updated] = await transaction
    .update(contentRefs)
    .set({ ...association, updatedAt: new Date() })
    .where(
      and(
        eq(contentRefs.id, contentId),
        eq(contentRefs.workspaceId, workspaceId),
        eq(contentRefs.contentType, expectedType),
        ...(association.messageId
          ? [or(isNull(contentRefs.messageId), eq(contentRefs.messageId, association.messageId))!]
          : []),
        ...(association.taskId
          ? [or(isNull(contentRefs.taskId), eq(contentRefs.taskId, association.taskId))!]
          : [])
      )
    )
    .returning({ id: contentRefs.id })
  if (!updated) throw new Error('Content unavailable')
}

export const attachTaskContentRef = (
  transaction: AgentHqTransaction,
  workspaceId: string,
  contentId: string,
  taskId: string,
  expectedType: 'task_objective' | 'task_input'
) => attach(transaction, workspaceId, contentId, { taskId }, expectedType)

export const attachMessageContentRef = (
  transaction: AgentHqTransaction,
  workspaceId: string,
  contentId: string,
  messageId: string
) => attach(transaction, workspaceId, contentId, { messageId }, 'message_body')
