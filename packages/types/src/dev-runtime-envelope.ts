// Internal shared envelope checks. Public consumers keep the dev-runtime-wire entry.
import {
  runtimeActivityEventKinds,
  isRuntimeActivityEventKind,
  isRuntimeCallEventKind,
  type RuntimeActivityEventKind,
} from './dev-runtime-event-kinds'
import type { RuntimeActivityPayloads } from './dev-runtime-activity'
import {
  decodeFollowUpQueueEventPayload,
  type FollowUpQueueEventPayload,
} from './dev-runtime-follow-up-event'
import { usageDataRecord, type RuntimeUsageObservedPayload } from './dev-runtime-usage'
import { assertWellFormedUnicode } from './dev-runtime-unicode'
import { cborByteLength } from './dev-runtime-cbor-length'
import {
  exactKeys,
  fail,
  finiteNumber,
  integerValue,
  literal,
  record,
  stringValue,
  timestamp,
  uint64String,
} from './dev-runtime-validation-internal'

export const runtimeEventKinds = [
  'queue.updated',
  'session.created',
  'session.starting',
  'session.ready',
  'session.disconnected',
  'session.resumed',
  'session.completed',
  'session.failed',
  'session.cancelled',
  'run.created',
  'run.starting',
  'run.ready',
  'run.disconnected',
  'run.resumed',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'turn.user_input',
  'turn.assistant_delta',
  'turn.assistant_message',
  'turn.reasoning_summary',
  'turn.method_step_summary',
  'turn.result',
  'attachment.added',
  'attachment.removed',
  'tool.requested',
  'tool.started',
  'tool.progress',
  'tool.completed',
  'tool.failed',
  'approval.requested',
  'approval.resolved',
  'approval.expired',
  'question.requested',
  'question.resolved',
  'question.expired',
  'file.observed',
  'checkpoint.observed',
  'checkpoint.restore_requested',
  'checkpoint.restore_resolved',
  'checkpoint.restore_failed',
  ...runtimeActivityEventKinds,
  'subagent.observed',
  'usage.observed',
  'terminal.command_started',
  'terminal.command_finished',
  'terminal.cwd_changed',
  'terminal.transcript_reference',
  'capability.degraded',
  'capability.restored',
] as const
export type RuntimeEventKind = (typeof runtimeEventKinds)[number]

export const dataClassifications = [
  'public',
  'workspace_metadata',
  'workspace_private',
  'credential',
  'restricted_local',
] as const
export type DataClassification = (typeof dataClassifications)[number]

export type RuntimeEvent<K extends RuntimeEventKind = RuntimeEventKind> = Readonly<{
  schemaVersion: 1
  eventId: string
  runtimeSessionId: string
  harnessRunId?: string
  generation: number
  seq: string
  occurredAt: string
  receivedAt: string
  source: 'native' | 'acp' | 'authenticated_hook' | 'terminal_fallback' | 'host'
  sourceEventId: string
  confidence: 'authoritative' | 'bounded_projection' | 'untrusted_hint'
  classification: DataClassification
  kind: K
  payload: K extends 'usage.observed'
    ? RuntimeUsageObservedPayload
    : K extends 'queue.updated'
      ? FollowUpQueueEventPayload
      : K extends RuntimeActivityEventKind
        ? RuntimeActivityPayloads[K]
        : unknown
}>

/** Existing runtime-events-v1 data-frame budget; includes the entire encoded event. */
export const RUNTIME_EVENT_CBOR_BYTES_MAX = 64 * 1024

export function assertRuntimeEventFrameSize(event: RuntimeEvent, failureMessage?: string): void {
  if (cborByteLength(event) > RUNTIME_EVENT_CBOR_BYTES_MAX)
    fail('event', failureMessage ?? 'CBOR limit: 64 KiB')
}

function validateEventPayload(value: unknown, path: string, depth = 0): void {
  if (depth > 32) fail(path, 'nesting too deep')
  if (typeof value === 'string') {
    stringValue(value, path, 0, 65_536)
    assertWellFormedUnicode(value, path)
    return
  }
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'number') {
    finiteNumber(value, path)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateEventPayload(entry, `${path}[${index}]`, depth + 1))
    return
  }
  const item = record(value, path)
  for (const [key, entry] of Object.entries(item)) {
    stringValue(key, `${path} key`, 1, 256)
    assertWellFormedUnicode(key, `${path} key`)
    validateEventPayload(entry, `${path}.${key}`, depth + 1)
  }
}

export type RuntimeEventProvenance = Readonly<{
  /** Source derived from the authenticated transport/adapter, never event JSON. */
  source: RuntimeEvent['source']
  /** Exact kinds owned by this authenticated adapter, never capabilities or event JSON. */
  ownedActivityKinds?: readonly RuntimeActivityEventKind[]
}>

export type EventSemantics = Readonly<{
  early(
    item: Record<string, unknown>,
    enforceEnvelopeBounds: boolean
  ): RuntimeUsageObservedPayload | FollowUpQueueEventPayload | undefined
  late(item: Record<string, unknown>): void
}>

export function decodeQueueEventPayload(
  item: Record<string, unknown>,
  decode = decodeFollowUpQueueEventPayload
): FollowUpQueueEventPayload {
  if (item.source !== 'host' || item.confidence !== 'authoritative')
    fail('event.source', 'queue facts require the authoritative host')
  if (item.classification !== 'workspace_metadata')
    fail('event.classification', 'expected workspace_metadata')
  const payload = decode(item.payload)
  if (payload.runtimeSessionId !== item.runtimeSessionId || payload.generation !== item.generation)
    fail('event.payload', 'queue identity does not match event')
  return payload
}

export function isVersionedCallClaim(item: Record<string, unknown>): boolean {
  return (
    isRuntimeCallEventKind(item.kind) &&
    item.payload !== null &&
    typeof item.payload === 'object' &&
    Object.hasOwn(item.payload, 'schemaVersion')
  )
}

export function isVersionedActivityClaim(item: Record<string, unknown>): boolean {
  return (
    isRuntimeActivityEventKind(item.kind) &&
    item.payload !== null &&
    typeof item.payload === 'object' &&
    Object.hasOwn(item.payload, 'schemaVersion')
  )
}

/**
 * Lean envelope decoder: authenticated envelope, generic payload bounds and the
 * full-frame bound for versioned call and activity claims. It never interprets
 * a kind's payload, so a consumer that renders or acts on one must narrow it
 * with the explicit contract (for example `decodeRuntimeCallEvent`); browser
 * stream and replay use `decodeRuntimeBrowserEnvelope` for the additional
 * strict queue contract. Host admission and persistence use
 * `decodeRuntimeEvent`.
 */
export function decodeRuntimeEnvelope(
  value: unknown,
  provenance: RuntimeEventProvenance
): RuntimeEvent {
  return decodeEventEnvelope(value, provenance, true)
}

/** Browser stream and replay decoder with the prompt-free queue contract. */
export function decodeRuntimeBrowserEnvelope(
  value: unknown,
  provenance: RuntimeEventProvenance
): RuntimeEvent {
  const event = decodeRuntimeEnvelope(value, provenance)
  if (event.kind !== 'queue.updated') return event
  const payload = decodeQueueEventPayload(event as unknown as Record<string, unknown>)
  return Object.freeze({ ...event, payload }) as RuntimeEvent
}

export function decodeEventEnvelope(
  value: unknown,
  provenance: RuntimeEventProvenance,
  enforceEnvelopeBounds: boolean,
  semantics?: EventSemantics
): RuntimeEvent {
  // The discriminator and all envelope fields are own data properties before
  // any branch or custom decoder can read them.
  const item = usageDataRecord(value, 'event')
  exactKeys(
    item,
    [
      'schemaVersion',
      'eventId',
      'runtimeSessionId',
      'generation',
      'seq',
      'occurredAt',
      'receivedAt',
      'source',
      'sourceEventId',
      'confidence',
      'classification',
      'kind',
      'payload',
    ],
    ['harnessRunId'],
    'event'
  )
  if (item.schemaVersion !== 1) fail('event.schemaVersion', 'expected 1')
  for (const key of ['eventId', 'runtimeSessionId', 'sourceEventId'] as const) {
    const text = stringValue(item[key], `event.${key}`, 1, 256)
    assertWellFormedUnicode(text, `event.${key}`)
  }
  if (item.harnessRunId !== undefined) {
    const text = stringValue(item.harnessRunId, 'event.harnessRunId', 1, 256)
    assertWellFormedUnicode(text, 'event.harnessRunId')
  }
  integerValue(item.generation, 'event.generation', 0)
  uint64String(item.seq, 'event.seq')
  timestamp(item.occurredAt, 'event.occurredAt')
  timestamp(item.receivedAt, 'event.receivedAt')
  literal(
    item.source,
    ['native', 'acp', 'authenticated_hook', 'terminal_fallback', 'host'],
    'event.source'
  )
  if (item.source !== provenance.source)
    fail('event.source', 'does not match authenticated transport provenance')
  literal(
    item.confidence,
    ['authoritative', 'bounded_projection', 'untrusted_hint'],
    'event.confidence'
  )
  literal(item.classification, dataClassifications, 'event.classification')
  literal(item.kind, runtimeEventKinds, 'event.kind')
  if (item.source === 'terminal_fallback') {
    if (item.confidence === 'authoritative')
      fail('event.confidence', 'terminal fallback cannot be authoritative')
    const fallbackKinds: readonly RuntimeEventKind[] = [
      'turn.assistant_delta',
      'turn.assistant_message',
      'terminal.command_started',
      'terminal.command_finished',
      'terminal.cwd_changed',
      'terminal.transcript_reference',
    ]
    if (!fallbackKinds.includes(item.kind as RuntimeEventKind)) fail('event.kind', 'event kind')
  }
  // Retained legacy events remain opaque. Complete decoding applies every
  // kind-specific contract; the lean decoder keeps whole-frame bounds for
  // versioned call and activity claims without interpreting their payloads.
  const decodedPayload = semantics?.early(item, enforceEnvelopeBounds)
  if (
    !semantics &&
    enforceEnvelopeBounds &&
    (isVersionedCallClaim(item) || isVersionedActivityClaim(item))
  )
    assertRuntimeEventFrameSize(item as RuntimeEvent)
  const payload = decodedPayload ?? item.payload
  validateEventPayload(payload, 'event.payload')
  semantics?.late({ ...item, payload })
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > 256 * 1024)
    fail('event.payload', 'too large')
  if (decodedPayload) return Object.freeze({ ...(value as RuntimeEvent), payload }) as RuntimeEvent
  return value as RuntimeEvent
}
