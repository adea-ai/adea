/*
 * The desktop push-event surface (M12): `DevRuntimeService.events()` as built
 * from the injected bridge. The surface subscribes through the bridge's
 * signed listen path only when the scope's capability snapshot grants
 * `dev.git.read` (fail closed), structurally validates every SSE payload
 * before delivery (transport bytes are untrusted; a malformed frame is
 * dropped, never trusted), and unsubscribes idempotently — including before
 * the async listen bind resolves. Without the bridge seam the surface is
 * undefined and panes keep generation-fenced pull.
 */
import { describe, expect, test } from 'bun:test'
import type { DevReply } from '@adea-ai/types/dev-runtime'

import type { DesktopShell } from '../src/lib/desktop-bridge'
import {
  createDesktopEventSurface,
  decodeStatusInvalidated,
  GIT_STATUS_INVALIDATED_EVENT,
} from '../src/lib/desktop-dev-runtime'

const scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}

const VALID_EVENT = {
  worktreeId: 'wt-1',
  generation: 4,
  revision: 2,
  reason: 'tree_changed',
}

type FakeBridge = {
  bridge: DesktopShell
  listened: string[]
  /** Delivers a raw SSE-decoded payload to the registered handler. */
  emit: (payload: unknown) => void
  closeLast: () => void
}

function fakeBridge(): FakeBridge {
  const listened: string[] = []
  let handler: ((payload: unknown) => void) | undefined
  let disposer: (() => void) | undefined
  const bridge = {
    invoke: () => Promise.resolve(),
    listen: (event: string, onEvent: (payload: unknown) => void) => {
      listened.push(event)
      handler = onEvent
      disposer = (() => {
        handler = undefined
      }) as () => void
      return Promise.resolve(disposer)
    },
  } as unknown as DesktopShell
  return {
    bridge,
    listened,
    emit: (payload) => handler?.({ payload }),
    closeLast: () => disposer?.(),
  }
}

/** An execute seam whose capability snapshot grants exactly the listed set. */
function executeWithGrants(granted: readonly string[]): (command: DevCommand) => Promise<DevReply> {
  return (command) =>
    Promise.resolve({
      schemaVersion: 1,
      operation: command.operation,
      requestId: command.requestId,
      ok: true,
      value: { scope, granted, unavailable: [], channelGeneration: 1, observedAt: '' },
      observedAt: '',
    })
}

function waitMicrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('decodeStatusInvalidated structural guard', () => {
  test('accepts the typed payload and tolerates additive fields', () => {
    expect(decodeStatusInvalidated(VALID_EVENT)).toEqual(VALID_EVENT)
    expect(decodeStatusInvalidated({ ...VALID_EVENT, futureField: true })).toEqual(VALID_EVENT)
    expect(decodeStatusInvalidated({ ...VALID_EVENT, reason: 'refenced' })).toMatchObject({
      reason: 'refenced',
    })
  })

  test('drops malformed transport bytes, never trusting them', () => {
    expect(decodeStatusInvalidated(undefined)).toBeUndefined()
    expect(decodeStatusInvalidated('tree_changed')).toBeUndefined()
    expect(decodeStatusInvalidated([])).toBeUndefined()
    expect(decodeStatusInvalidated({ ...VALID_EVENT, worktreeId: '' })).toBeUndefined()
    expect(decodeStatusInvalidated({ ...VALID_EVENT, generation: '4' })).toBeUndefined()
    expect(decodeStatusInvalidated({ ...VALID_EVENT, generation: 1.5 })).toBeUndefined()
    expect(decodeStatusInvalidated({ ...VALID_EVENT, revision: null })).toBeUndefined()
    expect(decodeStatusInvalidated({ ...VALID_EVENT, reason: 'surprise' })).toBeUndefined()
    expect(decodeStatusInvalidated({ reason: 'tree_changed' })).toBeUndefined()
  })
})

describe('createDesktopEventSurface', () => {
  test('is undefined when the bridge predates the listen seam', () => {
    const bridge = { invoke: () => Promise.resolve() } as unknown as DesktopShell
    expect(
      createDesktopEventSurface({ bridge, execute: executeWithGrants(['dev.git.read']) })
    ).toBeUndefined()
  })

  test('subscribes on the signed event path when the capability is granted and delivers typed events', async () => {
    const fake = fakeBridge()
    const surface = createDesktopEventSurface({
      bridge: fake.bridge,
      execute: executeWithGrants(['dev.git.read']),
    })
    if (!surface) throw new Error('surface expected')
    const delivered: unknown[] = []
    const dispose = surface.on('git.statusInvalidated', scope, (event) => delivered.push(event))
    await waitMicrotask()
    expect(fake.listened).toEqual([GIT_STATUS_INVALIDATED_EVENT])
    fake.emit({ garbage: true }) // malformed frame dropped
    fake.emit(VALID_EVENT)
    expect(delivered).toEqual([VALID_EVENT])
    dispose()
    fake.emit(VALID_EVENT) // after unsubscribe: no delivery
    expect(delivered.length).toBe(1)
  })

  test('fail closed: a scope without the git-read capability never subscribes', async () => {
    const fake = fakeBridge()
    const surface = createDesktopEventSurface({
      bridge: fake.bridge,
      execute: executeWithGrants(['dev.appearance.read']),
    })
    if (!surface) throw new Error('surface expected')
    const dispose = surface.on('git.statusInvalidated', scope, () => undefined)
    await waitMicrotask()
    expect(fake.listened).toEqual([])
    dispose()
  })

  test('a failed capability probe never subscribes (fail closed)', async () => {
    const fake = fakeBridge()
    const surface = createDesktopEventSurface({
      bridge: fake.bridge,
      execute: () => Promise.reject(new Error('channel refused')),
    })
    if (!surface) throw new Error('surface expected')
    const dispose = surface.on('git.statusInvalidated', scope, () => undefined)
    await waitMicrotask()
    expect(fake.listened).toEqual([])
    dispose()
  })

  test('an unsubscribed-before-bind surface tears the listener down when the bind lands', async () => {
    const fake = fakeBridge()
    const surface = createDesktopEventSurface({
      bridge: fake.bridge,
      execute: executeWithGrants(['dev.git.read']),
    })
    if (!surface) throw new Error('surface expected')
    const delivered: unknown[] = []
    const dispose = surface.on('git.statusInvalidated', scope, (event) => delivered.push(event))
    dispose() // the capability probe has not resolved yet
    await waitMicrotask()
    expect(delivered).toEqual([])
    // The late-delivered event must not reach the disposed listener.
    fake.emit(VALID_EVENT)
    expect(delivered).toEqual([])
  })
})
