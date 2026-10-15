// Assistant content identity is protocol data, never inferred from text or time.
// This module is shared by the wire decoder and host append guard; it has no UI
// or process dependencies. Other payload fields retain the bounded JSON contract.
import { fail, integerValue, literal, record, stringValue } from './dev-runtime-validation-internal'

/**
 * Encoded bound for one assistant payload (references keep their own budget).
 * It leaves room for the event envelope in the 64 KiB canonical-CBOR stream
 * frame, so an appended message can always be streamed and replayed.
 */
export const RUNTIME_ASSISTANT_PAYLOAD_BYTES_MAX = 48 * 1024

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

/** Refuse an unpaired surrogate: stream replay would turn it into U+FFFD. */
function wellFormed(text: string, path: string): void {
  if (/[\ud800-\udfff]/u.test(text)) fail(path, 'unpaired surrogate')
}

export function decodeRuntimeAssistantPayload<K extends RuntimeAssistantEventKind>(
  kind: K,
  value: unknown
): RuntimeAssistantPayloads[K] {
  const payload = record(value, 'event.payload')
  const messageId = stringValue(payload.messageId, 'event.payload.messageId', 1, 256)
  // With the `u` flag a surrogate-range class matches only an unpaired surrogate,
  // which UTF-8/CBOR would silently replace and so change the identity.
  if (/[\p{Cc}\s\ud800-\udfff]/u.test(messageId))
    fail(
      'event.payload.messageId',
      'expected a well-formed opaque identity without whitespace or controls'
    )
  const { references: _references, ...own } = payload
  if (
    new TextEncoder().encode(JSON.stringify(own)).byteLength > RUNTIME_ASSISTANT_PAYLOAD_BYTES_MAX
  )
    fail('event.payload', 'maximum assistant payload encoded size exceeded')
  if (kind === 'turn.assistant_delta') {
    integerValue(payload.deltaIndex, 'event.payload.deltaIndex', 0)
    wellFormed(stringValue(payload.text, 'event.payload.text', 0, 65_536), 'event.payload.text')
  } else if (kind === 'turn.assistant_message') {
    wellFormed(stringValue(payload.text, 'event.payload.text', 0, 65_536), 'event.payload.text')
    literal(payload.supersedes, ['deltas'], 'event.payload.supersedes')
  } else if (payload.summary !== undefined) {
    wellFormed(
      stringValue(payload.summary, 'event.payload.summary', 0, 65_536),
      'event.payload.summary'
    )
  }
  return value as RuntimeAssistantPayloads[K]
}
