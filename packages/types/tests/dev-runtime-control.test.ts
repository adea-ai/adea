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

test('rejects rollover dates and cursors beyond the uint64 wire range', () => {
  for (const frame of [
    { type: 'heartbeat', observedAt: '2026-02-31T18:00:00Z', throughSequence: '0' },
    { type: 'heartbeat', observedAt: '2026-09-27T24:00:00Z', throughSequence: '0' },
    {
      type: 'heartbeat',
      observedAt: '2026-09-27T18:00:00Z',
      throughSequence: '18446744073709551616',
    },
    { type: 'resync', reason: 'checkpoint_required', checkpointSequence: '18446744073709551616' },
  ]) {
    expect(() => decodeDevStreamControlFrame(frame)).toThrow()
    expect(() => decodeDevStreamFrame(frame)).toThrow()
  }
})

test('retains valid leap days and nanosecond timestamp precision', () => {
  for (const observedAt of [
    '2024-02-29T12:00:00Z',
    '2026-09-27T18:00:00.123456789Z',
    '0000-01-01T00:00:00Z',
  ]) {
    const frame = { type: 'heartbeat', observedAt, throughSequence: '18446744073709551615' }
    expect(decodeDevStreamControlFrame(frame)).toEqual(frame)
    expect(decodeDevStreamFrame(frame)).toEqual(frame)
  }
})
