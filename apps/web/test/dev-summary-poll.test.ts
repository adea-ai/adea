import { describe, expect, test } from 'bun:test'
import type { Scope, WorkspaceRunSummary } from '@adea-ai/types/dev-runtime'
import { createRoot } from 'solid-js'

import { createDevSummaryPoll } from '../src/lib/dev-summary-poll'

const scope: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

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
})
