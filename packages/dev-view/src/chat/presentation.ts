import type { RuntimeEvent, RuntimeSession } from '@adea-ai/types/dev-runtime'

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
  state?: 'requested' | 'started' | 'in_progress' | 'completed' | 'failed' | 'resolved' | 'expired'
  event?: RuntimeEvent
}>

const MAX_RENDERED_TEXT = 4_096
const MAX_LABEL = 160
/** The most prose one message body keeps. */
export const MAX_BODY_TEXT = 32_768
/** The scan window for a body: the wire's own 64 KiB string maximum. */
const BODY_SCAN_WINDOW = 65_536

function redact(
  value: string,
  limit: number,
  options: { window?: number; layout?: boolean } = {}
): string {
  // A hostile transcript can be arbitrarily large: bound the scan BEFORE
  // the redaction passes (the tail is discarded by the limit below
  // anyway) and keep every quantifier bounded so the passes stay linear.
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
    if (typeof value !== 'string' || value.trim().length === 0) continue
    // A fragment's edges are part of the sentence it continues.
    const raw = event.kind === 'turn.assistant_delta' ? value : value.trim()
    const normalised = raw.replace(/\r\n?/g, '\n')
    const body = redact(normalised, MAX_BODY_TEXT, { window: BODY_SCAN_WINDOW, layout: true })
    return { body, truncated: normalised.length > BODY_SCAN_WINDOW || body.length >= MAX_BODY_TEXT }
  }
  return undefined
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

/**
 * Render only known, bounded fields from runtime events. Every event with a
 * renderable classification gets a row: a kind the chat has no dedicated
 * presentation for becomes an `other` row labelled with its wire kind, and its
 * payload contributes only the same bounded, redacted fields every row may show
 * (never arbitrary JSON), so private paths, secrets and raw payloads never
 * become transcript markup. Credential-classified events are the one exclusion.
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
    const text = textFromPayload(event)
    const body = bodyFromPayload(event)
    const label = labelFromPayload(event)
    const state = stateFor(event.kind)
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
        ...(events[0] !== undefined ? { event: events[0] } : {}),
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
