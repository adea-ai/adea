import { expect, test } from 'bun:test'
import {
  defaultRailPreferences,
  readRailPreferences,
  writeRailPreferences,
} from '../../src/rail-preferences'
import {
  enabledWorkspaceApps,
  orderedWorkspaceApps,
  reorderWorkspaceAppsRelativeTo,
  resolveWorkspaceApp,
  setWorkspaceAppEnabled,
  workspaceApps,
} from '../../src/workspace-apps'

test('only Virtual, Chat and Dev start enabled; optional destinations require explicit enablement', () => {
  expect(workspaceApps.filter((app) => app.enabledByDefault).map((app) => app.id)).toEqual([
    'virtual',
    'chat',
    'dev',
  ])
  expect(enabledWorkspaceApps(defaultRailPreferences).map((app) => app.id)).toEqual([
    'virtual',
    'chat',
    'dev',
  ])
  // Kanban is still a known destination: it resolves once the person enables
  // it, and until then a request for it lands on the first enabled app.
  expect(resolveWorkspaceApp(defaultRailPreferences, 'kanban')?.id).toBe('virtual')
  const withKanban = setWorkspaceAppEnabled(defaultRailPreferences, 'kanban', true)
  expect(resolveWorkspaceApp(withKanban, 'kanban')?.view).toBe('chat')
  expect(enabledWorkspaceApps(withKanban).map((app) => app.id)).toEqual([
    'virtual',
    'chat',
    'dev',
    'kanban',
  ])
  // Turning it back off hides it again without dropping its recorded place.
  const withoutKanban = setWorkspaceAppEnabled(withKanban, 'kanban', false)
  expect(enabledWorkspaceApps(withoutKanban).map((app) => app.id)).toEqual([
    'virtual',
    'chat',
    'dev',
  ])
  expect(withoutKanban.order).toContain('kanban')
  expect(withoutKanban.hidden).toContain('kanban')
  const next = setWorkspaceAppEnabled(defaultRailPreferences, 'source-control', true)
  expect(enabledWorkspaceApps(next).map((app) => app.id)).toEqual([
    'virtual',
    'chat',
    'dev',
    'source-control',
  ])
  expect(defaultRailPreferences.order).toEqual(['virtual', 'chat', 'dev'])
})

test('a stored preference that already placed Kanban keeps it enabled', () => {
  // Preferences written before Kanban became optional recorded it in the order
  // when the person reordered or enabled apps; nothing is migrated or hidden.
  const stored = {
    version: 1 as const,
    order: ['virtual', 'chat', 'dev', 'kanban'],
    hidden: [],
  }
  expect(enabledWorkspaceApps(stored).map((app) => app.id)).toEqual([
    'virtual',
    'chat',
    'dev',
    'kanban',
  ])
  const hidden = { ...stored, hidden: ['kanban'] }
  expect(enabledWorkspaceApps(hidden).map((app) => app.id)).toEqual(['virtual', 'chat', 'dev'])
})

test('App Library order shares rail placements and retains filtered, hidden, and unknown ids', () => {
  const source = {
    version: 1 as const,
    order: ['virtual', 'app:future', 'chat', 'dev'],
    hidden: ['chat', 'app:future'],
  }

  expect(orderedWorkspaceApps(source).map((app) => app.id)).toEqual([
    'virtual',
    'chat',
    'dev',
    'kanban',
    'source-control',
  ])

  const moved = reorderWorkspaceAppsRelativeTo(source, 'source-control', 'dev', 'before')
  expect(moved.order).toEqual(['virtual', 'app:future', 'chat', 'source-control', 'dev', 'kanban'])
  // Reordering records every built-in app; optional ones are hidden, so
  // browsing the Library never enables Kanban or Source control.
  expect(moved.hidden).toEqual(['chat', 'app:future', 'kanban', 'source-control'])
  expect(enabledWorkspaceApps(moved).map((app) => app.id)).toEqual(['virtual', 'dev'])

  const enabled = setWorkspaceAppEnabled(moved, 'source-control', true)
  expect(enabledWorkspaceApps(enabled).map((app) => app.id)).toEqual([
    'virtual',
    'source-control',
    'dev',
  ])
})

test('App Library no-op moves leave the canonical record unchanged', () => {
  expect(reorderWorkspaceAppsRelativeTo(defaultRailPreferences, 'virtual', 'chat', 'before')).toBe(
    defaultRailPreferences
  )
})

test('disabling an active app selects an enabled destination, or Library when all are off', () => {
  let next = setWorkspaceAppEnabled(defaultRailPreferences, 'chat', false)
  expect(resolveWorkspaceApp(next, 'chat')?.id).toBe('virtual')
  next = setWorkspaceAppEnabled(next, 'kanban', false)
  next = setWorkspaceAppEnabled(setWorkspaceAppEnabled(next, 'dev', false), 'virtual', false)
  expect(resolveWorkspaceApp(next, 'dev')).toBeUndefined()
  expect(enabledWorkspaceApps(next)).toEqual([])
  next = setWorkspaceAppEnabled(next, 'chat', true)
  expect(resolveWorkspaceApp(next, 'chat')?.id).toBe('chat')
})

test('unknown external contribution IDs cannot register destinations and survive persistence', () => {
  const source = {
    version: 1 as const,
    order: ['app:untrusted', 'dev', 'chat', 'virtual'],
    hidden: ['app:future'],
  }
  expect(setWorkspaceAppEnabled(source, 'app:untrusted', true)).toBe(source)
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
  }
  const next = setWorkspaceAppEnabled(source, 'source-control', true)
  writeRailPreferences(storage, next)
  const restored = readRailPreferences(storage)
  expect(restored.order[0]).toBe('app:untrusted')
  expect(restored.hidden).toContain('app:future')
  expect(resolveWorkspaceApp(restored, 'source-control')?.view).toBe('dev')
  expect(enabledWorkspaceApps(restored).some((app) => (app.id as string) === 'app:untrusted')).toBe(
    false
  )
})
