import { describe, expect, test } from 'bun:test'
import { createEffect, createRoot } from 'solid-js'

import type { DevLayoutPreferencesV2, Scope } from '@adea-ai/types/dev-runtime'
import type { DevRuntimeService } from '../src/platform'
import { defaultUtilityPreferences, layoutUtilityTuple } from '../src/utility-preferences'
import { createSharedDevUtilityOwner, type LayoutLoadState } from '../src/utility-owner'
import type { LayoutStorageModule } from '../src/utility-layout-storage'
import { layoutStorageKeyV2, serializeLayoutPreferencesV2 } from '../src/layout/persistence'

const scope: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}

function documentFor(runtimeSessionId: string): DevLayoutPreferencesV2 {
  return {
    schemaVersion: 2,
    scope,
    projectId: 'project-a',
    runtimeSessionId,
    center: { kind: 'leaf', id: 'saved-editor', pane: 'editor' },
    utility: layoutUtilityTuple(
      defaultUtilityPreferences().map((item) =>
        item.pane === 'devices' ? { ...item, visible: true } : item
      )
    ),
    focusMode: false,
    focusTargetId: 'saved-editor',
  }
}

function createOwner(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'length' | 'key'>,
  loader: () => Promise<LayoutStorageModule>,
  visibilityTarget?: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>
) {
  const runtime: DevRuntimeService = {
    state: () => ({ status: 'ready' }),
    preferenceScope: () => scope,
    capabilitySnapshot: async (requestedScope) => ({
      scope: requestedScope,
      granted: [],
      unavailable: [],
      channelGeneration: 1,
      observedAt: new Date(0).toISOString(),
    }),
    execute: async () => {
      throw new Error('unused')
    },
  }
  let disposeRoot: (() => void) | undefined
  let loaderCalls = 0
  const loaderCallWaiters = new Map<number, Array<() => void>>()
  const trackedLoader = () => {
    loaderCalls += 1
    for (const [target, waiters] of loaderCallWaiters) {
      if (loaderCalls < target) continue
      loaderCallWaiters.delete(target)
      for (const resolve of waiters) resolve()
    }
    return loader()
  }
  const owner = createRoot((dispose) => {
    disposeRoot = dispose
    return createSharedDevUtilityOwner(runtime, storage, trackedLoader, visibilityTarget)
  })
  return {
    owner,
    bind(runtimeSessionId = 'session-a') {
      owner.setView('chat')
      owner.handoffCanonicalChatConversation({
        scope,
        projectId: 'project-a',
        runtimeSessionId,
        sessionGeneration: 4,
      })
    },
    waitForLoaderCall(target: number) {
      if (loaderCalls >= target) return Promise.resolve()
      return new Promise<void>((resolve) => {
        const waiters = loaderCallWaiters.get(target) ?? []
        waiters.push(resolve)
        loaderCallWaiters.set(target, waiters)
      })
    },
    loaderCallCount() {
      return loaderCalls
    },
    dispose() {
      owner.dispose()
      disposeRoot?.()
    },
  }
}

function memoryStorage(
  seed: ReadonlyMap<string, string> = new Map(),
  shouldFailSet: (key: string) => boolean = () => false
) {
  const values = new Map(seed)
  const writtenKeys = new Set<string>()
  const writeWaiters = new Map<string, Array<() => void>>()
  return {
    values,
    waitForWrite(key: string) {
      if (writtenKeys.has(key)) return Promise.resolve()
      return new Promise<void>((resolve) => {
        const waiters = writeWaiters.get(key) ?? []
        waiters.push(resolve)
        writeWaiters.set(key, waiters)
      })
    },
    storage: {
      get length() {
        return values.size
      },
      key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (shouldFailSet(key)) throw new Error(`write denied: ${key}`)
        values.set(key, value)
        writtenKeys.add(key)
        for (const resolve of writeWaiters.get(key) ?? []) resolve()
        writeWaiters.delete(key)
      },
      removeItem: (key: string) => void values.delete(key),
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function waitForLayoutRevision(
  owner: ReturnType<typeof createSharedDevUtilityOwner>,
  target: number
) {
  return new Promise<void>((resolve) => {
    createRoot((dispose) => {
      createEffect(() => {
        if (owner.layoutLoadRevision() >= target) {
          dispose()
          resolve()
        }
      })
    })
  })
}

function waitForLayoutState(
  owner: ReturnType<typeof createSharedDevUtilityOwner>,
  target: LayoutLoadState
) {
  return new Promise<void>((resolve) => {
    createRoot((dispose) => {
      createEffect(() => {
        if (owner.layoutLoadState() === target) {
          dispose()
          resolve()
        }
      })
    })
  })
}

const layoutModule = () => import('../src/layout/storage')

describe('lazy shared layout storage', () => {
  test('publishes a hydrated layout atomically before observers can switch views', async () => {
    const { storage } = memoryStorage()
    const listeners = new Set<EventListener>()
    const visibilityTarget = {
      hidden: false,
      addEventListener(_type: 'visibilitychange', listener: EventListener) {
        listeners.add(listener)
      },
      removeEventListener(_type: 'visibilitychange', listener: EventListener) {
        listeners.delete(listener)
      },
    }
    const testOwner = createOwner(storage, layoutModule, visibilityTarget)
    let observed!: () => void
    const sawLoadedState = new Promise<void>((resolve) => {
      observed = resolve
    })
    createRoot((dispose) => {
      createEffect(() => {
        if (testOwner.owner.layoutLoadState() !== 'empty') return
        testOwner.owner.setView('workspace')
        observed()
        dispose()
      })
    })

    testOwner.bind()
    await sawLoadedState
    expect(testOwner.owner.preferences()).toBeUndefined()
    expect(listeners.size).toBe(0)
    testOwner.dispose()
  })

  test('observer disposal after revision publication removes the visibility listener', async () => {
    const { storage } = memoryStorage()
    const listeners = new Set<EventListener>()
    const visibilityTarget = {
      hidden: false,
      addEventListener(_type: 'visibilitychange', listener: EventListener) {
        listeners.add(listener)
      },
      removeEventListener(_type: 'visibilitychange', listener: EventListener) {
        listeners.delete(listener)
      },
    }
    const testOwner = createOwner(storage, layoutModule, visibilityTarget)
    const sawRevision = new Promise<void>((resolve) => {
      createRoot((dispose) => {
        createEffect(() => {
          if (testOwner.owner.layoutLoadRevision() === 0) return
          testOwner.owner.dispose()
          resolve()
          dispose()
        })
      })
    })

    testOwner.bind()
    await sawRevision
    expect(testOwner.owner.preferences()).toBeUndefined()
    expect(listeners.size).toBe(0)
    testOwner.dispose()
  })

  test('keeps owner state immediate and overlays utility edits on the saved document', async () => {
    const saved = documentFor('session-a')
    const seeded = new Map([
      [layoutStorageKeyV2(scope, 'project-a', 'session-a'), serializeLayoutPreferencesV2(saved)],
    ])
    const { storage, values } = memoryStorage(seeded)
    const loading = deferred<LayoutStorageModule>()
    const testOwner = createOwner(storage, () => loading.promise)
    const { owner } = testOwner

    testOwner.bind()
    await testOwner.waitForLoaderCall(1)
    expect(owner.layoutLoadState()).toBe('loading')
    expect(owner.utilityPreferences().find((item) => item.pane === 'files')?.visible).toBe(true)

    owner.showUtilityPane('history')
    expect(owner.utilityPreferences().find((item) => item.pane === 'history')?.visible).toBe(true)
    loading.resolve(await layoutModule())
    await waitForLayoutRevision(owner, 1)

    expect(owner.preferences()).toMatchObject({
      runtimeSessionId: 'session-a',
      center: saved.center,
      focusMode: false,
      focusTargetId: 'saved-editor',
    })
    expect(owner.preferences()?.utility.find((item) => item.pane === 'history')?.visible).toBe(true)
    expect(owner.preferences()?.utility.find((item) => item.pane === 'devices')?.visible).toBe(
      false
    )
    expect(owner.layoutLoadRevision()).toBe(1)

    testOwner.dispose()
    const persisted = JSON.parse(
      values.get(layoutStorageKeyV2(scope, 'project-a', 'session-a'))!
    ) as DevLayoutPreferencesV2
    expect(persisted.center).toEqual(saved.center)
    expect(persisted.utility.find((item) => item.pane === 'history')?.visible).toBe(true)
  })

  test('overlays a pending focus/layout edit without replacing saved utility settings', async () => {
    const saved = documentFor('session-a')
    const { storage } = memoryStorage(
      new Map([
        [layoutStorageKeyV2(scope, 'project-a', 'session-a'), serializeLayoutPreferencesV2(saved)],
      ])
    )
    const loading = deferred<LayoutStorageModule>()
    const testOwner = createOwner(storage, () => loading.promise)
    const { owner } = testOwner
    testOwner.bind()
    await testOwner.waitForLoaderCall(1)

    const changedCenter = { kind: 'leaf', id: 'new-terminal', pane: 'terminal' } as const
    owner.updateLayoutPreferences({
      center: changedCenter,
      focusMode: true,
      focusTargetId: 'new-terminal',
    })
    loading.resolve(await layoutModule())
    await waitForLayoutRevision(owner, 1)

    expect(owner.preferences()).toMatchObject({
      center: changedCenter,
      focusMode: true,
      focusTargetId: 'new-terminal',
    })
    expect(owner.preferences()?.utility).toEqual(saved.utility)
    testOwner.dispose()
  })

  test('opening a pane before hydration preserves saved widths, full width, side, and order', async () => {
    const saved = documentFor('session-a')
    const savedUtility = layoutUtilityTuple(
      saved.utility.map((item) => {
        if (item.pane === 'files') return { ...item, size: 240, lastNonzeroSize: 240 }
        if (item.pane === 'source_control') return { ...item, side: 'right' as const, order: 2 }
        if (item.pane === 'browser')
          return {
            ...item,
            order: 1,
            size: 384,
            lastNonzeroSize: 384,
            fullWidth: true,
          }
        return item
      })
    )
    const savedDocument = { ...saved, utility: savedUtility }
    const { storage } = memoryStorage(
      new Map([
        [
          layoutStorageKeyV2(scope, 'project-a', 'session-a'),
          serializeLayoutPreferencesV2(savedDocument),
        ],
      ])
    )
    const loading = deferred<LayoutStorageModule>()
    const testOwner = createOwner(storage, () => loading.promise)
    const { owner } = testOwner
    testOwner.bind()
    await testOwner.waitForLoaderCall(1)

    owner.showUtilityPane('browser')
    loading.resolve(await layoutModule())
    await waitForLayoutRevision(owner, 1)

    const utility = owner.preferences()!.utility
    expect(utility.find((item) => item.pane === 'browser')).toMatchObject({
      visible: true,
      size: 384,
      lastNonzeroSize: 384,
      fullWidth: true,
      order: 1,
    })
    expect(utility.find((item) => item.pane === 'files')).toMatchObject({
      size: 240,
      lastNonzeroSize: 240,
      order: 0,
    })
    expect(utility.find((item) => item.pane === 'source_control')).toMatchObject({
      side: 'right',
      order: 2,
    })
    expect(utility.find((item) => item.pane === 'history')?.order).toBe(5)
    testOwner.dispose()
  })

  test('a resize during hydration patches its side and leaves the opposite side saved', async () => {
    const saved = documentFor('session-a')
    const savedUtility = layoutUtilityTuple(
      saved.utility.map((item) => ({
        ...item,
        size: item.side === 'left' ? 240 : 336,
        lastNonzeroSize: item.side === 'left' ? 240 : 336,
      }))
    )
    const { storage } = memoryStorage(
      new Map([
        [
          layoutStorageKeyV2(scope, 'project-a', 'session-a'),
          serializeLayoutPreferencesV2({ ...saved, utility: savedUtility }),
        ],
      ])
    )
    const loading = deferred<LayoutStorageModule>()
    const testOwner = createOwner(storage, () => loading.promise)
    const { owner } = testOwner
    testOwner.bind()
    await testOwner.waitForLoaderCall(1)

    owner.setUtilityPaneSize('browser', 448)
    loading.resolve(await layoutModule())
    await waitForLayoutRevision(owner, 1)

    const utility = owner.preferences()!.utility
    expect(utility.filter((item) => item.side === 'right').every((item) => item.size === 448)).toBe(
      true
    )
    expect(utility.filter((item) => item.side === 'left').every((item) => item.size === 240)).toBe(
      true
    )
    testOwner.dispose()
  })

  test('flushes an old-session edit to its captured key without publishing it into the new session', async () => {
    const { storage, values, waitForWrite } = memoryStorage(
      new Map([
        [
          layoutStorageKeyV2(scope, 'project-a', 'session-b'),
          serializeLayoutPreferencesV2(documentFor('session-b')),
        ],
      ])
    )
    const pendingModules: Array<ReturnType<typeof deferred<LayoutStorageModule>>> = []
    const testOwner = createOwner(storage, () => {
      const pending = deferred<LayoutStorageModule>()
      pendingModules.push(pending)
      return pending.promise
    })
    const { owner } = testOwner
    testOwner.bind('session-a')
    await testOwner.waitForLoaderCall(1)
    owner.showUtilityPane('history')
    owner.setUtilityPaneSize('browser', 384)

    owner.handoffCanonicalChatConversation({
      scope,
      projectId: 'project-a',
      runtimeSessionId: 'session-b',
      sessionGeneration: 5,
    })
    await testOwner.waitForLoaderCall(2)
    expect(pendingModules).toHaveLength(2)
    pendingModules[1]!.resolve(await layoutModule())
    await waitForLayoutRevision(owner, 1)
    expect(owner.preferences()?.runtimeSessionId).toBe('session-b')
    expect(owner.layoutLoadRevision()).toBe(1)

    const oldSessionWrite = waitForWrite(layoutStorageKeyV2(scope, 'project-a', 'session-a'))
    pendingModules[0]!.resolve(await layoutModule())
    await oldSessionWrite
    expect(owner.preferences()?.runtimeSessionId).toBe('session-b')
    expect(owner.layoutLoadRevision()).toBe(1)
    const savedA = JSON.parse(
      values.get(layoutStorageKeyV2(scope, 'project-a', 'session-a'))!
    ) as DevLayoutPreferencesV2
    expect(savedA.utility.find((item) => item.pane === 'history')?.visible).toBe(true)
    expect(
      savedA.utility.filter((item) => item.side === 'right').every((item) => item.size === 384)
    ).toBe(true)
    testOwner.dispose()
  })

  test('flushes pending edits after disposal without applying late owner state', async () => {
    const { storage, values, waitForWrite } = memoryStorage()
    const loading = deferred<LayoutStorageModule>()
    const testOwner = createOwner(storage, () => loading.promise)
    const { owner } = testOwner
    testOwner.bind()
    await testOwner.waitForLoaderCall(1)
    owner.showUtilityPane('history')
    owner.dispose()
    const stateAtDispose = owner.preferences()
    const revisionAtDispose = owner.layoutLoadRevision()

    const sessionWrite = waitForWrite(layoutStorageKeyV2(scope, 'project-a', 'session-a'))
    loading.resolve(await layoutModule())
    await sessionWrite
    expect(owner.preferences()).toBe(stateAtDispose)
    expect(owner.layoutLoadRevision()).toBe(revisionAtDispose)
    const saved = JSON.parse(
      values.get(layoutStorageKeyV2(scope, 'project-a', 'session-a'))!
    ) as DevLayoutPreferencesV2
    expect(saved.utility.find((item) => item.pane === 'history')?.visible).toBe(true)
    testOwner.dispose()
  })

  test('recovers a journal after module failure and owner disposal', async () => {
    const { storage, values, waitForWrite } = memoryStorage()
    const failedOwner = createOwner(storage, () => Promise.reject(new Error('chunk unavailable')))
    failedOwner.bind()
    failedOwner.owner.showUtilityPane('browser')
    await waitForLayoutState(failedOwner.owner, 'unavailable')
    failedOwner.dispose()

    const recoveredOwner = createOwner(storage, layoutModule)
    recoveredOwner.bind()
    await waitForLayoutRevision(recoveredOwner.owner, 1)
    await waitForWrite(layoutStorageKeyV2(scope, 'project-a', 'session-a'))

    expect(
      recoveredOwner.owner.preferences()?.utility.find((item) => item.pane === 'browser')?.visible
    ).toBe(true)
    expect([...values.keys()].some((key) => key.includes(':pending-patch.v1:'))).toBe(false)
    recoveredOwner.dispose()
  })

  test('retains the journal when the normal V2 write fails', async () => {
    const layoutKey = layoutStorageKeyV2(scope, 'project-a', 'session-a')
    const { storage, values } = memoryStorage(new Map(), (key) => key === layoutKey)
    const loading = deferred<LayoutStorageModule>()
    const testOwner = createOwner(storage, () => loading.promise)
    testOwner.bind()
    await testOwner.waitForLoaderCall(1)
    testOwner.owner.showUtilityPane('browser')
    loading.resolve(await layoutModule())
    await waitForLayoutRevision(testOwner.owner, 1)
    testOwner.dispose()

    expect(values.has(layoutKey)).toBe(false)
    expect([...values.keys()].some((key) => key.includes(':pending-patch.v1:'))).toBe(true)
  })

  test('surfaces a rejected journal write and keeps the edit in live owner state', async () => {
    let rejectJournal = true
    const { storage, values, waitForWrite } = memoryStorage(
      new Map(),
      (key) => rejectJournal && key.includes(':pending-patch.v1:')
    )
    const loading = deferred<LayoutStorageModule>()
    const testOwner = createOwner(storage, () => loading.promise)
    testOwner.bind()
    await testOwner.waitForLoaderCall(1)
    testOwner.owner.showUtilityPane('browser')
    await waitForLayoutState(testOwner.owner, 'unavailable')
    expect(
      testOwner.owner.utilityPreferences().find((item) => item.pane === 'browser')?.visible
    ).toBe(true)

    rejectJournal = false
    testOwner.owner.showUtilityPane('devices')
    loading.resolve(await layoutModule())
    await waitForLayoutRevision(testOwner.owner, 1)
    await waitForWrite(layoutStorageKeyV2(scope, 'project-a', 'session-a'))
    expect(testOwner.owner.layoutLoadState()).toBe('empty')
    expect(
      testOwner.owner.preferences()?.utility.find((item) => item.pane === 'devices')?.visible
    ).toBe(true)
    expect(values.has(layoutStorageKeyV2(scope, 'project-a', 'session-a'))).toBe(true)
    testOwner.dispose()
  })

  test('retries a failed V2 write on the active controller without reloading', async () => {
    const layoutKey = layoutStorageKeyV2(scope, 'project-a', 'session-a')
    let rejectWrites = true
    const { storage, values } = memoryStorage(new Map(), (key) => rejectWrites && key === layoutKey)
    const loading = deferred<LayoutStorageModule>()
    const testOwner = createOwner(storage, () => loading.promise)
    testOwner.bind()
    await testOwner.waitForLoaderCall(1)
    testOwner.owner.showUtilityPane('browser')
    loading.resolve(await layoutModule())
    await waitForLayoutRevision(testOwner.owner, 1)
    await waitForLayoutState(testOwner.owner, 'unavailable')
    expect([...values.keys()].some((key) => key.includes(':pending-patch.v1:'))).toBe(true)

    rejectWrites = false
    expect(testOwner.owner.retryLayoutStorage()).toBe(true)
    expect(testOwner.owner.layoutLoadState()).toBe('empty')
    expect(testOwner.owner.layoutLoadRevision()).toBe(1)
    expect(testOwner.loaderCallCount()).toBe(1)
    expect(values.has(layoutKey)).toBe(true)
    expect([...values.keys()].some((key) => key.includes(':pending-patch.v1:'))).toBe(false)
    testOwner.dispose()
  })

  test('keeps exact-session journals through A to B to A in both completion orders', async () => {
    for (const order of [
      ['a1', 'b', 'a2'],
      ['a2', 'b', 'a1'],
    ]) {
      const { storage, values, waitForWrite } = memoryStorage()
      const pending = new Map<string, ReturnType<typeof deferred<LayoutStorageModule>>[]>()
      let loaderCalls = 0
      const testOwner = createOwner(storage, () => {
        loaderCalls += 1
        const sessionId = loaderCalls === 2 ? 'session-b' : 'session-a'
        const request = deferred<LayoutStorageModule>()
        const requests = pending.get(sessionId) ?? []
        requests.push(request)
        pending.set(sessionId, requests)
        return request.promise
      })
      testOwner.bind('session-a')
      await testOwner.waitForLoaderCall(1)
      testOwner.owner.showUtilityPane('browser')
      testOwner.owner.handoffCanonicalChatConversation({
        scope,
        projectId: 'project-a',
        runtimeSessionId: 'session-b',
        sessionGeneration: 5,
      })
      await testOwner.waitForLoaderCall(2)
      testOwner.owner.showUtilityPane('history')
      testOwner.owner.handoffCanonicalChatConversation({
        scope,
        projectId: 'project-a',
        runtimeSessionId: 'session-a',
        sessionGeneration: 6,
      })
      await testOwner.waitForLoaderCall(3)
      testOwner.owner.showUtilityPane('devices')

      for (const entry of order) {
        const sessionId = entry === 'b' ? 'session-b' : 'session-a'
        const sessionRequests = pending.get(sessionId) ?? []
        const request =
          entry === 'a1'
            ? sessionRequests[0]
            : entry === 'a2'
              ? sessionRequests[1]
              : sessionRequests[0]
        request!.resolve(await layoutModule())
        if (entry === 'a2') await waitForLayoutRevision(testOwner.owner, 1)
      }
      testOwner.dispose()
      await waitForWrite(layoutStorageKeyV2(scope, 'project-a', 'session-a'))
      await waitForWrite(layoutStorageKeyV2(scope, 'project-a', 'session-b'))

      const savedA = JSON.parse(
        values.get(layoutStorageKeyV2(scope, 'project-a', 'session-a'))!
      ) as DevLayoutPreferencesV2
      const savedB = JSON.parse(
        values.get(layoutStorageKeyV2(scope, 'project-a', 'session-b'))!
      ) as DevLayoutPreferencesV2
      expect(savedA.utility.find((item) => item.pane === 'devices')?.visible).toBe(true)
      expect(savedA.utility.find((item) => item.pane === 'browser')?.visible).toBe(false)
      expect(savedB.utility.find((item) => item.pane === 'history')?.visible).toBe(true)
    }
  })

  test('exposes failed module loading and supports an explicit retry', async () => {
    const { storage } = memoryStorage()
    let attempts = 0
    const retry = deferred<LayoutStorageModule>()
    const testOwner = createOwner(storage, () => {
      attempts += 1
      return attempts === 1 ? Promise.reject(new Error('chunk unavailable')) : retry.promise
    })
    const { owner } = testOwner
    testOwner.bind()
    await waitForLayoutState(owner, 'unavailable')
    expect(owner.layoutLoadState()).toBe('unavailable')
    expect(owner.layoutLoadRevision()).toBe(0)
    owner.showUtilityPane('history')
    expect(owner.retryLayoutStorage()).toBe(true)
    expect(owner.retryLayoutStorage()).toBe(false)
    await testOwner.waitForLoaderCall(2)
    retry.resolve(await layoutModule())
    await waitForLayoutRevision(owner, 1)
    expect(owner.layoutLoadState()).toBe('empty')
    expect(owner.layoutLoadRevision()).toBe(1)
    expect(owner.preferences()?.utility.find((item) => item.pane === 'history')?.visible).toBe(true)
    testOwner.dispose()
  })
})
