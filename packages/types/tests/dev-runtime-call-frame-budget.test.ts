import { expect, test } from 'bun:test'

import { decodeRuntimeCallPayload } from '../src/dev-runtime-call'
import { decodeRuntimeCallEvent, decodeRuntimeEvent, encodeCbor } from '../src/dev-runtime-wire'

const data = () => ({ type: 'inline', value: ['x'.repeat(16_384), 'x'.repeat(16_377)] })

function event() {
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
    kind: 'tool.completed',
    payload: {
      schemaVersion: 1,
      callId: 'call-1',
      phase: 'completed',
      permissionEligibility: 'unknown',
      input: data(),
      output: data(),
    },
  }
}

test('two individually valid 32 KiB call fields cannot exceed the full CBOR event budget', () => {
  const observed = event()
  expect(() => {
    decodeRuntimeCallPayload(observed.payload, 'tool.completed')
  }).not.toThrow()
  expect(new TextEncoder().encode(JSON.stringify(observed.payload.input.value)).byteLength).toBe(
    32 * 1024
  )
  expect(new TextEncoder().encode(JSON.stringify(observed.payload.output.value)).byteLength).toBe(
    32 * 1024
  )
  expect(encodeCbor(observed).byteLength).toBeGreaterThan(65_536)
  expect(() => {
    decodeRuntimeCallEvent(observed, { source: 'acp' })
  }).toThrow('CBOR')
  expect(() => {
    decodeRuntimeEvent(observed, { source: 'acp' })
  }).toThrow('CBOR')
})

test('the exact full-event bound includes UTF-8 payload and envelope metadata bytes', () => {
  const observed = event()
  const excess = encodeCbor(observed).byteLength - 65_536
  observed.payload.output.value[1] = observed.payload.output.value[1]!.slice(0, -excess)
  expect(encodeCbor(observed).byteLength).toBe(65_536)
  expect(decodeRuntimeCallEvent(observed, { source: 'acp' })).toEqual(observed)
  const asciiOutput = observed.payload.output.value[1]!
  observed.payload.output.value[1] = `${observed.payload.output.value[1]!.slice(0, -1)}é`
  expect(() => {
    decodeRuntimeCallPayload(observed.payload, 'tool.completed')
  }).not.toThrow()
  expect(encodeCbor(observed).byteLength).toBe(65_537)
  expect(() => {
    decodeRuntimeCallEvent(observed, { source: 'acp' })
  }).toThrow('CBOR')
  observed.payload.output.value[1] = observed.payload.output.value[1]!.slice(1)
  expect(encodeCbor(observed).byteLength).toBe(65_536)
  expect(decodeRuntimeCallEvent(observed, { source: 'acp' })).toEqual(observed)
  observed.payload.output.value[1] = asciiOutput
  observed.sourceEventId = 'sourcé-1'
  expect(encodeCbor(observed).byteLength).toBe(65_537)
  expect(() => {
    decodeRuntimeCallEvent(observed, { source: 'acp' })
  }).toThrow('CBOR')
})
