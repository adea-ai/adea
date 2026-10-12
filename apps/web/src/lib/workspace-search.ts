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
