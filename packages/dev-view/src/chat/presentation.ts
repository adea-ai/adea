import type {
  RuntimeCitationReference,
  RuntimeEvent,
  RuntimeResponseSource,
  RuntimeSession,
  RuntimeVisibleSummary,
} from '@adea-ai/types/dev-runtime'
import { decodeRuntimeInteractionPayload } from '@adea-ai/types/dev-runtime'
import {
  decodeConversationCheckpoint,
  isRuntimeActivityEventKind,
} from '@adea-ai/types/dev-runtime'
import { projectActivityResult, type ChatResult } from './model/results'
import {
  decodeRuntimeAssistantPayload,
  decodeRuntimeEvent,
  isRuntimeCallEventKind,
  type RuntimeCallData,
  type RuntimeCallPayload,
  type RuntimeCallPhase,
} from '@adea-ai/types/dev-runtime-wire'

/**
 * What a versioned approval or question event says about itself, read only after
 * the wire gate accepted its payload. Legacy payloads carry none and are never
 * given one by guessing from their text.
 *
 * A request says whether this surface may answer it (`responseAvailable`, the
 * host fact `eligibility`); an outcome names the request it answers by the
 * canonical event id (`requestEventId`) and the protocol's own `requestId`. The
 * canvas pairs the two (see `buildChatTurns`) only when both agree.
 */
export type ChatInteraction =
  | Readonly<{ phase: 'requested'; requestId: string; responseAvailable: boolean }>
  | Readonly<{
      phase: 'outcome'
      requestId: string
      requestEventId: string
      decision: 'approved' | 'denied' | 'answered' | 'expired'
      /** When the host says the decision was made; the actor id is a protocol id and is not shown. */
      decidedAt?: string
    }>

/** A call's input or output as it may be drawn: redacted and bounded, or held elsewhere. */
export type ChatCallData =
  | Readonly<{ type: 'inline'; text: string; truncated: boolean }>
  | Readonly<{ type: 'reference'; byteLength?: number }>

/**
 * What a versioned tool or subagent observation says about itself, read only after
 * the wire gate accepted the whole event (native, ACP or owned-hook source, run
 * identity, schema, size). `callId` is stable within one session, generation, run
 * and source; `parentCallId` is absent when the producer did not say and `null`
 * when it observed a root call. Nothing here is an authorization: the permission
 * eligibility the payload carries is not read.
 */
export type ChatCall = Readonly<{
  family: 'tool' | 'subagent'
  callId: string
  parentCallId?: string | null
  phase: RuntimeCallPhase
  name?: string
  input?: ChatCallData
  output?: ChatCallData
  durationMs?: number
}>

/** A bounded, renderable row in the canonical transcript. */
export type ChatTranscriptItem = Readonly<{
  id: string
  role:
    | 'user'
    | 'assistant'
    | 'tool'
    | 'approval'
    | 'question'
    | 'subagent'
    | 'status'
    /** A validated source-reported reasoning summary snapshot (`turn.reasoning_summary`). */
    | 'reasoning'
    /** A validated source-reported method step snapshot (`turn.method_step_summary`). */
    | 'method'
    /** A structured activity observation the wire gate accepted (`ChatResult`). */
    | 'result'
    /** A kind the chat has no dedicated presentation for. Shown, never dropped. */
    | 'other'
  kind: RuntimeEvent['kind']
  label: string
  /** One trimmed, bounded run of text for labels and one-line summaries. */
  text?: string
  /** Safe request wording; separate from the clipped one-line summary. */
  requestContext?: string
  requestContextIncomplete?: boolean
  /** Redacted copyable tool output, preserving LF and tabs within the same bound. */
  output?: string
  /**
   * Prose for the message body: the same redaction, but line breaks and tabs
   * survive, a streamed fragment keeps its surrounding whitespace, and the bound
   * is a message's, not a label's. Only the turn kinds carry one.
   */
  body?: string
  /** `body` was cut at the bound. The canvas says so rather than showing a shorter message as whole. */
  bodyTruncated?: boolean
  /** Payload-free grouping identity for an explicitly withheld retained suffix. */
  withheldRun?: Readonly<Pick<RuntimeEvent, 'harnessRunId' | 'generation'>>
  /** The snapshot, present only for `reasoning` and `method` rows that passed the wire gate. */
  summary?: RuntimeVisibleSummary
  /** The producer's sources and cited spans, present only when they validated against the exact text. */
  references?: ChatResponseReferences
  state?: 'requested' | 'started' | 'in_progress' | 'completed' | 'failed' | 'resolved' | 'expired'
  /** Present only for a versioned approval or question the wire gate accepted. */
  interaction?: ChatInteraction
  /** Present only for a versioned tool or subagent call the wire gate accepted. */
  call?: ChatCall
  /** Present only for a versioned structured activity the wire gate accepted. */
  result?: ChatResult
  event?: RuntimeEvent
}>

/**
 * A final message's sources and the spans that cite them. `citations` are in the
 * coordinates of the displayed `body`; they are empty, and `inline` says why,
 * when the body is not the producer's exact text (redaction, control characters
 * or a CRLF changed it, so an offset would point somewhere else).
 */
export type ChatResponseSource = Readonly<{
  id: string
  title: string
  /** Absent when the producer's URL did not survive the display redaction unchanged. */
  url?: string
  snippet?: string
}>

export type ChatResponseReferences = Readonly<{
  sources: readonly ChatResponseSource[]
  citations: readonly RuntimeCitationReference[]
  /** How many spans the producer sent, so the canvas can say when fewer than that are marked. */
  cited: number
  inline: 'mapped' | 'text-changed'
}>

const MAX_RENDERED_TEXT = 4_096
const MAX_LABEL = 160
/** The most prose one message body keeps. */
export const MAX_BODY_TEXT = 32_768
/** The scan window for a body: the wire's own 64 KiB string maximum. */
const BODY_SCAN_WINDOW = 65_536
/** Bounded overlap for ordinary patterns; ambiguous unbounded boundaries fail closed. */
const MAX_CROSS_DELTA_CONTEXT = 5_000

function redactWithProvenance(
  value: string,
  limit: number,
  options: { window?: number; layout?: boolean } = {}
): { text: string; truncated: boolean } {
  // A hostile transcript can be arbitrarily large: bound the scan BEFORE
  // redaction. Even patterns with intentionally unbounded separators run only
  // over this bounded window, never over the whole transcript.
  const window = options.window ?? 16_384
  const bounded = value.length > window ? value.slice(0, window) : value
  const redacted = bounded
    .replace(
      /-----BEGIN [^-]{1,64}-+[^\s]{0,64}[\s\S]{0,4096}?-----END [^-]{1,64}-+/g,
      '[secret redacted]'
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{1,512}/gi, 'Bearer [secret redacted]')
    .replace(/\b(?:sk|pk|api|token|secret)[-_][A-Za-z0-9._-]{8,512}/gi, '[secret redacted]')
    .replace(/(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^\s`"']{1,512}/g, '[private path]')
  // Only `limit` surviving code points are kept, so stop walking once they
  // are collected. Materializing the whole 16KiB window into an array to then
  // slice 160 or 4096 entries off it was the single largest per-event cost in
  // this projector. Redaction still runs over the full bounded window first:
  // truncating before it would leave a secret straddling the cut half-visible.
  let kept = ''
  let count = 0
  for (const character of redacted) {
    const code = character.codePointAt(0) ?? 0
    // Count only surviving code points. Inspect one additional visible point
    // before declaring clipping: exact-limit content followed by removed
    // controls is complete, while replacement expansion can exceed the limit.
    const layout = options.layout && (code === 0x0a || code === 0x09)
    if (!layout && (code < 0x20 || code === 0x7f)) continue
    if (count >= limit) return { text: kept, truncated: true }
    kept += character
    count += 1
  }
  return { text: kept, truncated: value.length > window }
}

function redact(
  value: string,
  limit: number,
  options: { window?: number; layout?: boolean } = {}
): string {
  return redactWithProvenance(value, limit, options).text
}

/** Display redaction with the cut it made, for text a caller joins itself (terminal output). */
export function redactDisplay(
  value: string,
  limit: number,
  options: { window?: number; layout?: boolean } = {}
): { text: string; truncated: boolean } {
  return redactWithProvenance(value, limit, { window: BODY_SCAN_WINDOW, ...options })
}

function textFromPayload(event: RuntimeEvent): string | undefined {
  if (event.payload === null || typeof event.payload !== 'object') return undefined
  const payload = event.payload as Record<string, unknown>
  for (const key of ['text', 'content', 'message', 'delta', 'summary', 'reason']) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim().length > 0)
      return redact(value.trim(), MAX_RENDERED_TEXT)
  }
  return undefined
}

/** Keep existing text/scan bounds, and explicitly report undisplayed request content. */
function requestContextFromPayload(event: RuntimeEvent): {
  requestContext?: string
  requestContextIncomplete?: boolean
} {
  if (!event.kind.startsWith('approval.') && !event.kind.startsWith('question.')) return {}
  if (event.payload === null || typeof event.payload !== 'object')
    return { requestContextIncomplete: true }
  const payload = event.payload as Record<string, unknown>
  const keys = event.kind.startsWith('question.')
    ? ['question', 'prompt', 'text', 'content', 'message', 'reason', 'title', 'name']
    : ['prompt', 'text', 'content', 'message', 'reason', 'approval', 'title', 'name']
  for (const key of keys) {
    const value = payload[key]
    if (typeof value !== 'string' || value.trim().length === 0) continue
    const raw = value.trim().replace(/\r\n?/g, '\n')
    const safe = redactWithProvenance(raw, MAX_RENDERED_TEXT, { layout: true })
    return {
      requestContext: safe.text,
      // Conservative on redaction/control removal: never approve content outside
      // the inspected bound, even if sanitizing would make the preview shorter.
      requestContextIncomplete: raw.length > MAX_RENDERED_TEXT || safe.truncated,
    }
  }
  return { requestContextIncomplete: true }
}

function interactionFromEvent(event: RuntimeEvent): ChatInteraction | undefined {
  if (!event.kind.startsWith('approval.') && !event.kind.startsWith('question.')) return undefined
  let decoded: ReturnType<typeof decodeRuntimeInteractionPayload>
  try {
    decoded = decodeRuntimeInteractionPayload(event.kind, event.payload)
  } catch {
    return undefined
  }
  if (decoded === undefined) return undefined
  if ('eligibility' in decoded)
    return {
      phase: 'requested',
      requestId: decoded.requestId,
      responseAvailable: decoded.eligibility.eligible,
    }
  return {
    phase: 'outcome',
    requestId: decoded.requestId,
    requestEventId: decoded.requestEventId,
    decision: decoded.decision,
    ...(decoded.decidedAt !== undefined ? { decidedAt: decoded.decidedAt } : {}),
  }
}

const CALL_DATA_LIMIT = 4_096

function callData(data: RuntimeCallData | undefined): ChatCallData | undefined {
  if (data === undefined) return undefined
  if (data.type === 'reference')
    return {
      type: 'reference',
      ...(data.byteLength !== undefined ? { byteLength: data.byteLength } : {}),
    }
  const json = JSON.stringify(data.value, null, 2) ?? 'null'
  const safe = redactWithProvenance(json, CALL_DATA_LIMIT, {
    window: BODY_SCAN_WINDOW,
    layout: true,
  })
  return { type: 'inline', text: safe.text, truncated: safe.truncated }
}

function callFromEvent(event: RuntimeEvent): ChatCall | undefined {
  if (!isRuntimeCallEventKind(event.kind)) return undefined
  if (
    event.payload === null ||
    typeof event.payload !== 'object' ||
    !Object.hasOwn(event.payload, 'schemaVersion')
  )
    return undefined
  try {
    decodeRuntimeEvent(event, { source: event.source })
  } catch {
    return undefined
  }
  const payload = event.payload as RuntimeCallPayload
  const input = callData(payload.input)
  const output = callData(payload.output)
  return {
    family: event.kind === 'subagent.observed' ? 'subagent' : 'tool',
    callId: payload.callId,
    ...(payload.parentCallId !== undefined ? { parentCallId: payload.parentCallId } : {}),
    phase: payload.phase,
    ...(payload.name !== undefined ? { name: redact(payload.name, MAX_LABEL) } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(payload.durationMs !== undefined ? { durationMs: payload.durationMs } : {}),
  }
}

function resultFromEvent(event: RuntimeEvent): ChatResult | undefined {
  if (!isRuntimeActivityEventKind(event.kind) && event.kind !== 'checkpoint.observed')
    return undefined
  if (
    event.payload === null ||
    typeof event.payload !== 'object' ||
    !Object.hasOwn(event.payload, 'schemaVersion')
  )
    return undefined
  try {
    decodeRuntimeEvent(event, { source: event.source })
    // The wire gate admits a checkpoint claim by shape only when it is versioned;
    // read it through its own contract before anything is drawn.
    if (event.kind === 'checkpoint.observed') decodeConversationCheckpoint(event.payload)
  } catch {
    return undefined
  }
  return projectActivityResult(event.kind, event.payload, (text, limit, layout) =>
    redact(text, limit, { window: BODY_SCAN_WINDOW, ...(layout === true ? { layout } : {}) })
  )
}

function outputFromPayload(event: RuntimeEvent): string | undefined {
  if (!event.kind.startsWith('tool.')) return undefined
  if (event.payload === null || typeof event.payload !== 'object') return undefined
  const payload = event.payload as Record<string, unknown>
  for (const key of ['text', 'content', 'message', 'delta', 'summary', 'reason']) {
    const value = payload[key]
    if (typeof value === 'string' && value.length > 0)
      return redact(value.replace(/\r\n?/g, '\n'), MAX_RENDERED_TEXT, { layout: true })
  }
  return undefined
}

const BODY_KINDS: ReadonlySet<RuntimeEvent['kind']> = new Set([
  'turn.user_input',
  'turn.assistant_delta',
  'turn.assistant_message',
  'turn.result',
])

function bodyFromPayload(event: RuntimeEvent): { body: string; truncated: boolean } | undefined {
  if (!BODY_KINDS.has(event.kind)) return undefined
  if (event.payload === null || typeof event.payload !== 'object') return undefined
  const payload = event.payload as Record<string, unknown>
  for (const key of ['text', 'content', 'message', 'delta', 'summary', 'reason']) {
    const value = payload[key]
    if (typeof value !== 'string') continue
    // A fragment's edges, and a fragment that is only whitespace, are part of the
    // text it continues: dropping ' ' between 'Hello' and 'world' (or a newline
    // inside a code fence) would change the prose and break exact copy.
    const fragment = event.kind === 'turn.assistant_delta'
    if (fragment ? value.length === 0 : value.trim().length === 0) continue
    const raw = fragment ? value : value.trim()
    const normalised = raw.replace(/\r\n?/g, '\n')
    const body = redact(normalised, MAX_BODY_TEXT, { window: BODY_SCAN_WINDOW, layout: true })
    return { body, truncated: normalised.length > BODY_SCAN_WINDOW || body.length >= MAX_BODY_TEXT }
  }
  return undefined
}

/**
 * Join only the raw, bounded wire text for one assistant delta block, then
 * redact it once. Redacting individual fragments first is not sufficient:
 * credentials can start in one delta and finish in the next. The joined scan
 * is bounded before redaction, just like the per-message projection.
 */
export function redactAssistantDeltaGroup(items: readonly ChatTranscriptItem[]): {
  body: string
  truncated: boolean
} {
  let joined = ''
  let inputTruncated = false
  for (const item of items) {
    if (item.kind !== 'turn.assistant_delta') continue
    const event = item.event
    let fragment: string | undefined
    if (
      event?.kind === 'turn.assistant_delta' &&
      event.payload !== null &&
      typeof event.payload === 'object'
    ) {
      const payload = event.payload as Record<string, unknown>
      for (const key of ['text', 'content', 'message', 'delta', 'summary', 'reason']) {
        if (typeof payload[key] === 'string' && payload[key].length > 0) {
          fragment = payload[key] as string
          break
        }
      }
    }
    // Items without a canonical event can occur in pure model tests or
    // defensive callers. Their body is already bounded and redacted.
    fragment ??= item.body
    if (fragment === undefined || fragment.length === 0) continue

    const remaining = BODY_SCAN_WINDOW - joined.length
    if (remaining <= 0) {
      inputTruncated = true
      break
    }
    joined += fragment.slice(0, remaining)
    if (fragment.length > remaining) {
      inputTruncated = true
      break
    }
  }
  const normalised = joined.replace(/\r\n?/g, '\n')
  const body = redact(normalised, MAX_BODY_TEXT, { window: BODY_SCAN_WINDOW, layout: true })
  return {
    body,
    truncated:
      inputTruncated || normalised.length > BODY_SCAN_WINDOW || body.length >= MAX_BODY_TEXT,
  }
}

function assistantDeltaPayloadText(item: ChatTranscriptItem): string | undefined {
  const event = item.event
  if (
    item.kind === 'turn.assistant_delta' &&
    event?.kind === 'turn.assistant_delta' &&
    event.payload !== null &&
    typeof event.payload === 'object'
  ) {
    const payload = event.payload as Record<string, unknown>
    for (const key of ['text', 'content', 'message', 'delta', 'summary', 'reason']) {
      const value = payload[key]
      if (typeof value === 'string' && value.length > 0) return value
    }
  }
  // Defensive model callers can supply projected items without their event.
  return item.body
}

type RedactionSpan = Readonly<{ start: number; end: number; replacement: string }>

function redactionSpans(value: string): RedactionSpan[] {
  const spans: RedactionSpan[] = []
  const collect = (pattern: RegExp, replacement: string) => {
    for (const match of value.matchAll(pattern)) {
      if (match.index === undefined || match[0].length === 0) continue
      spans.push({ start: match.index, end: match.index + match[0].length, replacement })
    }
  }
  collect(
    /-----BEGIN [^-]{1,64}-+[^\s]{0,64}[\s\S]{0,4096}?-----END [^-]{1,64}-+/g,
    '[secret redacted]'
  )
  collect(/\bBearer\s+[A-Za-z0-9._~+/=-]{1,512}/gi, 'Bearer [secret redacted]')
  collect(/\b(?:sk|pk|api|token|secret)[-_][A-Za-z0-9._-]{8,512}/gi, '[secret redacted]')
  collect(/(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^\s`"']{1,512}/g, '[private path]')
  spans.sort((left, right) => left.start - right.start || right.end - left.end)
  const merged: Array<{ start: number; end: number; replacement: string }> = []
  for (const span of spans) {
    const previous = merged.at(-1)
    if (previous && span.start < previous.end) {
      previous.end = Math.max(previous.end, span.end)
      if (span.replacement.includes('secret')) previous.replacement = span.replacement
    } else {
      merged.push({ ...span })
    }
  }
  return merged
}

function redactTextRange(
  value: string,
  start: number,
  end: number,
  spans: readonly RedactionSpan[]
) {
  let cursor = start
  let result = ''
  for (const span of spans) {
    if (span.end <= start) continue
    if (span.start >= end) break
    const visibleStart = Math.max(cursor, start)
    if (span.start > visibleStart) result += value.slice(visibleStart, Math.min(span.start, end))
    if (span.start >= start && span.start < end) result += span.replacement
    cursor = Math.max(cursor, span.end)
  }
  if (cursor < end) result += value.slice(cursor, end)
  return result
}

const normalize = (value: string) => value.replace(/\r\n?/g, '\n')

// Bearer whitespace and PEM dash runs are intentionally unbounded in the
// canonical redactor. A saturated overlap that starts inside a possible
// separator is ambiguous: the missing prefix/suffix may complete a match.
// Fail closed rather than weakening either pattern's semantics.
const ambiguous = (leftRaw: string, rightRaw: string, context: string) => {
  const left = normalize(leftRaw)
  const right = normalize(rightRaw)
  const leftAtLimit = leftRaw.length >= MAX_CROSS_DELTA_CONTEXT
  const rightAtLimit = rightRaw.length >= MAX_CROSS_DELTA_CONTEXT
  const possibleBearerPrefix = /^(?:earer|arer|rer|er|r)\s*$/i.test(left)
  const ambiguousLeftBoundary =
    leftAtLimit && (/^\s/.test(left) || possibleBearerPrefix || left.startsWith('-'))
  const ambiguousPemRightBoundary =
    rightAtLimit && right.endsWith('-') && context.includes('-----BEGIN ')
  return ambiguousLeftBoundary || ambiguousPemRightBoundary
}

/**
 * Sanitize each delta with a bounded look-behind/look-ahead window. Credentials
 * can straddle fragments that remain separate entries, but one long run must
 * not consume another run's scan budget. Most redaction patterns have bounded
 * extents; if unbounded Bearer whitespace or PEM dash runs extend past the
 * overlap, the affected fragment is suppressed and visibly marked truncated.
 */
export function redactAssistantDeltaFragments(
  items: readonly ChatTranscriptItem[]
): readonly { body?: string; truncated: boolean; continuation?: boolean }[] {
  // Keep references to the payload strings instead of normalizing/copying every
  // complete fragment. Only the bounded slices below are materialized.
  const raw = items.map((item) => assistantDeltaPayloadText(item))

  // The raw text on either side of a fragment, across every neighbour in the
  // streak. Secret redaction needs this broad context whatever run each
  // neighbour belongs to.
  const neighbours = (index: number) => {
    let leftRaw = ''
    for (
      let cursor = index - 1;
      cursor >= 0 && leftRaw.length < MAX_CROSS_DELTA_CONTEXT;
      cursor -= 1
    ) {
      const previous = raw[cursor]
      if (previous === undefined) continue
      const remaining = MAX_CROSS_DELTA_CONTEXT - leftRaw.length
      leftRaw = previous.slice(-remaining) + leftRaw
    }
    let rightRaw = ''
    for (
      let cursor = index + 1;
      cursor < raw.length && rightRaw.length < MAX_CROSS_DELTA_CONTEXT;
      cursor += 1
    ) {
      const next = raw[cursor]
      if (next === undefined) continue
      const remaining = MAX_CROSS_DELTA_CONTEXT - rightRaw.length
      rightRaw += next.slice(0, remaining)
    }
    return { leftRaw, rightRaw }
  }

  const withheld = (index: number) => {
    const fragment = raw[index]
    if (fragment === undefined) return false
    const { leftRaw, rightRaw } = neighbours(index)
    const context =
      normalize(leftRaw) + normalize(fragment.slice(0, BODY_SCAN_WINDOW)) + normalize(rightRaw)
    return ambiguous(leftRaw, rightRaw, context)
  }

  // A CRLF split across two fragments is one line feed, but only when both
  // halves are rendered into the same prose block: the same validated run and
  // generation, directly adjacent, neither one empty, withheld or cut by the
  // scan window. The fragment holding the CR owns the line feed and the one
  // starting with the LF adds nothing, so the joined text matches the unsplit
  // payload. Any other pair keeps each fragment's own line feeds.
  const splitCrlf = (index: number) => {
    if (index <= 0 || index >= items.length) return false
    const before = raw[index - 1]
    const after = raw[index]
    return (
      before !== undefined &&
      after !== undefined &&
      before.length <= BODY_SCAN_WINDOW &&
      before.endsWith('\r') &&
      after.startsWith('\n') &&
      sameRun(items[index - 1]!, items[index]!) &&
      // Two messages are two texts: a CR that ends one does not claim the LF that starts the next.
      assistantMessageKey(items[index - 1]!) === assistantMessageKey(items[index]!) &&
      !withheld(index - 1) &&
      !withheld(index)
    )
  }

  return items.map((item, index) => {
    const fragment = raw[index]
    if (fragment === undefined) return { truncated: item.bodyTruncated === true }

    const currentRaw = fragment.slice(0, BODY_SCAN_WINDOW)
    const { leftRaw, rightRaw } = neighbours(index)
    const continuesCr = splitCrlf(index)
    const current = normalize(continuesCr ? currentRaw.slice(1) : currentRaw)

    // Measure the budget against raw wire units before CRLF normalization.
    // Otherwise 5,000 raw chars of CRLF whitespace shrink below the fail-closed
    // threshold and can hide an unbounded Bearer separator's discarded prefix.
    const left = normalize(leftRaw)
    const right = normalize(splitCrlf(index + 1) ? rightRaw.slice(1) : rightRaw)
    const context = left + current + right
    const currentStart = left.length
    const currentEnd = currentStart + current.length
    if (ambiguous(leftRaw, rightRaw, context)) return { truncated: true }

    const value = redactTextRange(context, currentStart, currentEnd, redactionSpans(context))
    const body = redact(value, MAX_BODY_TEXT, { window: BODY_SCAN_WINDOW, layout: true })
    return {
      body,
      truncated:
        fragment.length > BODY_SCAN_WINDOW ||
        item.bodyTruncated === true ||
        body.length >= MAX_BODY_TEXT,
      // The whole fragment was the LF of a CRLF whose CR ended the previous one:
      // it is empty but still part of the prose run, not an empty event.
      ...(continuesCr && current.length === 0 ? { continuation: true } : {}),
    }
  })
}

const assistantKeys = new WeakMap<ChatTranscriptItem, string | null>()

/**
 * The identity of the assistant message a row belongs to, scoped to its session,
 * generation, run and source, or `undefined`.
 *
 * It is defined only for a delta, a final text or a result whose payload passes the
 * kind-specific contract (`decodeRuntimeAssistantPayload`): a delta with a contiguous
 * index, a final that supersedes `deltas`, a result with a well-formed summary. Anything
 * else, including every row retained from before the identity existed, is opaque and is
 * grouped by run and generation alone. A row that merely carries a `messageId` string
 * never gains an identity, so a malformed event cannot replace or join valid text.
 */
export function assistantMessageKey(item: ChatTranscriptItem): string | undefined {
  const cached = assistantKeys.get(item)
  if (cached !== undefined) return cached ?? undefined
  let key: string | undefined
  const event = item.event
  if (
    event !== undefined &&
    (event.kind === 'turn.assistant_delta' ||
      event.kind === 'turn.assistant_message' ||
      event.kind === 'turn.result')
  ) {
    try {
      const payload = decodeRuntimeAssistantPayload(event.kind, event.payload)
      key = JSON.stringify([
        event.runtimeSessionId,
        event.generation,
        event.harnessRunId,
        event.source,
        payload.messageId,
      ])
    } catch {
      key = undefined
    }
  }
  assistantKeys.set(item, key ?? null)
  return key
}

/** Whether two projected rows belong to one known harness run and generation. */
export function sameRun(a: ChatTranscriptItem, b: ChatTranscriptItem): boolean {
  const leftRun = a.withheldRun ?? a.event
  const rightRun = b.withheldRun ?? b.event
  const left = leftRun?.harnessRunId
  const right = rightRun?.harnessRunId
  return (
    typeof left === 'string' &&
    left.trim().length > 0 &&
    typeof right === 'string' &&
    right.trim().length > 0 &&
    left === right &&
    typeof leftRun?.generation === 'number' &&
    leftRun.generation === rightRun?.generation
  )
}

function labelFromPayload(event: RuntimeEvent): string {
  if (event.payload !== null && typeof event.payload === 'object') {
    const payload = event.payload as Record<string, unknown>
    // A question's own wording is what the person has to answer, so it outranks a name.
    const keys = event.kind.startsWith('question.')
      ? ['question', 'name', 'tool', 'title', 'approval']
      : ['name', 'tool', 'title', 'question', 'approval']
    for (const key of keys) {
      const value = payload[key]
      if (typeof value === 'string' && value.trim().length > 0)
        return redact(value.trim(), MAX_LABEL)
    }
  }
  return event.kind
}

function stateFor(kind: RuntimeEvent['kind']): ChatTranscriptItem['state'] {
  if (kind.endsWith('.requested')) return 'requested'
  if (kind.endsWith('.started')) return 'started'
  if (kind.endsWith('.progress')) return 'in_progress'
  if (kind.endsWith('.completed')) return 'completed'
  if (kind.endsWith('.failed')) return 'failed'
  if (kind.endsWith('.resolved')) return 'resolved'
  if (kind.endsWith('.expired')) return 'expired'
  return undefined
}

function roleFor(kind: RuntimeEvent['kind']): ChatTranscriptItem['role'] {
  if (kind === 'turn.user_input') return 'user'
  if (kind === 'turn.reasoning_summary') return 'reasoning'
  if (kind === 'turn.method_step_summary') return 'method'
  if (
    kind === 'turn.assistant_delta' ||
    kind === 'turn.assistant_message' ||
    kind === 'turn.result'
  )
    return 'assistant'
  if (kind.startsWith('tool.')) return 'tool'
  if (kind.startsWith('approval.')) return 'approval'
  if (kind.startsWith('question.')) return 'question'
  if (kind === 'subagent.observed') return 'subagent'
  if (kind.startsWith('session.') || kind.startsWith('capability.')) return 'status'
  return 'other'
}

const SUMMARY_TEXT_LIMIT = 4_096

/**
 * The snapshot an event carries, or nothing. The whole event goes through the
 * wire decoder (provenance, authoritative confidence, run identity, schema, size),
 * so a payload that only looks like a summary never becomes one. The text is then
 * redacted like every other renderable string; the structure stays the producer's.
 */
function visibleSummary(event: RuntimeEvent): RuntimeVisibleSummary | undefined {
  try {
    decodeRuntimeEvent(event, { source: event.source })
  } catch {
    return undefined
  }
  const payload = event.payload as RuntimeVisibleSummary
  const text = redact(payload.text, SUMMARY_TEXT_LIMIT, { layout: true })
  const title = 'title' in payload ? redact(payload.title, MAX_LABEL) : undefined
  return { ...payload, text, ...(title !== undefined ? { title } : {}) } as RuntimeVisibleSummary
}

/**
 * Sources and cited spans for a final message, in the coordinates of its body.
 * Spans are the producer's offsets into its exact `payload.text`; the body is
 * that text trimmed, redacted and bounded, so a span is carried over only while
 * the body is verbatim a slice of the text. Anything else keeps the sources and
 * drops the spans, and `inline` says so, because a shifted span cites the wrong
 * words.
 */
const SOURCE_SNIPPET_LIMIT = 2_048
const SOURCE_URL_LIMIT = 2_048

/**
 * A source reaches the screen through the same redaction as every other string.
 * Its link fails closed: a URL the redaction would change (a token, a private
 * path, a dropped control character) is not a destination we can vouch for, so
 * the source is listed by its title without a link rather than linking to a
 * rewritten or secret-bearing address.
 */
function displaySource(source: RuntimeResponseSource, index: number): ChatResponseSource {
  const title = redact(source.title.trim(), MAX_LABEL).trim()
  const snippet =
    source.snippet === undefined
      ? ''
      : redact(source.snippet.trim(), SOURCE_SNIPPET_LIMIT, { layout: true }).trim()
  const safeUrl =
    source.url.length <= SOURCE_URL_LIMIT && redact(source.url, SOURCE_URL_LIMIT) === source.url
  return {
    id: source.id,
    title: title || `Source ${index + 1}`,
    ...(safeUrl ? { url: source.url } : {}),
    ...(snippet ? { snippet } : {}),
  }
}

function responseReferences(event: RuntimeEvent, body: string): ChatResponseReferences | undefined {
  const payload = event.payload as { text?: unknown; references?: unknown } | null
  if (payload === null || typeof payload !== 'object' || !('references' in payload))
    return undefined
  try {
    decodeRuntimeEvent(event, { source: event.source })
  } catch {
    return undefined
  }
  const text = payload.text as string
  const references = payload.references as {
    sources: readonly RuntimeResponseSource[]
    citations: readonly RuntimeCitationReference[]
  }
  const shift = text.length - text.trimStart().length
  if (text.slice(shift, shift + body.length) !== body) {
    return {
      sources: references.sources.map(displaySource),
      citations: [],
      cited: references.citations.length,
      inline: 'text-changed',
    }
  }
  const citations = references.citations.flatMap((citation) => {
    const start = citation.start - shift
    const end = citation.end - shift
    return start >= 0 && end <= body.length ? [{ sourceId: citation.sourceId, start, end }] : []
  })
  return {
    sources: references.sources.map(displaySource),
    citations,
    cited: references.citations.length,
    inline: 'mapped',
  }
}

/**
 * Render only known, bounded fields from runtime events. An unrecognised kind
 * has no trusted payload schema, so it is retained as a wire-kind-only row.
 * Credential-classified events are the one exclusion.
 */
export function projectTranscriptEvents(
  events: readonly RuntimeEvent[],
  session?: Pick<RuntimeSession, 'projection'>,
  context?: Readonly<{ assistantContextLost?: boolean }>
): readonly ChatTranscriptItem[] {
  const rows: ChatTranscriptItem[] = []
  let missingPrefix = context?.assistantContextLost === true
  for (const event of events) {
    if (event.kind !== 'turn.assistant_delta') missingPrefix = false
    // Credential-classified payloads are never renderer content, even if a
    // malformed upstream producer gives one a normally renderable event kind.
    if (event.classification === 'credential') continue
    const role = roleFor(event.kind)
    if (missingPrefix) {
      // A retained suffix can lose the prefix that identified it as a secret.
      // Withhold the entire leading delta streak until a canonical boundary;
      // do not pass raw text, labels or event references to a renderer fallback.
      rows.push({
        id: event.eventId,
        role,
        kind: event.kind,
        label: event.kind,
        bodyTruncated: true,
        withheldRun: { harnessRunId: event.harnessRunId, generation: event.generation },
      })
      continue
    }
    if (role === 'reasoning' || role === 'method') {
      const summary = visibleSummary(event)
      rows.push(
        summary
          ? {
              id: event.eventId,
              role,
              kind: event.kind,
              label: event.kind,
              summary,
              event,
            }
          : // Not a snapshot the wire gate admits: an unknown line, no payload content.
            { id: event.eventId, role: 'other', kind: event.kind, label: event.kind }
      )
      continue
    }
    if (role === 'other') {
      const result = resultFromEvent(event)
      if (result !== undefined) {
        rows.push({
          id: event.eventId,
          role: 'result',
          kind: event.kind,
          label: event.kind,
          result,
          event,
        })
        continue
      }
      rows.push({
        id: event.eventId,
        role,
        kind: event.kind,
        label: event.kind,
      })
      continue
    }
    const text = textFromPayload(event)
    const output = outputFromPayload(event)
    const body = bodyFromPayload(event)
    const label = labelFromPayload(event)
    const state = stateFor(event.kind)
    const interaction = interactionFromEvent(event)
    const call = callFromEvent(event)
    const references =
      body !== undefined && event.kind === 'turn.assistant_message'
        ? responseReferences(event, body.body)
        : undefined
    rows.push({
      id: event.eventId,
      role,
      kind: event.kind,
      label,
      ...(text !== undefined ? { text } : {}),
      ...requestContextFromPayload(event),
      ...(output !== undefined ? { output } : {}),
      ...(body !== undefined
        ? { body: body.body, ...(body.truncated ? { bodyTruncated: true } : {}) }
        : {}),
      ...(state !== undefined ? { state } : {}),
      ...(references !== undefined ? { references } : {}),
      ...(interaction !== undefined ? { interaction } : {}),
      ...(call !== undefined ? { call } : {}),
      event,
    })
  }
  if (session?.projection === 'terminal_fallback' && rows.every((row) => row.role !== 'status')) {
    return [
      {
        id: 'terminal-fallback',
        role: 'status',
        kind: 'session.disconnected',
        label: 'Terminal transcript projection',
        text: 'Structured runtime events are unavailable for this session.',
      },
      ...rows,
    ]
  }
  return rows
}

export function statusLabel(status: RuntimeSession['lifecycle'] | 'stale_generation'): string {
  return status === 'stale_generation'
    ? 'Needs resync'
    : status.charAt(0).toUpperCase() + status.slice(1)
}
