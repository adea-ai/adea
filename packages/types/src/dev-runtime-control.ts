import type { DevStreamFrame } from './dev-runtime'
import {
  exactKeys,
  fail,
  literal,
  record,
  timestamp,
  uint64String,
} from './dev-runtime-validation-internal'

export type DevStreamControlFrame = Extract<DevStreamFrame, { type: 'heartbeat' | 'resync' }>

/** Canonical non-byte stream controls, without loading the operation registry. */
export function decodeDevStreamControlFrame(value: unknown): DevStreamControlFrame {
  const item = record(value, 'stream frame')
  if (item.type === 'heartbeat') {
    exactKeys(item, ['type', 'observedAt', 'throughSequence'], [], 'stream frame')
    timestamp(item.observedAt, 'stream frame.observedAt')
    uint64String(item.throughSequence, 'stream frame.throughSequence')
  } else if (item.type === 'resync') {
    exactKeys(item, ['type', 'reason', 'checkpointSequence'], [], 'stream frame')
    literal(item.reason, ['sequence_gap', 'checkpoint_required'], 'stream frame.reason')
    uint64String(item.checkpointSequence, 'stream frame.checkpointSequence')
  } else {
    fail('stream frame.type', 'expected heartbeat|resync')
  }
  return value as DevStreamControlFrame
}
