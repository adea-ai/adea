import { expect, test } from 'bun:test'

import { createLayoutStorageController } from '../src/layout/storage'

const scope = { accountId: 'account', workspaceId: 'workspace', runtimeNodeId: 'node' }
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

test('retains an unread corrupt value before replacing it after an explicit change', () => {
  const storage = memoryStorage()
  const controller = createLayoutStorageController({ storage, scope, projectId: 'project' })
  storage.values.set(controller.key, '{bad')
  expect(controller.load()).toEqual({ state: 'corrupt', raw: '{bad' })

  controller.schedule(value)
  controller.flush()
  expect(storage.values.get(`${controller.key}:unread`)).toBe('{bad')
  expect(JSON.parse(storage.values.get(controller.key)!)).toMatchObject({ schemaVersion: 1 })
})
