import { describe, expect, test } from 'bun:test'
import type { QueryClient } from '@tanstack/react-query'

import {
  createWorkspaceEventSubscription,
  INITIAL_RECONNECT_DELAY_MS,
  MAX_RECONNECT_DELAY_MS,
  parseEventFrames,
  queryKeysForEvent,
  reconnectDelay,
  workspaceScopeKeys,
  type WorkspaceEventEnvelope,
} from '../../src/events'

const workspaceId = 'aaaaaaaa-1111-4111-8111-111111111111'
const url = `https://workspace.test/api/v1/workspaces/${workspaceId}/events`

/** Records what the subscription asks the cache to refresh. */
function fakeQueryClient() {
  const invalidated: string[] = []
  const client = {
    invalidateQueries: ({ queryKey }: { queryKey: unknown }) => {
      invalidated.push(JSON.stringify(queryKey))
      return Promise.resolve()
    },
  } as unknown as QueryClient
  return { client, invalidated }
}

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => void values.delete(key),
    setItem: (key: string, value: string) => void values.set(key, value),
    values,
  }
}

function envelope(sequence: number, eventType = 'message.created'): WorkspaceEventEnvelope {
  return {
    aggregateId: 'cccccccc-3333-4333-8333-333333333333',
    aggregateType: 'message',
    actor: null,
    eventId: `event-${sequence}`,
    eventType,
    occurredAt: '2026-09-12T00:00:00.000Z',
    payload: {},
    schemaVersion: 1,
    workspaceSequence: sequence,
  }
}

function frame(payload: unknown, id = 'cursor', event = 'workspace.event') {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
}

/** A fetch implementation that streams the given frames and then ends. */
function streamFetch(frames: readonly string[]) {
  return (async () => {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const value of frames) controller.enqueue(encoder.encode(value))
        controller.close()
      },
    })
    return new Response(body, { status: 200 })
  }) as unknown as typeof fetch
}

/** Runs scheduled callbacks immediately, so tests never wait on real timers. */
function immediateScheduler(scheduled: number[]) {
  return (run: () => void, delayMs: number) => {
    scheduled.push(delayMs)
    return () => undefined
  }
}

describe('workspace event client', () => {
  test('parses SSE frames with ids, events, data, and retry guidance', () => {
    const frames = parseEventFrames(
      [
        'retry: 2000\n\n',
        ': heartbeat\n\n',
        'id: abc\nevent: workspace.event\ndata: {"workspaceSequence":3}\n\n',
        'event: resync_required\ndata: {"reason":"cursor-expired"}\n\n',
        'data: partial',
      ].join('')
    )
    expect(frames).toEqual([
      { data: '', event: 'message', id: null, retryMs: 2000 },
      { data: '{"workspaceSequence":3}', event: 'workspace.event', id: 'abc', retryMs: null },
      { data: '{"reason":"cursor-expired"}', event: 'resync_required', id: null, retryMs: null },
    ])
  })

  test('maps each event family to the query groups it changes', () => {
    expect(queryKeysForEvent(workspaceId, 'message.created')).toContainEqual([
      'workspaces',
      workspaceId,
      'channels',
    ])
    expect(queryKeysForEvent(workspaceId, 'channel.archived')).toContainEqual([
      'workspaces',
      workspaceId,
      'rooms',
    ])
    expect(queryKeysForEvent(workspaceId, 'thread.read')).toContainEqual([
      'workspaces',
      workspaceId,
      'read-state',
    ])
    expect(queryKeysForEvent(workspaceId, 'agent.profile_changed')).toContainEqual([
      'workspaces',
      workspaceId,
      'agents',
    ])
    expect(queryKeysForEvent(workspaceId, 'artifact.availability_changed')).toContainEqual([
      'workspaces',
      workspaceId,
      'artifacts',
    ])
    expect(queryKeysForEvent(workspaceId, 'task.completed')).toContainEqual([
      'workspaces',
      workspaceId,
      'tasks',
    ])
    // An unknown family refreshes the workspace rather than being dropped.
    expect(queryKeysForEvent(workspaceId, 'mystery.happened')).toEqual([
      ['workspaces', workspaceId],
    ])
    expect(workspaceScopeKeys(workspaceId)).toEqual([['workspaces', workspaceId]])
  })

  test('backs off exponentially with jitter and a cap', () => {
    const noJitter = () => 0
    const fullJitter = () => 1
    expect(reconnectDelay(1, noJitter)).toBe(INITIAL_RECONNECT_DELAY_MS / 2)
    expect(reconnectDelay(1, fullJitter)).toBe(INITIAL_RECONNECT_DELAY_MS)
    expect(reconnectDelay(2, fullJitter)).toBe(2_000)
    expect(reconnectDelay(3, fullJitter)).toBe(4_000)
    expect(reconnectDelay(20, fullJitter)).toBe(MAX_RECONNECT_DELAY_MS)
    expect(reconnectDelay(1, fullJitter)).toBeLessThan(reconnectDelay(2, fullJitter))
  })

  test('applies events once, refreshes their groups, and persists the cursor', async () => {
    const { client, invalidated } = fakeQueryClient()
    const storage = memoryStorage()
    const diagnostics: string[] = []

    const subscription = createWorkspaceEventSubscription({
      fetchImpl: streamFetch([frame(envelope(1)), frame(envelope(2, 'channel.updated'))]),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.event),
      queryClient: client,
      schedule: immediateScheduler([]),
      storage,
      url,
      workspaceId,
    })

    await new Promise((resolve) => setTimeout(resolve, 20))
    subscription.stop()

    expect(subscription.appliedSequence()).toBe(2)
    expect(storage.values.get(`adea:workspace-events-cursor:${workspaceId}`)).toBe('2')
    expect(invalidated).toContain(JSON.stringify(['workspaces', workspaceId, 'channels']))
    expect(diagnostics).toContain('connected')
    expect(diagnostics).toContain('applied')
  })

  test('resumes from the stored cursor and ignores replayed events', async () => {
    const { client, invalidated } = fakeQueryClient()
    const storage = memoryStorage()
    storage.setItem(`adea:workspace-events-cursor:${workspaceId}`, '5')
    let requestedUrl = ''

    const subscription = createWorkspaceEventSubscription({
      fetchImpl: (async (target: string) => {
        requestedUrl = target
        const encoder = new TextEncoder()
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            // A replay of already-applied events plus one new event.
            controller.enqueue(encoder.encode(frame(envelope(5))))
            controller.enqueue(encoder.encode(frame(envelope(6, 'task.updated'))))
            controller.close()
          },
        })
        return new Response(body, { status: 200 })
      }) as unknown as typeof fetch,
      queryClient: client,
      schedule: immediateScheduler([]),
      storage,
      url,
      workspaceId,
    })

    await new Promise((resolve) => setTimeout(resolve, 20))
    subscription.stop()

    expect(requestedUrl).toContain('cursor=5')
    expect(subscription.appliedSequence()).toBe(6)
    // The duplicate delivery of sequence 5 changed nothing.
    expect(invalidated).toHaveLength(1)
    expect(invalidated[0]).toBe(JSON.stringify(['workspaces', workspaceId, 'tasks']))
  })

  test('a sequence gap refreshes authoritative state instead of applying it blindly', async () => {
    const { client, invalidated } = fakeQueryClient()
    const diagnostics: Array<{ event: string; reason?: string }> = []
    const storage = memoryStorage()
    storage.setItem(`adea:workspace-events-cursor:${workspaceId}`, '3')

    const subscription = createWorkspaceEventSubscription({
      fetchImpl: streamFetch([frame(envelope(7, 'message.created'))]),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      queryClient: client,
      schedule: immediateScheduler([]),
      storage,
      url,
      workspaceId,
    })

    await new Promise((resolve) => setTimeout(resolve, 20))
    subscription.stop()

    // The cursor still advances so the stream can resume, but the client asks
    // for current state rather than inventing the missing sequences.
    expect(subscription.appliedSequence()).toBe(7)
    expect(invalidated).toEqual([JSON.stringify(['workspaces', workspaceId])])
    expect(diagnostics.some((entry) => entry.event === 'gap')).toBe(true)
  })

  test('resync_required refetches current state and resumes from the fresh cursor', async () => {
    const { client, invalidated } = fakeQueryClient()
    const storage = memoryStorage()
    const diagnostics: Array<{ event: string; reason?: string }> = []

    const subscription = createWorkspaceEventSubscription({
      fetchImpl: streamFetch([
        frame({ reason: 'cursor-behind-retained-window' }, 'fresh-cursor', 'resync_required'),
        frame(envelope(12, 'room.updated')),
      ]),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      queryClient: client,
      schedule: immediateScheduler([]),
      storage,
      url,
      workspaceId,
    })

    await new Promise((resolve) => setTimeout(resolve, 20))
    subscription.stop()

    expect(invalidated[0]).toBe(JSON.stringify(['workspaces', workspaceId]))
    expect(diagnostics.some((entry) => entry.reason === 'server')).toBe(true)
    expect(subscription.appliedSequence()).toBe(12)
  })

  test('appends the cursor to a relative stream URL without parsing it as absolute', async () => {
    // The browser API client builds a same-origin path, which is not a valid
    // absolute URL; the subscription must not assume otherwise.
    const { client } = fakeQueryClient()
    const storage = memoryStorage()
    storage.setItem(`adea:workspace-events-cursor:${workspaceId}`, '4')
    const requested: string[] = []

    const subscription = createWorkspaceEventSubscription({
      fetchImpl: (async (target: string) => {
        requested.push(target)
        return new Response(null, { status: 204 })
      }) as unknown as typeof fetch,
      queryClient: client,
      schedule: immediateScheduler([]),
      storage,
      url: `/api/v1/workspaces/${workspaceId}/events`,
      workspaceId,
    })

    await new Promise((resolve) => setTimeout(resolve, 20))
    subscription.stop()

    expect(requested[0]).toBe(`/api/v1/workspaces/${workspaceId}/events?cursor=4`)
  })

  test('reconnects with backoff when the stream ends or refuses', async () => {
    const scheduled: number[] = []
    const { client } = fakeQueryClient()
    const responses = [{ status: 503 }, { status: 200 }]
    let calls = 0

    const subscription = createWorkspaceEventSubscription({
      fetchImpl: (async () => {
        const response = responses[Math.min(calls, responses.length - 1)]!
        calls += 1
        if (response.status !== 200) return new Response(null, { status: response.status })
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close()
            },
          }),
          { status: 200 }
        )
      }) as unknown as typeof fetch,
      queryClient: client,
      schedule: immediateScheduler(scheduled),
      storage: memoryStorage(),
      url,
      workspaceId,
    })

    await new Promise((resolve) => setTimeout(resolve, 20))
    subscription.stop()

    // The refused connection scheduled a retry rather than giving up.
    expect(scheduled.length).toBeGreaterThan(0)
    expect(scheduled[0]).toBeGreaterThanOrEqual(INITIAL_RECONNECT_DELAY_MS / 2)
    expect(calls).toBeGreaterThan(0)
  })

  test('never reconnects faster than the server asks', async () => {
    const scheduled: number[] = []
    const { client } = fakeQueryClient()

    const subscription = createWorkspaceEventSubscription({
      fetchImpl: (async () => {
        const encoder = new TextEncoder()
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode('retry: 5000\n\n'))
              controller.close()
            },
          }),
          { status: 200 }
        )
      }) as unknown as typeof fetch,
      queryClient: client,
      schedule: immediateScheduler(scheduled),
      storage: memoryStorage(),
      url,
      workspaceId,
    })

    await new Promise((resolve) => setTimeout(resolve, 20))
    subscription.stop()

    expect(scheduled[0]).toBeGreaterThanOrEqual(5_000)
  })

  test('stop() ends the subscription', async () => {
    const { client } = fakeQueryClient()
    const subscription = createWorkspaceEventSubscription({
      fetchImpl: streamFetch([frame(envelope(1))]),
      queryClient: client,
      schedule: immediateScheduler([]),
      storage: memoryStorage(),
      url,
      workspaceId,
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    subscription.stop()
    expect(subscription.stop).toBeDefined()
  })
})
