import { describe, expect, test } from 'bun:test'
import type { RuntimeEvent } from '@adea-ai/types/dev-runtime'

import { latestUsageFigures } from '../src/chat/model/usage'

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
    ).toEqual({ used: 40, total: 100 })
  })

  test('an observation of another generation describes a window that is gone', () => {
    expect(
      latestUsageFigures([usage('u1', {}), usage('u2', { generation: 2 }, { generation: 2 })], 3)
    ).toEqual({ used: 10, total: 100 })
    expect(
      latestUsageFigures([usage('u2', { generation: 2 }, { generation: 2 })], 3)
    ).toBeUndefined()
  })

  test('an unknown figure stays missing and is never drawn as zero', () => {
    expect(
      latestUsageFigures([usage('u1', { context: { used: null, total: 200_000 } })], 3)
    ).toEqual({
      total: 200_000,
    })
    expect(latestUsageFigures([usage('u1', { context: { used: null, total: null } })], 3)).toEqual(
      {}
    )
  })

  test('an observation the gate refuses is skipped in favour of an earlier one', () => {
    const refused = [
      usage('bad-1', { context: { used: 500, total: 100 } }),
      usage('bad-2', {}, { confidence: 'derived' }),
    ]
    expect(latestUsageFigures([usage('u1', {}), ...refused], 3)).toEqual({ used: 10, total: 100 })
    expect(latestUsageFigures(refused, 3)).toBeUndefined()
  })

  test('the breakdown is carried as reported', () => {
    expect(
      latestUsageFigures([usage('u1', { breakdown: { input: 8, output: 2, cacheRead: 3 } })], 3)
    ).toMatchObject({ breakdown: { input: 8, output: 2, cacheRead: 3 } })
  })

  test('a cost is shown only when the shared number keeps its exact value', () => {
    expect(
      latestUsageFigures([usage('u1', { cost: { amount: '0.0125', currency: 'USD' } })], 3)
    ).toMatchObject({ cost: { amount: 0.0125, currency: 'USD' } })
    expect(
      latestUsageFigures(
        [usage('u1', { cost: { amount: '12345678901234567890.123', currency: 'USD' } })],
        3
      )
    ).toEqual({ used: 10, total: 100 })
  })

  test('events that are not usage are ignored', () => {
    expect(latestUsageFigures([], 3)).toBeUndefined()
    expect(latestUsageFigures([usage('u1', {}, { kind: 'session.ready' })], 3)).toBeUndefined()
  })
})
