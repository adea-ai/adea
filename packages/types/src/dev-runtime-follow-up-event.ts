import {
  exactKeys,
  fail,
  integerValue,
  literal,
  record,
  stringValue,
} from './dev-runtime-validation-internal'
import { assertWellFormedUnicode } from './dev-runtime-unicode'

export const FOLLOW_UP_QUEUE_MAX_ITEMS = 16
export const FOLLOW_UP_TEXT_MAX_BYTES = 16_384
export const FOLLOW_UP_QUEUE_MAX_BYTES = 65_536

export type FollowUpQueueEventPayload = Readonly<{
  schemaVersion: 1
  runtimeSessionId: string
  generation: number
  version: number
  items: readonly Readonly<{
    id: string
    bytes: number
    state: 'queued' | 'dispatching' | 'ambiguous'
  }>[]
  change:
    | 'enqueue'
    | 'remove'
    | 'reorder'
    | 'delivery_started'
    | 'delivery_accepted'
    | 'delivery_ambiguous'
    | 'cancelled'
  lastDelivery?: Readonly<{ messageId: string; status: 'accepted' | 'ambiguous' }>
}>

function dataRecord(value: unknown, path: string) {
  const item = record(value, path)
  for (const key of Reflect.ownKeys(item)) {
    const descriptor = Object.getOwnPropertyDescriptor(item, key)!
    if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor))
      fail(path, 'expected data properties')
  }
  return item
}

function identifier(value: unknown, path: string, max = 128): string {
  const text = stringValue(value, path, 1, max)
  assertWellFormedUnicode(text, path)
  if (text.trim() !== text || Array.from(text).some((char) => char.charCodeAt(0) < 32))
    fail(path, 'invalid identifier')
  return text
}

/** Prompt-free queue facts shared by the lean browser wire decoder and host. */
export function decodeFollowUpQueueEventPayload(value: unknown): FollowUpQueueEventPayload {
  const item = dataRecord(value, 'followUps')
  exactKeys(
    item,
    ['schemaVersion', 'runtimeSessionId', 'generation', 'version', 'items', 'change'],
    ['lastDelivery'],
    'followUps'
  )
  if (item.schemaVersion !== 1) fail('followUps.schemaVersion', 'expected 1')
  identifier(item.runtimeSessionId, 'followUps.runtimeSessionId', 256)
  integerValue(item.generation, 'followUps.generation', 0)
  integerValue(item.version, 'followUps.version', 0)
  literal(
    item.change,
    [
      'enqueue',
      'remove',
      'reorder',
      'delivery_started',
      'delivery_accepted',
      'delivery_ambiguous',
      'cancelled',
    ],
    'followUps.change'
  )
  if (!Array.isArray(item.items) || item.items.length > FOLLOW_UP_QUEUE_MAX_ITEMS)
    fail('followUps.items', 'expected bounded array')
  const ids = new Set<string>()
  let bytes = 0
  let claimed = 0
  for (const entryValue of item.items) {
    const entry = dataRecord(entryValue, 'followUps.items[]')
    exactKeys(entry, ['id', 'bytes', 'state'], [], 'followUps.items[]')
    const id = identifier(entry.id, 'followUps.items[].id')
    if (ids.has(id)) fail('followUps.items', 'duplicate id')
    ids.add(id)
    integerValue(entry.bytes, 'followUps.items[].bytes', 1, FOLLOW_UP_TEXT_MAX_BYTES)
    bytes += entry.bytes as number
    literal(entry.state, ['queued', 'dispatching', 'ambiguous'], 'followUps.items[].state')
    if (entry.state !== 'queued') claimed += 1
  }
  if (bytes > FOLLOW_UP_QUEUE_MAX_BYTES || claimed > 1)
    fail('followUps.items', 'queue bound exceeded')
  if (item.lastDelivery !== undefined) {
    const receipt = dataRecord(item.lastDelivery, 'followUps.lastDelivery')
    exactKeys(receipt, ['messageId', 'status'], [], 'followUps.lastDelivery')
    identifier(receipt.messageId, 'followUps.lastDelivery.messageId')
    literal(receipt.status, ['accepted', 'ambiguous'], 'followUps.lastDelivery.status')
  }
  const payload = structuredClone(value) as FollowUpQueueEventPayload
  payload.items.forEach(Object.freeze)
  Object.freeze(payload.items)
  if (payload.lastDelivery) Object.freeze(payload.lastDelivery)
  return Object.freeze(payload)
}
