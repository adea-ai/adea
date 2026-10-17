import { decodeRuntimeAssistantPayload, isRuntimeAssistantEventKind } from './dev-runtime-assistant'
export { decodeRuntimeAssistantPayload, isRuntimeAssistantEventKind } from './dev-runtime-assistant'
export type {
  RuntimeAssistantEventKind,
  RuntimeAssistantDeltaPayload,
  RuntimeAssistantMessagePayload,
  RuntimeAssistantResultPayload,
  RuntimeAssistantPayloads,
} from './dev-runtime-assistant'
import { decodeChatAttachmentEventPayload } from './dev-runtime-attachments'
import {
  exactKeys,
  fail,
  finiteNumber,
  integerValue,
  literal,
  objectPrototype,
  record,
  stringValue,
  timestamp,
  uint64String,
} from './dev-runtime-validation-internal'
import {
  decodeRuntimeCallPayload,
  isRuntimeCallEventKind,
  type RuntimeCallEventKind,
  type RuntimeCallPayload,
} from './dev-runtime-call'
import {
  decodeRuntimeActivityPayload,
  isRuntimeActivityEventKind,
  runtimeActivityEventKinds,
  type RuntimeActivityEventKind,
  type RuntimeActivityPayloads,
} from './dev-runtime-activity'
import { cborByteLength } from './dev-runtime-cbor-length'
import { assertJsonUnicode, assertWellFormedUnicode } from './dev-runtime-unicode'
import { decodeRuntimeInteractionPayload } from './dev-runtime-interactions'
import {
  decodeFollowUpQueueEventPayload,
  type FollowUpQueueEventPayload,
} from './dev-runtime-follow-up-event'
export type { FollowUpQueueEventPayload } from './dev-runtime-follow-up-event'
import {
  decodeRuntimeUsageObservedPayload,
  usageDataRecord,
  type RuntimeUsageObservedPayload,
} from './dev-runtime-usage'
export { decodeRuntimeUsageObservedPayload } from './dev-runtime-usage'
export type { RuntimeUsageObservedPayload } from './dev-runtime-usage'
export {
  decodeRuntimeCallPayload,
  isRuntimeCallEventKind,
  runtimeCallEventKinds,
  runtimeCallPhases,
  RUNTIME_CALL_INLINE_BYTES_MAX,
  RUNTIME_CALL_JSON_NODES_MAX,
  RUNTIME_CALL_JSON_DEPTH_MAX,
  RUNTIME_CALL_JSON_ENTRIES_MAX,
  RUNTIME_CALL_JSON_STRING_MAX,
} from './dev-runtime-call'
export type {
  RuntimeCallData,
  RuntimeCallEventKind,
  RuntimeCallJson,
  RuntimeCallPayload,
  RuntimeCallPermissionEligibility,
  RuntimeCallPhase,
} from './dev-runtime-call'
import { validateRuntimeResponseReferences } from './dev-runtime-response-references'
import { validateRuntimeVisibleSummaryEvent } from './dev-runtime-visible-summaries'

export const runtimeEventKinds = [
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
  'subagent.observed',
  'usage.observed',
  'queue.updated',
  'terminal.command_started',
  'terminal.command_finished',
  'terminal.cwd_changed',
  'terminal.transcript_reference',
  'capability.degraded',
  'capability.restored',
  ...runtimeActivityEventKinds,
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

export type RuntimeCallEvent = Omit<RuntimeEvent, 'kind' | 'payload' | 'source'> &
  Readonly<{
    harnessRunId: string
    source: 'native' | 'acp' | 'authenticated_hook'
    kind: RuntimeCallEventKind
    payload: RuntimeCallPayload
  }>

function validateCall(event: Record<string, unknown>, enforceEnvelopeBounds = true): void {
  if (!isRuntimeCallEventKind(event.kind)) fail('event.kind', 'expected tool or subagent call')
  if (event.source === 'host' || event.source === 'terminal_fallback')
    fail('event.source', 'call observations require a native, ACP or owned hook producer')
  stringValue(event.harnessRunId, 'event.harnessRunId', 1, 256)
  const payload = decodeRuntimeCallPayload(event.payload, event.kind)
  if (event.classification === 'credential')
    fail('event.classification', 'credential-classified data must not enter the runtime event log')
  if (
    (payload.input?.type === 'inline' || payload.output?.type === 'inline') &&
    event.classification !== 'restricted_local'
  )
    fail('event.classification', 'inline call content requires restricted_local classification')
  for (const [key, entry] of Object.entries(event))
    if (typeof entry === 'string') assertWellFormedUnicode(entry, `event.${key}`)
  if (payload.permissionEligibility !== 'unknown' && event.confidence !== 'authoritative')
    fail(
      'event.payload.permissionEligibility',
      'requires an authoritative native, ACP or owned hook observation'
    )
  if (enforceEnvelopeBounds) assertRuntimeEventFrameSize(event as RuntimeEvent)
}

/** Explicit opt-in narrowing. Legacy opaque payloads never acquire call semantics. */
export function decodeRuntimeCallEvent(
  value: unknown,
  provenance: RuntimeEventProvenance
): RuntimeCallEvent {
  decodeRuntimeEvent(value, provenance)
  validateCall(record(value, 'event'))
  return value as RuntimeCallEvent
}

export type RuntimeActivityEvent = {
  [K in RuntimeActivityEventKind]: Omit<
    RuntimeEvent,
    'kind' | 'payload' | 'source' | 'confidence'
  > &
    Readonly<{
      source: 'native' | 'acp' | 'authenticated_hook'
      confidence: 'authoritative'
      kind: K
      payload: RuntimeActivityPayloads[K]
    }>
}[RuntimeActivityEventKind]

function validateActivity(item: Record<string, unknown>, enforceEnvelopeBounds = true): void {
  if (!isRuntimeActivityEventKind(item.kind))
    fail('event.kind', 'expected structured activity kind')
  decodeRuntimeActivityPayload(item.payload, item.kind)
  assertJsonUnicode(item)
  if (item.source === 'host' || item.source === 'terminal_fallback')
    fail('event.source', 'structured activity requires a native, ACP or owned hook producer')
  if (item.confidence !== 'authoritative')
    fail('event.confidence', 'structured activity requires authoritative producer facts')
  if (enforceEnvelopeBounds) assertRuntimeEventFrameSize(item as RuntimeEvent)
  if (
    enforceEnvelopeBounds &&
    item.source === 'authenticated_hook' &&
    new TextEncoder().encode(JSON.stringify(item)).byteLength > 8 * 1024
  )
    fail('event', 'authenticated hook observation exceeds 8 KiB')
}

function assertActivityOwnership(
  item: Record<string, unknown>,
  provenance: RuntimeEventProvenance
): void {
  if (
    !Array.isArray(provenance.ownedActivityKinds) ||
    !provenance.ownedActivityKinds.includes(item.kind as RuntimeActivityEventKind)
  )
    fail('event.kind', 'structured activity requires out-of-band producer ownership')
}

/** Explicit opt-in: an opaque legacy row never gains structured activity semantics. */
export function decodeRuntimeActivityEvent(
  value: unknown,
  provenance: RuntimeEventProvenance
): RuntimeActivityEvent {
  decodeRuntimeEvent(value, provenance)
  const item = record(value, 'event')
  validateActivity(item)
  assertActivityOwnership(item, provenance)
  return value as RuntimeActivityEvent
}

/** @internal Validation-only replay input; no new event or frame is returned. */
export function validateRuntimeActivityReplayCandidate(
  value: unknown,
  provenance: RuntimeEventProvenance
): void {
  validateRuntimeEventReplayCandidate(value, provenance)
  const item = record(value, 'event')
  validateActivity(item, false)
  assertActivityOwnership(item, provenance)
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

/**
 * Kind-specific payload validators. Everything that interprets a payload (call
 * observations, visible summaries, cited responses, and any later interaction
 * or attachment contract) is reached ONLY through this object, so the lean
 * browser decoder below never imports it. Register new validators here, never
 * inside `decodeEventEnvelope`. Browser stream and replay have a separate
 * focused queue decoder so they do not pull unrelated kind validators into
 * the lean envelope entry.
 */
type EventSemantics = Readonly<{
  early(
    item: Record<string, unknown>,
    enforceEnvelopeBounds: boolean
  ): RuntimeUsageObservedPayload | FollowUpQueueEventPayload | undefined
  late(item: Record<string, unknown>): void
}>

function decodeQueueEventPayload(
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

const eventSemantics: EventSemantics = {
  early(item, enforceEnvelopeBounds) {
    // Lone surrogates in identities would be rewritten by UTF-8/CBOR and so
    // collapse distinct namespaces; refuse them before admission and dedupe.
    for (const key of ['eventId', 'runtimeSessionId', 'sourceEventId', 'harnessRunId'] as const)
      if (item[key] !== undefined) assertWellFormedUnicode(item[key] as string, `event.${key}`)
    uint64String(item.seq, 'event.seq')
    if (isVersionedCallClaim(item)) validateCall(item, enforceEnvelopeBounds)
    const kind = item.kind as string
    if (isRuntimeAssistantEventKind(kind)) {
      stringValue(item.harnessRunId, 'event.harnessRunId', 1, 256)
      decodeRuntimeAssistantPayload(kind, item.payload)
      if (enforceEnvelopeBounds)
        assertRuntimeEventFrameSize(
          item as RuntimeEvent,
          `maximum encoded assistant event size exceeded (${RUNTIME_EVENT_CBOR_BYTES_MAX} bytes)`
        )
    }
    if (isVersionedActivityClaim(item)) {
      validateActivity(item, enforceEnvelopeBounds)
    }
    let queuePayload: FollowUpQueueEventPayload | undefined
    if (item.kind === 'queue.updated') queuePayload = decodeQueueEventPayload(item)
    const interaction = decodeRuntimeInteractionPayload(kind, item.payload)
    if (interaction) {
      if (item.confidence !== 'authoritative')
        fail('event.confidence', 'structured interactions require authoritative provenance')
      if (item.classification !== 'workspace_private')
        fail('event.classification', 'structured interactions require workspace_private')
      stringValue(item.harnessRunId, 'event.harnessRunId', 1, 256)
    }
    if (item.kind === 'attachment.added' || item.kind === 'attachment.removed') {
      if (item.source !== 'host' || item.confidence !== 'authoritative')
        fail('event.source', 'attachment facts require authoritative host provenance')
      decodeChatAttachmentEventPayload(item.kind, item.payload)
    }
    validateRuntimeVisibleSummaryEvent(item as RuntimeEvent)
    if (item.kind === 'usage.observed') {
      if (item.confidence !== 'authoritative')
        fail('event.confidence', 'usage observations require authoritative reported figures')
      return decodeRuntimeUsageObservedPayload(item.payload, item.generation as number)
    }
    return queuePayload
  },
  late(item) {
    validateRuntimeResponseReferences(item.kind as string, item.payload, item.source as string)
  },
}

function isVersionedCallClaim(item: Record<string, unknown>): boolean {
  return (
    isRuntimeCallEventKind(item.kind) &&
    item.payload !== null &&
    typeof item.payload === 'object' &&
    Object.hasOwn(item.payload, 'schemaVersion')
  )
}

function isVersionedActivityClaim(item: Record<string, unknown>): boolean {
  return (
    isRuntimeActivityEventKind(item.kind) &&
    item.payload !== null &&
    typeof item.payload === 'object' &&
    Object.hasOwn(item.payload, 'schemaVersion')
  )
}

/** Complete decoder: envelope, generic payload bounds and every kind-specific contract. */
export function decodeRuntimeEvent(
  value: unknown,
  provenance: RuntimeEventProvenance
): RuntimeEvent {
  return decodeEventEnvelope(value, provenance, true, eventSemantics)
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

/** @internal Validates a retry before comparing it; new records still require full decoding. */
export function validateRuntimeEventReplayCandidate(
  value: unknown,
  provenance: RuntimeEventProvenance
): void {
  decodeEventEnvelope(value, provenance, false, eventSemantics)
}

function decodeEventEnvelope(
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

// ─── Canonical CBOR (RFC 8949 deterministic encoding subset) ────────────────
//
// Bulk-stream control frames are canonical CBOR with a 64 KiB maximum. This
// subset covers the frame vocabulary — unsigned/negative integers, floats,
// booleans, null, byte and text strings, arrays, and text-keyed maps — and
// refuses anything else (tags, indefinite lengths, non-shortest heads,
// duplicate or unsorted map keys) instead of guessing.

const cborEncoder = new TextEncoder()
const cborDecoder = new TextDecoder('utf-8', { fatal: true })

function cborHead(major: number, length: number | bigint): Uint8Array {
  const value = BigInt(length)
  const head: number[] = []
  let info: number
  let bytes: number[] = []
  if (value < 24n) info = Number(value)
  else if (value <= 0xffn) {
    info = 24
    bytes = [Number(value)]
  } else if (value <= 0xffffn) {
    info = 25
    for (let shift = 8; shift >= 0; shift -= 8) bytes.push(Number((value >> BigInt(shift)) & 0xffn))
  } else if (value <= 0xffff_ffffn) {
    info = 26
    for (let shift = 24; shift >= 0; shift -= 8)
      bytes.push(Number((value >> BigInt(shift)) & 0xffn))
  } else {
    info = 27
    for (let shift = 56; shift >= 0; shift -= 8)
      bytes.push(Number((value >> BigInt(shift)) & 0xffn))
  }
  head.push((major << 5) | info, ...bytes)
  return Uint8Array.from(head)
}

function shortestFloat(value: number): Uint8Array {
  const buffer = new ArrayBuffer(8)
  const view = new DataView(buffer)
  for (const [head, write, read] of [
    [0xf9, 'setFloat16', 'getFloat16'],
    [0xfa, 'setFloat32', 'getFloat32'],
  ] as const) {
    view[write](0, value, false)
    if (view[read](0, false) === value) {
      const size = head === 0xf9 ? 2 : 4
      const out = new Uint8Array(1 + size)
      out[0] = head
      out.set(new Uint8Array(buffer, 0, size), 1)
      return out
    }
  }
  view.setFloat64(0, value, false)
  const out = new Uint8Array(9)
  out[0] = 0xfb
  out.set(new Uint8Array(buffer, 0, 8), 1)
  return out
}

export function encodeCbor(value: unknown): Uint8Array {
  const chunks: Uint8Array[] = []
  const encode = (input: unknown): void => {
    if (input === null) {
      chunks.push(Uint8Array.from([0xf6]))
      return
    }
    if (typeof input === 'boolean') {
      chunks.push(Uint8Array.from([input ? 0xf5 : 0xf4]))
      return
    }
    if (typeof input === 'bigint') {
      if (input >= 0n) chunks.push(cborHead(0, input))
      else chunks.push(cborHead(1, -1n - input))
      return
    }
    if (typeof input === 'number') {
      if (Number.isSafeInteger(input)) {
        if (input >= 0) chunks.push(cborHead(0, input))
        else chunks.push(cborHead(1, -1 - input))
        return
      }
      if (Number.isFinite(input)) {
        chunks.push(shortestFloat(input))
        return
      }
      fail('cbor', 'numbers must be finite')
    }
    if (typeof input === 'string') {
      assertWellFormedUnicode(input, 'cbor string')
      const bytes = cborEncoder.encode(input)
      chunks.push(cborHead(3, bytes.byteLength), bytes)
      return
    }
    if (input instanceof Uint8Array) {
      chunks.push(cborHead(2, input.byteLength), input)
      return
    }
    if (Array.isArray(input)) {
      chunks.push(cborHead(4, input.length))
      for (const entry of input) encode(entry)
      return
    }
    if (typeof input === 'object') {
      if (Object.getPrototypeOf(input) !== objectPrototype && Object.getPrototypeOf(input) !== null)
        fail('cbor', 'expected a plain object')
      const entries = Object.entries(input as Record<string, unknown>)
      const encoded = entries
        .map(([key, entry]) => ({ key: encodeCbor(key), value: encodeCbor(entry) }))
        .toSorted((left, right) => {
          const shorter = Math.min(left.key.byteLength, right.key.byteLength)
          for (let index = 0; index < shorter; index += 1) {
            const delta = left.key[index]! - right.key[index]!
            if (delta !== 0) return delta
          }
          return left.key.byteLength - right.key.byteLength
        })
      chunks.push(cborHead(5, encoded.length))
      for (const entry of encoded) {
        chunks.push(entry.key, entry.value)
      }
      return
    }
    fail('cbor', `cannot encode ${typeof input}`)
  }
  encode(value)
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

export function decodeCbor(bytes: Uint8Array): { value: unknown; byteLength: number } {
  let offset = 0
  const read = (count: number): bigint => {
    if (offset + count > bytes.byteLength) fail('cbor', 'truncated input')
    let value = 0n
    for (let index = 0; index < count; index += 1) value = (value << 8n) | BigInt(bytes[offset++]!)
    return value
  }
  const head = (): { major: number; value: bigint } => {
    if (offset >= bytes.byteLength) fail('cbor', 'truncated input')
    const first = bytes[offset++]!
    const major = first >> 5
    const info = first & 0x1f
    if (info < 24) return { major, value: BigInt(info) }
    if (info > 27) fail('cbor', `bad CBOR info ${info}`)
    const value = read(1 << (info - 24))
    if (value < [24n, 256n, 65_536n, 4_294_967_296n][info - 24]!)
      fail('cbor', 'non-shortest integer head')
    return { major, value }
  }
  const decode = (): unknown => {
    if (offset >= bytes.byteLength) fail('cbor', 'truncated input')
    const first = bytes[offset]!
    // Major 7's "value" is a simple value or raw float bits, not a
    // length, so the integer shortest-form rules do not apply to it.
    if (first >> 5 === 7) {
      offset += 1
      const info = first & 0x1f
      if (info === 20) return false
      if (info === 21) return true
      if (info === 22) return null
      if (info === 25 || info === 26 || info === 27) {
        const width = 2 ** (info - 24)
        if (offset + width > bytes.byteLength) fail('cbor', 'truncated input')
        const view = new DataView(bytes.buffer, bytes.byteOffset + offset, width)
        offset += width
        const parsed =
          info === 25
            ? view.getFloat16(0, false)
            : info === 26
              ? view.getFloat32(0, false)
              : view.getFloat64(0, false)
        if (!Number.isFinite(parsed)) fail('cbor', 'floats must be finite')
        return parsed
      }
      fail('cbor', `unsupported simple value ${info}`)
    }
    const { major, value } = head()
    if (major === 0) {
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) return value
      return Number(value)
    }
    if (major === 1) {
      const result = -1n - value
      return result >= BigInt(Number.MIN_SAFE_INTEGER) && result <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(result)
        : result
    }
    if (major === 2) {
      const length = Number(value)
      if (offset + length > bytes.byteLength) fail('cbor', 'truncated byte string')
      const out = bytes.slice(offset, offset + length)
      offset += length
      return out
    }
    if (major === 3) {
      const length = Number(value)
      if (offset + length > bytes.byteLength) fail('cbor', 'truncated text string')
      const slice = bytes.subarray(offset, offset + length)
      offset += length
      try {
        return cborDecoder.decode(slice)
      } catch {
        return fail('cbor', 'invalid UTF-8')
      }
    }
    if (major === 4) {
      const length = Number(value)
      const out: unknown[] = []
      for (let index = 0; index < length; index += 1) out.push(decode())
      return out
    }
    if (major === 5) {
      const length = Number(value)
      const out: Record<string, unknown> = {}
      let previousKey: Uint8Array | undefined
      for (let index = 0; index < length; index += 1) {
        const keyStart = offset
        const key = decode()
        const keyBytes = bytes.slice(keyStart, offset)
        if (typeof key !== 'string') fail('cbor', 'text map keys')
        if (previousKey && compareBytes(previousKey, keyBytes) >= 0) fail('cbor', 'bad map order')
        previousKey = keyBytes
        if (Object.hasOwn(out, key)) fail('cbor', 'duplicate map key')
        // Define rather than assign so `__proto__` stays an ordinary own key.
        Object.defineProperty(out, key, {
          value: decode(),
          enumerable: true,
          configurable: true,
          writable: true,
        })
      }
      return out
    }
    if (major === 6) fail('cbor', 'unsupported CBOR')
    return fail('cbor', `unsupported major type ${major}`)
  }
  const value = decode()
  return { value, byteLength: offset }
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const shorter = Math.min(left.byteLength, right.byteLength)
  for (let index = 0; index < shorter; index += 1) {
    const delta = left[index]! - right[index]!
    if (delta !== 0) return delta
  }
  return left.byteLength - right.byteLength
}
