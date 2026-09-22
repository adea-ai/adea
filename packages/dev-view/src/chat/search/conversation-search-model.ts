import type { HarnessRun, RuntimeEvent, RuntimeSession } from '@adea-ai/types/dev-runtime'

export type ConversationSearchKind =
  | 'prompt'
  | 'result'
  | 'tool'
  | 'approval'
  | 'question'
  | 'status'
  | 'run'

export type ConversationSearchJump = Readonly<{
  runtimeSessionId: string
  eventId?: string
  sequence?: string
}>

export type ConversationSearchRow = Readonly<{
  id: string
  kind: ConversationSearchKind
  runtimeSessionId: string
  generation: number
  title: string
  preview: string
  occurredAt?: string
  jump: ConversationSearchJump
  resumable?: boolean
  resumeReason?: 'available' | 'cancelled' | 'missing_start' | 'non_terminal' | 'unknown_state'
}>

export type ConversationSearchPage = Readonly<{
  items: readonly ConversationSearchRow[]
  nextCursor?: string
  totalMatches: number
}>

export type ConversationSearchInput = Readonly<{
  sessions: readonly RuntimeSession[]
  runs: readonly HarnessRun[]
  events: ReadonlyMap<string, readonly RuntimeEvent[]>
  query?: string
  cursor?: string
  limit?: number
}>

const MAX_PAGE = 500
const MAX_EVENT_WINDOW = 1_000
const MAX_TEXT = 240

function codePointText(value: string, limit = MAX_TEXT): string {
  return Array.from(value)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0
      return code >= 0x20 && code !== 0x7f
    })
    .slice(0, limit)
    .join('')
}

/** Apply the same safe display boundary to history/search as live transcript. */
export function redactSearchText(value: string, limit = MAX_TEXT): string {
  return codePointText(
    value
      .replace(
        /-----BEGIN [^-]{1,64}-+[^\s]{0,64}[\s\S]{0,4096}?-----END [^-]{1,64}-+/g,
        '[secret redacted]'
      )
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{1,512}/gi, 'Bearer [secret redacted]')
      .replace(/\b(?:sk|pk|api|token|secret)[-_][A-Za-z0-9._-]{8,512}/gi, '[secret redacted]')
      .replace(/(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^\s`\"']{1,512}/g, '[private path]'),
    limit
  )
}

function sequence(event: RuntimeEvent): bigint {
  try {
    return BigInt(event.seq)
  } catch {
    return -1n
  }
}

function payloadString(event: RuntimeEvent, keys: readonly string[]): string | undefined {
  if (event.payload === null || typeof event.payload !== 'object') return undefined
  const payload = event.payload as Record<string, unknown>
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim().length > 0) return redactSearchText(value.trim())
  }
  return undefined
}

function sessionTitle(session: RuntimeSession | undefined, id: string): string {
  return session?.displayName
    ? redactSearchText(session.displayName, 120)
    : `Session ${id.slice(0, 8)}`
}

function eventRow(
  event: RuntimeEvent,
  session: RuntimeSession | undefined
): ConversationSearchRow | undefined {
  const kind = event.kind
  let searchKind: ConversationSearchKind
  let preview: string | undefined
  if (kind === 'turn.user_input') {
    searchKind = 'prompt'
    preview = payloadString(event, ['text', 'content', 'message'])
  } else if (kind === 'turn.result') {
    searchKind = 'result'
    preview = payloadString(event, ['summary', 'result', 'text', 'content'])
  } else if (kind.startsWith('tool.')) {
    searchKind = 'tool'
    preview = payloadString(event, ['name', 'tool', 'summary'])
  } else if (kind.startsWith('approval.')) {
    searchKind = 'approval'
    preview = payloadString(event, ['name', 'title', 'reason'])
  } else if (kind.startsWith('question.')) {
    searchKind = 'question'
    preview = payloadString(event, ['question', 'title', 'text'])
  } else if (kind.startsWith('session.') || kind.startsWith('run.')) {
    searchKind = 'status'
    preview = kind
  } else {
    return undefined
  }
  return {
    id: `event:${event.eventId}`,
    kind: searchKind,
    runtimeSessionId: event.runtimeSessionId,
    generation: event.generation,
    title: sessionTitle(session, event.runtimeSessionId),
    preview: preview ?? kind,
    occurredAt: event.occurredAt,
    jump: {
      runtimeSessionId: event.runtimeSessionId,
      eventId: event.eventId,
      sequence: event.seq,
    },
  }
}

function runRow(run: HarnessRun, session: RuntimeSession | undefined): ConversationSearchRow {
  const resumable =
    (run.state === 'completed' || run.state === 'disconnected' || run.state === 'failed') &&
    run.startedAt !== undefined
  return {
    id: `run:${run.id}`,
    kind: 'run',
    runtimeSessionId: run.runtimeSessionId,
    generation: run.generation,
    title: sessionTitle(session, run.runtimeSessionId),
    preview: redactSearchText(`Harness ${run.state}`),
    ...(run.startedAt !== undefined ? { occurredAt: run.startedAt } : {}),
    jump: { runtimeSessionId: run.runtimeSessionId },
    resumable,
    resumeReason: resumable
      ? 'available'
      : run.state === 'cancelled'
        ? 'cancelled'
        : run.state === 'unknown'
          ? 'unknown_state'
          : run.startedAt === undefined
            ? 'missing_start'
            : 'non_terminal',
  }
}

function cursorOffset(cursor: string | undefined): number {
  if (!cursor || !/^v1\.[0-9a-z]+$/.test(cursor)) return 0
  const parsed = Number.parseInt(cursor.slice(3), 36)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

function nextCursor(offset: number, total: number): string | undefined {
  return offset < total ? `v1.${offset.toString(36)}` : undefined
}

function rowTime(row: ConversationSearchRow): string {
  return row.occurredAt ?? ''
}

/** Search canonical run records and bounded event windows without an index. */
export function searchConversationHistory(input: ConversationSearchInput): ConversationSearchPage {
  const sessions = new Map(input.sessions.map((session) => [session.id, session]))
  const rows: ConversationSearchRow[] = input.runs.map((run) =>
    runRow(run, sessions.get(run.runtimeSessionId))
  )
  for (const [runtimeSessionId, source] of input.events) {
    const session = sessions.get(runtimeSessionId)
    for (const event of [...source]
      .toSorted((left, right) => (sequence(right) < sequence(left) ? -1 : 1))
      .slice(0, MAX_EVENT_WINDOW)) {
      const row = eventRow(event, session)
      if (row) rows.push(row)
    }
  }
  const normalizedQuery = input.query?.trim().toLocaleLowerCase() ?? ''
  const filtered = rows
    .filter((row) => {
      if (!normalizedQuery) return true
      return [row.title, row.preview, row.kind, row.runtimeSessionId]
        .join(' ')
        .toLocaleLowerCase()
        .includes(normalizedQuery)
    })
    .toSorted((left, right) => {
      const time = rowTime(right).localeCompare(rowTime(left))
      return time !== 0 ? time : right.id.localeCompare(left.id)
    })
  const offset = Math.min(cursorOffset(input.cursor), filtered.length)
  const limit = Math.min(Math.max(input.limit ?? 100, 1), MAX_PAGE)
  const items = filtered.slice(offset, offset + limit)
  return {
    items,
    ...(nextCursor(offset + items.length, filtered.length)
      ? { nextCursor: nextCursor(offset + items.length, filtered.length) }
      : {}),
    totalMatches: filtered.length,
  }
}

/** Return a bounded viewport for a search result list without retaining rows. */
export function virtualSearchRows(
  rows: readonly ConversationSearchRow[],
  options: { start: number; visible: number; overscan?: number }
): readonly ConversationSearchRow[] {
  const overscan = Math.min(Math.max(options.overscan ?? 8, 0), 50)
  const start = Math.max(options.start - overscan, 0)
  const end = Math.min(options.start + Math.max(options.visible, 0) + overscan, rows.length)
  return rows.slice(start, end)
}
