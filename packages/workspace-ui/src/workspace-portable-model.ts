import { ApiClientError } from '@adea-ai/api-client'

/**
 * The largest portable bundle the API reads or emits. Mirrors the server bound
 * (`PORTABLE_WORKSPACE_EXPORT_MAX_BYTES`); the server repeats the check, so this only saves a
 * round trip for a file that cannot be restored.
 */
export const PORTABLE_MAX_BYTES = 8 * 1024 * 1024

const PORTABLE_FORMAT = 'adea.portable-workspace-export'

/** What a chosen export file says about itself, read without trusting it: the server validates. */
export type PortableFileSummary = Readonly<{
  counts: Readonly<{
    agents: number
    channels: number
    messages: number
    projects: number
    tasks: number
  }>
  exportedAt: string | undefined
  exportedBy: string | undefined
  workspaceName: string
}>

export type PortableFileReading =
  | Readonly<{ ok: true; summary: PortableFileSummary; text: string }>
  | Readonly<{ ok: false; reason: 'invalid' | 'too_large' }>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const countOf = (content: Record<string, unknown>, key: string) => {
  const value = content[key]
  return Array.isArray(value) ? value.length : 0
}

/**
 * Reads the summary the restore confirmation shows. A file that is not a version 1 Adea
 * workspace export, or that carries no workspace name, is `invalid` here; anything subtler (a
 * changed digest, an unknown person) is the server's call.
 */
export function readPortableFile(text: string, byteLength: number): PortableFileReading {
  if (byteLength > PORTABLE_MAX_BYTES) return { ok: false, reason: 'too_large' }
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  if (!isRecord(document) || document.format !== PORTABLE_FORMAT || document.formatVersion !== 1)
    return { ok: false, reason: 'invalid' }
  const { content } = document
  if (!isRecord(content) || !isRecord(content.workspace)) return { ok: false, reason: 'invalid' }
  const { name } = content.workspace
  if (typeof name !== 'string' || name.trim() === '') return { ok: false, reason: 'invalid' }
  const exporter = isRecord(document.exportedBy) ? document.exportedBy.userId : undefined
  const person = Array.isArray(content.users)
    ? content.users.find((user) => isRecord(user) && user.userId === exporter)
    : undefined
  const displayName = isRecord(person) ? person.displayName : undefined
  return {
    ok: true,
    summary: {
      counts: {
        agents: countOf(content, 'agents'),
        channels: countOf(content, 'channels'),
        messages: countOf(content, 'messages'),
        projects: countOf(content, 'projects'),
        tasks: countOf(content, 'tasks'),
      },
      exportedAt: typeof document.exportedAt === 'string' ? document.exportedAt : undefined,
      exportedBy: typeof displayName === 'string' && displayName !== '' ? displayName : undefined,
      workspaceName: name,
    },
    text,
  }
}

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`

/** The count badges the restore confirmation and result show, in a fixed order. */
export function portableCountLabels(counts: PortableFileSummary['counts']): readonly string[] {
  return [
    plural(counts.projects, 'project'),
    plural(counts.channels, 'conversation'),
    plural(counts.messages, 'message'),
    plural(counts.tasks, 'task'),
    plural(counts.agents, 'agent'),
  ]
}

export function formatPortableBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** "Oct 12, 2026" for the file line; undefined when the file carries no usable date. */
export function formatPortableDate(value: string | undefined): string | undefined {
  if (!value) return undefined
  const time = Date.parse(value)
  if (Number.isNaN(time)) return undefined
  return new Date(time).toLocaleDateString('en-US', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
    year: 'numeric',
  })
}

/** The line under the chosen file: size, then who exported it and when, as far as the file says. */
export function describePortableFile(summary: PortableFileSummary, bytes: number): string {
  const exported = formatPortableDate(summary.exportedAt)
  const parts = [formatPortableBytes(bytes)]
  if (exported)
    parts.push(`exported ${exported}${summary.exportedBy ? ` by ${summary.exportedBy}` : ''}`)
  return parts.join(' · ')
}

/** Records in an export: every content row except the workspace itself and the people list. */
export function countPortableRecords(text: string): number | undefined {
  try {
    const document: unknown = JSON.parse(text)
    if (!isRecord(document) || !isRecord(document.content)) return undefined
    return Object.entries(document.content).reduce(
      (total, [key, value]) =>
        key !== 'users' && Array.isArray(value) ? total + value.length : total,
      0
    )
  } catch {
    return undefined
  }
}

const code = (failure: unknown) => (failure instanceof ApiClientError ? failure.code : undefined)

export type PortableFailure = Readonly<{
  /** Trying again cannot help, so the action that failed stays disabled. */
  final?: true
  message: string
  tone: 'destructive' | 'warning'
}>

/** Export refusals the server names; anything else is a plain retry. */
export function exportFailure(failure: unknown): PortableFailure {
  switch (code(failure)) {
    case 'too_large':
      return {
        message:
          'This workspace is over the export limit of 10,000 records or 8 MB, so nothing was downloaded. Archive or trim old conversations and try again.',
        tone: 'warning',
      }
    case 'workspace_unavailable':
      return {
        message:
          'This workspace is unavailable. It may have been archived or removed, or you no longer have access to it.',
        final: true,
        tone: 'destructive',
      }
    default:
      return { message: 'The export could not be prepared. Try again.', tone: 'destructive' }
  }
}

/** Restore refusals the server names; anything else is a plain retry. */
export function restoreFailure(failure: unknown): PortableFailure {
  switch (code(failure)) {
    case 'invalid_document':
      return {
        message: 'This file isn’t a valid Adea workspace export. Choose a file exported from Adea.',
        tone: 'destructive',
      }
    case 'digest_mismatch':
      return {
        message:
          'This file has changed since it was exported, so it can’t be trusted. Export it again from the original workspace.',
        tone: 'destructive',
      }
    case 'unresolved_users':
      return {
        message:
          'Some people in this export don’t have accounts here yet. Ask them to sign in once, then try again.',
        tone: 'destructive',
      }
    case 'target_exists':
      return {
        message:
          'This workspace already exists here, so it can’t be restored over. Nothing was changed.',
        tone: 'warning',
      }
    case 'too_large':
      return {
        message: 'This file is over the restore limit of 10,000 records or 8 MB.',
        tone: 'warning',
      }
    case 'importer_unavailable':
    case 'workspace_unavailable':
      return {
        message: 'You can’t create workspaces right now, so nothing was restored.',
        tone: 'destructive',
      }
    case 'verification_failed':
      return {
        message:
          'The restore couldn’t be verified, so nothing was kept. Try again; if it keeps failing, export the workspace again.',
        tone: 'destructive',
      }
    default:
      return { message: 'The workspace could not be restored. Try again.', tone: 'destructive' }
  }
}

/** Saves text as a file through the browser's download path. */
export function savePortableFile(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  try {
    const link = document.createElement('a')
    link.href = url
    link.download = fileName
    document.body.append(link)
    link.click()
    link.remove()
  } finally {
    // The click has queued the download; revoking on the next turn lets it start first.
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}

/** Why a chosen file never reached the server. */
export type RejectedFileReason = 'invalid' | 'too_large' | 'unreadable'

/** The refusal shown for a file that was chosen but never sent. */
export function rejectedFileFailure(reason: RejectedFileReason): PortableFailure {
  if (reason === 'unreadable')
    return {
      message:
        'This file couldn’t be read. Check that it still exists and isn’t open elsewhere, then choose it again.',
      tone: 'destructive',
    }
  return restoreFailure(
    new ApiClientError('', 0, reason === 'too_large' ? 'too_large' : 'invalid_document')
  )
}

/** Shown when the restore worked but the new workspace could not be opened yet. */
export const OPEN_RESTORED_FAILURE: PortableFailure = {
  message:
    'The workspace was restored, but it couldn’t be opened yet. It will appear in your workspace list once the list reloads; try Open workspace again.',
  tone: 'warning',
}
