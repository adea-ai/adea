import type { DevOperation } from '@adea-ai/types/dev-runtime'

/**
 * Pure model for the provider-backed archive shelf (Dev Runtime spec:
 * `dev.session.archive`/`dev.session.unarchive` produce the `ArchiveRecord`
 * journal; archived sessions leave the active list and appear here). Restore
 * rides the real `dev.session.unarchive` contract. Deletion is destructive
 * and has **no** M12 host contract: the shelf keeps the confirmation gate but
 * the commit reports the missing `dev.session.delete` operation as an
 * explicit handoff instead of inventing a client-side workaround.
 */
export type ArchivedSessionSummary = Readonly<{
  id: string
  projectId: string
  title: string
  archivedAt: string
  /** Current session generation for resource-bound restore commands. */
  generation?: number
}>

export type ArchiveShelfState = Readonly<{
  status: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'
  items: readonly ArchivedSessionSummary[]
  /** The session awaiting destructive confirmation, if any. */
  pendingDeleteId?: string
  reason?: string
}>

/**
 * The future host contract name for durable session deletion. It is absent
 * from the M12 operation registry on purpose: the UI treats its absence as a
 * typed handoff, never as a silent success.
 */
export const SESSION_DELETE_OPERATION = 'dev.session.delete' as DevOperation

export function sessionDeleteContractAvailable(
  definitions: Readonly<Record<string, unknown>>
): boolean {
  return SESSION_DELETE_OPERATION in definitions
}

export function beginArchiveShelfLoad(): ArchiveShelfState {
  return { status: 'loading', items: [] }
}

export function archiveShelfReady(items: readonly ArchivedSessionSummary[]): ArchiveShelfState {
  return { status: 'ready', items }
}

export function archiveShelfUnavailable(reason: string): ArchiveShelfState {
  return { status: 'unavailable', reason, items: [] }
}

export function archiveShelfError(reason: string, previous: ArchiveShelfState): ArchiveShelfState {
  // Provider loss keeps recoverable data mounted; the state names the error.
  return { ...previous, status: 'error', reason }
}

export function restoreCompleted(
  state: ArchiveShelfState,
  runtimeSessionId: string
): ArchiveShelfState {
  if (!state.items.some((item) => item.id === runtimeSessionId)) return state
  return {
    ...state,
    items: state.items.filter((item) => item.id !== runtimeSessionId),
    pendingDeleteId: undefined,
  }
}

export function requestDelete(
  state: ArchiveShelfState,
  runtimeSessionId: string
): ArchiveShelfState {
  return { ...state, pendingDeleteId: runtimeSessionId }
}

export function cancelPendingDelete(state: ArchiveShelfState): ArchiveShelfState {
  return state.pendingDeleteId === undefined ? state : { ...state, pendingDeleteId: undefined }
}

export function confirmPendingDelete(state: ArchiveShelfState): {
  state: ArchiveShelfState
  commitId?: string
} {
  if (state.pendingDeleteId === undefined) return { state }
  const commitId = state.pendingDeleteId
  return { state: { ...state, pendingDeleteId: undefined }, commitId }
}
