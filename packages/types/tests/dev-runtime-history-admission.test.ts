import { describe, expect, test } from 'bun:test'
import { decodeRuntimeEventHistoryPage } from '../src/dev-runtime-history'
import { decodeRuntimeEnvelope, decodeRuntimeEvent } from '../src/dev-runtime-wire'

const call = {
  schemaVersion: 1,
  eventId: 'event-1',
  runtimeSessionId: 'session-1',
  harnessRunId: 'run-1',
  generation: 1,
  seq: '1',
  occurredAt: '2026-10-15T05:00:00Z',
  receivedAt: '2026-10-15T05:00:01Z',
  source: 'acp',
  sourceEventId: 'source-1',
  confidence: 'authoritative',
  classification: 'workspace_private',
  kind: 'tool.started',
  payload: {
    schemaVersion: 1,
    callId: 'call-1',
    phase: 'started',
    permissionEligibility: 'unknown',
  },
} as const

function page(item: unknown) {
  return {
    runtimeSessionId: 'session-1',
    generation: 1,
    beforeSequence: '2',
    retainedFromSequence: '1',
    retainedThroughSequence: '1',
    historyStart: 'generation_start',
    items: [item],
  }
}

describe('history retains complete canonical event admission', () => {
  test('accepts the same canonical call as the public full decoder', () => {
    expect(decodeRuntimeEvent(call, { source: 'acp' })).toEqual(call)
    expect(decodeRuntimeEventHistoryPage(page(call)).items).toEqual([call])
  })

  test('a lean-valid envelope cannot bypass the kind-specific history contract', () => {
    const { harnessRunId: _run, ...withoutRun } = call
    for (const invalid of [
      { ...call, payload: { schemaVersion: 1 } },
      { ...call, payload: { ...call.payload, phase: 'completed' } },
      { ...call, source: 'host' },
      withoutRun,
      { ...call, payload: { ...call.payload, unexpected: true } },
    ]) {
      expect(decodeRuntimeEnvelope(invalid, { source: invalid.source })).toEqual(invalid)
      expect(() => decodeRuntimeEvent(invalid, { source: invalid.source })).toThrow()
      expect(() => decodeRuntimeEventHistoryPage(page(invalid))).toThrow()
    }
  })

  test('retains private-body withholding and page identity/generation fences', () => {
    const withheld = { ...call, classification: 'restricted_local', payload: {} }
    expect(decodeRuntimeEventHistoryPage(page(withheld)).items).toEqual([withheld])
    for (const invalid of [
      { ...call, runtimeSessionId: 'foreign-session' },
      { ...call, generation: 2 },
      { ...call, seq: '2' },
      { ...call, classification: 'credential' },
      { ...call, classification: 'restricted_local' },
    ])
      expect(() => decodeRuntimeEventHistoryPage(page(invalid))).toThrow()
  })
})
