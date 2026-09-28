import type { RailPreferencesV1 } from './rail-preferences'
import { setRailItemHidden } from './rail-preferences'
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
    description: 'A full workspace task board.',
    view: 'chat',
    enabledByDefault: false,
  },
  {
    id: 'source-control',
    name: 'Source control',
    description: 'Review the selected runtime session’s changes.',
    view: 'dev',
    enabledByDefault: false,
  },
])

export function enabledWorkspaceApps(preferences: RailPreferencesV1): readonly WorkspaceApp[] {
  const byId = new Map(workspaceApps.map((app) => [app.id, app]))
  const order = [...new Set([...preferences.order, ...workspaceApps.map((app) => app.id)])]
  return order.flatMap((id) => {
    const app = byId.get(id as WorkspaceAppId)
    if (!app || preferences.hidden.includes(id)) return []
    return app.enabledByDefault || preferences.order.includes(id) ? [app] : []
  })
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
