import { expect, test } from 'bun:test'
import { decodeDevStreamControlFrame } from '../src/dev-runtime-control'
import {
  decodeDevStreamFrame,
  decodeDevStreamControlFrame as compatibilityDecoder,
} from '../src/dev-runtime'

test('focused controls and full contract share one decoder and validation', () => {
  expect(compatibilityDecoder).toBe(decodeDevStreamControlFrame)
  const timestamp = '2026-09-27T18:00:00.000Z'
  for (const frame of [
    { type: 'heartbeat', observedAt: timestamp, throughSequence: '0' },
    { type: 'heartbeat', observedAt: timestamp, throughSequence: '18446744073709551615' },
    { type: 'resync', reason: 'sequence_gap', checkpointSequence: '7' },
    { type: 'resync', reason: 'checkpoint_required', checkpointSequence: '0' },
  ]) {
    expect(decodeDevStreamControlFrame(frame)).toBe(frame)
    expect(decodeDevStreamFrame(frame)).toBe(frame)
  }
  for (const frame of [
    null,
    [],
    { type: 'ack', throughSequence: '0', availableCreditBytes: 1 },
    { type: 'heartbeat', observedAt: timestamp },
    { type: 'heartbeat', observedAt: 'invalid', throughSequence: '0' },
    { type: 'heartbeat', observedAt: timestamp, throughSequence: '01' },
    { type: 'heartbeat', observedAt: timestamp, throughSequence: '1'.repeat(65) },
    { type: 'heartbeat', observedAt: timestamp, throughSequence: 0 },
    { type: 'heartbeat', observedAt: timestamp, throughSequence: '0', extra: true },
    { type: 'resync', reason: 'unknown', checkpointSequence: '0' },
    { type: 'resync', reason: 'sequence_gap', checkpointSequence: '-1' },
  ]) {
    expect(() => decodeDevStreamControlFrame(frame)).toThrow()
    if (frame && !Array.isArray(frame) && frame.type !== 'ack')
      expect(() => decodeDevStreamFrame(frame)).toThrow()
  }
})
