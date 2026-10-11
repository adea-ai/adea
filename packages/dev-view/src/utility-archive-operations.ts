import type { Scope } from '@adea-ai/types/dev-runtime'
import {
  devOperationMetadataFor_dev_session_get,
  devOperationMetadataFor_dev_session_list,
  devOperationMetadataFor_dev_session_unarchive,
} from '@adea-ai/types/dev-runtime-operation-metadata'

import { buildDevCommandFromMetadata, type BoundDevOperationMetadata } from './browser/command-core'
import { DevUtilityContextChangedError, type DevUtilityFence } from './utility-context'
import type { ArchivedSessionSummary } from './sidebar/archive-shelf-model'

export type ArchiveOperationFence = Readonly<{
  fence: DevUtilityFence
  /** Owner-maintained request/disposal revision, checked at every await boundary. */
  isOwnerCurrent(): boolean
}>

const ARCHIVE_SHELF_PAGE_SIZE = 500
const ARCHIVE_SHELF_PAGE_LIMIT = 20

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function matchesArchiveScope(value: unknown, expected: Scope): boolean {
  return (
    isRecord(value) &&
    value.accountId === expected.accountId &&
    value.workspaceId === expected.workspaceId &&
    value.runtimeNodeId === expected.runtimeNodeId
  )
}

function assertCurrent(operation: ArchiveOperationFence): void {
  if (!operation.fence.context.scope || !operation.isOwnerCurrent() || !operation.fence.isCurrent())
    throw new DevUtilityContextChangedError()
}

async function executeArchiveOperation<T>(
  operation: ArchiveOperationFence,
  metadata: BoundDevOperationMetadata,
  body: Record<string, unknown>,
  resource?: { kind: string; id: string; generation: number }
): Promise<T> {
  assertCurrent(operation)
  const fence = operation.fence
  const reply = await fence.context.runtime.execute(
    buildDevCommandFromMetadata(metadata, {
      scope: fence.context.scope!,
      body,
      ...(resource ? { resource } : {}),
    })
  )
  assertCurrent(operation)
  if (!reply.ok) throw reply
  return reply.value as T
}

function runtimeSessionFromArchiveRow(
  value: unknown,
  expectedScope: Scope
): ArchivedSessionSummary | undefined {
  if (!isRecord(value) || value.archived !== true) return undefined
  if (
    typeof value.id !== 'string' ||
    !value.id ||
    typeof value.projectId !== 'string' ||
    !value.projectId ||
    typeof value.generation !== 'number' ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    !isRecord(value.scope) ||
    !matchesArchiveScope(value.scope, expectedScope)
  )
    return undefined
  return {
    id: value.id,
    projectId: value.projectId,
    title:
      typeof value.displayName === 'string' && value.displayName ? value.displayName : value.id,
    archivedAt: typeof value.archivedAt === 'string' ? value.archivedAt : 'legacy',
    generation: value.generation,
  }
}

/** Lists a complete scope-matched shelf; partial pages are never returned. */
export async function listArchivedSessions(
  operation: ArchiveOperationFence
): Promise<readonly ArchivedSessionSummary[]> {
  assertCurrent(operation)
  const scope = operation.fence.context.scope!
  const items: ArchivedSessionSummary[] = []
  const seenCursors = new Set<string>()
  let cursor: string | undefined
  let pageCount = 0

  while (true) {
    const page = await executeArchiveOperation<unknown>(
      operation,
      devOperationMetadataFor_dev_session_list,
      {
        archived: true,
        limit: ARCHIVE_SHELF_PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      }
    )
    assertCurrent(operation)
    pageCount += 1
    if (!isRecord(page) || !Array.isArray(page.items))
      throw new Error('The runtime returned an invalid archived-session page.')
    for (const item of page.items) {
      const parsed = runtimeSessionFromArchiveRow(item, scope)
      if (!parsed)
        throw new Error(
          'The runtime returned an archived session with invalid or mismatched scope.'
        )
      items.push(parsed)
    }
    const nextCursor = page.nextCursor
    if (nextCursor === undefined) break
    if (typeof nextCursor !== 'string' || nextCursor.length === 0)
      throw new Error('The runtime returned an invalid archived-session cursor.')
    if (seenCursors.has(nextCursor))
      throw new Error('The runtime returned a repeated archived-session cursor.')
    seenCursors.add(nextCursor)
    if (pageCount >= ARCHIVE_SHELF_PAGE_LIMIT)
      throw new Error(
        `The archived-session list reached the ${ARCHIVE_SHELF_PAGE_LIMIT}-page limit and may be incomplete.`
      )
    cursor = nextCursor
  }

  assertCurrent(operation)
  return items
}

/** Revalidates the selected archive and its generation before confirming restore. */
export async function restoreArchivedSession(
  operation: ArchiveOperationFence,
  archived: ArchivedSessionSummary
): Promise<void> {
  assertCurrent(operation)
  if (!Number.isSafeInteger(archived.generation) || archived.generation! < 1)
    throw new Error(
      'Restore failed: the session generation is unavailable; refresh Archived sessions.'
    )

  const runtimeSessionId = archived.id
  const generation = archived.generation!
  const scope = operation.fence.context.scope!
  const session = await executeArchiveOperation<unknown>(
    operation,
    devOperationMetadataFor_dev_session_get,
    { runtimeSessionId },
    { kind: 'runtime_session', id: runtimeSessionId, generation }
  )
  if (
    !isRecord(session) ||
    session.id !== runtimeSessionId ||
    session.projectId !== archived.projectId ||
    typeof session.worktreeId !== 'string' ||
    session.worktreeId.length === 0 ||
    session.archived !== true ||
    session.generation !== generation ||
    !isRecord(session.scope) ||
    !matchesArchiveScope(session.scope, scope)
  )
    throw new Error('The archived session changed. Refresh Archived sessions and try again.')

  const restored = await executeArchiveOperation<unknown>(
    operation,
    devOperationMetadataFor_dev_session_unarchive,
    { runtimeSessionId, expectedGeneration: generation },
    { kind: 'runtime_session', id: runtimeSessionId, generation }
  )
  if (
    !isRecord(restored) ||
    restored.runtimeSessionId !== runtimeSessionId ||
    restored.worktreeId !== session.worktreeId ||
    restored.generation !== generation ||
    restored.state !== 'restored' ||
    !isRecord(restored.scope) ||
    !matchesArchiveScope(restored.scope, scope)
  )
    throw new Error('The runtime did not confirm that the archived session was restored.')
  assertCurrent(operation)
}
