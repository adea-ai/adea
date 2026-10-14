import type { RailPreferencesV1 } from './rail-preferences'
import { reorderRailItemsRelativeTo, setRailItemHidden } from './rail-preferences'
import type { WorkspaceView } from './workspace-view-toggle'

export type WorkspaceAppId = WorkspaceView | 'kanban' | 'source-control'
export type WorkspaceApp = Readonly<{
  id: WorkspaceAppId
  name: string
  description: string
  view: WorkspaceView
  enabledByDefault: boolean
}>

/** Build-owned destinations. External plugin metadata cannot register routes. */
export const workspaceApps: readonly WorkspaceApp[] = Object.freeze([
  {
    id: 'virtual',
    name: 'Virtual',
    description: 'Rooms and the spatial workspace.',
    view: 'virtual',
    enabledByDefault: true,
  },
  {
    id: 'chat',
    name: 'Chat',
    description: 'Conversations with your agents.',
    view: 'chat',
    enabledByDefault: true,
  },
  {
    id: 'dev',
    name: 'Dev',
    description: 'Projects, worktrees, terminals and developer tools.',
    view: 'dev',
    enabledByDefault: true,
  },
  {
    id: 'kanban',
    name: 'Kanban',
    description: 'Plan and track tasks on a full-width board.',
    view: 'chat',
    // The board is the only place tasks are listed, so it is on unless the
    // person turns it off in the App Library.
    enabledByDefault: true,
  },
  {
    id: 'source-control',
    name: 'Source control',
    description: 'Pull requests, reviews, checks and merges across your GitHub projects.',
    view: 'dev',
    enabledByDefault: false,
  },
])

/**
 * Every built-in destination in its shared rail-preference order, including
 * destinations that are currently hidden. Unknown contribution ids remain in
 * the preference record but are not promoted into this compiled app list.
 */
export function orderedWorkspaceApps(preferences: RailPreferencesV1): readonly WorkspaceApp[] {
  const byId = new Map(workspaceApps.map((app) => [app.id, app]))
  const order = [...new Set([...preferences.order, ...workspaceApps.map((app) => app.id)])]
  return order.flatMap((id) => {
    const app = byId.get(id as WorkspaceAppId)
    return app ? [app] : []
  })
}

/**
 * Move an App Library entry using the same before/after operation as the
 * global rail. Missing built-in destinations are added to the canonical order
 * before moving; optional destinations are also marked hidden so browsing or
 * reordering them never enables them as a side effect. Other known and
 * unknown ids remain in the stored order.
 */
export function reorderWorkspaceAppsRelativeTo(
  preferences: RailPreferencesV1,
  id: WorkspaceAppId,
  targetId: WorkspaceAppId,
  position: 'after' | 'before' = 'before'
): RailPreferencesV1 {
  if (id === targetId) return preferences
  if (
    !workspaceApps.some((app) => app.id === id) ||
    !workspaceApps.some((app) => app.id === targetId)
  )
    return preferences

  const order = [...preferences.order]
  const hidden = new Set(preferences.hidden)
  for (const app of workspaceApps) {
    if (order.includes(app.id)) continue
    order.push(app.id)
    if (!app.enabledByDefault) hidden.add(app.id)
  }

  const complete = {
    version: 1 as const,
    order: Object.freeze(order),
    hidden: Object.freeze([...hidden]),
  }
  const next = reorderRailItemsRelativeTo(complete, id, targetId, position)
  if (next.order.every((candidate, index) => candidate === complete.order[index]))
    return preferences
  return next
}

export function enabledWorkspaceApps(preferences: RailPreferencesV1): readonly WorkspaceApp[] {
  const hidden = new Set(preferences.hidden)
  return orderedWorkspaceApps(preferences).filter(
    (app) => !hidden.has(app.id) && (app.enabledByDefault || preferences.order.includes(app.id))
  )
}

export function setWorkspaceAppEnabled(
  preferences: RailPreferencesV1,
  id: string,
  enabled: boolean
): RailPreferencesV1 {
  if (!workspaceApps.some((app) => app.id === id)) return preferences
  const ordered =
    enabled && !preferences.order.includes(id)
      ? { ...preferences, order: Object.freeze([...preferences.order, id]) }
      : preferences
  return setRailItemHidden(ordered, id, !enabled)
}

/** Undefined means Library: it remains reachable when every app is disabled. */
export function resolveWorkspaceApp(
  preferences: RailPreferencesV1,
  requested: string
): WorkspaceApp | undefined {
  const enabled = enabledWorkspaceApps(preferences)
  return enabled.find((app) => app.id === requested) ?? enabled[0]
}
