import { describe, expect, test } from 'bun:test'

import type { RuntimeSession } from '@adea-ai/types/dev-runtime'

import {
  captureNativeSessionSection,
  NativeSessionInventoryError,
} from '../../src/native-session-inventory'

/**
 * Unit proofs for the runtime-owned session inventory adapter: the canonical
 * `dev.session.list` record maps exactly, reads stay bounded and deterministic,
 * an authoritative empty page is a captured zero, and every failure is a typed
 * error the capture reports as `unknown` — never an empty section.
 */

function session(overrides: Partial<RuntimeSession> = {}): RuntimeSession {
  return {
    archived: false,
    generation: 1,
    id: 'sess-b',
    lifecycle: 'ready',
    projectId: 'prj-1',
    repoId: 'repo-1',
    scope: { accountId: 'acct-1', runtimeNodeId: 'node-1', workspaceId: 'wsp-1' },
    version: 1,
    worktreeId: 'wt-1',
    ...overrides,
  }
}

describe('native session inventory adapter', () => {
  test('maps the canonical read into the snapshot contract with exact provenance', async () => {
    const section = await captureNativeSessionSection(
      {
        listRuntimeSessions: async () => ({
          items: [
            session({
              activeHarnessRunId: 'run-1',
              agentProfileId: 'prf-1',
              agentProfileVersion: 3,
              harnessInstallationId: 'inst-1',
              lifecycle: 'active',
            }),
          ],
        }),
      },
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
      { items: [session({ id: 'sess-c' })], nextCursor: 'c1' },
      { items: [session({ id: 'sess-a' })] },
    ]
    let calls = 0
    const section = await captureNativeSessionSection(
      {
        listRuntimeSessions: async ({ cursor }) => {
          expect(cursor).toBe(calls === 0 ? undefined : 'c1')
          calls += 1
          return pages[calls - 1]!
        },
      },
      10
    )
    expect(section.records.map((record) => record.sessionRef)).toEqual(['sess-a', 'sess-c'])
    expect(calls).toBe(2)
  })

  test('observes truncation with a probe row and never exceeds the bound', async () => {
    const items = [session({ id: 'sess-a' }), session({ id: 'sess-b' }), session({ id: 'sess-c' })]
    const section = await captureNativeSessionSection(
      { listRuntimeSessions: async ({ limit }) => ({ items: items.slice(0, limit) }) },
      2
    )
    expect(section.truncated).toBe(true)
    expect(section.records.map((record) => record.sessionRef)).toEqual(['sess-a', 'sess-b'])
  })

  test('an authoritative empty page is a captured zero, not an unknown', async () => {
    const section = await captureNativeSessionSection(
      { listRuntimeSessions: async () => ({ items: [] }) },
      5
    )
    expect(section).toEqual({ limit: 5, records: [], truncated: false })
  })

  test('a record outside the canonical contract is refused as invalid', async () => {
    const malformed = session() as unknown as { lifecycle: string }
    malformed.lifecycle = 'bogus'
    const failure = captureNativeSessionSection(
      { listRuntimeSessions: async () => ({ items: [malformed as unknown as RuntimeSession] }) },
      5
    )
    await expect(failure).rejects.toBeInstanceOf(NativeSessionInventoryError)
    await failure.catch((error: NativeSessionInventoryError) => expect(error.kind).toBe('invalid'))
  })

  test('a source failure propagates as a typed unavailable error', async () => {
    const failure = captureNativeSessionSection(
      {
        listRuntimeSessions: async () => {
          throw new Error('bridge down')
        },
      },
      5
    )
    await expect(failure).rejects.toBeInstanceOf(NativeSessionInventoryError)
    await failure.catch((error: NativeSessionInventoryError) =>
      expect(error.kind).toBe('unavailable')
    )
  })

  test('composes a multi-page inventory to exhaustion', async () => {
    const pages = [
      { items: [session({ id: 'sess-c' }), session({ id: 'sess-f' })], nextCursor: 'c1' },
      { items: [session({ id: 'sess-a' }), session({ id: 'sess-e' })], nextCursor: 'c2' },
      { items: [session({ id: 'sess-b' }), session({ id: 'sess-d' })] },
    ]
    const cursors: Array<string | undefined> = []
    const section = await captureNativeSessionSection(
      {
        listRuntimeSessions: async ({ cursor }) => {
          cursors.push(cursor)
          const page = pages[cursors.length - 1]
          if (!page) throw new Error('unexpected extra page')
          return page
        },
      },
      10
    )
    expect(cursors).toEqual([undefined, 'c1', 'c2'])
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

  test('a repeated cursor is refused instead of looping forever', async () => {
    const failure = captureNativeSessionSection(
      {
        listRuntimeSessions: async () => ({
          items: [session({ id: 'sess-a' })],
          nextCursor: 'loop',
        }),
      },
      10
    )
    await expect(failure).rejects.toBeInstanceOf(NativeSessionInventoryError)
    await failure.catch((error: NativeSessionInventoryError) => expect(error.kind).toBe('invalid'))
  })

  test('an empty page with a continuation cursor is refused, never streamed forever', async () => {
    const failure = captureNativeSessionSection(
      { listRuntimeSessions: async () => ({ items: [], nextCursor: 'next' }) },
      10
    )
    await expect(failure).rejects.toBeInstanceOf(NativeSessionInventoryError)
    await failure.catch((error: NativeSessionInventoryError) => expect(error.kind).toBe('invalid'))
  })

  test('a record outside the requested scope is refused as invalid', async () => {
    const failure = captureNativeSessionSection(
      {
        listRuntimeSessions: async () => ({
          items: [
            session({
              id: 'sess-foreign',
              scope: { accountId: 'acct-2', runtimeNodeId: 'node-1', workspaceId: 'wsp-1' },
            }),
          ],
        }),
      },
      10,
      { scope: { accountId: 'acct-1', runtimeNodeId: 'node-1', workspaceId: 'wsp-1' } }
    )
    await expect(failure).rejects.toBeInstanceOf(NativeSessionInventoryError)
    await failure.catch((error: NativeSessionInventoryError) => expect(error.kind).toBe('invalid'))
  })

  test('a record inside the requested scope composes', async () => {
    const section = await captureNativeSessionSection(
      { listRuntimeSessions: async () => ({ items: [session({ id: 'sess-a' })] }) },
      10,
      { scope: { accountId: 'acct-1', runtimeNodeId: 'node-1', workspaceId: 'wsp-1' } }
    )
    expect(section.records.map((record) => record.sessionRef)).toEqual(['sess-a'])
  })
})
