import { describe, expect, test } from 'bun:test'
import type { Scope, WorkspaceRunSummary } from '@adea-ai/types/dev-runtime'
import { createRoot } from 'solid-js'

import { createDevSummaryPoll, sameSummaryItems } from '../src/lib/dev-summary-poll'

const scope: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Waits (bounded) until `done` holds. */
async function until(done: () => boolean) {
  for (let attempt = 0; attempt < 200 && !done(); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 5))
}

function runtime(status: 'ready' | 'unavailable' = 'ready') {
  return {
    execute: async () => {
      throw new Error('reads go through the injected summary reader')
    },
    preferenceScope: () => scope,
    ready: Promise.resolve(),
    state: () =>
      status === 'ready'
        ? ({ status: 'ready' } as const)
        : ({ status: 'unavailable', reason: 'channel_unauthenticated' } as const),
  }
}

describe('desktop cross-workspace run summary poll', () => {
  test('reads once the runtime is ready, then on its interval', async () => {
    const reads: Scope[] = []
    let running = 1
    const read = async (_service: unknown, readScope: Scope): Promise<WorkspaceRunSummary> => {
      reads.push(readScope)
      return {
        items: [{ workspaceId: 'other', running: running++, needsInput: 2 }],
        observedAt: '2026-10-06T00:00:00.000Z',
      }
    }
    await createRoot(async (dispose) => {
      const items = createDevSummaryPoll(runtime(), { intervalMs: 20, read })
      await tick()
      await tick()
      expect(reads).toEqual([scope])
      expect(items()).toEqual([{ workspaceId: 'other', running: 1, needsInput: 2 }])
      await new Promise((resolve) => setTimeout(resolve, 45))
      expect(reads.length).toBeGreaterThanOrEqual(2)
      expect(items()?.[0]?.running).toBeGreaterThan(1)
      dispose()
      const settled = reads.length
      await new Promise((resolve) => setTimeout(resolve, 45))
      // Disposing the owner stops the poll.
      expect(reads.length).toBe(settled)
    })
  })

  test('a failed read keeps the last counts; an unavailable runtime never reads', async () => {
    let calls = 0
    const failing = async () => {
      calls += 1
      return calls === 1
        ? { items: [{ workspaceId: 'w', running: 1, needsInput: 0 }], observedAt: 'now' }
        : undefined
    }
    await createRoot(async (dispose) => {
      const items = createDevSummaryPoll(runtime(), { intervalMs: 10, read: failing })
      await new Promise((resolve) => setTimeout(resolve, 35))
      expect(calls).toBeGreaterThan(1)
      expect(items()).toEqual([{ workspaceId: 'w', running: 1, needsInput: 0 }])
      dispose()
    })
    let unavailableCalls = 0
    await createRoot(async (dispose) => {
      const items = createDevSummaryPoll(runtime('unavailable'), {
        intervalMs: 10,
        read: async () => {
          unavailableCalls += 1
          return undefined
        },
      })
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(unavailableCalls).toBe(0)
      expect(items()).toBeUndefined()
      dispose()
    })
  })

  test('a poll that observed the same counts keeps the previous array', async () => {
    let calls = 0
    const read = async (): Promise<WorkspaceRunSummary> => {
      calls += 1
      return {
        // A fresh array and fresh items every read, as the wire decode returns.
        items: [{ workspaceId: 'w', running: calls < 3 ? 1 : 2, needsInput: 0 }],
        observedAt: `read-${calls}`,
      }
    }
    await createRoot(async (dispose) => {
      const items = createDevSummaryPoll(runtime(), { intervalMs: 10, read })
      await tick()
      await tick()
      const first = items()
      expect(first).toEqual([{ workspaceId: 'w', running: 1, needsInput: 0 }])
      await until(() => calls >= 2)
      await tick()
      expect(items()).toBe(first)
      await until(() => calls >= 3)
      await tick()
      expect(items()).not.toBe(first)
      expect(items()?.[0]?.running).toBe(2)
      dispose()
    })
  })

  test('sameSummaryItems compares workspace, order and counts', () => {
    const item = { workspaceId: 'a', running: 1, needsInput: 0 }
    expect(sameSummaryItems(undefined, [item])).toBe(false)
    expect(sameSummaryItems([item], [{ ...item }])).toBe(true)
    expect(sameSummaryItems([item], [{ ...item, needsInput: 1 }])).toBe(false)
    expect(sameSummaryItems([item], [])).toBe(false)
    expect(
      sameSummaryItems([item, { ...item, workspaceId: 'b' }], [{ ...item, workspaceId: 'b' }, item])
    ).toBe(false)
  })
})
