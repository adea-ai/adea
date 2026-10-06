/*
 * Per-viewer conveniences the source control app keeps in browser storage,
 * scoped to the runtime scope: the selected project, the details panel's
 * open state per tab, the remembered merge method, the diff layout, viewed
 * files, and review drafts. Review comments stay local until Submit review,
 * so a reload must not lose them. Every read decodes strictly and falls back
 * to the default; every write tolerates a full or unavailable store.
 */
import type { GitHubMergeMethod, Scope } from '@adea-ai/types/dev-runtime'

export type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export type PrTab = 'conversation' | 'commits' | 'checks' | 'files'

export type Selection =
  | Readonly<{ kind: 'project'; repoId: string; projectId: string }>
  | Readonly<{ kind: 'shortcut'; id: 'needs_you' | 'ready' }>

export type AppPreferences = Readonly<{
  selection?: Selection
  details: Readonly<Record<PrTab, boolean>>
  mergeMethod?: GitHubMergeMethod
  diffLayout: 'unified' | 'split'
  deleteBranch: boolean
  /**
   * Repositories collapsed below the sidebar's show-more line. Hiding is a
   * display preference, never an unlink: hidden repositories stay adopted
   * and registered, remain reachable from the collapsed group, and every
   * newly adopted repository is visible by default (auto-adopt lands above
   * the line). The row order of the drag-bar this models is an upstream
   * shared-UI seam; v1 ships explicit hide/show controls.
   */
  hiddenRepoIds: readonly string[]
}>

export const defaultPreferences: AppPreferences = {
  details: { conversation: true, commits: false, checks: false, files: false },
  diffLayout: 'unified',
  deleteBranch: true,
  hiddenRepoIds: [],
}

export type PendingComment = Readonly<{
  id: string
  path: string
  line: number
  side: 'left' | 'right'
  startLine?: number
  body: string
}>

export type ReviewDraft = Readonly<{
  headSha: string
  body: string
  verdict: 'comment' | 'approve' | 'request_changes'
  comments: readonly PendingComment[]
}>

export type ViewedFiles = Readonly<{ headSha: string; paths: readonly string[] }>

const PREFIX = 'adea:source-control:v1'

function scopeKey(scope: Scope): string {
  return `${scope.accountId}:${scope.workspaceId}:${scope.runtimeNodeId}`
}

function read(storage: KeyValueStorage | undefined, key: string): unknown {
  if (!storage) return undefined
  try {
    const raw = storage.getItem(key)
    return raw === null ? undefined : (JSON.parse(raw) as unknown)
  } catch {
    return undefined
  }
}

function write(storage: KeyValueStorage | undefined, key: string, value: unknown): void {
  if (!storage) return
  try {
    if (value === undefined) storage.removeItem(key)
    else storage.setItem(key, JSON.stringify(value))
  } catch {
    // A full or unavailable store keeps the in-memory value.
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isString = (value: unknown, max = 512): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max
const isMethod = (value: unknown): value is GitHubMergeMethod =>
  value === 'merge' || value === 'squash' || value === 'rebase'

export function decodePreferences(value: unknown): AppPreferences {
  if (!isRecord(value)) return defaultPreferences
  let selection: Selection | undefined
  const raw = value.selection
  if (isRecord(raw)) {
    if (raw.kind === 'project' && isString(raw.repoId) && isString(raw.projectId))
      selection = { kind: 'project', repoId: raw.repoId, projectId: raw.projectId }
    else if (raw.kind === 'shortcut' && (raw.id === 'needs_you' || raw.id === 'ready'))
      selection = { kind: 'shortcut', id: raw.id }
  }
  const details = { ...defaultPreferences.details }
  if (isRecord(value.details))
    for (const tab of Object.keys(details) as PrTab[])
      if (typeof value.details[tab] === 'boolean') details[tab] = value.details[tab] as boolean
  // A bounded set of repo ids; anything unreadable falls back to the default
  // (visible) rather than guessing.
  const hiddenRepoIds: string[] = []
  if (Array.isArray(value.hiddenRepoIds))
    for (const entry of value.hiddenRepoIds) {
      if (typeof entry === 'string' && isString(entry, 128)) hiddenRepoIds.push(entry)
      if (hiddenRepoIds.length >= 512) break
    }
  return {
    ...(selection ? { selection } : {}),
    details,
    ...(isMethod(value.mergeMethod) ? { mergeMethod: value.mergeMethod } : {}),
    diffLayout: value.diffLayout === 'split' ? 'split' : 'unified',
    deleteBranch: value.deleteBranch !== false,
    hiddenRepoIds,
  }
}

const MAX_COMMENTS = 100

export function decodeDraft(value: unknown): ReviewDraft | undefined {
  if (!isRecord(value) || !isString(value.headSha, 64) || typeof value.body !== 'string')
    return undefined
  const verdict =
    value.verdict === 'approve' || value.verdict === 'request_changes' ? value.verdict : 'comment'
  const comments: PendingComment[] = []
  if (Array.isArray(value.comments))
    for (const entry of value.comments.slice(0, MAX_COMMENTS)) {
      if (
        !isRecord(entry) ||
        !isString(entry.id, 64) ||
        !isString(entry.path, 1024) ||
        !Number.isSafeInteger(entry.line) ||
        (entry.line as number) < 1 ||
        (entry.side !== 'left' && entry.side !== 'right') ||
        typeof entry.body !== 'string'
      )
        continue
      const startLine =
        Number.isSafeInteger(entry.startLine) &&
        (entry.startLine as number) < (entry.line as number)
          ? (entry.startLine as number)
          : undefined
      comments.push({
        id: entry.id,
        path: entry.path,
        line: entry.line as number,
        side: entry.side,
        ...(startLine !== undefined ? { startLine } : {}),
        body: entry.body.slice(0, 65_536),
      })
    }
  return { headSha: value.headSha, body: value.body.slice(0, 65_536), verdict, comments }
}

export function createAppStorage(storage: KeyValueStorage | undefined, scope: Scope) {
  const base = `${PREFIX}:${scopeKey(scope)}`
  return {
    loadPreferences: (): AppPreferences => decodePreferences(read(storage, `${base}:prefs`)),
    savePreferences: (value: AppPreferences) => write(storage, `${base}:prefs`, value),
    loadDraft: (pullRequestId: string): ReviewDraft | undefined =>
      decodeDraft(read(storage, `${base}:draft:${pullRequestId}`)),
    saveDraft: (pullRequestId: string, draft: ReviewDraft | undefined) =>
      write(
        storage,
        `${base}:draft:${pullRequestId}`,
        draft && (draft.comments.length > 0 || draft.body.length > 0) ? draft : undefined
      ),
    loadViewed: (pullRequestId: string, headSha: string): ReadonlySet<string> => {
      const value = read(storage, `${base}:viewed:${pullRequestId}`)
      // Viewed marks belong to one head: a new push resets them.
      if (!isRecord(value) || value.headSha !== headSha || !Array.isArray(value.paths))
        return new Set()
      return new Set(value.paths.filter((path): path is string => isString(path, 1024)))
    },
    saveViewed: (pullRequestId: string, headSha: string, paths: ReadonlySet<string>) =>
      write(storage, `${base}:viewed:${pullRequestId}`, { headSha, paths: [...paths] }),
  }
}

export type AppStorage = ReturnType<typeof createAppStorage>
