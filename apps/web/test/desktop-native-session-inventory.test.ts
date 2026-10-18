import { describe, expect, spyOn, test } from 'bun:test'
import { readFileSync } from 'node:fs'

import { compareMigrationSnapshots } from '../../../packages/db/src/migration-snapshot-comparator'
import type { NativeSessionInventorySource } from '@adea-ai/types/native-session-inventory'
import type { DevRuntimeService } from '@adea-ai/dev-view/platform'
import { MIGRATION_SNAPSHOT_FORMAT_VERSION, type MigrationSnapshotDocument } from '@adea-ai/types'
import type { DevCommand, DevReply, RuntimeSession, Scope } from '@adea-ai/types/dev-runtime'

import {
  createDesktopDevRuntimeService,
  createDesktopNativeSessionInventoryDiagnosticService,
  createDesktopNativeSessionInventorySource,
} from '../src/lib/desktop-dev-runtime'

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

describe('desktop native session inventory diagnostic caller', () => {
  test('desktop workspace composition passes the bound provider through platform services', () => {
    const composition = readFileSync(
      new URL('../src/components/desktop-workspace-entry.tsx', import.meta.url),
      'utf8'
    )
    const utilityOwner = composition.match(/createSharedDevUtilityOwner\(([\s\S]*?)\n  \)/)?.[1]

    expect(composition).toContain('createDesktopNativeSessionInventoryDiagnosticService(')
    expect(composition).toContain('authorizationContext: () =>')
    expect(composition).toContain('props.session?.sessionId ?? null')
    expect(composition).toContain('props.accountPrincipalId() ?? null')
    expect(composition).not.toContain('props.session?.credential')
    expect(composition).toContain('nativeSessionInventoryDiagnostics,')
    expect(utilityOwner).toBeDefined()
    expect(utilityOwner).not.toContain('nativeSessionInventoryDiagnostics')
  })

  test('captures multiple bounded pages through the authenticated desktop service', async () => {
    const commands: DevCommand[] = []
    const runtime = service({
      execute: async (command) => {
        commands.push(command)
        const body = command.body as { cursor?: string; limit?: number }
        const session = body.cursor === undefined ? SESSION : SECOND_SESSION
        return {
          schemaVersion: 1,
          operation: command.operation,
          requestId: command.requestId,
          ok: true,
          value: {
            items: [
              {
                ...session,
                displayName: 'private label',
                repoId: 'private-repo-id',
                terminalId: 'private-terminal-id',
              },
            ],
            ...(body.cursor === undefined ? { nextCursor: SESSION.id } : {}),
            observedAt: '2026-10-15T00:00:00.000Z',
          },
          observedAt: '2026-10-15T00:00:00.000Z',
        } as DevReply
      },
    })
    const diagnostic = createDesktopNativeSessionInventoryDiagnosticService(runtime)

    const result = await diagnostic.capture({
      workspaceId: SCOPE.workspaceId,
      runtimeNodeId: SCOPE.runtimeNodeId,
    })

    expect(result.status).toBe('captured')
    if (result.status !== 'captured') throw new Error('expected a captured inventory')
    expect(result.section.records.map((record) => record.sessionRef)).toEqual([
      SESSION.id,
      SECOND_SESSION.id,
    ])
    expect(JSON.stringify(result.section)).not.toContain('private label')
    expect(JSON.stringify(result.section)).not.toContain('private-repo-id')
    expect(JSON.stringify(result.section)).not.toContain('private-terminal-id')
    expect(JSON.stringify(result.section)).not.toContain('transcript')
    expect(commands.map((command) => command.operation)).toEqual([
      'dev.session.list',
      'dev.session.list',
    ])
    expect(commands.map((command) => command.scope)).toEqual([SCOPE, SCOPE])
    expect(commands.map((command) => command.body)).toEqual([
      { limit: 500 },
      { cursor: SESSION.id, limit: 500 },
    ])
    expect(result.section.records.length).toBeLessThanOrEqual(result.section.limit ?? 0)
  })

  test('captures stable records again after restart so the migration comparator can compare them', async () => {
    let generation = 1
    const runtime = service({
      execute: async (command) =>
        ({
          schemaVersion: 1,
          operation: command.operation,
          requestId: command.requestId,
          ok: true,
          value: {
            items: [{ ...SESSION, generation }],
            observedAt: '2026-10-15T00:00:00.000Z',
          },
          observedAt: '2026-10-15T00:00:00.000Z',
        }) as DevReply,
    })
    const diagnostic = createDesktopNativeSessionInventoryDiagnosticService(runtime)
    const input = { workspaceId: SCOPE.workspaceId, runtimeNodeId: SCOPE.runtimeNodeId }
    const before = await diagnostic.capture(input)
    generation = 2
    const after = await diagnostic.capture(input)

    expect(before.status).toBe('captured')
    expect(after.status).toBe('captured')
    if (before.status !== 'captured' || after.status !== 'captured')
      throw new Error('expected both restart captures to be available')
    const document = (snapshotId: string, section: typeof before.section) =>
      ({
        identity: {
          formatVersion: MIGRATION_SNAPSHOT_FORMAT_VERSION,
          rehearsalId: 'desktop-local-session-restart-diagnostic',
          snapshotId,
          source: 'desktop-native-session-inventory-diagnostic',
        },
        sections: { nativeSessions: section },
      }) satisfies MigrationSnapshotDocument
    const comparison = compareMigrationSnapshots({
      before: document('before-restart', before.section),
      after: document('after-restart', after.section),
    })

    expect(comparison.verdict).toBe('divergent')
    expect(comparison.findings).toContainEqual(
      expect.objectContaining({
        family: 'nativeSessions',
        findingClass: 'changed_attribute',
        side: 'both',
      })
    )
  })

  test('reports foreign workspace or runtime ownership as unknown without dispatching', async () => {
    const base = service()
    const execute = spyOn(base, 'execute')
    const foreignWorkspace = createDesktopNativeSessionInventoryDiagnosticService(
      service({
        scope: { ...SCOPE, workspaceId: '00000000-0000-4000-8000-000000000099' },
        execute,
      })
    )
    const foreignRuntime = createDesktopNativeSessionInventoryDiagnosticService(
      service({
        scope: { ...SCOPE, runtimeNodeId: '00000000-0000-4000-8000-000000000099' },
        execute,
      })
    )
    const input = { workspaceId: SCOPE.workspaceId, runtimeNodeId: SCOPE.runtimeNodeId }

    await expect(foreignWorkspace.capture(input)).resolves.toEqual({
      status: 'unknown',
      reason: 'ownership_mismatch',
    })
    await expect(foreignRuntime.capture(input)).resolves.toEqual({
      status: 'unknown',
      reason: 'ownership_mismatch',
    })
    expect(execute).not.toHaveBeenCalled()
  })

  test('treats malformed, refused, and offline reads as unknown without exposing transport details', async () => {
    const malformed = createDesktopNativeSessionInventoryDiagnosticService(
      service({
        execute: async (command) =>
          ({
            schemaVersion: 1,
            operation: command.operation,
            requestId: command.requestId,
            ok: true,
            value: {
              items: [{ ...SESSION, scope: { ...SCOPE, accountId: 'foreign-account' } }],
              observedAt: '2026-10-15T00:00:00.000Z',
            },
            observedAt: '2026-10-15T00:00:00.000Z',
          }) as DevReply,
      })
    )
    const refused = createDesktopNativeSessionInventoryDiagnosticService(
      service({ execute: async () => Promise.reject(new Error('private transport diagnostic')) })
    )
    const unavailable = createDesktopNativeSessionInventoryDiagnosticService(
      service({ status: 'unavailable' })
    )
    const input = { workspaceId: SCOPE.workspaceId, runtimeNodeId: SCOPE.runtimeNodeId }

    await expect(malformed.capture(input)).resolves.toEqual({
      status: 'unknown',
      reason: 'read_failed',
    })
    await expect(refused.capture(input)).resolves.toEqual({
      status: 'unknown',
      reason: 'read_failed',
    })
    await expect(unavailable.capture(input)).resolves.toEqual({
      status: 'unknown',
      reason: 'unavailable',
    })
  })

  test('rejects path-shaped native identifiers before producing snapshot records', async () => {
    const unsafeSessions: RuntimeSession[] = [
      { ...SESSION, id: '/Users/private/session-store/one' },
      { ...SESSION, projectId: 'C:\\Users\\private\\project' },
      { ...SESSION, worktreeId: '\\\\private-host\\share\\checkout' },
      { ...SESSION, activeHarnessRunId: '~/Library/Application Support/private/run' },
      { ...SESSION, agentProfileId: 'file:///private/profile' },
      {
        ...SESSION,
        scope: { ...SCOPE, accountId: '/Users/private/account-reference' },
      },
    ]

    for (const unsafeSession of unsafeSessions) {
      const diagnostic = createDesktopNativeSessionInventoryDiagnosticService(
        service({
          scope: unsafeSession.scope,
          execute: async (command) =>
            ({
              schemaVersion: 1,
              operation: command.operation,
              requestId: command.requestId,
              ok: true,
              value: {
                items: [unsafeSession],
                observedAt: '2026-10-15T00:00:00.000Z',
              },
              observedAt: '2026-10-15T00:00:00.000Z',
            }) as DevReply,
        })
      )

      await expect(
        diagnostic.capture({
          workspaceId: SCOPE.workspaceId,
          runtimeNodeId: SCOPE.runtimeNodeId,
        })
      ).resolves.toEqual({ status: 'unknown', reason: 'read_failed' })
    }
  })

  test('does not dispatch when the diagnostic is cancelled before capture', async () => {
    const base = service()
    const execute = spyOn(base, 'execute')
    const diagnostic = createDesktopNativeSessionInventoryDiagnosticService(service({ execute }))
    const controller = new AbortController()
    controller.abort()

    await expect(
      diagnostic.capture({
        workspaceId: SCOPE.workspaceId,
        runtimeNodeId: SCOPE.runtimeNodeId,
        signal: controller.signal,
      })
    ).resolves.toEqual({ status: 'unknown', reason: 'cancelled' })
    expect(execute).not.toHaveBeenCalled()
  })

  test('cancels an in-flight page and never dispatches a later page', async () => {
    let calls = 0
    let resolveRead: ((reply: DevReply) => void) | undefined
    const runtime = service({
      execute: async (command) => {
        calls += 1
        return new Promise<DevReply>((resolve) => {
          resolveRead = () =>
            resolve({
              schemaVersion: 1,
              operation: command.operation,
              requestId: command.requestId,
              ok: true,
              value: {
                items: [SESSION],
                nextCursor: SESSION.id,
                observedAt: '2026-10-15T00:00:00.000Z',
              },
              observedAt: '2026-10-15T00:00:00.000Z',
            } as DevReply)
        })
      },
    })
    const diagnostic = createDesktopNativeSessionInventoryDiagnosticService(runtime)
    const controller = new AbortController()
    const capture = diagnostic.capture({
      runtimeNodeId: SCOPE.runtimeNodeId,
      signal: controller.signal,
      workspaceId: SCOPE.workspaceId,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    controller.abort()

    await expect(capture).resolves.toEqual({ status: 'unknown', reason: 'cancelled' })
    resolveRead?.({
      schemaVersion: 1,
      operation: 'dev.session.list',
      requestId: 'late-private-reply',
      ok: false,
      error: {
        code: 'unavailable',
        retryable: true,
        message: 'late private transport detail',
        observedAt: '2026-10-15T00:00:00.000Z',
      },
    } as DevReply)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toBe(1)
  })

  test('maps the bounded diagnostic deadline to an explicit unknown result', async () => {
    const diagnostic = createDesktopNativeSessionInventoryDiagnosticService(
      service({ execute: async () => new Promise<DevReply>(() => undefined) }),
      { timeoutMs: 5 }
    )

    await expect(
      diagnostic.capture({
        runtimeNodeId: SCOPE.runtimeNodeId,
        workspaceId: SCOPE.workspaceId,
      })
    ).resolves.toEqual({ status: 'unknown', reason: 'timed_out' })
  })

  test('session or principal changes invalidate a cached signed runtime binding', async () => {
    let appIdentity = JSON.stringify(['session-before', 'principal-before'])
    let calls = 0
    let resolveRead: ((reply: DevReply) => void) | undefined
    const runtime = service({
      execute: async (command) => {
        calls += 1
        return new Promise<DevReply>((resolve) => {
          resolveRead = () =>
            resolve({
              schemaVersion: 1,
              operation: command.operation,
              requestId: command.requestId,
              ok: true,
              value: { items: [SESSION], observedAt: '2026-10-15T00:00:00.000Z' },
              observedAt: '2026-10-15T00:00:00.000Z',
            } as DevReply)
        })
      },
    })
    const diagnostic = createDesktopNativeSessionInventoryDiagnosticService(runtime, {
      authorizationContext: () => appIdentity,
    })
    const originalIdentity = diagnostic.scopeIdentity()
    const capture = diagnostic.capture({
      workspaceId: SCOPE.workspaceId,
      runtimeNodeId: SCOPE.runtimeNodeId,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The cached DevRuntime preference scope has not changed. A same-workspace
    // login/account rotation still invalidates the old app-side authority.
    appIdentity = JSON.stringify(['session-after', 'principal-after'])
    expect(diagnostic.scopeIdentity()).toBeUndefined()
    resolveRead?.({
      schemaVersion: 1,
      operation: 'dev.session.list',
      requestId: 'late-session-switch',
      ok: true,
      value: { items: [SESSION], observedAt: '2026-10-15T00:00:00.000Z' },
      observedAt: '2026-10-15T00:00:00.000Z',
    } as DevReply)

    await expect(capture).resolves.toEqual({ status: 'unknown', reason: 'ownership_mismatch' })
    expect(originalIdentity).toBeDefined()
    expect(calls).toBe(1)
    await expect(
      diagnostic.capture({
        workspaceId: SCOPE.workspaceId,
        runtimeNodeId: SCOPE.runtimeNodeId,
      })
    ).resolves.toEqual({ status: 'unknown', reason: 'ownership_mismatch' })
    expect(calls).toBe(1)
  })

  test('rejects a signed account/workspace scope change while a page is in flight', async () => {
    let currentScope = SCOPE
    let resolveRead: ((reply: DevReply) => void) | undefined
    const runtime = service({
      execute: async (command) =>
        new Promise<DevReply>((resolve) => {
          resolveRead = () =>
            resolve({
              schemaVersion: 1,
              operation: command.operation,
              requestId: command.requestId,
              ok: true,
              value: { items: [SESSION], observedAt: '2026-10-15T00:00:00.000Z' },
              observedAt: '2026-10-15T00:00:00.000Z',
            } as DevReply)
        }),
      scope: currentScope,
    })
    const diagnostic = createDesktopNativeSessionInventoryDiagnosticService({
      ...runtime,
      preferenceScope: () => currentScope,
    })
    const capture = diagnostic.capture({
      runtimeNodeId: SCOPE.runtimeNodeId,
      workspaceId: SCOPE.workspaceId,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    currentScope = { ...SCOPE, accountId: '00000000-0000-4000-8000-000000000099' }
    resolveRead?.({
      schemaVersion: 1,
      operation: 'dev.session.list',
      requestId: 'scope-change-reply',
      ok: true,
      value: { items: [SESSION], observedAt: '2026-10-15T00:00:00.000Z' },
      observedAt: '2026-10-15T00:00:00.000Z',
    } as DevReply)

    await expect(capture).resolves.toEqual({
      status: 'unknown',
      reason: 'ownership_mismatch',
    })
  })
})

describe('local diagnostic authority independent of cloud registration', () => {
  test('captures from the shell projection without a renderer node assertion', async () => {
    const originalWindow = (globalThis as { window?: unknown }).window
    const commands: DevCommand[] = []
    try {
      ;(globalThis as { window?: unknown }).window = {
        __adeaDesktop: {
          invoke: async (operation: string) => {
            expect(operation).toBe('desktop_identity_scope')
            return SCOPE
          },
          devExecute: async (command: DevCommand) => {
            commands.push(command)
            return {
              schemaVersion: 1,
              operation: command.operation,
              requestId: command.requestId,
              ok: true,
              value: { items: [SESSION], observedAt: '2026-10-15T00:00:00.000Z' },
              observedAt: '2026-10-15T00:00:00.000Z',
            }
          },
          listen: async () => () => {},
        },
      }
      const runtime = createDesktopDevRuntimeService({ expectedWorkspaceId: SCOPE.workspaceId })
      await runtime.ready
      const diagnostic = createDesktopNativeSessionInventoryDiagnosticService(runtime)
      const result = await diagnostic.capture({ workspaceId: SCOPE.workspaceId })
      expect(result.status).toBe('captured')
      if (result.status !== 'captured') throw new Error('local inventory was not captured')
      expect(result.section.records[0]?.runtimeNodeId).toBe(SCOPE.runtimeNodeId)
      expect(commands.map(({ operation, scope }) => ({ operation, scope }))).toEqual([
        { operation: 'dev.session.list', scope: SCOPE },
      ])
      expect(await diagnostic.capture({ workspaceId: 'another-workspace' })).toEqual({
        status: 'unknown',
        reason: 'ownership_mismatch',
      })
      expect(commands).toHaveLength(1)
    } finally {
      ;(globalThis as { window?: unknown }).window = originalWindow
    }
  })
})
