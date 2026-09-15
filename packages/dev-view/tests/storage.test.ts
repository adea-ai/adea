import { expect, test } from 'bun:test'

import { createLayoutStorageController } from '../src/layout/storage'

const scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const value = {
  schemaVersion: 1 as const,
  scope,
  projectId: 'project',
  runtimeSessionId: 'session',
  center: { kind: 'leaf' as const, id: 'terminal', pane: 'terminal' as const },
  utility: [],
  focusMode: false,
}

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, next: string) => void values.set(key, next),
  }
}

test('debounces writes and flushes pending state when hidden', () => {
  const storage = memoryStorage()
  const callbacks: (() => void)[] = []
  const controller = createLayoutStorageController({
    storage,
    scope,
    projectId: 'project',
    runtimeSessionId: 'session',
    setTimer: ((callback: () => void) => {
      callbacks.push(callback)
      return callbacks.length as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout,
    clearTimer: (() => {}) as typeof clearTimeout,
  })

  controller.schedule(value)
  controller.schedule({ ...value, focusMode: true })
  expect(storage.values.size).toBe(0)
  controller.visibilityChanged(true)
  expect(JSON.parse(storage.values.get(controller.key)!)).toMatchObject({ focusMode: true })
})

test('rejects stored and scheduled preferences from another scope', () => {
  const other = {
    ...value,
    scope: { ...scope, workspaceId: '00000000-0000-4000-8000-000000000009' },
  }
  const storage = memoryStorage()
  const controller = createLayoutStorageController({
    storage,
    scope,
    projectId: 'project',
    runtimeSessionId: 'session',
  })
  storage.values.set(controller.key, JSON.stringify(other))
  expect(controller.load()).toMatchObject({ state: 'corrupt' })
  expect(() => controller.schedule(other)).toThrow('scope_mismatch')
})

test('retains an unread corrupt value before replacing it after an explicit change', () => {
  const storage = memoryStorage()
  const controller = createLayoutStorageController({
    storage,
    scope,
    projectId: 'project',
    runtimeSessionId: 'session',
  })
  storage.values.set(controller.key, '{bad')
  expect(controller.load()).toEqual({ state: 'corrupt', raw: '{bad' })

  controller.schedule(value)
  controller.flush()
  expect(storage.values.get(`${controller.key}:unread`)).toBe('{bad')
  expect(JSON.parse(storage.values.get(controller.key)!)).toMatchObject({ schemaVersion: 1 })
})
