import { describe, expect, test } from 'bun:test'
import { createRoot } from 'solid-js'

import type { DevRuntimeService } from '../src/platform'
import {
  createDevUtilityContext,
  createDevUtilityFenceSource,
  type DevUtilityContextInput,
} from '../src/utility-context'
import { createSharedDevUtilityOwner } from '../src/utility-owner'
import { layoutStorageKeyV2 } from '../src/layout/persistence'

const scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
let activeScope = scope

const fixtureRuntime = runtime()

function runtime(): DevRuntimeService {
  return {
    state: () => ({ status: 'ready' }),
    preferenceScope: () => activeScope,
    capabilitySnapshot: async (activeScope) => ({
      scope: activeScope,
      granted: [],
      unavailable: [],
      channelGeneration: 1,
      observedAt: new Date(0).toISOString(),
    }),
    execute: async () => {
      throw new Error('unused')
    },
  }
}

function sessionContext(
  runtimeSessionId = 'session-a',
  sessionGeneration = 1
): DevUtilityContextInput {
  return {
    view: 'dev',
    runtime: fixtureRuntime,
    scope,
    projectId: 'project-a',
    runtimeSessionId,
    sessionGeneration,
    worktreeId: 'worktree-a',
  }
}

function createTestOwner(storage?: Parameters<typeof createSharedDevUtilityOwner>[1]) {
  let disposeRoot: () => void = () => {}
  const owner = createRoot((dispose) => {
    disposeRoot = dispose
    return createSharedDevUtilityOwner(fixtureRuntime, storage)
  })
  return {
    owner,
    dispose() {
      owner.dispose()
      disposeRoot()
    },
  }
}

describe('Dev utility request context', () => {
  test('monotonically revises context across an A to B to A session switch', () => {
    let value = sessionContext()
    const read = createDevUtilityContext(() => value)

    const first = read()
    value = sessionContext('session-b', 2)
    const second = read()
    value = sessionContext()
    const third = read()

    expect(second.revision).toBeGreaterThan(first.revision)
    expect(third.revision).toBeGreaterThan(second.revision)
  })

  test('invalidates old requests across sessions, generations, scopes, and views', () => {
    let value = sessionContext()
    const read = createDevUtilityContext(() => value)
    const fences = createDevUtilityFenceSource(read)
    const fence = fences.capture('session')!

    value = { ...value, runtimeSessionId: 'session-b', sessionGeneration: 2 }
    expect(fence.isCurrent()).toBe(false)

    const next = fences.capture('session')!
    value = { ...value, view: 'chat' }
    expect(next.isCurrent()).toBe(false)

    const chat = fences.capture('session')!
    value = { ...value, scope: { ...scope, workspaceId: 'workspace-b' } }
    expect(chat.isCurrent()).toBe(false)
  })

  test('does not create a session fence without an authoritative session generation', () => {
    const read = createDevUtilityContext(() => ({
      ...sessionContext(),
      runtimeSessionId: undefined,
      sessionGeneration: undefined,
    }))
    const fences = createDevUtilityFenceSource(read)

    expect(fences.capture('scope')).toBeDefined()
    expect(fences.capture('session')).toBeUndefined()
  })

  test('disposal invalidates deferred work even when the context is unchanged', () => {
    const read = createDevUtilityContext(() => sessionContext())
    const fences = createDevUtilityFenceSource(read)
    const fence = fences.capture('session')!

    fences.dispose()

    expect(fence.isCurrent()).toBe(false)
    expect(fences.capture('session')).toBeUndefined()
  })

  test('the shell owner publishes only explicit canonical Dev and Chat bindings', () => {
    activeScope = scope
    const testOwner = createTestOwner()
    const { owner } = testOwner
    const binding = {
      scope,
      projectId: 'project-a',
      runtimeSessionId: 'session-a',
      sessionGeneration: 4,
      worktreeId: 'worktree-a',
    }

    owner.setView('chat')
    expect(owner.context().runtimeSessionId).toBeUndefined()
    expect(owner.handoffCanonicalChatConversation(binding)).toBe(true)
    expect(owner.context()).toMatchObject({
      view: 'chat',
      projectId: 'project-a',
      runtimeSessionId: 'session-a',
      sessionGeneration: 4,
    })

    owner.setView('virtual')
    expect(owner.context().runtimeSessionId).toBeUndefined()
    expect(owner.handoffCanonicalChatConversation(binding)).toBe(false)

    owner.setView('dev')
    expect(owner.selectDevSession(binding)).toBe(true)
    activeScope = { ...scope, workspaceId: 'workspace-b' }
    expect(owner.context().runtimeSessionId).toBeUndefined()
    testOwner.dispose()
    activeScope = scope
  })

  test('the owner never promotes a room or channel id into a runtime session', () => {
    activeScope = scope
    const testOwner = createTestOwner()
    const { owner } = testOwner
    owner.setView('virtual')

    expect(owner.context()).toMatchObject({ view: 'virtual' })
    expect(owner.context().runtimeSessionId).toBeUndefined()
    expect(
      owner.handoffCanonicalChatConversation({
        scope,
        projectId: 'room-9',
        runtimeSessionId: 'channel-4',
        sessionGeneration: 1,
      })
    ).toBe(false)

    testOwner.dispose()
  })

  test('the shell owner is the scoped V2 writer shared by Chat and Dev', async () => {
    activeScope = scope
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    }
    const binding = {
      scope,
      projectId: 'project-a',
      runtimeSessionId: 'session-a',
      sessionGeneration: 4,
      worktreeId: 'worktree-a',
    }
    const testOwner = createTestOwner(storage)
    const { owner } = testOwner

    owner.setView('chat')
    expect(owner.handoffCanonicalChatConversation(binding)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(owner.layoutLoadRevision()).toBe(1)
    owner.showUtilityPane('history', binding)
    expect(owner.layoutLoadRevision()).toBe(1)
    expect(owner.utilityPreferences().find((item) => item.pane === 'files')?.visible).toBe(true)
    owner.toggleRightUtility(binding)
    expect(owner.utilityPreferences().find((item) => item.pane === 'history')?.visible).toBe(false)
    expect(owner.utilityPreferences().find((item) => item.pane === 'files')?.visible).toBe(true)
    owner.toggleRightUtility(binding)
    expect(owner.utilityPreferences().find((item) => item.pane === 'history')?.visible).toBe(true)
    owner.setView('dev')
    expect(owner.selectDevSession(binding)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(owner.utilityPreferences().find((item) => item.pane === 'history')?.visible).toBe(true)
    testOwner.dispose()

    const stored = values.get(layoutStorageKeyV2(scope, 'project-a', 'session-a'))
    expect(stored).toBeDefined()
    const document = JSON.parse(stored!) as {
      runtimeSessionId: string
      utility: readonly { pane: string; visible: boolean }[]
    }
    expect(document.runtimeSessionId).toBe('session-a')
    expect(document.utility.find((item) => item.pane === 'history')?.visible).toBe(true)
    expect([...values.keys()]).toEqual([layoutStorageKeyV2(scope, 'project-a', 'session-a')])
    activeScope = scope
  })

  test('sessionless Virtual keeps utility visibility without writing a session document', () => {
    activeScope = scope
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    }
    const testOwner = createTestOwner(storage)
    const { owner } = testOwner

    owner.setView('virtual')
    owner.showUtilityPane('devices', null)

    expect(owner.context().runtimeSessionId).toBeUndefined()
    expect(owner.rightUtilityOpen()).toBe(true)
    owner.toggleRightUtility(null)
    expect(owner.rightUtilityOpen()).toBe(false)
    expect(owner.utilityPreferences().find((item) => item.pane === 'files')?.visible).toBe(true)
    owner.toggleRightUtility(null)
    expect(values.size).toBe(0)
    testOwner.dispose()
  })

  test('a utility opened before Chat attaches stays open after canonical handoff', async () => {
    activeScope = scope
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    }
    const binding = {
      scope,
      projectId: 'project-a',
      runtimeSessionId: 'session-a',
      sessionGeneration: 4,
      worktreeId: 'worktree-a',
    }
    const testOwner = createTestOwner(storage)
    const { owner } = testOwner

    owner.setView('chat')
    owner.showUtilityPane('devices', null)
    expect(owner.rightUtilityOpen()).toBe(true)
    expect(owner.handoffCanonicalChatConversation(binding)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(owner.utilityPreferences().find((item) => item.pane === 'devices')?.visible).toBe(true)
    testOwner.dispose()
    activeScope = scope
  })
})
