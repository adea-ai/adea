// Assistant content identity is protocol data, never inferred from text or time.
// This module is shared by the wire decoder and host append guard; it has no UI
// or process dependencies. Other payload fields retain the bounded JSON contract.
import { fail, integerValue, literal, record, stringValue } from './dev-runtime-validation-internal'
import { assertWellFormedUnicode } from './dev-runtime-unicode'

export type RuntimeAssistantEventKind =
  | 'turn.assistant_delta'
  | 'turn.assistant_message'
  | 'turn.result'

export type RuntimeAssistantDeltaPayload = Readonly<{
  messageId: string
  /** Zero-based, contiguous within one scoped message; unrelated events may interleave. */
  deltaIndex: number
  text: string
}>

export type RuntimeAssistantMessagePayload = Readonly<{
  messageId: string
  /** Complete replacement text, including when earlier deltas are no longer retained. */
  text: string
  supersedes: 'deltas'
}>

export type RuntimeAssistantResultPayload = Readonly<{
  /** References the assistant message; a result alone never proves a final answer. */
  messageId: string
  summary?: string
}>

export type RuntimeAssistantPayloads = Readonly<{
  'turn.assistant_delta': RuntimeAssistantDeltaPayload
  'turn.assistant_message': RuntimeAssistantMessagePayload
  'turn.result': RuntimeAssistantResultPayload
}>

export function isRuntimeAssistantEventKind(kind: string): kind is RuntimeAssistantEventKind {
  return (
    kind === 'turn.assistant_delta' || kind === 'turn.assistant_message' || kind === 'turn.result'
  )
}

export function decodeRuntimeAssistantPayload<K extends RuntimeAssistantEventKind>(
  kind: K,
  value: unknown
): RuntimeAssistantPayloads[K] {
  const payload = record(value, 'event.payload')
  const messageId = stringValue(payload.messageId, 'event.payload.messageId', 1, 256)
  // UTF-8/CBOR would silently replace an unpaired surrogate and so change the identity.
  assertWellFormedUnicode(messageId, 'event.payload.messageId')
  if (/[\p{Cc}\s]/u.test(messageId))
    fail('event.payload.messageId', 'expected an opaque identity without whitespace or controls')
  const text = (key: 'text' | 'summary') => {
    const path = `event.payload.${key}`
    assertWellFormedUnicode(stringValue(payload[key], path, 0, 65_536), path)
  }
  if (kind === 'turn.assistant_delta') {
    integerValue(payload.deltaIndex, 'event.payload.deltaIndex', 0)
    text('text')
  } else if (kind === 'turn.assistant_message') {
    text('text')
    literal(payload.supersedes, ['deltas'], 'event.payload.supersedes')
  } else if (payload.summary !== undefined) text('summary')
  return value as RuntimeAssistantPayloads[K]
}
