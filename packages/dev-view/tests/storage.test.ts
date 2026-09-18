import { describe, expect, test } from 'bun:test'

import { createLayoutStorageController, type LayoutStorage } from '../src/layout/storage'
import type {
  DevLayoutPreferencesV2,
  DevUtilityPreference,
  Scope,
} from '@adea-ai/types/dev-runtime'

const scope: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const otherNode: Scope = { ...scope, runtimeNodeId: '00000000-0000-4000-8000-000000000004' }

const pane = (name: DevUtilityPreference['pane'], order: number): DevUtilityPreference => ({
  pane: name,
  side: name === 'files' || name === 'source_control' ? 'left' : 'right',
  order,
  visible: order === 0,
  size: 288,
  lastNonzeroSize: 288,
  fullWidth: false,
})

const preferences = (scopeValue: Scope = scope): DevLayoutPreferencesV2 => ({
  schemaVersion: 2,
  scope: scopeValue,
  projectId: 'project-a',
  runtimeSessionId: 'session-a',
  center: { kind: 'leaf', id: 'terminal-a', pane: 'terminal' },
  utility: [
    pane('files', 0),
    pane('source_control', 1),
    pane('browser', 2),
    pane('devices', 3),
    pane('agents', 4),
    pane('history', 5),
  ],
  focusMode: false,
  focusTargetId: 'terminal-a',
})

const v1Document = JSON.stringify({
  schemaVersion: 1,
  scope,
  projectId: 'project-a',
  runtimeSessionId: 'session-a',
  center: { kind: 'leaf', id: 'terminal-a', pane: 'terminal' },
  utility: [{ pane: 'files', side: 'left', visible: true, size: 280, lastNonzeroSize: 280 }],
  focusMode: false,
  focusTargetId: 'terminal-a',
})

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  const store = {
    failSet: false,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (store.failSet) throw new DOMException('quota exceeded', 'QuotaExceededError')
      data.set(key, value)
    },
    removeItem: (key: string) => {
      data.delete(key)
    },
  }
  return { data, store: store as LayoutStorage & typeof store }
}

function controller(storage: LayoutStorage, scopeValue: Scope = scope) {
  return createLayoutStorageController({
    storage,
    scope: scopeValue,
    projectId: 'project-a',
    runtimeSessionId: 'session-a',
    debounceMs: 5,
  })
}

const denied = () => {
  throw new DOMException('storage denied', 'SecurityError')
}

describe('Dev layout storage controller', () => {
  test('debounces writes and flushes pending state when hidden', () => {
    const { store } = memoryStorage()
    const layout = controller(store)
    expect(layout.load()).toEqual({ state: 'empty' })
    layout.schedule(preferences())
    layout.schedule({ ...preferences(), focusMode: true })
    expect(store.getItem(layout.key)).toBeNull()
    layout.visibilityChanged(true)
    expect(store.getItem(layout.key)).toContain('"schemaVersion":2')
    expect(store.getItem(layout.key)).toContain('"focusMode":true')
    expect(store.getItem(layout.legacyKey)).toBeNull()
  })

  test('rejects stored and scheduled preferences from another scope', () => {
    const { data, store } = memoryStorage()
    const layout = controller(store)
    data.set(layout.key, JSON.stringify(preferences(otherNode)))
    expect(layout.load()).toMatchObject({ state: 'corrupt' })
    expect(() => layout.schedule(preferences(otherNode))).toThrow('scope_mismatch')
  })

  test('retains an unread corrupt value before replacing it after an explicit change', () => {
    const { data, store } = memoryStorage()
    const layout = controller(store)
    data.set(layout.key, '{bad')
    expect(layout.load()).toEqual({ state: 'corrupt', raw: '{bad' })
    layout.schedule(preferences())
    layout.flush()
    expect(data.get(`${layout.key}:unread`)).toBe('{bad')
    expect(data.get(layout.key)).toContain('"schemaVersion":2')
  })

  test('migrates the V1 envelope, commits V2 first, then removes the original', () => {
    const { data, store } = memoryStorage()
    const layout = controller(store)
    data.set(layout.legacyKey, v1Document)
    const loaded = layout.load()
    expect(loaded).toMatchObject({ state: 'ready', migrated: true })
    if (loaded.state === 'ready') expect(loaded.value.utility).toHaveLength(6)
    expect(data.get(layout.key)).toContain('"schemaVersion":2')
    expect(data.has(layout.legacyKey)).toBe(false)
  })

  test('keeps the pending write when quota fails and succeeds on a later flush', () => {
    const { store } = memoryStorage()
    store.failSet = true
    const layout = controller(store)
    layout.schedule(preferences())
    expect(() => layout.flush()).not.toThrow()
    expect(store.getItem(layout.key)).toBeNull()
    store.failSet = false
    layout.flush()
    expect(store.getItem(layout.key)).toContain('"schemaVersion":2')
  })

  test('keeps the V1 original in place when migration hits quota failures', () => {
    const { data, store } = memoryStorage()
    store.failSet = true
    const layout = controller(store)
    data.set(layout.legacyKey, v1Document)
    const loaded = layout.load()
    expect(loaded).toMatchObject({ state: 'ready', migrated: true })
    expect(data.has(layout.key)).toBe(false)
    expect(data.has(layout.legacyKey)).toBe(true)
  })

  test('treats unavailable storage as empty and never crashes the shell', () => {
    const layout = controller({
      getItem: denied,
      setItem: denied,
      removeItem: denied,
    })
    expect(layout.load()).toEqual({ state: 'empty' })
    expect(() => layout.schedule(preferences())).not.toThrow()
    expect(() => layout.flush()).not.toThrow()
    expect(() => layout.visibilityChanged(true)).not.toThrow()
  })

  test('resolves stale two-window writes by last committed writer', () => {
    const { store } = memoryStorage()
    const windowA = controller(store)
    const windowB = controller(store)
    windowA.schedule({ ...preferences(), focusMode: false })
    windowB.schedule({ ...preferences(), focusMode: true })
    windowA.flush()
    expect(store.getItem(windowA.key)).toContain('"focusMode":false')
    windowB.flush()
    expect(store.getItem(windowA.key)).toContain('"focusMode":true')
  })

  test('never restores preferences across runtime nodes', () => {
    const { store } = memoryStorage()
    const nodeA = controller(store)
    nodeA.schedule(preferences())
    nodeA.flush()
    const nodeB = controller(store, otherNode)
    expect(nodeB.load()).toEqual({ state: 'empty' })
  })
})
