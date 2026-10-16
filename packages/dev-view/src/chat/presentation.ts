import type {
  RuntimeCitationReference,
  RuntimeEvent,
  RuntimeResponseSource,
  RuntimeSession,
  RuntimeVisibleSummary,
} from '@adea-ai/types/dev-runtime'
import { decodeRuntimeEvent } from '@adea-ai/types/dev-runtime-wire'

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
    /** A kind the chat has no dedicated presentation for. Shown, never dropped. */
    | 'other'
  kind: RuntimeEvent['kind']
  label: string
  /** One trimmed, bounded run of text for labels and one-line summaries. */
  text?: string
  /**
   * Prose for the message body: the same redaction, but line breaks and tabs
   * survive, a streamed fragment keeps its surrounding whitespace, and the bound
   * is a message's, not a label's. Only the turn kinds carry one.
   */
  body?: string
  /** `body` was cut at the bound. The canvas says so rather than showing a shorter message as whole. */
  bodyTruncated?: boolean
  /** The snapshot, present only for `reasoning` and `method` rows that passed the wire gate. */
  summary?: RuntimeVisibleSummary
  /** The producer's sources and cited spans, present only when they validated against the exact text. */
  references?: ChatResponseReferences
  state?: 'requested' | 'started' | 'in_progress' | 'completed' | 'failed' | 'resolved' | 'expired'
  event?: RuntimeEvent
}>

/**
 * A final message's sources and the spans that cite them. `citations` are in the
 * coordinates of the displayed `body`; they are empty, and `inline` says why,
 * when the body is not the producer's exact text (redaction, control characters
 * or a CRLF changed it, so an offset would point somewhere else).
 */
export type ChatResponseReferences = Readonly<{
  sources: readonly RuntimeResponseSource[]
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

function redact(
  value: string,
  limit: number,
  options: { window?: number; layout?: boolean } = {}
): string {
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
    // Prose keeps its line breaks and tabs (text nodes, never markup); every
    // other control character is dropped from both forms.
    if (options.layout && (code === 0x0a || code === 0x09)) {
      kept += character
      count += 1
      if (count >= limit) break
      continue
    }
    if (code < 0x20 || code === 0x7f) continue
    kept += character
    count += 1
    if (count >= limit) break
  }
  return kept
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

/**
 * Sanitize each delta with a bounded look-behind/look-ahead window. Credentials
 * can straddle fragments that remain separate entries, but one long run must
 * not consume another run's scan budget. Most redaction patterns have bounded
 * extents; if unbounded Bearer whitespace or PEM dash runs extend past the
 * overlap, the affected fragment is suppressed and visibly marked truncated.
 */
export function redactAssistantDeltaFragments(
  items: readonly ChatTranscriptItem[]
): readonly { body?: string; truncated: boolean }[] {
  // Keep references to the payload strings instead of normalizing/copying every
  // complete fragment. Only the bounded slices below are materialized.
  const raw = items.map((item) => assistantDeltaPayloadText(item))
  return items.map((item, index) => {
    const fragment = raw[index]
    if (fragment === undefined) return { truncated: item.bodyTruncated === true }

    const currentRaw = fragment.slice(0, BODY_SCAN_WINDOW)
    const current = currentRaw.replace(/\r\n?/g, '\n')
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

    // Measure the budget against raw wire units before CRLF normalization.
    // Otherwise 5,000 raw chars of CRLF whitespace shrink below the fail-closed
    // threshold and can hide an unbounded Bearer separator's discarded prefix.
    const left = leftRaw.replace(/\r\n?/g, '\n')
    const right = rightRaw.replace(/\r\n?/g, '\n')
    const context = left + current + right
    const currentStart = left.length
    const currentEnd = currentStart + current.length
    // Bearer whitespace and PEM dash runs are intentionally unbounded in the
    // canonical redactor. A saturated overlap that starts inside a possible
    // separator is ambiguous: the missing prefix/suffix may complete a match.
    // Fail closed rather than weakening either pattern's semantics.
    const leftAtLimit = leftRaw.length >= MAX_CROSS_DELTA_CONTEXT
    const rightAtLimit = rightRaw.length >= MAX_CROSS_DELTA_CONTEXT
    const possibleBearerPrefix = /^(?:earer|arer|rer|er|r)\s*$/i.test(left)
    const ambiguousLeftBoundary =
      leftAtLimit && (/^\s/.test(left) || possibleBearerPrefix || left.startsWith('-'))
    const ambiguousPemRightBoundary =
      rightAtLimit && right.endsWith('-') && context.includes('-----BEGIN ')
    if (ambiguousLeftBoundary || ambiguousPemRightBoundary) return { truncated: true }

    const value = redactTextRange(context, currentStart, currentEnd, redactionSpans(context))
    const body = redact(value, MAX_BODY_TEXT, { window: BODY_SCAN_WINDOW, layout: true })
    return {
      body,
      truncated:
        fragment.length > BODY_SCAN_WINDOW ||
        item.bodyTruncated === true ||
        body.length >= MAX_BODY_TEXT,
    }
  })
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
      sources: references.sources,
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
    sources: references.sources,
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
  session?: Pick<RuntimeSession, 'projection'>
): readonly ChatTranscriptItem[] {
  const rows: ChatTranscriptItem[] = []
  for (const event of events) {
    // Credential-classified payloads are never renderer content, even if a
    // malformed upstream producer gives one a normally renderable event kind.
    if (event.classification === 'credential') continue
    const role = roleFor(event.kind)
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
      rows.push({
        id: event.eventId,
        role,
        kind: event.kind,
        label: event.kind,
      })
      continue
    }
    const text = textFromPayload(event)
    const body = bodyFromPayload(event)
    const label = labelFromPayload(event)
    const state = stateFor(event.kind)
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
      ...(body !== undefined
        ? { body: body.body, ...(body.truncated ? { bodyTruncated: true } : {}) }
        : {}),
      ...(state !== undefined ? { state } : {}),
      ...(references !== undefined ? { references } : {}),
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
