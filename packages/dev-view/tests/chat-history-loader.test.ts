import { describe, expect, test } from 'bun:test'
import type { RuntimeEvent, RuntimeEventHistoryPage } from '@adea-ai/types/dev-runtime'
import {
  createTranscriptAccumulator,
  acceptRuntimeEvent,
  acceptRuntimeStreamFrame,
} from '../src/chat/model/transcript'
import { createRuntimeHistoryLoader, prependRuntimeHistory } from '../src/chat/model/history'
import { openRuntimeEventStream } from '../src/chat/model/event-stream'
import { encodeCbor } from '@adea-ai/types/dev-runtime'
import type { DevRuntimeService } from '../src/platform'

const event = (seq: number): RuntimeEvent => ({
  schemaVersion: 1,
  eventId: `event-${seq}`,
  runtimeSessionId: 'session-a',
  generation: 1,
  seq: String(seq),
  occurredAt: '2026-10-15T00:00:00Z',
  receivedAt: '2026-10-15T00:00:00Z',
  source: 'host',
  sourceEventId: `source-${seq}`,
  confidence: 'authoritative',
  classification: 'workspace_private',
  kind: 'turn.user_input',
  payload: { text: `prompt ${seq}` },
})
const initial = () =>
  acceptRuntimeEvent(
    createTranscriptAccumulator({
      runtimeSessionId: 'session-a',
      generation: 1,
      fromSequence: '4',
    }),
    event(4)
  )
const page = (): RuntimeEventHistoryPage => ({
  runtimeSessionId: 'session-a',
  generation: 1,
  beforeSequence: '4',
  retainedFromSequence: '1',
  retainedThroughSequence: '4',
  historyStart: 'generation_start',
  items: [event(2), event(3)],
  nextCursor: 'opaque',
})
describe('older transcript loading', () => {
  test('does not page before a disclosed stream retention floor', async () => {
    let state = createTranscriptAccumulator({
      runtimeSessionId: 'session-a',
      generation: 1,
      fromSequence: '0',
    })
    state = acceptRuntimeStreamFrame(
      state,
      { type: 'resync', reason: 'checkpoint_required', checkpointSequence: '4' },
      'host'
    )
    state = acceptRuntimeEvent(state, event(4))
    let reads = 0
    const reader = createRuntimeHistoryLoader({
      state: () => state,
      commit: (next) => {
        state = next
      },
      read: async () => {
        reads++
        return page()
      },
    })

    expect(reader.hasOlder()).toBe(false)
    await reader.loadOlder()
    expect(reads).toBe(0)
    reader.close()
  })

  test('resync replay advances over backfilled duplicates without duplicating rows or stalling live data', () => {
    const loaded = prependRuntimeHistory(initial(), page())
    expect(loaded.retainedFloorSequence).toBe('1')
    let replay = acceptRuntimeStreamFrame(
      loaded,
      { type: 'resync', reason: 'checkpoint_required', checkpointSequence: '3' },
      'host'
    )
    replay = acceptRuntimeEvent(replay, event(3))
    replay = acceptRuntimeEvent(replay, event(4))
    replay = acceptRuntimeEvent(replay, event(5))
    expect(replay.availability.status).not.toBe('resync_required')
    expect(replay.expectedSequence).toBe('6')
    expect(replay.events.map((e) => e.seq)).toEqual(['2', '3', '4', '5'])
  })
  test('the production stream handle loads through an authorized command and publishes before resolving', async () => {
    const calls: Array<{ operation: string; scope: unknown; body: unknown; resource?: unknown }> =
      []
    const scope = { accountId: 'account-a', workspaceId: 'workspace-a', runtimeNodeId: 'node-a' }
    const service = {
      execute: async (command: { operation: string; requestId: string }) => {
        calls.push(command as never)
        return {
          ok: true,
          operation: command.operation,
          requestId: command.requestId,
          value:
            command.operation === 'dev.session.events'
              ? { resource: { generation: 1 }, fromSequence: '4' }
              : page(),
        }
      },
      streams: () => ({
        connect: (_grant: unknown, observer: { onFrame: (frame: unknown) => void }) => {
          observer.onFrame({ type: 'data', sequence: '4', bytes: encodeCbor(event(4)) })
          observer.onFrame({
            type: 'heartbeat',
            observedAt: '2026-10-15T00:00:00Z',
            throughSequence: '4',
          })
          return { open: true, send: () => {}, close: () => {} }
        },
      }),
    } as unknown as DevRuntimeService
    const accepted: RuntimeEvent[] = []
    const handle = await openRuntimeEventStream({
      service,
      scope,
      runtimeSessionId: 'session-a',
      generation: 1,
      resource: { kind: 'runtime_session', id: 'session-a', generation: 1 },
      onHistoryAccepted: (events) => accepted.push(...events),
    })
    let published = false
    handle.subscribe((state) => {
      published = state.events[0]?.seq === '2'
    })
    await handle.loadOlder()
    expect(published).toBe(true)
    expect(accepted.map((e) => e.seq)).toEqual(['2', '3', '4'])
    expect(calls[1]).toMatchObject({
      operation: 'dev.session.history',
      scope,
      body: { runtimeSessionId: 'session-a', expectedGeneration: 1, beforeSequence: '4' },
      resource: { kind: 'runtime_session', id: 'session-a', generation: 1 },
    })
    expect(handle.state().expectedSequence).toBe('5')
    handle.close()
    expect(handle.hasOlder()).toBe(false)
  })
  test('prepends in order without changing live replay cursor, dedupes retry and preserves concurrent appends', () => {
    const live = acceptRuntimeEvent(initial(), event(5))
    const loaded = prependRuntimeHistory(live, page())
    expect(loaded.retainedFloorSequence).toBe('1')
    expect(loaded.events.map((e) => e.seq)).toEqual(['2', '3', '4', '5'])
    expect(loaded.expectedSequence).toBe('6')
    expect(prependRuntimeHistory(loaded, page())).toEqual(loaded)
    const completed = prependRuntimeHistory(loaded, {
      ...page(),
      beforeSequence: '2',
      items: [event(1)],
      nextCursor: undefined,
    })
    expect(completed.retention.complete).toBe(true)
  })
  test('rejects mixed identities, gaps, conflicts and invalid private payloads without changing the visible window', () => {
    const state = initial()
    for (const bad of [
      { ...page(), runtimeSessionId: 'other' },
      { ...page(), generation: 2 },
      { ...page(), items: [event(1)] },
      { ...page(), items: [{ ...event(3), runtimeSessionId: 'other' }] },
      { ...page(), items: [{ ...event(3), classification: 'credential' as const }] },
    ])
      expect(() => prependRuntimeHistory(state, bad)).toThrow()
    const loaded = prependRuntimeHistory(state, page())
    expect(() =>
      prependRuntimeHistory(loaded, {
        ...page(),
        items: [{ ...event(3), payload: { text: 'changed' } }],
      })
    ).toThrow()
    expect(state.events).toEqual([event(4)])
  })
  test('coalesces repeated loads and fences cancellation, disposal and late responses', async () => {
    let state = initial()
    let calls = 0
    let deliver!: (value: RuntimeEventHistoryPage) => void
    const reader = createRuntimeHistoryLoader({
      state: () => state,
      commit: (next) => {
        state = next
      },
      read: () => {
        calls++
        return new Promise((resolve) => {
          deliver = resolve
        })
      },
    })
    const a = reader.loadOlder()
    const b = reader.loadOlder()
    expect(calls).toBe(1)
    state = acceptRuntimeEvent(state, event(5))
    deliver(page())
    await Promise.all([a, b])
    expect(state.events.map((e) => e.seq)).toEqual(['2', '3', '4', '5'])
    const controller = new AbortController()
    const cancelled = reader.loadOlder({ signal: controller.signal })
    controller.abort()
    await expect(cancelled).rejects.toThrow()
    deliver({ ...page(), beforeSequence: '2', items: [event(1)], nextCursor: undefined })
    await Promise.resolve()
    expect(state.events[0]!.seq).toBe('2')
    const closed = reader.loadOlder()
    reader.close()
    await expect(closed).rejects.toThrow()
    deliver({ ...page(), beforeSequence: '2', items: [event(1)], nextCursor: undefined })
    await Promise.resolve()
    expect(state.events[0]!.seq).toBe('2')
    expect(reader.hasOlder()).toBe(false)
  })
  test('failed reads retry the same anchor and a stale generation cannot install its response', async () => {
    let state = initial()
    const requests: unknown[] = []
    let failure = true
    const reader = createRuntimeHistoryLoader({
      state: () => state,
      commit: (next) => {
        state = next
      },
      read: async (request) => {
        requests.push(request)
        if (failure) throw new Error('retryable transport failure')
        return page()
      },
    })
    await expect(reader.loadOlder()).rejects.toThrow()
    failure = false
    await reader.loadOlder()
    expect(requests).toEqual([{ beforeSequence: '4' }, { beforeSequence: '4' }])
    reader.close()
    let resolve!: (page: RuntimeEventHistoryPage) => void
    const stale = createRuntimeHistoryLoader({
      state: () => state,
      commit: (next) => {
        state = next
      },
      read: () =>
        new Promise((done) => {
          resolve = done
        }),
    })
    const pending = stale.loadOlder()
    state = { ...state, generation: 2, events: [] }
    resolve(page())
    await expect(pending).rejects.toThrow()
    expect(state.generation).toBe(2)
    expect(state.events).toEqual([])
    stale.close()
  })
})
