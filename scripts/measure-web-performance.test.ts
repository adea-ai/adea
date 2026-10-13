import { expect, test } from 'bun:test'

import {
  measureScriptedInteractions,
  sampleResponseHeaders,
  summarizeInteractionEvidence,
} from './web-performance-samplers.mjs'

test('header timing excludes a slow response body while still draining it', async () => {
  let clock = 0
  let drained = false
  const response = {
    ok: true,
    status: 200,
    arrayBuffer: async () => {
      clock += 900
      drained = true
      return new ArrayBuffer(0)
    },
  }
  const sample = await sampleResponseHeaders('http://127.0.0.1:1234/', {
    now: () => clock,
    request: async (_url: string, options: { redirect: string }) => {
      expect(options.redirect).toBe('manual')
      clock += 12
      return response
    },
  })
  expect(sample.elapsedMs).toBe(12)
  expect(sample.response).toBe(response)
  expect(drained).toBe(true)
  expect(clock).toBe(912)
})

function pageFixture({
  missingTarget,
  events = [16, 32],
  supported = true,
}: { missingTarget?: string; events?: number[]; supported?: boolean } = {}) {
  const attempts: string[] = []
  return {
    attempts,
    getByRole: (_role: string, { name }: { name: RegExp }) => ({
      first: () => ({
        click: async () => {
          attempts.push(name.source)
          if (name.source === missingTarget) throw new Error('target unavailable')
        },
      }),
    }),
    keyboard: { press: async (key: string) => void attempts.push(key) },
    waitForTimeout: async () => {},
    evaluate: async () => ({ lcpMs: 100, cls: 0, events, eventTimingSupported: supported }),
  }
}

test('a missing required Search target cannot produce a successful latency sample', async () => {
  const page = pageFixture({ missingTarget: 'search' })
  const result = await measureScriptedInteractions(page)
  expect(page.attempts).toEqual(['search', 'Escape', 'user settings', 'Escape'])
  expect(result.interactionStatus).toBe('unavailable')
  expect(result.interactionReason).toBe('required_interaction_failed')
  expect(result.interactionWorstMs).toBeNull()
  expect(
    result.requiredInteractions.filter((step: { completed: boolean }) => !step.completed)
  ).toHaveLength(1)
})

test('missing User settings also refuses the sample even when events were observed', async () => {
  const result = await measureScriptedInteractions(pageFixture({ missingTarget: 'user settings' }))
  expect(result.interactionStatus).toBe('unavailable')
  expect(result.interactionWorstMs).toBeNull()
})

test('zero observed events is explicit unavailable evidence, never zero latency', async () => {
  const result = await measureScriptedInteractions(pageFixture({ events: [] }))
  expect(result.interactionStatus).toBe('unavailable')
  expect(result.interactionReason).toBe('no_interaction_observations')
  expect(result.interactionCount).toBe(0)
  expect(result.interactionWorstMs).toBeNull()
})

test('unsupported Event Timing is unavailable even if a fixture supplies events', async () => {
  const result = await measureScriptedInteractions(pageFixture({ supported: false }))
  expect(result.interactionStatus).toBe('unavailable')
  expect(result.interactionReason).toBe('event_timing_unavailable')
  expect(result.interactionWorstMs).toBeNull()
})

test('completed interactions retain the numeric fields for a valid observed sample', async () => {
  const result = await measureScriptedInteractions(pageFixture())
  expect(result).toMatchObject({
    lcpMs: 100,
    cls: 0,
    interactionStatus: 'measured',
    interactionCount: 2,
    interactionWorstMs: 32,
  })
  expect(result.requiredInteractions).toHaveLength(4)
})

test('malformed duration evidence is failed rather than measured', () => {
  const steps = Array.from({ length: 4 }, (_, index) => ({ index, completed: true }))
  for (const duration of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const result = summarizeInteractionEvidence(steps, [duration], true)
    expect(result.interactionStatus).toBe('failed')
    expect(result.interactionWorstMs).toBeNull()
  }
})
