import { describe, expect, test } from 'bun:test'
import { createRoot, createSignal } from 'solid-js'

import type { DevCommand, Scope } from '@adea-ai/types/dev-runtime'
import type { DevRuntimeService } from '../src/platform'
import { createSharedDevUtilityOwner } from '../src/utility-owner'

const originalScope: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const archivedSession = {
  id: 'session-archived',
  scope: originalScope,
  projectId: 'project-archived',
  repoId: 'repo-archived',
  worktreeId: 'worktree-archived',
  displayName: 'Archived cross-view session',
  archived: true,
  projection: 'structured',
  generation: 12,
  version: 6,
}
const secondArchivedSession = {
  ...archivedSession,
  id: 'session-archived-second',
  projectId: 'project-archived-second',
  displayName: 'Second archived session',
  generation: 14,
}

function createHarness(
  execute: DevRuntimeService['execute'],
  options: {
    ready?: Promise<void>
    initialScope?: Scope | null
    state?: DevRuntimeService['state']
  } = {}
) {
  const [activeScope, setActiveScope] = createSignal<Scope | undefined>(
    options.initialScope === null ? undefined : (options.initialScope ?? originalScope)
  )
  const runtime: DevRuntimeService = {
    ...(options.ready ? { ready: options.ready } : {}),
    state: options.state ?? (() => ({ status: 'ready' })),
    preferenceScope: activeScope,
    capabilitySnapshot: async (scope) => ({
      scope,
      granted: [],
      unavailable: [],
      channelGeneration: 1,
      observedAt: new Date(0).toISOString(),
    }),
    execute,
  }
  let disposeRoot: (() => void) | undefined
  const owner = createRoot((dispose) => {
    disposeRoot = dispose
    return createSharedDevUtilityOwner(runtime)
  })
  return {
    owner,
    setScope(scope: Scope | undefined) {
      setActiveScope(scope)
    },
    dispose() {
      owner.dispose()
      disposeRoot?.()
    },
  }
}

function operationStartedSignal() {
  let notify: (() => void) | undefined
  const promise = new Promise<void>((resolve) => {
    notify = resolve
  })
  return { promise, notify: () => notify?.() }
}

describe('shared archive utility owner', () => {
  test('restores a Chat/Virtual archive with the row scope and exact session generation', async () => {
    const commands: DevCommand[] = []
    const harness = createHarness(async (command) => {
      commands.push(command)
      const value =
        command.operation === 'dev.session.list'
          ? { items: [archivedSession] }
          : command.operation === 'dev.session.get'
            ? archivedSession
            : {
                id: 'archive-record',
                scope: originalScope,
                runtimeSessionId: archivedSession.id,
                worktreeId: archivedSession.worktreeId,
                state: 'restored',
                archivedAt: '2026-10-03T00:00:00.000Z',
                archivedBy: 'test',
                generation: archivedSession.generation,
                restoredAt: '2026-10-03T00:00:01.000Z',
              }
      return {
        schemaVersion: 1,
        operation: command.operation,
        requestId: command.requestId,
        ok: true,
        value,
      } as never
    })

    harness.owner.setView('virtual')
    expect(harness.owner.context().runtimeSessionId).toBeUndefined()
    expect(await harness.owner.refreshArchiveShelf()).toBe(true)
    expect(harness.owner.archiveShelf().items).toEqual([
      expect.objectContaining({ id: archivedSession.id, generation: archivedSession.generation }),
    ])
    expect(await harness.owner.restoreArchivedSession(archivedSession.id)).toBe(true)

    const [list, get, unarchive] = commands
    expect(list).toMatchObject({
      operation: 'dev.session.list',
      scope: originalScope,
      body: { archived: true, limit: 500 },
    })
    expect(get).toMatchObject({
      operation: 'dev.session.get',
      scope: originalScope,
      body: { runtimeSessionId: archivedSession.id },
      resource: {
        kind: 'runtime_session',
        id: archivedSession.id,
        generation: archivedSession.generation,
      },
    })
    expect(unarchive).toMatchObject({
      operation: 'dev.session.unarchive',
      scope: originalScope,
      body: {
        runtimeSessionId: archivedSession.id,
        expectedGeneration: archivedSession.generation,
      },
      resource: {
        kind: 'runtime_session',
        id: archivedSession.id,
        generation: archivedSession.generation,
      },
    })
    expect(harness.owner.archiveShelf().items).toEqual([])
    harness.dispose()
  })

  for (const worktreeId of [undefined, '', { id: 'worktree-archived' }]) {
    test(`does not unarchive a session with an invalid worktree binding: ${JSON.stringify(worktreeId)}`, async () => {
      const commands: DevCommand[] = []
      const harness = createHarness(async (command) => {
        commands.push(command)
        if (command.operation === 'dev.session.unarchive')
          throw new Error('An incomplete session must not be unarchived')
        return {
          schemaVersion: 1,
          operation: command.operation,
          requestId: command.requestId,
          ok: true,
          value:
            command.operation === 'dev.session.list'
              ? { items: [archivedSession] }
              : { ...archivedSession, worktreeId },
        } as never
      })
      harness.owner.setView('chat')
      expect(await harness.owner.refreshArchiveShelf()).toBe(true)
      expect(await harness.owner.restoreArchivedSession(archivedSession.id)).toBe(false)
      expect(commands.map((command) => command.operation)).toEqual([
        'dev.session.list',
        'dev.session.get',
      ])
      expect(harness.owner.archiveHandoffMessage()).toContain('archived session changed')
      expect(harness.owner.archiveShelf().items).toHaveLength(1)
      harness.dispose()
    })
  }

  test('follows archive cursors and validates rows from every page', async () => {
    const commands: DevCommand[] = []
    const harness = createHarness(async (command) => {
      commands.push(command)
      const firstPage = command.body.cursor === undefined
      return {
        schemaVersion: 1,
        operation: command.operation,
        requestId: command.requestId,
        ok: true,
        value: firstPage
          ? { items: [archivedSession], nextCursor: 'page-token-1' }
          : { items: [secondArchivedSession] },
      } as never
    })
    harness.owner.setView('virtual')

    expect(await harness.owner.refreshArchiveShelf()).toBe(true)
    expect(commands).toHaveLength(2)
    expect(commands[0]).toMatchObject({
      scope: originalScope,
      body: { archived: true, limit: 500 },
    })
    expect(commands[1]).toMatchObject({
      scope: originalScope,
      body: { archived: true, limit: 500, cursor: 'page-token-1' },
    })
    expect(harness.owner.archiveShelf().items.map((item) => item.id)).toEqual([
      archivedSession.id,
      secondArchivedSession.id,
    ])
    harness.dispose()
  })

  test('does not mark a later page with a mismatched session scope complete', async () => {
    const commands: DevCommand[] = []
    const harness = createHarness(async (command) => {
      commands.push(command)
      return {
        schemaVersion: 1,
        operation: command.operation,
        requestId: command.requestId,
        ok: true,
        value:
          command.body.cursor === undefined
            ? { items: [archivedSession], nextCursor: 'page-token-1' }
            : {
                items: [
                  {
                    ...secondArchivedSession,
                    scope: {
                      ...originalScope,
                      runtimeNodeId: '00000000-0000-4000-8000-000000000004',
                    },
                  },
                ],
              },
      } as never
    })
    harness.owner.setView('chat')

    expect(await harness.owner.refreshArchiveShelf()).toBe(false)
    expect(commands).toHaveLength(2)
    expect(harness.owner.archiveShelf().status).toBe('error')
    expect(harness.owner.archiveShelf().items).toEqual([])
    expect(harness.owner.archiveShelf().reason).toContain('mismatched scope')
    harness.dispose()
  })

  test('reports repeated cursors instead of presenting a partial archive listing as complete', async () => {
    const commands: DevCommand[] = []
    const harness = createHarness(async (command) => {
      commands.push(command)
      return {
        schemaVersion: 1,
        operation: command.operation,
        requestId: command.requestId,
        ok: true,
        value: { items: [archivedSession], nextCursor: 'repeated-token' },
      } as never
    })
    harness.owner.setView('chat')

    expect(await harness.owner.refreshArchiveShelf()).toBe(false)
    expect(commands).toHaveLength(2)
    expect(harness.owner.archiveShelf().status).toBe('error')
    expect(harness.owner.archiveShelf().items).toEqual([])
    expect(harness.owner.archiveShelf().reason).toContain('repeated')
    harness.dispose()
  })

  test('reports an incomplete archive listing when the page cap is reached', async () => {
    const commands: DevCommand[] = []
    const harness = createHarness(async (command) => {
      commands.push(command)
      return {
        schemaVersion: 1,
        operation: command.operation,
        requestId: command.requestId,
        ok: true,
        value: { items: [], nextCursor: `page-token-${commands.length}` },
      } as never
    })
    harness.owner.setView('virtual')

    expect(await harness.owner.refreshArchiveShelf()).toBe(false)
    expect(commands).toHaveLength(20)
    expect(harness.owner.archiveShelf().status).toBe('error')
    expect(harness.owner.archiveShelf().reason).toContain('may be incomplete')
    harness.dispose()
  })

  test('does not publish an archive page returned after its runtime scope changes', async () => {
    const commands: DevCommand[] = []
    const listStarted = operationStartedSignal()
    let resolveList:
      | ((value: Awaited<ReturnType<DevRuntimeService['execute']>>) => void)
      | undefined
    const harness = createHarness(
      (command) =>
        new Promise<Awaited<ReturnType<DevRuntimeService['execute']>>>((resolve) => {
          commands.push(command)
          resolveList = resolve
          listStarted.notify()
        })
    )
    harness.owner.setView('chat')
    const pending = harness.owner.refreshArchiveShelf()
    await listStarted.promise
    expect(commands).toHaveLength(1)

    harness.setScope({
      ...originalScope,
      runtimeNodeId: '00000000-0000-4000-8000-000000000004',
    })
    resolveList?.({
      schemaVersion: 1,
      operation: 'dev.session.list',
      requestId: commands[0]!.requestId,
      ok: true,
      value: { items: [archivedSession] },
    } as never)

    expect(await pending).toBe(false)
    expect(harness.owner.archiveShelf().items).toEqual([])
    harness.dispose()
  })

  test('does not publish an archive page returned after the active view changes', async () => {
    const commands: DevCommand[] = []
    const listStarted = operationStartedSignal()
    let resolveList:
      | ((value: Awaited<ReturnType<DevRuntimeService['execute']>>) => void)
      | undefined
    const harness = createHarness(
      (command) =>
        new Promise<Awaited<ReturnType<DevRuntimeService['execute']>>>((resolve) => {
          commands.push(command)
          resolveList = resolve
          listStarted.notify()
        })
    )
    harness.owner.setView('chat')
    const pending = harness.owner.refreshArchiveShelf()
    await listStarted.promise
    expect(commands).toHaveLength(1)

    harness.owner.setView('virtual')
    resolveList?.({
      schemaVersion: 1,
      operation: 'dev.session.list',
      requestId: commands[0]!.requestId,
      ok: true,
      value: { items: [archivedSession] },
    } as never)

    expect(await pending).toBe(false)
    expect(harness.owner.archiveShelf().items).toEqual([])
    harness.dispose()
  })

  test('does not dispatch the lazy archive operation after a hidden-view roundtrip', async () => {
    const commands: DevCommand[] = []
    const harness = createHarness(async (command) => {
      commands.push(command)
      return {
        schemaVersion: 1,
        operation: command.operation,
        requestId: command.requestId,
        ok: true,
        value: { items: [archivedSession] },
      } as never
    })
    harness.owner.setView('chat')

    const pending = harness.owner.refreshArchiveShelf()
    // The owner first awaits runtime readiness, then awaits the lazy module.
    // Yield once so the fence is captured and module import is in flight.
    await Promise.resolve()
    harness.owner.setView('workspace')
    harness.owner.setView('chat')

    expect(await pending).toBe(false)
    expect(commands).toEqual([])
    expect(harness.owner.archiveShelf().items).toEqual([])
    harness.dispose()
  })

  test('does not dispatch a ready-delayed archive operation after a hidden-view roundtrip', async () => {
    const commands: DevCommand[] = []
    let resolveReady: (() => void) | undefined
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve
    })
    const harness = createHarness(
      async (command) => {
        commands.push(command)
        return {
          schemaVersion: 1,
          operation: command.operation,
          requestId: command.requestId,
          ok: true,
          value: { items: [archivedSession] },
        } as never
      },
      { ready }
    )
    harness.owner.setView('chat')

    const pending = harness.owner.refreshArchiveShelf()
    harness.owner.setView('workspace')
    harness.owner.setView('chat')
    resolveReady?.()

    expect(await pending).toBe(false)
    expect(commands).toEqual([])
    expect(harness.owner.archiveShelf().items).toEqual([])
    harness.dispose()
  })

  test('does not recapture an existing scope after an observed scope ABA during readiness', async () => {
    const commands: DevCommand[] = []
    let resolveReady: (() => void) | undefined
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve
    })
    const harness = createHarness(
      async (command) => {
        commands.push(command)
        return {
          schemaVersion: 1,
          operation: command.operation,
          requestId: command.requestId,
          ok: true,
          value: { items: [archivedSession] },
        } as never
      },
      { ready }
    )
    harness.owner.setView('chat')

    const pending = harness.owner.refreshArchiveShelf()
    harness.setScope({ ...originalScope, runtimeNodeId: '00000000-0000-4000-8000-000000000004' })
    harness.setScope(originalScope)
    resolveReady?.()

    expect(await pending).toBe(false)
    expect(commands).toEqual([])
    expect(harness.owner.archiveShelf().items).toEqual([])
    harness.dispose()
  })

  test('loads the first scope published by runtime readiness when the view is unchanged', async () => {
    const commands: DevCommand[] = []
    let resolveReady: (() => void) | undefined
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve
    })
    const harness = createHarness(
      async (command) => {
        commands.push(command)
        return {
          schemaVersion: 1,
          operation: command.operation,
          requestId: command.requestId,
          ok: true,
          value: { items: [archivedSession] },
        } as never
      },
      { ready, initialScope: null }
    )
    harness.owner.setView('chat')

    const pending = harness.owner.refreshArchiveShelf()
    expect(commands).toEqual([])
    harness.setScope(originalScope)
    resolveReady?.()

    expect(await pending).toBe(true)
    expect(commands).toHaveLength(1)
    expect(commands[0]).toMatchObject({ operation: 'dev.session.list', scope: originalScope })
    expect(harness.owner.archiveShelf().items).toEqual([
      expect.objectContaining({ id: archivedSession.id }),
    ])
    harness.dispose()
  })

  test('rejects multiple first-scope publications during runtime readiness', async () => {
    const commands: DevCommand[] = []
    let resolveReady: (() => void) | undefined
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve
    })
    const harness = createHarness(
      async (command) => {
        commands.push(command)
        return {
          schemaVersion: 1,
          operation: command.operation,
          requestId: command.requestId,
          ok: true,
          value: { items: [archivedSession] },
        } as never
      },
      { ready, initialScope: null }
    )
    harness.owner.setView('chat')

    const pending = harness.owner.refreshArchiveShelf()
    expect(commands).toEqual([])
    harness.setScope(originalScope)
    harness.setScope({ ...originalScope, runtimeNodeId: '00000000-0000-4000-8000-000000000004' })
    harness.setScope(originalScope)
    resolveReady?.()

    expect(await pending).toBe(false)
    expect(commands).toEqual([])
    expect(harness.owner.archiveShelf().items).toEqual([])
    harness.dispose()
  })

  test('loads an unchanged scope when runtime readiness makes its channel available', async () => {
    const commands: DevCommand[] = []
    let availability: ReturnType<DevRuntimeService['state']> = {
      status: 'unavailable',
      reason: 'channel_unauthenticated',
    }
    let resolveReady: (() => void) | undefined
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve
    })
    const harness = createHarness(
      async (command) => {
        commands.push(command)
        return {
          schemaVersion: 1,
          operation: command.operation,
          requestId: command.requestId,
          ok: true,
          value: { items: [archivedSession] },
        } as never
      },
      { ready, state: () => availability }
    )
    harness.owner.setView('chat')

    const pending = harness.owner.refreshArchiveShelf()
    expect(commands).toEqual([])
    availability = { status: 'ready' }
    resolveReady?.()

    expect(await pending).toBe(true)
    expect(commands).toHaveLength(1)
    expect(commands[0]).toMatchObject({ operation: 'dev.session.list', scope: originalScope })
    expect(harness.owner.archiveShelf().items).toEqual([
      expect.objectContaining({ id: archivedSession.id }),
    ])
    harness.dispose()
  })

  test('does not dispatch a lazy archive operation after an observed scope ABA', async () => {
    const commands: DevCommand[] = []
    const harness = createHarness(async (command) => {
      commands.push(command)
      return {
        schemaVersion: 1,
        operation: command.operation,
        requestId: command.requestId,
        ok: true,
        value: { items: [archivedSession] },
      } as never
    })
    harness.owner.setView('chat')

    const pending = harness.owner.refreshArchiveShelf()
    await Promise.resolve()
    harness.setScope({ ...originalScope, runtimeNodeId: '00000000-0000-4000-8000-000000000004' })
    harness.setScope(originalScope)

    expect(await pending).toBe(false)
    expect(commands).toEqual([])
    expect(harness.owner.archiveShelf().items).toEqual([])
    harness.dispose()
  })

  test('clears the previous scope shelf while the next scoped listing is pending', async () => {
    const commands: DevCommand[] = []
    const nextListStarted = operationStartedSignal()
    let resolveNextList:
      | ((value: Awaited<ReturnType<DevRuntimeService['execute']>>) => void)
      | undefined
    const harness = createHarness((command) => {
      commands.push(command)
      if (commands.length === 1)
        return Promise.resolve({
          schemaVersion: 1,
          operation: 'dev.session.list',
          requestId: command.requestId,
          ok: true,
          value: { items: [archivedSession] },
        } as never)
      return new Promise<Awaited<ReturnType<DevRuntimeService['execute']>>>((resolve) => {
        resolveNextList = resolve
        nextListStarted.notify()
      })
    })
    harness.owner.setView('chat')
    expect(await harness.owner.refreshArchiveShelf()).toBe(true)
    expect(harness.owner.archiveShelf().items).toHaveLength(1)

    const nextScope = {
      ...originalScope,
      runtimeNodeId: '00000000-0000-4000-8000-000000000004',
    }
    harness.setScope(nextScope)
    const pending = harness.owner.refreshArchiveShelf()
    await nextListStarted.promise
    expect(commands).toHaveLength(2)
    expect(harness.owner.archiveShelf().items).toEqual([])

    resolveNextList?.({
      schemaVersion: 1,
      operation: 'dev.session.list',
      requestId: commands[1]!.requestId,
      ok: true,
      value: { items: [] },
    } as never)
    expect(await pending).toBe(true)
    expect(harness.owner.archiveShelf().items).toEqual([])
    harness.dispose()
  })

  for (const transition of ['runtime scope change', 'hidden surface roundtrip'] as const) {
    test(`does not unarchive after a ${transition} between get and restore`, async () => {
      const commands: DevCommand[] = []
      const getStarted = operationStartedSignal()
      let resolveGet:
        | ((value: Awaited<ReturnType<DevRuntimeService['execute']>>) => void)
        | undefined
      const harness = createHarness((command) => {
        commands.push(command)
        if (command.operation === 'dev.session.list')
          return Promise.resolve({
            schemaVersion: 1,
            operation: command.operation,
            requestId: command.requestId,
            ok: true,
            value: { items: [archivedSession] },
          } as never)
        if (command.operation === 'dev.session.get')
          return new Promise<Awaited<ReturnType<DevRuntimeService['execute']>>>((resolve) => {
            resolveGet = resolve
            getStarted.notify()
          })
        throw new Error(`Unexpected operation: ${command.operation}`)
      })
      const activeView = transition === 'hidden surface roundtrip' ? 'virtual' : 'chat'
      harness.owner.setView(activeView)
      expect(await harness.owner.refreshArchiveShelf()).toBe(true)

      const pending = harness.owner.restoreArchivedSession(archivedSession.id)
      await getStarted.promise
      expect(commands.map((command) => command.operation)).toEqual([
        'dev.session.list',
        'dev.session.get',
      ])
      if (transition === 'hidden surface roundtrip') {
        harness.owner.setView('workspace')
        expect(await harness.owner.refreshArchiveShelf()).toBe(false)
        expect(await harness.owner.restoreArchivedSession(archivedSession.id)).toBe(false)
        harness.owner.setView(activeView)
      } else
        harness.setScope({
          ...originalScope,
          runtimeNodeId: '00000000-0000-4000-8000-000000000004',
        })
      resolveGet?.({
        schemaVersion: 1,
        operation: 'dev.session.get',
        requestId: commands[1]!.requestId,
        ok: true,
        value: archivedSession,
      } as never)

      expect(await pending).toBe(false)
      expect(commands.map((command) => command.operation)).toEqual([
        'dev.session.list',
        'dev.session.get',
      ])
      harness.dispose()
    })
  }
})
