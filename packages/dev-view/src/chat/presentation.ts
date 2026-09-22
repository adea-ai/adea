import type { RuntimeEvent, RuntimeSession } from '@adea-ai/types/dev-runtime'

/** A bounded, renderable row in the canonical transcript. */
export type ChatTranscriptItem = Readonly<{
  id: string
  role: 'user' | 'assistant' | 'tool' | 'approval' | 'question' | 'subagent' | 'status'
  kind: RuntimeEvent['kind']
  label: string
  text?: string
  state?: 'requested' | 'started' | 'in_progress' | 'completed' | 'failed' | 'resolved' | 'expired'
  event?: RuntimeEvent
}>

const MAX_RENDERED_TEXT = 4_096
const MAX_LABEL = 160

function redact(value: string, limit: number): string {
  const redacted = value
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '[secret redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [secret redacted]')
    .replace(/\b(?:sk|pk|api|token|secret)[-_][A-Za-z0-9._-]{8,}/gi, '[secret redacted]')
    .replace(/(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^\s`"']+/g, '[private path]')
  return Array.from(redacted)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0
      return code >= 0x20 && code !== 0x7f
    })
    .slice(0, limit)
    .join('')
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

function labelFromPayload(event: RuntimeEvent): string {
  if (event.payload !== null && typeof event.payload === 'object') {
    const payload = event.payload as Record<string, unknown>
    for (const key of ['name', 'tool', 'title', 'question', 'approval']) {
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

function roleFor(kind: RuntimeEvent['kind']): ChatTranscriptItem['role'] | undefined {
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
  return undefined
}

/**
 * Render only known, bounded fields from runtime events. Unknown payloads are
 * intentionally omitted so private paths, secrets, and arbitrary JSON never
 * become transcript markup.
 */
export function projectTranscriptEvents(
  events: readonly RuntimeEvent[],
  session?: Pick<RuntimeSession, 'projection'>
): readonly ChatTranscriptItem[] {
  const rows: ChatTranscriptItem[] = []
  for (const event of events) {
    const role = roleFor(event.kind)
    if (!role) continue
    const text = textFromPayload(event)
    const label = labelFromPayload(event)
    rows.push({
      id: event.eventId,
      role,
      kind: event.kind,
      label,
      ...(text !== undefined ? { text } : {}),
      ...(stateFor(event.kind) !== undefined ? { state: stateFor(event.kind) } : {}),
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
