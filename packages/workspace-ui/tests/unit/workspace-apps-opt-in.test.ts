import { expect, test } from 'bun:test'
import {
  defaultRailPreferences,
  readRailPreferences,
  writeRailPreferences,
  normalizeRailPreferences,
} from '../../src/rail-preferences'
import {
  workspaceApps,
  enabledWorkspaceApps,
  resolveWorkspaceApp,
  setWorkspaceAppEnabled,
  reorderWorkspaceAppsRelativeTo,
} from '../../src/workspace-apps'

const ids = (preferences = defaultRailPreferences) =>
  enabledWorkspaceApps(preferences).map((app) => app.id)

function blockedStorage() {
  throw new Error('Storage access denied')
}

test('a fresh or unreadable store enables only Chat and Dev; every extra registry entry is opt-in', () => {
  expect(ids(readRailPreferences(undefined))).toEqual(['chat', 'dev'])
  expect(ids(readRailPreferences({ getItem: () => null, setItem() {} }))).toEqual(['chat', 'dev'])
  expect(ids(normalizeRailPreferences({ version: 99 }).value)).toEqual(['chat', 'dev'])
  for (const app of workspaceApps)
    if (app.id !== 'chat' && app.id !== 'dev') expect(ids()).not.toContain(app.id)
})

test('enabling an extra view persists across reload; disabling an active extra falls back to a core view', () => {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
  }
  let preferences = setWorkspaceAppEnabled(defaultRailPreferences, 'virtual', true)
  preferences = setWorkspaceAppEnabled(preferences, 'kanban', true)
  preferences = setWorkspaceAppEnabled(preferences, 'source-control', true)
  writeRailPreferences(storage, preferences)
  expect(ids(readRailPreferences(storage))).toEqual([
    'chat',
    'dev',
    'virtual',
    'kanban',
    'source-control',
  ])
  preferences = setWorkspaceAppEnabled(readRailPreferences(storage), 'virtual', false)
  expect(resolveWorkspaceApp(preferences, 'virtual')?.id).toBe('chat')
  preferences = setWorkspaceAppEnabled(preferences, 'chat', false)
  expect(resolveWorkspaceApp(preferences, 'virtual')?.id).toBe('dev')
  writeRailPreferences(storage, preferences)
  expect(ids(readRailPreferences(storage))).toEqual(['dev', 'kanban', 'source-control'])
})

test('valid legacy records preserve explicit extra views, hidden choices, order and unknown IDs', () => {
  const legacy = {
    version: 1,
    order: ['app:future', 'virtual', 'dev', 'kanban', 'source-control', 'chat'],
    hidden: ['source-control', 'chat', 'app:hidden'],
  }
  const restored = normalizeRailPreferences(legacy).value
  expect(restored).toEqual(legacy)
  expect(ids(restored)).toEqual(['virtual', 'dev', 'kanban'])
  expect(resolveWorkspaceApp(restored, 'virtual')?.id).toBe('virtual')
  expect(resolveWorkspaceApp(restored, 'source-control')?.id).toBe('dev')
})

test('missing legacy IDs and browsing/reordering extras cannot implicitly enable optional views', () => {
  expect(ids(normalizeRailPreferences({ version: 1, order: ['dev'], hidden: [] }).value)).toEqual([
    'dev',
    'chat',
  ])
  const moved = reorderWorkspaceAppsRelativeTo(defaultRailPreferences, 'virtual', 'chat')
  expect(ids(moved)).toEqual(['chat', 'dev'])
  expect(moved.hidden).toContain('virtual')
  expect(moved.hidden).toContain('kanban')
  expect(moved.hidden).toContain('source-control')
})

test('a disabled or unknown route never falls back into another optional app', () => {
  let preferences = setWorkspaceAppEnabled(defaultRailPreferences, 'virtual', true)
  preferences = setWorkspaceAppEnabled(preferences, 'chat', false)
  preferences = setWorkspaceAppEnabled(preferences, 'dev', false)
  expect(resolveWorkspaceApp(preferences, 'virtual')?.id).toBe('virtual')
  expect(resolveWorkspaceApp(preferences, 'kanban')).toBeUndefined()
  expect(resolveWorkspaceApp(preferences, 'unknown')).toBeUndefined()
})

test('blocked browser storage access retains core-only defaults and does not break in-memory choices', () => {
  expect(ids(readRailPreferences(blockedStorage))).toEqual(['chat', 'dev'])
  const enabled = setWorkspaceAppEnabled(readRailPreferences(blockedStorage), 'virtual', true)
  expect(ids(enabled)).toContain('virtual')
  expect(() => writeRailPreferences(blockedStorage, enabled)).not.toThrow()
})
