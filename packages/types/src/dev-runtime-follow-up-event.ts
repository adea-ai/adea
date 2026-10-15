import { fail } from './dev-runtime-validation-internal'
import { usageDataRecord } from './dev-runtime-usage'

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

function validIdentifier(value: unknown, max = 128): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    value.trim() === value &&
    !Array.from(value).some((character) => character.charCodeAt(0) < 32)
  )
}

/** Prompt-free queue facts shared by the lean browser wire decoder and host. */
export function validateFollowUpQueueEventPayload(value: unknown): FollowUpQueueEventPayload {
  const item = usageDataRecord(value, 'followUps')
  const hasReceipt = 'lastDelivery' in item
  if (
    Object.keys(item).length !== 6 + Number(hasReceipt) ||
    item.schemaVersion !== 1 ||
    !validIdentifier(item.runtimeSessionId, 256) ||
    !Number.isSafeInteger(item.generation) ||
    (item.generation as number) < 0 ||
    !Number.isSafeInteger(item.version) ||
    (item.version as number) < 0 ||
    ![
      'enqueue',
      'remove',
      'reorder',
      'delivery_started',
      'delivery_accepted',
      'delivery_ambiguous',
      'cancelled',
    ].includes(item.change as string) ||
    !Array.isArray(item.items) ||
    item.items.length > FOLLOW_UP_QUEUE_MAX_ITEMS
  )
    fail('followUps', 'invalid queue event')
  const ids = new Set<string>()
  let bytes = 0
  let claimed = 0
  for (const entryValue of item.items) {
    const entry = usageDataRecord(entryValue, 'followUps.items[]')
    const id = entry.id
    if (
      Object.keys(entry).length !== 3 ||
      !validIdentifier(id) ||
      !Number.isSafeInteger(entry.bytes) ||
      (entry.bytes as number) < 1 ||
      (entry.bytes as number) > FOLLOW_UP_TEXT_MAX_BYTES ||
      !['queued', 'dispatching', 'ambiguous'].includes(entry.state as string) ||
      ids.has(id)
    )
      fail('followUps', 'invalid queue item')
    ids.add(id)
    bytes += entry.bytes as number
    if (entry.state !== 'queued') claimed += 1
  }
  if (bytes > FOLLOW_UP_QUEUE_MAX_BYTES || claimed > 1) fail('followUps', 'invalid queue bounds')
  if (item.lastDelivery !== undefined) {
    const receipt = usageDataRecord(item.lastDelivery, 'followUps.lastDelivery')
    if (
      Object.keys(receipt).length !== 2 ||
      !validIdentifier(receipt.messageId) ||
      !['accepted', 'ambiguous'].includes(receipt.status as string)
    )
      fail('followUps', 'invalid delivery receipt')
  }
  return value as FollowUpQueueEventPayload
}

/** Strict queue decoder used by host persistence and callers needing detached facts. */
export function decodeFollowUpQueueEventPayload(value: unknown): FollowUpQueueEventPayload {
  const payload = structuredClone(validateFollowUpQueueEventPayload(value))
  payload.items.forEach(Object.freeze)
  Object.freeze(payload.items)
  if (payload.lastDelivery) Object.freeze(payload.lastDelivery)
  return Object.freeze(payload)
}
