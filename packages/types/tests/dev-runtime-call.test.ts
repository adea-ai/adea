import { describe, expect, test } from 'bun:test'
import { decodeRuntimeCallEvent as decodeAggregateCallEvent } from '../src/dev-runtime'

import {
  decodeRuntimeCallEvent,
  decodeRuntimeCallPayload,
  decodeRuntimeEvent,
} from '../src/dev-runtime-wire'

const payload = {
  schemaVersion: 1,
  callId: 'call-1',
  phase: 'started',
  permissionEligibility: 'unknown',
} as const

function event(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    eventId: 'event-1',
    runtimeSessionId: 'session-1',
    harnessRunId: 'run-1',
    generation: 1,
    seq: '1',
    occurredAt: '2026-10-15T05:00:00.000Z',
    receivedAt: '2026-10-15T05:00:01.000Z',
    source: 'acp',
    sourceEventId: 'source-1',
    confidence: 'authoritative',
    classification: 'workspace_private',
    kind: 'tool.started',
    payload,
    ...overrides,
  }
}

const decode = (value: unknown) => decodeRuntimeCallEvent(value, { source: 'acp' })

describe('versioned runtime call contract', () => {
  test('the aggregate and wire entry points share the same validator', () => {
    expect(decodeAggregateCallEvent).toBe(decodeRuntimeCallEvent)
  })
  test('pairs observations by an explicit call id without inventing missing facts', () => {
    const started = decode(event())
    const completed = decode(
      event({
        kind: 'tool.completed',
        payload: { ...payload, phase: 'completed', durationMs: 0 },
      })
    )
    expect(started.payload.callId).toBe(completed.payload.callId)
    expect(started.payload.permissionEligibility).toBe('unknown')
    expect(started.payload).not.toHaveProperty('parentCallId')
    expect(started.payload).not.toHaveProperty('input')
    expect(started.payload).not.toHaveProperty('output')
    expect(started.payload).not.toHaveProperty('durationMs')
    expect(completed.payload.durationMs).toBe(0)
  })

  test('validates every tool kind against its own phase', () => {
    for (const phase of ['requested', 'started', 'progress', 'completed', 'failed']) {
      expect(
        decode(event({ kind: `tool.${phase}`, payload: { ...payload, phase } })).payload.phase
      ).toBe(phase)
      expect(() =>
        decode(event({ kind: `tool.${phase}`, payload: { ...payload, phase: 'cancelled' } }))
      ).toThrow('phase')
    }
  })

  test('subagents carry their observed phase and parent rather than inferring either', () => {
    for (const phase of ['requested', 'started', 'progress', 'completed', 'failed', 'cancelled']) {
      const observed = decode(
        event({
          kind: 'subagent.observed',
          payload: { ...payload, phase, parentCallId: 'parent-1', name: 'Reviewer' },
        })
      )
      expect(observed.payload.parentCallId).toBe('parent-1')
      expect(observed.payload.phase).toBe(phase)
    }
    expect(
      decode(event({ payload: { ...payload, parentCallId: null } })).payload.parentCallId
    ).toBeNull()
    expect(() => decode(event({ payload: { ...payload, parentCallId: 'call-1' } }))).toThrow(
      'parentCallId'
    )
  })

  test('requires bounded identity, a run namespace and explicit eligibility', () => {
    for (const callId of ['', ' ', '../call', 'call\n1', 'x'.repeat(257), 1, null]) {
      expect(() => decode(event({ payload: { ...payload, callId } }))).toThrow('callId')
    }
    expect(() => decode(event({ harnessRunId: undefined }))).toThrow('harnessRunId')
    for (const permissionEligibility of [undefined, true, 'allowed', 'eligible']) {
      expect(() => decode(event({ payload: { ...payload, permissionEligibility } }))).toThrow(
        'permissionEligibility'
      )
    }
    expect(() => decode(event({ payload: { ...payload, parentCallId: '' } }))).toThrow(
      'parentCallId'
    )
    for (const durationMs of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => decode(event({ payload: { ...payload, durationMs } }))).toThrow('durationMs')
    }
  })

  test('does not promote permission claims from host lifecycle, hints or fallback', () => {
    expect(() => decodeRuntimeCallEvent(event({ source: 'host' }), { source: 'host' })).toThrow(
      'producer'
    )
    for (const permissionEligibility of ['requires_approval', 'not_required']) {
      expect(
        decode(event({ payload: { ...payload, permissionEligibility } })).payload
          .permissionEligibility
      ).toBe(permissionEligibility)
      for (const source of ['host', 'terminal_fallback']) {
        expect(() =>
          decodeRuntimeCallEvent(
            event({ source, payload: { ...payload, permissionEligibility } }),
            { source }
          )
        ).toThrow()
      }
      for (const confidence of ['bounded_projection', 'untrusted_hint']) {
        expect(() =>
          decode(event({ confidence, payload: { ...payload, permissionEligibility } }))
        ).toThrow('permissionEligibility')
      }
    }
    expect(() => decodeRuntimeCallEvent(event(), { source: 'native' })).toThrow('provenance')
  })

  test('preserves bounded inline JSON, explicit null, and opaque references', () => {
    const input = { type: 'inline', value: { query: 'hello', args: [null, true, 2] } }
    const output = {
      type: 'reference',
      referenceId: 'output-1',
      byteLength: 100,
      sha256: 'a'.repeat(64),
    }
    const observed = decode(event({ payload: { ...payload, input, output } }))
    expect(observed.payload.input).toEqual(input)
    expect(observed.payload.output).toEqual(output)
    expect(
      decode(event({ payload: { ...payload, output: { type: 'inline', value: null } } })).payload
        .output
    ).toEqual({ type: 'inline', value: null })
  })

  test('rejects malformed references, extra authority and unknown contract versions', () => {
    expect(() => decodeRuntimeCallPayload(payload, 'made_up' as never)).toThrow('kind')
    for (const output of [
      { type: 'reference', referenceId: 'https://example.com/file' },
      { type: 'reference', referenceId: 'r', byteLength: -1 },
      { type: 'reference', referenceId: 'r', sha256: 'bad' },
      { type: 'inline' },
      { type: 'inline', value: 1, trusted: true },
      { type: 'url', url: 'file:///private/key' },
    ])
      expect(() => decode(event({ payload: { ...payload, output } }))).toThrow()
    for (const extra of [{ trusted: true }, { source: 'native' }, { approvalId: 'a' }]) {
      expect(() => decode(event({ payload: { ...payload, ...extra } }))).toThrow('unknown key')
    }
    expect(() => decode(event({ payload: { ...payload, schemaVersion: 2 } }))).toThrow(
      'schemaVersion'
    )
    expect(() => decode(event({ kind: 'run.ready' }))).toThrow('kind')
  })

  test('bounds JSON bytes, depth, nodes, strings, and collection width before encoding', () => {
    const atByteLimit = ['x'.repeat(16_384), 'x'.repeat(16_377)]
    expect(new TextEncoder().encode(JSON.stringify(atByteLimit)).byteLength).toBe(32 * 1024)
    expect(
      decode(event({ payload: { ...payload, input: { type: 'inline', value: atByteLimit } } }))
        .payload.input
    ).toEqual({ type: 'inline', value: atByteLimit })
    expect(() =>
      decode(
        event({ payload: { ...payload, input: { type: 'inline', value: [...atByteLimit, ''] } } })
      )
    ).toThrow('encoded size')
    const invalid: unknown[] = [
      'x'.repeat(16_385),
      ['x'.repeat(16_384), 'x'.repeat(16_384)],
      '😀'.repeat(8193),
      Array.from({ length: 257 }, () => null),
      Array.from({ length: 16 }, () => Array.from({ length: 256 }, () => null)),
      Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`k${index}`, 1])),
      { ['k'.repeat(257)]: 1 },
      Array.from({ length: 17 }).reduce<unknown>((value) => [value], null),
      undefined,
      NaN,
      Infinity,
      1n,
      new Date(),
    ]
    const circular: unknown[] = []
    circular.push(circular)
    invalid.push(circular)
    const sparse = Array(2)
    invalid.push(sparse)
    for (const value of invalid) {
      expect(() =>
        decode(event({ payload: { ...payload, input: { type: 'inline', value } } }))
      ).toThrow()
    }
  })

  test('retains legacy opaque events without granting them a validated call identity', () => {
    const legacy = event({ payload: { name: 'read_file' } })
    expect(decodeRuntimeEvent(legacy, { source: 'acp' })).toEqual(legacy)
    expect(() => decode(legacy)).toThrow('schemaVersion')
    expect(() =>
      decodeRuntimeEvent(event({ payload: { ...payload, callId: '' } }), { source: 'acp' })
    ).toThrow('callId')
  })
})
