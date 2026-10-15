import { describe, expect, spyOn, test } from 'bun:test'

import type { NativeSessionInventorySource } from '@adea-ai/db'
import type { DevRuntimeService } from '@adea-ai/dev-view/platform'
import type { DevCommand, DevReply, RuntimeSession, Scope } from '@adea-ai/types/dev-runtime'

import { createDesktopNativeSessionInventorySource } from '../src/lib/desktop-dev-runtime'

const SCOPE: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
  workspaceId: '00000000-0000-4000-8000-000000000002',
}

const SESSION: RuntimeSession = {
  archived: false,
  generation: 1,
  id: '00000000-0000-4000-8000-000000000040',
  lifecycle: 'ready',
  projectId: '00000000-0000-4000-8000-000000000020',
  projection: 'structured',
  repoId: '00000000-0000-4000-8000-000000000030',
  scope: SCOPE,
  version: 1,
  worktreeId: '00000000-0000-4000-8000-000000000050',
}
const SECOND_SESSION: RuntimeSession = {
  ...SESSION,
  id: '00000000-0000-4000-8000-000000000041',
}

function service(
  options: {
    execute?: (command: DevCommand) => Promise<DevReply>
    scope?: Scope
    status?: 'ready' | 'unavailable'
  } = {}
): Pick<DevRuntimeService, 'execute' | 'preferenceScope' | 'state'> {
  return {
    execute:
      options.execute ??
      (async (command) =>
        ({
          schemaVersion: 1,
          operation: command.operation,
          requestId: command.requestId,
          ok: true,
          value: { items: [SESSION], observedAt: '2026-10-15T00:00:00.000Z' },
          observedAt: '2026-10-15T00:00:00.000Z',
        }) as DevReply),
    preferenceScope: () => options.scope ?? SCOPE,
    state: () =>
      options.status === 'unavailable'
        ? { status: 'unavailable', reason: 'unavailable' }
        : { status: 'ready' },
  }
}

describe('desktop native session inventory source', () => {
  test('uses the authenticated service scope and canonical paged read', async () => {
    const commands: DevCommand[] = []
    const runtime = service({
      execute: async (command) => {
        commands.push(command)
        const body = command.body as { cursor?: string; limit?: number }
        const privateSessionFields = {
          ...(body.cursor === undefined ? SESSION : SECOND_SESSION),
          displayName: 'private display label',
          taskId: 'private-task-id',
          terminalId: 'private-terminal-id',
        }
        return {
          schemaVersion: 1,
          operation: command.operation,
          requestId: command.requestId,
          ok: true,
          value: {
            items: [privateSessionFields],
            ...(body.cursor === undefined ? { nextCursor: SESSION.id } : {}),
            observedAt: '2026-10-15T00:00:00.000Z',
          },
          observedAt: '2026-10-15T00:00:00.000Z',
        } as DevReply
      },
    })
    const inventory: NativeSessionInventorySource | undefined =
      createDesktopNativeSessionInventorySource(runtime)
    expect(inventory?.authorizedScopes).toEqual([SCOPE])

    const first = await inventory!.listRuntimeSessions({ limit: 2 })
    const second = await inventory!.listRuntimeSessions({ cursor: first.nextCursor, limit: 2 })
    expect(first).toMatchObject({
      items: [
        {
          id: SESSION.id,
          projectId: SESSION.projectId,
          scope: SCOPE,
          worktreeId: SESSION.worktreeId,
        },
      ],
      nextCursor: SESSION.id,
    })
    for (const field of ['displayName', 'taskId', 'terminalId', 'repoId', 'projection']) {
      expect(first.items[0]).not.toHaveProperty(field)
    }
    expect(second).toMatchObject({ items: [{ id: SECOND_SESSION.id, scope: SCOPE }] })
    expect(commands.map(({ operation, scope, body }) => ({ operation, scope, body }))).toEqual([
      { operation: 'dev.session.list', scope: SCOPE, body: { limit: 2 } },
      {
        operation: 'dev.session.list',
        scope: SCOPE,
        body: { cursor: SESSION.id, limit: 2 },
      },
    ])
  })

  test('an unavailable or unbound runtime produces no source instead of an empty inventory', () => {
    expect(createDesktopNativeSessionInventorySource(service({ status: 'unavailable' }))).toBe(
      undefined
    )
    expect(
      createDesktopNativeSessionInventorySource({
        ...service(),
        preferenceScope: () => undefined,
      })
    ).toBeUndefined()
  })

  test('a changed authenticated scope refuses the read before dispatch', async () => {
    let currentScope: Scope | undefined = SCOPE
    const commands: DevCommand[] = []
    const runtime = {
      ...service(),
      preferenceScope: () => currentScope,
      execute: async (command: DevCommand) => {
        commands.push(command)
        return service().execute(command)
      },
    }
    const inventory = createDesktopNativeSessionInventorySource(runtime)
    currentScope = { ...SCOPE, workspaceId: '00000000-0000-4000-8000-000000000099' }

    await expect(inventory!.listRuntimeSessions({ limit: 1 })).rejects.toThrow()
    expect(commands).toEqual([])
  })

  test('a workspace switch during a read refuses the old-scope reply', async () => {
    let currentScope: Scope = SCOPE
    const runtime = service({
      execute: async (command) => {
        currentScope = { ...SCOPE, workspaceId: '00000000-0000-4000-8000-000000000099' }
        return {
          schemaVersion: 1,
          operation: command.operation,
          requestId: command.requestId,
          ok: true,
          value: { items: [SESSION], observedAt: '2026-10-15T00:00:00.000Z' },
          observedAt: '2026-10-15T00:00:00.000Z',
        } as DevReply
      },
    })
    const inventory = createDesktopNativeSessionInventorySource({
      ...runtime,
      preferenceScope: () => currentScope,
    })

    await expect(inventory!.listRuntimeSessions({ limit: 1 })).rejects.toThrow(/scope changed/i)
  })

  test('rejects invalid or oversized pages and requests without exceeding the runtime limit', async () => {
    const commands: DevCommand[] = []
    const inventory = createDesktopNativeSessionInventorySource(
      service({
        execute: async (command) => {
          commands.push(command)
          return {
            schemaVersion: 1,
            operation: command.operation,
            requestId: command.requestId,
            ok: true,
            value: {
              items: [SESSION, { ...SESSION, id: '00000000-0000-4000-8000-000000000041' }],
              observedAt: '2026-10-15T00:00:00.000Z',
            },
            observedAt: '2026-10-15T00:00:00.000Z',
          } as DevReply
        },
      })
    )

    await expect(inventory!.listRuntimeSessions({ limit: 501 })).rejects.toThrow()
    await expect(inventory!.listRuntimeSessions({ limit: 1 })).rejects.toThrow()
    expect(commands).toHaveLength(1)
    expect((commands[0]!.body as { limit: number }).limit).toBe(1)
  })

  test('rejects malformed, foreign-scope, and duplicate replies as unknown-source failures', async () => {
    const malformed = createDesktopNativeSessionInventorySource(
      service({
        execute: async (command) =>
          ({
            schemaVersion: 1,
            operation: command.operation,
            requestId: command.requestId,
            ok: true,
            value: { items: 'not-an-array', observedAt: '2026-10-15T00:00:00.000Z' },
            observedAt: '2026-10-15T00:00:00.000Z',
          }) as DevReply,
      })
    )
    await expect(malformed!.listRuntimeSessions({ limit: 1 })).rejects.toThrow(/malformed/i)

    const emptyContinuation = createDesktopNativeSessionInventorySource(
      service({
        execute: async (command) =>
          ({
            schemaVersion: 1,
            operation: command.operation,
            requestId: command.requestId,
            ok: true,
            value: {
              items: [],
              nextCursor: SESSION.id,
              observedAt: '2026-10-15T00:00:00.000Z',
            },
            observedAt: '2026-10-15T00:00:00.000Z',
          }) as DevReply,
      })
    )
    await expect(emptyContinuation!.listRuntimeSessions({ limit: 1 })).rejects.toThrow(
      /empty page/i
    )

    for (const items of [
      [
        {
          ...SESSION,
          scope: { ...SCOPE, workspaceId: '00000000-0000-4000-8000-000000000099' },
        },
      ],
      [SESSION, SESSION],
    ]) {
      const inventory = createDesktopNativeSessionInventorySource(
        service({
          execute: async (command) =>
            ({
              schemaVersion: 1,
              operation: command.operation,
              requestId: command.requestId,
              ok: true,
              value: { items, observedAt: '2026-10-15T00:00:00.000Z' },
              observedAt: '2026-10-15T00:00:00.000Z',
            }) as DevReply,
        })
      )
      await expect(inventory!.listRuntimeSessions({ limit: 2 })).rejects.toThrow(
        /identity|bound scope/i
      )
    }
  })

  test('a runtime refusal is not converted into an empty successful page', async () => {
    const inventory = createDesktopNativeSessionInventorySource(
      service({
        execute: async (command) =>
          ({
            schemaVersion: 1,
            operation: command.operation,
            requestId: command.requestId,
            ok: false,
            error: {
              code: 'unavailable',
              retryable: true,
              message: 'private host detail',
              observedAt: '2026-10-15T00:00:00.000Z',
            },
          }) as DevReply,
      })
    )
    await expect(inventory!.listRuntimeSessions({ limit: 1 })).rejects.toThrow(
      'desktop session inventory read is unavailable'
    )
  })

  test('a transport exception does not expose private host details', async () => {
    const inventory = createDesktopNativeSessionInventorySource(
      service({ execute: async () => Promise.reject(new Error('/private/home/amf/session.db')) })
    )
    await expect(inventory!.listRuntimeSessions({ limit: 1 })).rejects.toThrow(
      'desktop session inventory read is unavailable'
    )
  })

  test('a stalled read fails within its configured deadline', async () => {
    const inventory = createDesktopNativeSessionInventorySource(
      service({ execute: async () => new Promise<DevReply>(() => undefined) }),
      { timeoutMs: 5 }
    )
    await expect(inventory!.listRuntimeSessions({ limit: 1 })).rejects.toThrow(/timed out/i)
  })

  test('clears its read deadline and consumes a late transport rejection', async () => {
    const clearTimeoutSpy = spyOn(globalThis, 'clearTimeout')
    try {
      const fast = createDesktopNativeSessionInventorySource(
        service({ execute: async (command) => service().execute(command) }),
        { timeoutMs: 100 }
      )
      await fast!.listRuntimeSessions({ limit: 1 })
      expect(clearTimeoutSpy).toHaveBeenCalled()
    } finally {
      clearTimeoutSpy.mockRestore()
    }

    let rejectTransport: ((reason: Error) => void) | undefined
    const stalled = createDesktopNativeSessionInventorySource(
      service({
        execute: async () =>
          new Promise<DevReply>((_, reject) => {
            rejectTransport = reject
          }),
      }),
      { timeoutMs: 5 }
    )
    await expect(stalled!.listRuntimeSessions({ limit: 1 })).rejects.toThrow(/timed out/i)
    rejectTransport?.(new Error('late private transport failure'))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
})
