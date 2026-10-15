import {
  exactKeys,
  fail,
  integerValue,
  literal,
  record,
  stringValue,
} from './dev-runtime-validation-internal'
import { decodeDevReply, type DevReply } from './dev-runtime'

export const FOLLOW_UP_QUEUE_MAX_ITEMS = 16
export const FOLLOW_UP_TEXT_MAX_BYTES = 16_384
export const FOLLOW_UP_QUEUE_MAX_BYTES = 65_536

type QueueTarget = Readonly<{ runtimeSessionId: string; expectedGeneration: number }>
export type FollowUpQueueRequest = QueueTarget &
  (
    | Readonly<{ action: 'read' }>
    | Readonly<{ action: 'enqueue'; expectedVersion: number; messageId: string; text: string }>
    | Readonly<{ action: 'remove'; expectedVersion: number; messageId: string }>
    | Readonly<{ action: 'reorder'; expectedVersion: number; messageIds: readonly string[] }>
    | Readonly<{ action: 'deliver'; expectedVersion: number }>
  )
export type FollowUpQueueItem = Readonly<{
  id: string
  text: string
  bytes: number
  state: 'queued' | 'dispatching' | 'ambiguous'
}>
export type FollowUpDeliveryReceipt = Readonly<{
  messageId: string
  status: 'accepted' | 'ambiguous'
}>
export type FollowUpQueueSnapshot = Readonly<{
  schemaVersion: 1
  runtimeSessionId: string
  generation: number
  version: number
  delivery: 'unavailable' | 'busy' | 'ready'
  items: readonly FollowUpQueueItem[]
  lastDelivery?: FollowUpDeliveryReceipt
}>
export type FollowUpQueueEventPayload = Omit<FollowUpQueueSnapshot, 'delivery' | 'items'> &
  Readonly<{
    items: readonly Omit<FollowUpQueueItem, 'text'>[]
    change:
      | 'enqueue'
      | 'remove'
      | 'reorder'
      | 'delivery_started'
      | 'delivery_accepted'
      | 'delivery_ambiguous'
      | 'cancelled'
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
  if (text.trim() !== text || Array.from(text).some((char) => char.charCodeAt(0) < 32))
    fail(path, 'invalid identifier')
  return text
}

function prompt(value: unknown, path: string): number {
  const text = stringValue(value, path, 1, FOLLOW_UP_TEXT_MAX_BYTES)
  const bytes = new TextEncoder().encode(text).byteLength
  if (
    bytes > FOLLOW_UP_TEXT_MAX_BYTES ||
    Array.from(text).some((char) => {
      const code = char.charCodeAt(0)
      return code < 32 && code !== 9 && code !== 10 && code !== 13
    })
  )
    fail(path, 'invalid or oversized queued text')
  return bytes
}

export function decodeFollowUpQueueRequest(value: unknown): FollowUpQueueRequest {
  const item = dataRecord(value, 'followUps')
  literal(item.action, ['read', 'enqueue', 'remove', 'reorder', 'deliver'], 'followUps.action')
  const extra =
    item.action === 'enqueue'
      ? ['expectedVersion', 'messageId', 'text']
      : item.action === 'remove'
        ? ['expectedVersion', 'messageId']
        : item.action === 'reorder'
          ? ['expectedVersion', 'messageIds']
          : item.action === 'deliver'
            ? ['expectedVersion']
            : []
  exactKeys(item, ['runtimeSessionId', 'expectedGeneration', 'action', ...extra], [], 'followUps')
  identifier(item.runtimeSessionId, 'followUps.runtimeSessionId', 256)
  integerValue(item.expectedGeneration, 'followUps.expectedGeneration', 0)
  if (item.action !== 'read') integerValue(item.expectedVersion, 'followUps.expectedVersion', 0)
  if (item.action === 'enqueue' || item.action === 'remove')
    identifier(item.messageId, 'followUps.messageId')
  if (item.action === 'enqueue') prompt(item.text, 'followUps.text')
  if (item.action === 'reorder') {
    if (!Array.isArray(item.messageIds) || item.messageIds.length > FOLLOW_UP_QUEUE_MAX_ITEMS)
      fail('followUps.messageIds', 'expected bounded array')
    item.messageIds.forEach((id) => identifier(id, 'followUps.messageIds[]'))
    if (new Set(item.messageIds).size !== item.messageIds.length)
      fail('followUps.messageIds', 'duplicate id')
  }
  return structuredClone(value) as FollowUpQueueRequest
}

function decodeSnapshot(
  value: unknown,
  event: boolean
): FollowUpQueueSnapshot | FollowUpQueueEventPayload {
  const item = dataRecord(value, 'followUps')
  exactKeys(
    item,
    [
      'schemaVersion',
      'runtimeSessionId',
      'generation',
      'version',
      'items',
      event ? 'change' : 'delivery',
    ],
    ['lastDelivery'],
    'followUps'
  )
  if (item.schemaVersion !== 1) fail('followUps.schemaVersion', 'expected 1')
  identifier(item.runtimeSessionId, 'followUps.runtimeSessionId', 256)
  integerValue(item.generation, 'followUps.generation', 0)
  integerValue(item.version, 'followUps.version', 0)
  if (event)
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
  else literal(item.delivery, ['unavailable', 'busy', 'ready'], 'followUps.delivery')
  if (!Array.isArray(item.items) || item.items.length > FOLLOW_UP_QUEUE_MAX_ITEMS)
    fail('followUps.items', 'expected bounded array')
  const ids = new Set<string>()
  let bytes = 0
  let claimed = 0
  for (const entryValue of item.items) {
    const entry = dataRecord(entryValue, 'followUps.items[]')
    exactKeys(
      entry,
      event ? ['id', 'bytes', 'state'] : ['id', 'bytes', 'state', 'text'],
      [],
      'followUps.items[]'
    )
    const id = identifier(entry.id, 'followUps.items[].id')
    if (ids.has(id)) fail('followUps.items', 'duplicate id')
    ids.add(id)
    integerValue(entry.bytes, 'followUps.items[].bytes', 1, FOLLOW_UP_TEXT_MAX_BYTES)
    if (!event && prompt(entry.text, 'followUps.items[].text') !== entry.bytes)
      fail('followUps.items[].bytes', 'does not match UTF-8 text')
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
  const snapshot = structuredClone(value) as FollowUpQueueSnapshot | FollowUpQueueEventPayload
  snapshot.items.forEach(Object.freeze)
  Object.freeze(snapshot.items)
  if (snapshot.lastDelivery) Object.freeze(snapshot.lastDelivery)
  return Object.freeze(snapshot)
}

export function decodeFollowUpQueueSnapshot(value: unknown): FollowUpQueueSnapshot {
  return decodeSnapshot(value, false) as FollowUpQueueSnapshot
}

/** Strict reply decoder for consumers that load the focused queue contract. */
export function decodeFollowUpQueueReply(value: unknown): DevReply {
  return decodeDevReply(value, { 'dev.session.followUps': decodeFollowUpQueueSnapshot })
}
export function decodeFollowUpQueueEventPayload(value: unknown): FollowUpQueueEventPayload {
  return decodeSnapshot(value, true) as FollowUpQueueEventPayload
}
