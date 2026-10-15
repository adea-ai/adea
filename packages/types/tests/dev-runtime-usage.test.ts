import { describe, expect, test } from 'bun:test'

import {
  decodeCbor,
  decodeRuntimeEvent,
  decodeRuntimeUsageObservedPayload,
  encodeCbor,
  type RuntimeEvent,
} from '../src/dev-runtime-wire'
import { decodeRuntimeUsageObservedPayload as decodeAggregateUsage } from '../src/dev-runtime'

const payload = {
  schemaVersion: 1,
  model: { providerId: 'provider-a', modelId: 'model-a' },
  generation: 2,
  context: { used: 12_000, total: 128_000 },
} as const

function event(usage: unknown = payload) {
  return {
    schemaVersion: 1,
    eventId: 'event-usage-1',
    runtimeSessionId: 'session-1',
    harnessRunId: 'run-1',
    generation: 2,
    seq: '1',
    occurredAt: '2026-10-15T05:00:00.000Z',
    receivedAt: '2026-10-15T05:00:01.000Z',
    source: 'native',
    sourceEventId: 'provider-usage-1',
    confidence: 'authoritative',
    classification: 'workspace_metadata',
    kind: 'usage.observed',
    payload: usage,
  } as const
}

const decode = (usage: unknown) => decodeRuntimeEvent(event(usage), { source: 'native' })

describe('usage.observed contract', () => {
  test('refuses accessors and serialization hooks in usage records', () => {
    for (const key of ['model', 'context', 'breakdown', 'cost']) {
      const value = { ...payload }
      Object.defineProperty(value, key, { enumerable: true, get: () => payload.context })
      expect(() => decodeRuntimeUsageObservedPayload(value, 2)).toThrow()
    }
    const withHook = { ...payload, context: { ...payload.context } }
    Object.defineProperty(withHook.context, 'toJSON', { value: () => ({ total: 128_000 }) })
    expect(() => decodeRuntimeUsageObservedPayload(withHook, 2)).toThrow()
  })

  test('decodes a detached snapshot that cannot change with its original event', () => {
    const raw = {
      ...event(),
      generation: Number(2),
      payload: {
        ...payload,
        context: { used: Number(12_000), total: 128_000 },
        model: { ...payload.model },
      },
    }
    const decoded = decodeRuntimeEvent(raw, { source: 'native' })
    const usage = decodeRuntimeUsageObservedPayload(raw.payload, 2)
    raw.generation = 3
    raw.payload.context.used = -1
    expect(decoded.generation).toBe(2)
    expect(decoded.payload).toMatchObject({ context: { used: 12_000 } })
    expect(usage.context.used).toBe(12_000)
    expect(Object.isFrozen(usage.context)).toBe(true)
  })

  test('exposes the same strict codec through focused and aggregate entries', () => {
    const typed: RuntimeEvent<'usage.observed'> = { ...event(), payload }
    expect(typed.payload.model.modelId).toBe('model-a')
    expect(decodeAggregateUsage).toBe(decodeRuntimeUsageObservedPayload)
    expect(decodeRuntimeUsageObservedPayload(payload, 2)).toEqual(payload)
    expect(() => decodeRuntimeUsageObservedPayload(payload, 1)).toThrow('generation')
    expect(() => decodeRuntimeUsageObservedPayload(payload, NaN)).toThrow('expectedGeneration')
  })

  test('round trips reported usage through the actual event wire decoder', () => {
    const value = event({
      ...payload,
      breakdown: {
        input: 80_000,
        output: 20_000,
        cacheRead: 10_000,
        cacheWrite: 500,
        reasoning: 700,
      },
      cost: { amount: '0.001200', currency: 'USD' },
    })
    const wire = decodeCbor(encodeCbor(value))
    expect(decodeRuntimeEvent(wire.value, { source: 'native' })).toEqual(value)
  })

  test.each([
    { used: null, total: null },
    { used: 123, total: null },
    { used: null, total: 128_000 },
    { used: 0, total: 128_000 },
    { used: 128_000, total: 128_000 },
    { used: Number.MAX_SAFE_INTEGER, total: Number.MAX_SAFE_INTEGER },
  ])('preserves partial and unknown context without filling figures: %j', (context) => {
    const value = { ...payload, context }
    expect(decode(value).payload).toEqual(value)
    expect(Object.keys(decode(value).payload as object)).toEqual(Object.keys(value))
  })

  test('accepts independently reported partial breakdown and exact zero cost', () => {
    const value = {
      ...payload,
      context: { used: null, total: null },
      breakdown: { cacheRead: 42, reasoning: 0 },
      cost: { amount: '0', currency: 'EUR' },
    }
    expect(decode(value).payload).toEqual(value)
  })

  test('preserves large independent generation counts and exact cost without summing or rounding', () => {
    const value = {
      ...payload,
      breakdown: {
        input: Number.MAX_SAFE_INTEGER,
        output: Number.MAX_SAFE_INTEGER,
        cacheRead: Number.MAX_SAFE_INTEGER - 1,
        cacheWrite: 1,
        reasoning: Number.MAX_SAFE_INTEGER,
      },
      cost: { amount: '9007199254740993.000000000000000001', currency: 'USD' },
    }
    expect(decode(value).payload).toEqual(value)
    expect(decodeRuntimeUsageObservedPayload(value, 2)).toEqual(value)
  })

  const invalidPayloads: [string, unknown][] = [
    ['opaque legacy payload', {}],
    ['null payload', null],
    ['array payload', []],
    ['unknown version', { ...payload, schemaVersion: 2 }],
    ['unknown generation', { ...payload, generation: null }],
    ['unknown property', { ...payload, estimate: 1 }],
    ['missing context', { schemaVersion: 1, model: payload.model, generation: 2 }],
    ['missing used', { ...payload, context: { total: 100 } }],
    ['missing total', { ...payload, context: { used: 10 } }],
    ['unknown context property', { ...payload, context: { used: 10, total: 100, remaining: 90 } }],
    ['empty model', { ...payload, model: { providerId: 'provider-a', modelId: '' } }],
    ['blank provider', { ...payload, model: { providerId: ' ', modelId: 'model-a' } }],
    ['control in model', { ...payload, model: { ...payload.model, modelId: 'model\n' } }],
    [
      'C1 control in provider',
      { ...payload, model: { ...payload.model, providerId: 'provider\u0085a' } },
    ],
    ['oversized model', { ...payload, model: { ...payload.model, modelId: 'm'.repeat(257) } }],
    ['unknown model property', { ...payload, model: { ...payload.model, name: 'model' } }],
    ['missing model identity', { ...payload, model: { modelId: 'model-a' } }],
    ['stale generation', { ...payload, generation: 1 }],
    ['future generation', { ...payload, generation: 3 }],
    ['negative generation', { ...payload, generation: -1 }],
    ['fractional generation', { ...payload, generation: 2.5 }],
    ['unsafe generation', { ...payload, generation: Number.MAX_SAFE_INTEGER + 1 }],
    ['context overflow', { ...payload, context: { used: 101, total: 100 } }],
    ['zero window', { ...payload, context: { used: 0, total: 0 } }],
    ['empty breakdown', { ...payload, breakdown: {} }],
    ['unknown breakdown block', { ...payload, breakdown: null }],
    ['unknown cost block', { ...payload, cost: null }],
    ['unknown breakdown', { ...payload, breakdown: { estimated: 100 } }],
    ['cache read exceeds input', { ...payload, breakdown: { input: 10, cacheRead: 11 } }],
    ['cache write exceeds input', { ...payload, breakdown: { input: 10, cacheWrite: 11 } }],
    [
      'combined cache exceeds input',
      { ...payload, breakdown: { input: 10, cacheRead: 6, cacheWrite: 5 } },
    ],
    [
      'cache addition overflow',
      {
        ...payload,
        breakdown: {
          input: Number.MAX_SAFE_INTEGER,
          cacheRead: Number.MAX_SAFE_INTEGER,
          cacheWrite: 1,
        },
      },
    ],
    ['reasoning exceeds output', { ...payload, breakdown: { output: 1, reasoning: 2 } }],
    ['missing cost currency', { ...payload, cost: { amount: '1' } }],
    [
      'unknown cost property',
      { ...payload, cost: { amount: '1', currency: 'USD', estimated: true } },
    ],
  ]

  for (const [name, value] of invalidPayloads) {
    test(`rejects ${name}`, () => {
      expect(() => decode(value)).toThrow()
      expect(() => decodeRuntimeUsageObservedPayload(value, 2)).toThrow()
    })
  }

  for (const value of [
    -1,
    0.5,
    NaN,
    Infinity,
    -Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    '10',
    true,
  ]) {
    test(`rejects invalid token counter ${String(value)} in every position`, () => {
      expect(() => decode({ ...payload, context: { used: value, total: null } })).toThrow()
      expect(() => decode({ ...payload, context: { used: null, total: value } })).toThrow()
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']) {
        expect(() => decode({ ...payload, breakdown: { [key]: value } })).toThrow()
      }
    })
  }

  for (const amount of [
    -1,
    0.1,
    '',
    '-1',
    'NaN',
    'Infinity',
    '1e3',
    '01',
    '.1',
    '1.',
    '1\n',
    '1'.repeat(65),
  ]) {
    test(`rejects invalid cost amount ${String(amount)}`, () => {
      expect(() => decode({ ...payload, cost: { amount, currency: 'USD' } })).toThrow()
    })
  }

  for (const currency of ['', 'usd', '$', 'US', 'USDD', 'USD\n']) {
    test(`rejects invalid currency ${JSON.stringify(currency)}`, () => {
      expect(() => decode({ ...payload, cost: { amount: '0.1', currency } })).toThrow()
    })
  }

  test('rejects lower confidence and terminal fallback usage', () => {
    for (const confidence of ['bounded_projection', 'untrusted_hint']) {
      expect(() => decodeRuntimeEvent({ ...event(), confidence }, { source: 'native' })).toThrow()
    }
    expect(() =>
      decodeRuntimeEvent(
        { ...event(), source: 'terminal_fallback', confidence: 'bounded_projection' },
        { source: 'terminal_fallback' }
      )
    ).toThrow()
  })

  test('validates each model and generation independently without aggregation', () => {
    const first = decode(payload)
    const second = decode({
      ...payload,
      model: { ...payload.model, modelId: 'model-b' },
      context: { used: 0, total: null },
    })
    const resumed = event({ ...payload, generation: 3, context: { used: null, total: null } })
    expect(decodeRuntimeEvent({ ...resumed, generation: 3 }, { source: 'native' }).payload).toEqual(
      resumed.payload
    )
    expect(first.payload).toEqual(payload)
    expect(second.payload).toMatchObject({
      model: { modelId: 'model-b' },
      context: { used: 0, total: null },
    })
  })
})
