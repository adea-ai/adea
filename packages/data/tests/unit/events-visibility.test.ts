import { expect, test } from 'bun:test'
import type { QueryClient } from '@tanstack/solid-query'
import { createWorkspaceEventSubscription } from '../../src/events'

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}
function visibility(initial = true) {
  let visible = initial
  const listeners = new Set<() => void>()
  return {
    isVisible: () => visible,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set(value: boolean) {
      visible = value
      for (const listener of listeners) listener()
    },
    listeners,
  }
}
function fixture(initial = true) {
  const visible = visibility(initial)
  const requests: Array<{ url: string; signal: AbortSignal }> = []
  const retry = new Set<() => void>()
  const values = new Map<string, string>()
  let canceled = 0
  const subscription = createWorkspaceEventSubscription({
    workspaceId: 'workspace',
    url: '/events',
    visibility: visible,
    queryClient: { invalidateQueries: () => Promise.resolve() } as unknown as QueryClient,
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value)
      },
      removeItem: (key) => {
        values.delete(key)
      },
    },
    schedule(run) {
      retry.add(run)
      return () => {
        retry.delete(run)
      }
    },
    fetchImpl: (async (url, options) => {
      requests.push({ url: String(url), signal: options!.signal as AbortSignal })
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'id: signed-cursor\nevent: workspace.withheld\ndata: {"workspaceSequence":7}\n\n'
              )
            )
          },
          cancel() {
            canceled++
          },
        })
      )
    }) as typeof fetch,
  })
  return { visible, requests, retry, subscription, canceled: () => canceled }
}

test('hidden windows open no stream; visibility resumes once and stop removes its listener', async () => {
  const f = fixture(false)
  await settle()
  expect(f.requests).toHaveLength(0)
  f.subscription.reconnect()
  expect(f.requests).toHaveLength(0)
  f.visible.set(true)
  f.visible.set(true)
  await settle()
  expect(f.requests).toHaveLength(1)
  expect(f.subscription.appliedSequence()).toBe(7)
  f.subscription.stop()
  await settle()
  expect(f.requests[0]!.signal.aborted).toBe(true)
  expect(f.canceled()).toBe(1)
  expect(f.visible.listeners.size).toBe(0)
  expect(f.retry.size).toBe(0)
  f.visible.set(false)
  f.visible.set(true)
  expect(f.requests).toHaveLength(1)
})

test('hiding aborts the stream, suppresses retries and resumes with the signed cursor', async () => {
  const f = fixture()
  await settle()
  f.visible.set(false)
  expect(f.requests[0]!.signal.aborted).toBe(true)
  // Resume before the aborted reader settles: queue exactly one replacement.
  f.visible.set(true)
  f.visible.set(true)
  await settle()
  expect(f.requests).toHaveLength(2)
  expect(f.requests[1]!.url).toBe('/events?cursor=signed-cursor')
  expect(f.canceled()).toBe(1)
  f.visible.set(false)
  await settle()
  expect(f.retry.size).toBe(0)
  f.subscription.stop()
})

test('manual reconnect replaces one live stream without waiting for backoff', async () => {
  const f = fixture()
  await settle()
  f.subscription.reconnect()
  f.subscription.reconnect()
  await settle()
  expect(f.requests).toHaveLength(2)
  expect(f.requests[1]!.signal.aborted).toBe(false)
  expect(f.retry.size).toBe(0)
  f.subscription.stop()
})

test('hiding cancels a scheduled reconnect and showing starts immediately', async () => {
  const visible = visibility()
  const retry = new Set<() => void>()
  let requests = 0
  const subscription = createWorkspaceEventSubscription({
    workspaceId: 'workspace',
    url: '/events',
    visibility: visible,
    queryClient: {} as QueryClient,
    fetchImpl: (async () => {
      requests++
      throw new Error('offline')
    }) as typeof fetch,
    schedule(run) {
      retry.add(run)
      return () => {
        retry.delete(run)
      }
    },
  })
  await settle()
  expect(retry.size).toBe(1)
  visible.set(false)
  expect(retry.size).toBe(0)
  await settle()
  expect(requests).toBe(1)
  visible.set(true)
  await settle()
  expect(requests).toBe(2)
  subscription.stop()
  expect(retry.size).toBe(0)
})
