// Complete canonical admission stays separate from the lean browser envelope.
import { decodeRuntimeAssistantPayload, isRuntimeAssistantEventKind } from './dev-runtime-assistant'
import { decodeChatAttachmentEventPayload } from './dev-runtime-attachments'
import {
  decodeRuntimeActivityPayload,
  isRuntimeActivityEventKind,
  type RuntimeActivityEventKind,
  type RuntimeActivityPayloads,
} from './dev-runtime-activity'
import { decodeCheckpointEventPayload } from './dev-runtime-checkpoints'
import { decodeRuntimeInteractionPayload } from './dev-runtime-interactions'
import {
  decodeRuntimeCallPayload,
  isRuntimeCallEventKind,
  type RuntimeCallEventKind,
  type RuntimeCallPayload,
} from './dev-runtime-call'
import { decodeRuntimeUsageObservedPayload } from './dev-runtime-usage'
import { decodeFollowUpQueueEventPayload } from './dev-runtime-follow-up-event'
import { assertJsonUnicode, assertWellFormedUnicode } from './dev-runtime-unicode'
import { validateRuntimeResponseReferences } from './dev-runtime-response-references'
import { validateRuntimeVisibleSummaryEvent } from './dev-runtime-visible-summaries'
import { fail, record, stringValue, uint64String } from './dev-runtime-validation-internal'
import {
  assertRuntimeEventFrameSize,
  decodeEventEnvelope,
  isVersionedCallClaim,
  type RuntimeEvent,
  type RuntimeEventProvenance,
  type EventSemantics,
} from './dev-runtime-envelope'

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
  decodeEventEnvelope(value, provenance, false, eventSemantics)
  const item = record(value, 'event')
  validateActivity(item, false)
  assertActivityOwnership(item, provenance)
}

/**
 * Kind-specific payload validators. Everything that interprets a payload (call
 * observations, visible summaries, cited responses, and any later interaction
 * or attachment contract) is reached ONLY through this object, so the lean
 * browser decoder below never imports it. Register new validators here, never
 * inside `decodeEventEnvelope`.
 */
function validateCheckpointEvent(item: Record<string, unknown>): void {
  const checkpointPayload = decodeCheckpointEventPayload(item.kind as string, item.payload)
  if (checkpointPayload) {
    if (item.confidence !== 'authoritative')
      fail('event.confidence', 'checkpoint evidence must be authoritative')
    if (item.classification !== 'workspace_private')
      fail('event.classification', 'checkpoint evidence must be workspace_private')
    stringValue(item.harnessRunId, 'event.harnessRunId', 1, 256)
    if (item.kind !== 'checkpoint.observed') {
      if (item.source !== 'host') fail('event.source', 'checkpoint restore outcomes are host-owned')
      if (
        'requestedGeneration' in checkpointPayload &&
        checkpointPayload.requestedGeneration !== item.generation
      )
        fail('event.generation', 'does not match checkpoint restore request')
    }
  }
}

const eventSemantics: EventSemantics = {
  early(item, enforceEnvelopeBounds) {
    validateCheckpointEvent(item)
    if (item.kind === 'queue.updated') {
      if (item.source !== 'host' || item.confidence !== 'authoritative')
        fail('event.source', 'queue facts require the authoritative host')
      const payload = decodeFollowUpQueueEventPayload(item.payload)
      if (
        payload.generation !== item.generation ||
        payload.runtimeSessionId !== item.runtimeSessionId
      )
        fail('event.payload', 'queue identity does not match its event')
    }
    if (
      isRuntimeActivityEventKind(item.kind) &&
      item.payload !== null &&
      typeof item.payload === 'object' &&
      Object.hasOwn(item.payload, 'schemaVersion')
    )
      validateActivity(item, enforceEnvelopeBounds)
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
    }
    if (item.kind === 'attachment.added' || item.kind === 'attachment.removed') {
      if (item.source !== 'host' || item.confidence !== 'authoritative')
        fail('event.source', 'attachment facts require authoritative host provenance')
      decodeChatAttachmentEventPayload(item.kind, item.payload)
    }
    validateRuntimeVisibleSummaryEvent(item as RuntimeEvent)
    // Usage has a strict producer contract (#1391): authoritative reported
    // figures only, fully validated and normalized before projection. The
    // replacement payload is admitted, frozen and persisted in their place.
    if (item.kind !== 'usage.observed') return undefined
    if (item.confidence !== 'authoritative')
      fail('event.confidence', 'usage observations require authoritative reported figures')
    return decodeRuntimeUsageObservedPayload(item.payload, item.generation as number)
  },
  late(item) {
    validateRuntimeResponseReferences(item.kind as string, item.payload, item.source as string)
    // Structured question/approval interactions (#1395) travel only with
    // authoritative, workspace_private, harness-run-bound provenance.
    if (decodeRuntimeInteractionPayload(item.kind as string, item.payload)) {
      if (item.confidence !== 'authoritative')
        fail('event.confidence', 'structured interactions require authoritative provenance')
      if (item.classification !== 'workspace_private')
        fail('event.classification', 'structured interactions require workspace_private')
      stringValue(item.harnessRunId, 'event.harnessRunId', 1, 256)
    }
  },
}

/** Complete decoder: envelope, generic payload bounds and every kind-specific contract. */
export function decodeRuntimeEvent(
  value: unknown,
  provenance: RuntimeEventProvenance
): RuntimeEvent {
  const event = decodeEventEnvelope(value, provenance, true, eventSemantics)
  return event.kind === 'queue.updated'
    ? Object.freeze({ ...event, payload: decodeFollowUpQueueEventPayload(event.payload) })
    : event
}

/** @internal Validates a retry before comparing it; new records still require full decoding. */
export function validateRuntimeEventReplayCandidate(
  value: unknown,
  provenance: RuntimeEventProvenance
): void {
  decodeEventEnvelope(value, provenance, false, eventSemantics)
}
