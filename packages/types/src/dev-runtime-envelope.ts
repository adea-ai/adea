// Internal shared envelope checks. Public consumers keep the dev-runtime-wire entry.
import { runtimeActivityEventKinds, type RuntimeActivityEventKind } from './dev-runtime-event-kinds'
import { isRuntimeCallEventKind } from './dev-runtime-event-kinds'
import { usageDataRecord, type RuntimeUsageObservedPayload } from './dev-runtime-usage'
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
  uint64Pattern,
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
  payload: K extends 'usage.observed' ? RuntimeUsageObservedPayload : unknown
}>

/** Existing runtime-events-v1 data-frame budget; includes the entire encoded event. */
export const RUNTIME_EVENT_CBOR_BYTES_MAX = 64 * 1024

export function assertRuntimeEventFrameSize(event: RuntimeEvent): void {
  if (cborByteLength(event) > RUNTIME_EVENT_CBOR_BYTES_MAX)
    fail('event', 'full CBOR event exceeds the 64 KiB runtime-events frame limit')
}

function validateEventPayload(value: unknown, path: string, depth = 0): void {
  if (depth > 32) fail(path, 'maximum nesting depth exceeded')
  if (typeof value === 'string') {
    stringValue(value, path, 0, 65_536)
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
    validateEventPayload(entry, `${path}.${key}`, depth + 1)
  }
}

export type RuntimeEventProvenance = Readonly<{
  /** Source derived from the authenticated transport/adapter, never event JSON. */
  source: RuntimeEvent['source']
  /** Exact kinds owned by this authenticated adapter, never event JSON. */
  ownedActivityKinds?: readonly RuntimeActivityEventKind[]
}>

export type EventSemantics = Readonly<{
  /** May return a normalized replacement payload (usage observations). */
  early(item: Record<string, unknown>, enforceEnvelopeBounds: boolean): unknown | undefined
  late(item: Record<string, unknown>): void
}>

export function isVersionedCallClaim(item: Record<string, unknown>): boolean {
  return (
    isRuntimeCallEventKind(item.kind) &&
    item.payload !== null &&
    typeof item.payload === 'object' &&
    Object.hasOwn(item.payload, 'schemaVersion')
  )
}

/**
 * Lean browser decoder: authenticated envelope, generic payload bounds and the
 * full-frame bound for versioned call claims. It never interprets a kind's
 * payload, so a consumer that renders or acts on one must narrow it with the
 * explicit contract (for example `decodeRuntimeCallEvent`). Host admission and
 * persistence use `decodeRuntimeEvent`.
 */
export function decodeRuntimeEnvelope(
  value: unknown,
  provenance: RuntimeEventProvenance
): RuntimeEvent {
  return decodeEventEnvelope(value, provenance, true)
}

export function decodeEventEnvelope(
  value: unknown,
  provenance: RuntimeEventProvenance,
  enforceEnvelopeBounds: boolean,
  semantics?: EventSemantics
): RuntimeEvent {
  // A programmatic discriminator must be inert before ANY field is read.
  // Otherwise a changing `kind` getter can select a different validation path.
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
  for (const key of ['eventId', 'runtimeSessionId', 'sourceEventId'] as const)
    stringValue(item[key], `event.${key}`, 1, 256)
  if (item.harnessRunId !== undefined) stringValue(item.harnessRunId, 'event.harnessRunId', 1, 256)
  integerValue(item.generation, 'event.generation', 0)
  if (!uint64Pattern.test(stringValue(item.seq, 'event.seq')))
    fail('event.seq', 'expected uint64 string')
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
    if (!fallbackKinds.includes(item.kind as RuntimeEventKind))
      fail('event.kind', 'terminal fallback cannot synthesize this event kind')
  }
  // Retained legacy events remain opaque. With semantics, a versioned call claim
  // must satisfy the complete contract even through the generic decoder; the lean
  // decoder still bounds the whole encoded call event. Kind-specific semantics may
  // normalize a payload (usage observations are validated and replaced).
  const payload = semantics
    ? (semantics.early(item, enforceEnvelopeBounds) ?? item.payload)
    : item.payload
  if (!semantics && enforceEnvelopeBounds && isVersionedCallClaim(item))
    assertRuntimeEventFrameSize(item as RuntimeEvent)
  validateEventPayload(payload, 'event.payload')
  semantics?.late(item)
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > 256 * 1024)
    fail('event.payload', 'maximum encoded size exceeded')
  if (payload !== item.payload) return Object.freeze({ ...(value as RuntimeEvent), payload })
  return value as RuntimeEvent
}
