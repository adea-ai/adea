import { expect, test } from 'bun:test'
import {
  defaultRailPreferences,
  readRailPreferences,
  writeRailPreferences,
} from '../../src/rail-preferences'
import {
  enabledWorkspaceApps,
  resolveWorkspaceApp,
  setWorkspaceAppEnabled,
} from '../../src/workspace-apps'

test('built-in apps start enabled; optional destinations require explicit enablement', () => {
  expect(enabledWorkspaceApps(defaultRailPreferences).map((app) => app.id)).toEqual([
    'virtual',
    'chat',
    'dev',
  ])
  const next = setWorkspaceAppEnabled(defaultRailPreferences, 'kanban', true)
  expect(enabledWorkspaceApps(next).map((app) => app.id)).toEqual([
    'virtual',
    'chat',
    'dev',
    'kanban',
  ])
  expect(resolveWorkspaceApp(next, 'kanban')?.view).toBe('chat')
  expect(defaultRailPreferences.order).toEqual(['virtual', 'chat', 'dev'])
})

test('disabling an active app selects an enabled destination, or Library when all are off', () => {
  let next = setWorkspaceAppEnabled(defaultRailPreferences, 'chat', false)
  expect(resolveWorkspaceApp(next, 'chat')?.id).toBe('virtual')
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
