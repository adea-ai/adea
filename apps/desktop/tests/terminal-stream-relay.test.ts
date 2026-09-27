import { describe, expect, test } from 'bun:test'

import type { DevStreamFrame } from '../../../packages/types/src/dev-runtime'
import { fromRelayFrame, toRelayFrames } from '../shell/src/dev-runtime/stream-relay'

describe('terminal stream relay control frames', () => {
  test('forwards the canonical server heartbeat and resync control frames', () => {
    const heartbeat: DevStreamFrame = {
      type: 'heartbeat',
      observedAt: '2026-09-27T12:00:00.000Z',
      throughSequence: '0',
    }
    const resync: DevStreamFrame = {
      type: 'resync',
      reason: 'checkpoint_required',
      checkpointSequence: '4',
    }

    expect(toRelayFrames('terminal-stream', heartbeat)).toEqual([
      {
        type: 'heartbeat',
        observedAt: heartbeat.observedAt,
        throughSequence: '0',
      },
    ])
    expect(toRelayFrames('terminal-stream', resync)).toEqual([
      {
        type: 'resync',
        reason: 'checkpoint_required',
        checkpointSequence: '4',
      },
    ])
  })

  test('keeps heartbeat and resync server-only on the renderer relay leg', () => {
    expect(() =>
      fromRelayFrame(
        { type: 'heartbeat', observedAt: '2026-09-27T12:00:00.000Z', throughSequence: '0' },
        64 * 1024
      )
    ).toThrow('relay streams accept only ack/input frames')
    expect(() =>
      fromRelayFrame({ type: 'resync', reason: 'sequence_gap', checkpointSequence: '0' }, 64 * 1024)
    ).toThrow('relay streams accept only ack/input frames')
  })

  test('retains canonical uint64 and timestamp validation while relaying', () => {
    expect(() =>
      toRelayFrames('terminal-stream', {
        type: 'heartbeat',
        observedAt: 'not-a-timestamp',
        throughSequence: '0',
      })
    ).toThrow()
    expect(() =>
      toRelayFrames('terminal-stream', {
        type: 'heartbeat',
        observedAt: '2026-09-27T12:00:00.000Z',
        throughSequence: '-1',
      })
    ).toThrow()
  })
})
