import { describe, expect, test } from 'bun:test'
import type { RuntimeEvent } from '@adea-ai/types/dev-runtime'

import { latestUsageFigures } from '../src/chat/model/usage'

const FIXTURE = { providerId: 'anthropic', modelId: 'fixture-model' }
const B = { providerId: 'openai', modelId: 'other-model' }
let sequence = 0
function usage(
  id: string,
  payload: Record<string, unknown>,
  over: Partial<RuntimeEvent> = {}
): RuntimeEvent {
  sequence += 1
  return {
    schemaVersion: 1,
    eventId: id,
    runtimeSessionId: 'session-1',
    harnessRunId: 'run-1',
    generation: 3,
    seq: String(sequence),
    occurredAt: '2026-10-14T10:00:00.000Z',
    receivedAt: '2026-10-14T10:00:00.000Z',
    source: 'native',
    sourceEventId: `s${sequence}`,
    confidence: 'authoritative',
    classification: 'workspace_private',
    kind: 'usage.observed',
    payload: {
      schemaVersion: 1,
      model: { providerId: 'anthropic', modelId: 'fixture-model' },
      generation: 3,
      context: { used: 10, total: 100 },
      ...payload,
    },
    ...over,
  }
}

describe('context figures', () => {
  test('the newest observation of the generation on screen wins', () => {
    expect(
      latestUsageFigures(
        [
          usage('u1', { context: { used: 10, total: 100 } }),
          usage('u2', { context: { used: 40, total: 100 } }),
        ],
        3
      )
    ).toEqual({ model: FIXTURE, used: 40, total: 100 })
  })

  test('an observation of another generation describes a window that is gone', () => {
    expect(
      latestUsageFigures([usage('u1', {}), usage('u2', { generation: 2 }, { generation: 2 })], 3)
    ).toEqual({ model: FIXTURE, used: 10, total: 100 })
    expect(
      latestUsageFigures([usage('u2', { generation: 2 }, { generation: 2 })], 3)
    ).toBeUndefined()
  })

  test('an unknown figure stays missing and is never drawn as zero', () => {
    expect(
      latestUsageFigures([usage('u1', { context: { used: null, total: 200_000 } })], 3)
    ).toEqual({ model: FIXTURE, total: 200_000 })
    expect(latestUsageFigures([usage('u1', { context: { used: null, total: null } })], 3)).toEqual({
      model: FIXTURE,
    })
  })

  test('an observation the gate refuses is skipped in favour of an earlier one', () => {
    const refused = [
      usage('bad-1', { context: { used: 500, total: 100 } }),
      usage('bad-2', {}, { confidence: 'derived' }),
    ]
    expect(latestUsageFigures([usage('u1', {}), ...refused], 3)).toEqual({
      model: FIXTURE,
      used: 10,
      total: 100,
    })
    expect(latestUsageFigures(refused, 3)).toBeUndefined()
  })

  test('the breakdown is carried as reported', () => {
    expect(
      latestUsageFigures([usage('u1', { breakdown: { input: 8, output: 2, cacheRead: 3 } })], 3)
    ).toMatchObject({ breakdown: { input: 8, output: 2, cacheRead: 3 } })
  })

  test("a cost stays the producer's exact decimal text, never a number", () => {
    for (const amount of [
      '0.0125',
      '0.000000123456789',
      '12345678901234567890.123456789',
      '1.10',
    ]) {
      expect(
        latestUsageFigures([usage('u1', { cost: { amount, currency: 'USD' } })], 3)?.cost
      ).toEqual({ amount, currency: 'USD' })
    }
  })

  test('a model switch shows the named model, not the newest occupancy of another', () => {
    const events = [
      usage('a1', { context: { used: 30, total: 100 } }),
      usage('b1', { model: B, context: { used: 5, total: 1000 } }),
    ]
    expect(latestUsageFigures(events, 3, { modelId: 'fixture-model' })).toMatchObject({
      model: FIXTURE,
      used: 30,
      total: 100,
    })
    expect(
      latestUsageFigures(events, 3, { providerId: 'openai', modelId: 'other-model' })
    ).toMatchObject({
      model: B,
      used: 5,
      total: 1000,
    })
    expect(latestUsageFigures(events, 3, { modelId: 'never-reported' })).toBeUndefined()
  })

  test('interleaved models each keep their own newest snapshot', () => {
    const events = [
      usage('a1', { context: { used: 10, total: 100 } }),
      usage('b1', { model: B, context: { used: 200, total: 1000 } }),
      usage('a2', { context: { used: 20, total: 100 } }),
      usage('b2', { model: B, context: { used: 300, total: 1000 } }),
    ]
    expect(latestUsageFigures(events, 3, { modelId: 'fixture-model' })?.used).toBe(20)
    expect(latestUsageFigures(events, 3, { modelId: 'other-model' })?.used).toBe(300)
  })

  test('the same model id under another provider is another model', () => {
    const events = [
      usage('a1', { context: { used: 10, total: 100 } }),
      usage('c1', {
        model: { providerId: 'openai', modelId: 'fixture-model' },
        context: { used: 99, total: 100 },
      }),
    ]
    expect(
      latestUsageFigures(events, 3, { providerId: 'anthropic', modelId: 'fixture-model' })?.used
    ).toBe(10)
  })

  test('a model id alone is ambiguous when two providers reported it', () => {
    const shared = { providerId: 'openai', modelId: 'fixture-model' }
    const events = [
      usage('a1', { context: { used: 10, total: 100 } }),
      usage('c1', { model: shared, context: { used: 99, total: 100 } }),
    ]
    // Neither the newest nor the first is chosen on the id alone.
    expect(latestUsageFigures(events, 3, { modelId: 'fixture-model' })).toBeUndefined()
    // Naming the provider resolves it, whichever provider.
    expect(
      latestUsageFigures(events, 3, { providerId: 'openai', modelId: 'fixture-model' })?.used
    ).toBe(99)
    expect(
      latestUsageFigures(events, 3, { providerId: 'anthropic', modelId: 'fixture-model' })?.used
    ).toBe(10)
  })

  test('a model id that one provider reported still resolves without a provider', () => {
    const events = [
      usage('a1', { context: { used: 10, total: 100 } }),
      usage('a2', { context: { used: 30, total: 100 } }),
      usage('b1', { model: B, context: { used: 1, total: 2 } }),
    ]
    expect(latestUsageFigures(events, 3, { modelId: 'fixture-model' })?.used).toBe(30)
  })

  test('with no model named, several reported models are ambiguous and show nothing', () => {
    expect(
      latestUsageFigures(
        [usage('a1', {}), usage('b1', { model: B, context: { used: 1, total: 2 } })],
        3
      )
    ).toBeUndefined()
    expect(latestUsageFigures([usage('a1', {}), usage('a2', {})], 3)).toMatchObject({
      model: FIXTURE,
    })
  })

  test('events that are not usage are ignored', () => {
    expect(latestUsageFigures([], 3)).toBeUndefined()
    expect(latestUsageFigures([usage('u1', {}, { kind: 'session.ready' })], 3)).toBeUndefined()
  })
})
