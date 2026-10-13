/**
 * One-shot deep-link search parameters. A surface consumes them exactly once
 * (channel/message/thread/task selection, workspace scoping); they must never
 * ride along into another app's search or be restored by a late completion.
 *
 * The navigation-race regression in `apps/web/test/workspace-search.test.ts`
 * pins the hazard: @tanstack/solid-router replaces the search with the value
 * of whichever overlapping `navigate` commits last, so a strip that captures a
 * value before a newer app switch would replace the switch and drop
 * `app=kanban`, unmounting the task board.
 */
export const WORKSPACE_DEEP_LINK_KEYS = [
  'channel',
  'message',
  'task',
  'thread',
  'workspace',
] as const

export type WorkspaceDeepLinkKey = (typeof WORKSPACE_DEEP_LINK_KEYS)[number]

/** A section retained by links to the removed standalone account directory. */
export type LegacyDirectorySection = 'agents' | 'inbox'

export type LegacyDirectoryIntent = Readonly<{
  accountPrincipalId: string | null
  routeKey: string
  section: LegacyDirectorySection
  sourceSearchKey: string
  workspaceId: string
}>

export type LegacyDirectoryIntentResolution =
  | Readonly<{ status: 'pending' }>
  | Readonly<{ status: 'superseded' }>
  | Readonly<{ section: LegacyDirectorySection; status: 'settled' }>

function stableSearchKey(search: object): string {
  return JSON.stringify(
    Object.entries(search)
      .filter(([, value]) => value !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right))
  )
}

/** Stable key for navigation intent, ignoring workspace/scene settle writes. */
export function legacyDirectoryIntentRouteKey(search: object): string {
  const stable = { ...(search as Record<string, unknown>) }
  delete stable.workspace
  delete stable.scene
  return stableSearchKey(stable)
}

/** Stable key for a whole search value, used to guard a pending normalization. */
export function workspaceSearchKey(search: object): string {
  return stableSearchKey(search)
}

/**
 * Keep a legacy section selection pending across an authorized workspace switch.
 * A route or account change supersedes the old intent before it can apply.
 */
export function resolveLegacyDirectoryIntent(
  intent: LegacyDirectoryIntent,
  current: Readonly<{
    accountPrincipalId: string | null
    activeWorkspaceId: string | undefined
    search: object
  }>
): LegacyDirectoryIntentResolution {
  const search = current.search as Record<string, unknown>
  if (current.accountPrincipalId !== intent.accountPrincipalId) return { status: 'superseded' }
  if (search.directory !== undefined)
    return workspaceSearchKey(current.search) === intent.sourceSearchKey
      ? { status: 'pending' }
      : { status: 'superseded' }
  if (
    legacyDirectoryIntentRouteKey(current.search) !== intent.routeKey ||
    (search.workspace !== undefined && search.workspace !== intent.workspaceId)
  )
    return { status: 'superseded' }
  if (current.activeWorkspaceId !== intent.workspaceId) return { status: 'pending' }
  return { status: 'settled', section: intent.section }
}

/**
 * Turn an old standalone-directory URL into the canonical Chat surface. A
 * stale one-shot selection must not open an unrelated conversation or task
 * when a legacy directory link is loaded.
 */
export function normalizeLegacyDirectorySearch<T extends object>(
  search: T
): {
  section?: LegacyDirectorySection
  search: T
} {
  const next = { ...(search as Record<string, unknown>) }
  const value = next.directory
  delete next.directory
  if (value === 'agents' || value === 'inbox') {
    for (const key of ['channel', 'task', 'thread', 'message']) delete next[key]
    next.view = 'chat'
    delete next.app
    delete next.roomDesigner
    delete next.characterDesigner
    return { section: value, search: next as T }
  }
  return { search: next as T }
}

/**
 * Removes only the one-shot deep-link keys, preserving every other search
 * parameter (app switches, view, directory, scene, …). Use this as a
 * functional `navigate({ search: previous => … })` updater so a completion
 * that lands after a newer navigation strips the latest search instead of
 * overwriting it.
 */
export function stripWorkspaceDeepLinkSearch<T extends object>(search: T): T {
  const next = { ...(search as Record<string, unknown>) }
  for (const key of WORKSPACE_DEEP_LINK_KEYS) delete next[key]
  return next as T
}
