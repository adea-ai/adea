// Workspace settings › Memory: the pure model behind the pane (ADR 0012).
// Validation mirrors the desktop store's bounds; refusals arrive from the
// shell as stable codes and map to copy here, so the pane never shows a raw
// error string and never echoes entry text into an error.
import {
  workspaceMemoryLimits,
  type WorkspaceMemoryEntry,
  type WorkspaceMemorySnapshot,
} from '@adea-ai/types'

export const MEMORY_ENTRY_MAX_CHARS = workspaceMemoryLimits.entryMaxChars

export const memoryErrorCodes = [
  'memory_workspace_unauthorized',
  'memory_invalid_input',
  'memory_not_found',
  'memory_stale_revision',
  'memory_limit_exceeded',
  'memory_invalid_state',
  'memory_unavailable',
  /** The shell fenced the workspace because its device cleanup is prepared. */
  'workspace_cleanup_pending',
] as const

export type MemoryErrorCode = (typeof memoryErrorCodes)[number]

/** The typed code behind a refused memory command; unknown failures read as
 *  `memory_unavailable`. */
export function memoryErrorCode(error: unknown): MemoryErrorCode {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return (memoryErrorCodes as readonly string[]).includes(message)
    ? (message as MemoryErrorCode)
    : 'memory_unavailable'
}

const errorCopy: Readonly<Record<MemoryErrorCode, string>> = {
  memory_workspace_unauthorized:
    'Memory is available for the workspace Adea Desktop is signed in to. Switch to it on this device to manage its memory.',
  memory_invalid_input: `Memory notes need between 1 and ${String(MEMORY_ENTRY_MAX_CHARS)} characters.`,
  memory_not_found: 'That memory note no longer exists. The list has been refreshed.',
  memory_stale_revision: 'That memory note changed elsewhere. The list has been refreshed.',
  memory_limit_exceeded: 'This workspace holds the maximum number of memory notes.',
  memory_invalid_state: 'That proposal was already handled. The list has been refreshed.',
  memory_unavailable: 'Memory could not be read on this device.',
  workspace_cleanup_pending:
    'This workspace is being removed from this device, so memory is paused. Nothing was changed.',
}

export function memoryErrorMessage(code: MemoryErrorCode): string {
  return errorCopy[code]
}

/** Codes after which the pane re-reads the store rather than keep stale rows. */
export function memoryErrorNeedsRefresh(code: MemoryErrorCode): boolean {
  return (
    code === 'memory_not_found' ||
    code === 'memory_stale_revision' ||
    code === 'memory_invalid_state'
  )
}

export const MEMORY_UNAVAILABLE_COPY =
  'Memory is stored on your desktop. Open Adea Desktop to manage it.'

/** A draft's validation message, or undefined when it can be saved. */
export function memoryDraftError(text: string): string | undefined {
  const trimmed = text.trim()
  if (trimmed.length === 0) return 'Write a note before saving.'
  if (trimmed.length > MEMORY_ENTRY_MAX_CHARS) {
    return `Notes are at most ${String(MEMORY_ENTRY_MAX_CHARS)} characters.`
  }
  return undefined
}

export type MemoryView = Readonly<{
  /** Accepted memory, newest first: what launches inject. */
  active: readonly WorkspaceMemoryEntry[]
  /** Agent proposals awaiting Accept/Reject, newest first. */
  pending: readonly WorkspaceMemoryEntry[]
  injectionEnabled: boolean
  unreadable: number
}>

function newestFirst(left: WorkspaceMemoryEntry, right: WorkspaceMemoryEntry): number {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1
  return left.id < right.id ? 1 : left.id > right.id ? -1 : 0
}

/** Partitions a snapshot, dropping anything that names another workspace. */
export function memoryView(snapshot: WorkspaceMemorySnapshot, workspaceId: string): MemoryView {
  const own = snapshot.entries.filter((entry) => entry.workspaceId === workspaceId)
  return {
    active: own.filter((entry) => entry.status === 'active').toSorted(newestFirst),
    pending: own.filter((entry) => entry.status === 'pending').toSorted(newestFirst),
    injectionEnabled: snapshot.injectionEnabled,
    unreadable: snapshot.unreadable,
  }
}

export function memorySourceLabel(entry: WorkspaceMemoryEntry): string {
  return entry.source === 'agent' ? 'Agent' : 'You'
}

function shortId(id: string): string {
  return id.slice(0, 8)
}

/**
 * Where an entry came from, in words, or undefined for a note you wrote. Only
 * what the desktop store recorded is stated: an agent entry from before runs
 * were recorded says so instead of guessing a session.
 */
export function memoryOriginDetail(entry: WorkspaceMemoryEntry): string | undefined {
  const { origin } = entry
  if (origin.kind === 'user') return undefined
  if (origin.provenance === 'unknown') {
    return 'Origin not recorded (added before agent runs were tracked)'
  }
  const harness = origin.harnessId
    ? origin.harnessId.charAt(0).toUpperCase() + origin.harnessId.slice(1)
    : 'an agent'
  return `Proposed by ${harness} in session ${shortId(origin.runtimeSessionId)} (run ${shortId(origin.runId)})`
}

/** A short, locale-formatted date for an entry row. */
export function memoryDateLabel(iso: string, locale?: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' })
}
