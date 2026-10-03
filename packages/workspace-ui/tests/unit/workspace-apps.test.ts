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
} from '../../src/workspace-apps'

test('built-in apps and Kanban start enabled; optional destinations require explicit enablement', () => {
  // Kanban is the only place tasks are listed, so it is on by default.
  expect(enabledWorkspaceApps(defaultRailPreferences).map((app) => app.id)).toEqual([
    'virtual',
    'chat',
    'dev',
    'kanban',
  ])
  expect(resolveWorkspaceApp(defaultRailPreferences, 'kanban')?.view).toBe('chat')
  const withoutKanban = setWorkspaceAppEnabled(defaultRailPreferences, 'kanban', false)
  expect(enabledWorkspaceApps(withoutKanban).map((app) => app.id)).toEqual([
    'virtual',
    'chat',
    'dev',
  ])
  // An explicitly enabled app is recorded in the order; a default-on app that
  // was never placed follows the recorded ones.
  const next = setWorkspaceAppEnabled(defaultRailPreferences, 'source-control', true)
  expect(enabledWorkspaceApps(next).map((app) => app.id)).toEqual([
    'virtual',
    'chat',
    'dev',
    'source-control',
    'kanban',
  ])
  expect(defaultRailPreferences.order).toEqual(['virtual', 'chat', 'dev'])
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
  expect(moved.hidden).toEqual(['chat', 'app:future', 'source-control'])
  expect(enabledWorkspaceApps(moved).map((app) => app.id)).toEqual(['virtual', 'dev', 'kanban'])

  const enabled = setWorkspaceAppEnabled(moved, 'source-control', true)
  expect(enabledWorkspaceApps(enabled).map((app) => app.id)).toEqual([
    'virtual',
    'source-control',
    'dev',
    'kanban',
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
