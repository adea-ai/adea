import { describe, expect, spyOn, test } from 'bun:test'

import type { MigrationSnapshotDocument } from '@adea-ai/types'
import { MIGRATION_SNAPSHOT_FORMAT_VERSION } from '@adea-ai/types'
import type { RuntimeSession } from '@adea-ai/types/dev-runtime'

import { compareMigrationSnapshots } from '../../src/migration-snapshot-comparator'
import {
  captureNativeSessionSection,
  NATIVE_SESSION_INVENTORY_MAX_OUTPUT_BYTES,
  NATIVE_SESSION_INVENTORY_PAGE_LIMIT,
  NATIVE_SESSION_INVENTORY_PAGE_TIMEOUT_MS,
  NativeSessionInventoryError,
  type NativeSessionInventoryPage,
  type NativeSessionInventoryScope,
  type NativeSessionInventorySource,
} from '../../src/native-session-inventory'

/**
 * Unit proofs for the runtime-owned session inventory adapter: the canonical
 * `dev.session.list` record maps exactly, reads stay inside the registry page
 * limit (`integer(1..500)`) with exact truncation detection, records are
 * validated against the source's explicitly declared authorized scope(s), and
 * every failure is a typed error the capture reports as `unknown` — never an
 * empty section.
 */

const SCOPE: NativeSessionInventoryScope = {
  accountId: 'acct-1',
  runtimeNodeId: 'node-1',
  workspaceId: 'wsp-1',
}

const SECOND_SCOPE: NativeSessionInventoryScope = {
  accountId: 'acct-2',
  runtimeNodeId: 'node-2',
  workspaceId: 'wsp-2',
}

function session(overrides: Partial<RuntimeSession> = {}): RuntimeSession {
  return {
    archived: false,
    generation: 1,
    id: 'sess-b',
    lifecycle: 'ready',
    projectId: 'prj-1',
    repoId: 'repo-1',
    scope: {
      accountId: SCOPE.accountId,
      runtimeNodeId: SCOPE.runtimeNodeId,
      workspaceId: SCOPE.workspaceId,
    },
    version: 1,
    worktreeId: 'wt-1',
    ...overrides,
  }
}

function source(
  listRuntimeSessions: NativeSessionInventorySource['listRuntimeSessions'],
  authorizedScopes: readonly NativeSessionInventoryScope[] = [SCOPE]
): NativeSessionInventorySource {
  return { authorizedScopes, listRuntimeSessions }
}

/**
 * A source that enforces the canonical registry validator (`limit` an integer
 * in `1..500`) and pages with opaque cursors, so the adapter is proven
 * against the real contract rather than an accepting stub.
 */
function registryValidatingSource(total: number, scope: NativeSessionInventoryScope = SCOPE) {
  const requests: number[] = []
  const listRuntimeSessions = async ({
    cursor,
    limit,
  }: Readonly<{ cursor?: string; limit: number }>): Promise<NativeSessionInventoryPage> => {
    if (!Number.isInteger(limit) || limit < 1 || limit > NATIVE_SESSION_INVENTORY_PAGE_LIMIT) {
      throw new Error(`dev.session.list limit violated: ${limit}`)
    }
    requests.push(limit)
    const start = cursor === undefined ? 0 : Number(cursor)
    const count = Math.min(limit, total - start)
    const items = Array.from({ length: count }, (_, index) =>
      session({
        id: `sess-${String(start + index).padStart(5, '0')}`,
        scope: {
          accountId: scope.accountId,
          runtimeNodeId: scope.runtimeNodeId,
          workspaceId: scope.workspaceId,
        },
      })
    )
    const next = start + items.length
    return next < total ? { items, nextCursor: String(next) } : { items }
  }
  return { requests, source: source(listRuntimeSessions, [scope]) }
}

describe('native session inventory adapter', () => {
  test('maps the canonical read into the snapshot contract with exact provenance', async () => {
    const section = await captureNativeSessionSection(
      source(async () => ({
        items: [
          session({
            activeHarnessRunId: 'run-1',
            agentProfileId: 'prf-1',
            agentProfileVersion: 3,
            harnessInstallationId: 'inst-1',
            lifecycle: 'active',
          }),
        ],
      })),
      10
    )
    expect(section).toEqual({
      limit: 10,
      records: [
        {
          accountId: 'acct-1',
          activeHarnessRunId: 'run-1',
          agentProfileId: 'prf-1',
          agentProfileVersion: 3,
          archived: false,
          family: 'nativeSessions',
          generation: 1,
          harnessInstallationId: 'inst-1',
          lifecycle: 'active',
          projectId: 'prj-1',
          runtimeNodeId: 'node-1',
          sessionRef: 'sess-b',
          version: 1,
          workspaceId: 'wsp-1',
          worktreeId: 'wt-1',
        },
      ],
      truncated: false,
    })
  })

  test('follows cursors and sorts records by stable id', async () => {
    const pages = [
      { items: [session({ id: 'sess-c' })], nextCursor: 'opaque-cursor-1' },
      { items: [session({ id: 'sess-a' })] },
    ]
    let calls = 0
    const section = await captureNativeSessionSection(
      source(async ({ cursor }) => {
        expect(cursor).toBe(calls === 0 ? undefined : 'opaque-cursor-1')
        calls += 1
        return pages[calls - 1]!
      }),
      10
    )
    expect(section.records.map((record) => record.sessionRef)).toEqual(['sess-a', 'sess-c'])
    expect(calls).toBe(2)
  })

  test('observes truncation with a probe row and never exceeds the bound', async () => {
    const items = [session({ id: 'sess-a' }), session({ id: 'sess-b' }), session({ id: 'sess-c' })]
    const section = await captureNativeSessionSection(
      source(async ({ limit }) => ({ items: items.slice(0, limit) })),
      2
    )
    expect(section.truncated).toBe(true)
    expect(section.records.map((record) => record.sessionRef)).toEqual(['sess-a', 'sess-b'])
  })

  test('validates duplicate identities in the overflow probe before reporting truncation', async () => {
    const failure = captureNativeSessionSection(
      source(async () => ({
        items: [session({ id: 'sess-a' }), session({ id: 'sess-b' }), session({ id: 'sess-b' })],
      })),
      2
    )
    await expect(failure).rejects.toBeInstanceOf(NativeSessionInventoryError)
    await failure.catch((error: NativeSessionInventoryError) => expect(error.kind).toBe('invalid'))
  })

  test('validates scope ownership in the overflow probe before reporting truncation', async () => {
    const failure = captureNativeSessionSection(
      source(async () => ({
        items: [
          session({ id: 'sess-a' }),
          session({ id: 'sess-b' }),
          session({
            id: 'sess-foreign',
            scope: { accountId: 'acct-9', runtimeNodeId: 'node-9', workspaceId: 'wsp-9' },
          }),
        ],
      })),
      2
    )
    await expect(failure).rejects.toBeInstanceOf(NativeSessionInventoryError)
    await failure.catch((error: NativeSessionInventoryError) => expect(error.kind).toBe('invalid'))
  })

  test('rejects malformed page shapes and pages larger than the requested limit', async () => {
    const malformed = captureNativeSessionSection(
      source(async () => ({ items: 'not-an-array' }) as unknown as NativeSessionInventoryPage),
      5
    )
    await expect(malformed).rejects.toBeInstanceOf(NativeSessionInventoryError)
    await malformed.catch((error: NativeSessionInventoryError) =>
      expect(error.kind).toBe('invalid')
    )

    const oversized = captureNativeSessionSection(
      source(async () => ({
        items: [session({ id: 'sess-a' }), session({ id: 'sess-b' }), session({ id: 'sess-c' })],
      })),
      1
    )
    await expect(oversized).rejects.toBeInstanceOf(NativeSessionInventoryError)
    await oversized.catch((error: NativeSessionInventoryError) =>
      expect(error.kind).toBe('invalid')
    )
  })

  test('refuses invalid inventory bounds before calling the source', async () => {
    let calls = 0
    const inventory = source(async () => {
      calls += 1
      return { items: [] }
    })
    await expect(captureNativeSessionSection(inventory, 0)).rejects.toBeInstanceOf(
      NativeSessionInventoryError
    )
    await expect(captureNativeSessionSection(inventory, 10_001)).rejects.toBeInstanceOf(
      NativeSessionInventoryError
    )
    expect(calls).toBe(0)
  })

  test('cancels a page that aborts before returning its already-resolved reply', async () => {
    const controller = new AbortController()
    let calls = 0
    const capture = captureNativeSessionSection(
      source(async () => {
        calls += 1
        controller.abort()
        return { items: [session()], nextCursor: 'opaque-cursor' }
      }),
      5,
      { signal: controller.signal }
    )

    await expect(capture).rejects.toBeInstanceOf(NativeSessionInventoryError)
    await capture.catch((error: NativeSessionInventoryError) =>
      expect(error.kind).toBe('unavailable')
    )
    expect(calls).toBe(1)
  })

  test('refuses a mapped section whose serialized output exceeds the byte bound', async () => {
    const largeScope = {
      accountId: 'a'.repeat(512),
      runtimeNodeId: 'n'.repeat(512),
      workspaceId: 'w'.repeat(512),
    }
    const largeSessions = Array.from({ length: 500 }, (_, index) =>
      session({
        id: `session-${index}`,
        projectId: 'p'.repeat(512),
        scope: largeScope,
        worktreeId: 't'.repeat(512),
      })
    )
    const failure = captureNativeSessionSection(
      source(async () => ({ items: largeSessions }), [largeScope]),
      500
    )

    await expect(failure).rejects.toBeInstanceOf(NativeSessionInventoryError)
    await failure.catch((error: NativeSessionInventoryError) => expect(error.kind).toBe('invalid'))
    expect(NATIVE_SESSION_INVENTORY_MAX_OUTPUT_BYTES).toBe(1_048_576)
  })

  test('times out a stalled page, clears its deadline on completion, and consumes a late rejection', async () => {
    const clearTimeoutSpy = spyOn(globalThis, 'clearTimeout')
    try {
      const completed = await captureNativeSessionSection(
        source(async () => ({ items: [] })),
        5,
        {
          pageTimeoutMs: 100,
        }
      )
      expect(completed.records).toEqual([])
      expect(clearTimeoutSpy).toHaveBeenCalled()
    } finally {
      clearTimeoutSpy.mockRestore()
    }

    let rejectRead: ((reason: Error) => void) | undefined
    const timeout = captureNativeSessionSection(
      source(
        () =>
          new Promise<NativeSessionInventoryPage>((_, reject) => {
            rejectRead = reject
          })
      ),
      5,
      { pageTimeoutMs: 5 }
    )
    await expect(timeout).rejects.toBeInstanceOf(NativeSessionInventoryError)
    await timeout.catch((error: NativeSessionInventoryError) =>
      expect(error.kind).toBe('unavailable')
    )
    rejectRead?.(new Error('late transport rejection'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    await expect(
      captureNativeSessionSection(
        source(async () => ({ items: [] })),
        5,
        {
          pageTimeoutMs: NATIVE_SESSION_INVENTORY_PAGE_TIMEOUT_MS + 1,
        }
      )
    ).rejects.toBeInstanceOf(NativeSessionInventoryError)
  })

  test('an authoritative empty page is a captured zero, not an unknown', async () => {
    const section = await captureNativeSessionSection(
      source(async () => ({ items: [] })),
      5
    )
    expect(section).toEqual({ limit: 5, records: [], truncated: false })
  })

  test('a record outside the canonical contract is refused as invalid', async () => {
    const malformed = session() as unknown as { lifecycle: string }
    malformed.lifecycle = 'bogus'
    const failure = captureNativeSessionSection(
      source(async () => ({ items: [malformed as unknown as RuntimeSession] })),
      5
    )
    await expect(failure).rejects.toBeInstanceOf(NativeSessionInventoryError)
    await failure.catch((error: NativeSessionInventoryError) => expect(error.kind).toBe('invalid'))
  })

  test('a source failure propagates as a typed unavailable error', async () => {
    const failure = captureNativeSessionSection(
      source(async () => {
        throw new Error('bridge down')
      }),
      5
    )
    await expect(failure).rejects.toBeInstanceOf(NativeSessionInventoryError)
    await failure.catch((error: NativeSessionInventoryError) =>
      expect(error.kind).toBe('unavailable')
    )
  })

  test('composes a multi-page inventory to exhaustion', async () => {
    const pages = [
      { items: [session({ id: 'sess-c' }), session({ id: 'sess-f' })], nextCursor: 'opaque-1' },
      { items: [session({ id: 'sess-a' }), session({ id: 'sess-e' })], nextCursor: 'opaque-2' },
      { items: [session({ id: 'sess-b' }), session({ id: 'sess-d' })] },
    ]
    const cursors: Array<string | undefined> = []
    const section = await captureNativeSessionSection(
      source(async ({ cursor }) => {
        cursors.push(cursor)
        const page = pages[cursors.length - 1]
        if (!page) throw new Error('unexpected extra page')
        return page
      }),
      10
    )
    expect(cursors).toEqual([undefined, 'opaque-1', 'opaque-2'])
    expect(section.records.map((record) => record.sessionRef)).toEqual([
      'sess-a',
      'sess-b',
      'sess-c',
      'sess-d',
      'sess-e',
      'sess-f',
    ])
    expect(section.truncated).toBe(false)
  })

  test('rejects duplicate stable identities across pages', async () => {
    let calls = 0
    const failure = captureNativeSessionSection(
      source(async () => {
        calls += 1
        return calls === 1
          ? { items: [session({ id: 'sess-a' })], nextCursor: 'sess-a' }
          : { items: [session({ id: 'sess-a' })] }
      }),
      5
    )
    await expect(failure).rejects.toBeInstanceOf(NativeSessionInventoryError)
    await failure.catch((error: NativeSessionInventoryError) => expect(error.kind).toBe('invalid'))
  })

  test('a stable native identity compares unchanged after a runtime restart', async () => {
    const beforeSection = await captureNativeSessionSection(
      source(async () => ({ items: [session({ id: 'session-stable' })] })),
      5
    )
    const afterSection = await captureNativeSessionSection(
      source(async () => ({ items: [session({ id: 'session-stable' })] })),
      5
    )
    const baseIdentity = {
      formatVersion: MIGRATION_SNAPSHOT_FORMAT_VERSION,
      rehearsalId: 'native-session-restart',
      source: 'unit',
    }
    const before: MigrationSnapshotDocument = {
      identity: { ...baseIdentity, snapshotId: 'before-restart' },
      sections: { nativeSessions: beforeSection },
    }
    const after: MigrationSnapshotDocument = {
      identity: { ...baseIdentity, snapshotId: 'after-restart' },
      sections: { nativeSessions: afterSection },
    }
    const comparison = compareMigrationSnapshots({ before, after })
    expect(comparison.findings.filter((finding) => finding.family === 'nativeSessions')).toEqual([])
    expect(comparison.inventory.find((item) => item.family === 'nativeSessions')).toMatchObject({
      before: 1,
      after: 1,
    })
    // Every other family is intentionally absent, so this small fixture cannot
    // claim that a full migration rehearsal is complete.
    expect(comparison.verdict).toBe('inconclusive')
  })

  test('a repeated cursor is refused instead of looping forever', async () => {
    const failure = captureNativeSessionSection(
      source(async () => ({ items: [session({ id: 'sess-a' })], nextCursor: 'sess-a' })),
      10
    )
    await expect(failure).rejects.toBeInstanceOf(NativeSessionInventoryError)
    await failure.catch((error: NativeSessionInventoryError) => expect(error.kind).toBe('invalid'))
  })

  test('an empty page with a continuation cursor is refused, never streamed forever', async () => {
    const failure = captureNativeSessionSection(
      source(async () => ({ items: [], nextCursor: 'next' })),
      10
    )
    await expect(failure).rejects.toBeInstanceOf(NativeSessionInventoryError)
    await failure.catch((error: NativeSessionInventoryError) => expect(error.kind).toBe('invalid'))
  })

  test('a record outside the source authorized scopes is refused as invalid', async () => {
    const failure = captureNativeSessionSection(
      source(async () => ({
        items: [
          session({
            id: 'sess-foreign',
            scope: { accountId: 'acct-9', runtimeNodeId: 'node-9', workspaceId: 'wsp-9' },
          }),
        ],
      })),
      10
    )
    await expect(failure).rejects.toBeInstanceOf(NativeSessionInventoryError)
    await failure.catch((error: NativeSessionInventoryError) => expect(error.kind).toBe('invalid'))
  })

  test('a source declaring no authorized scope is refused', async () => {
    const failure = captureNativeSessionSection(
      source(async () => ({ items: [] }), []),
      10
    )
    await expect(failure).rejects.toBeInstanceOf(NativeSessionInventoryError)
    await failure.catch((error: NativeSessionInventoryError) => expect(error.kind).toBe('invalid'))
  })

  test('multiple authorized scopes are represented and both compose', async () => {
    const section = await captureNativeSessionSection(
      source(
        async () => ({
          items: [
            session({ id: 'sess-a' }),
            session({
              id: 'sess-b',
              scope: {
                accountId: SECOND_SCOPE.accountId,
                runtimeNodeId: SECOND_SCOPE.runtimeNodeId,
                workspaceId: SECOND_SCOPE.workspaceId,
              },
            }),
          ],
        }),
        [SCOPE, SECOND_SCOPE]
      ),
      10
    )
    expect(section.records.map((record) => record.sessionRef)).toEqual(['sess-a', 'sess-b'])
  })

  test('freezes declared scope authority before the first asynchronous read', async () => {
    const scopes = [SCOPE]
    const failure = captureNativeSessionSection(
      source(async () => {
        scopes.push(SECOND_SCOPE)
        return {
          items: [
            session({
              id: 'sess-late-scope',
              scope: {
                accountId: SECOND_SCOPE.accountId,
                runtimeNodeId: SECOND_SCOPE.runtimeNodeId,
                workspaceId: SECOND_SCOPE.workspaceId,
              },
            }),
          ],
        }
      }, scopes),
      10
    )
    await expect(failure).rejects.toBeInstanceOf(NativeSessionInventoryError)
    await failure.catch((error: NativeSessionInventoryError) => expect(error.kind).toBe('invalid'))
  })

  test('a bound above the canonical page limit pages within 1..500 and truncates exactly', async () => {
    const beyond = registryValidatingSource(1300)
    const truncated = await captureNativeSessionSection(beyond.source, 1200)
    expect(truncated.records).toHaveLength(1200)
    expect(truncated.truncated).toBe(true)
    expect(beyond.requests).toEqual([500, 500, 201])
    expect(beyond.requests.every((limit) => limit >= 1 && limit <= 500)).toBe(true)
    expect(truncated.records[0]?.sessionRef).toBe('sess-00000')
    expect(truncated.records[1199]?.sessionRef).toBe('sess-01199')

    const exact = registryValidatingSource(1200)
    const complete = await captureNativeSessionSection(exact.source, 1200)
    expect(complete.records).toHaveLength(1200)
    expect(complete.truncated).toBe(false)
    expect(exact.requests).toEqual([500, 500, 201])
  })

  test('one-row truncation detection stays exact across a page boundary', async () => {
    const exact = registryValidatingSource(501)
    const complete = await captureNativeSessionSection(exact.source, 501)
    expect(complete.records).toHaveLength(501)
    expect(complete.truncated).toBe(false)
    expect(exact.requests).toEqual([500, 2])

    const beyond = registryValidatingSource(502)
    const truncated = await captureNativeSessionSection(beyond.source, 501)
    expect(truncated.records).toHaveLength(501)
    expect(truncated.truncated).toBe(true)
    expect(beyond.requests).toEqual([500, 2])
  })
})
