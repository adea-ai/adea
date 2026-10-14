// Pure model for the History pane's Turns list: one row per user prompt with a
// short summary of the agent's reply, derived only from the canonical event log
// (`turn.user_input`, `turn.assistant_message`, `turn.result`, `tool.*`). Nothing
// here is stored or indexed; the pane re-derives it from the bounded window.
//
// Text goes through the same redaction and control-character boundary as the
// live transcript and history search (`redactSearchText`).
import type { HarnessRun, RuntimeEvent } from '@adea-ai/types/dev-runtime'

import { redactSearchText } from '../chat/search/conversation-search-model'
import type { ConversationSearchJump } from '../chat/search/conversation-search-model'

export type HistoryTurnState =
  /** A reply has not arrived and the session's harness run is still active. */
  | 'working'
  | 'done'
  /** The reply event itself reports an error; never inferred from silence. */
  | 'failed'
  /** The prompt has no reply event and no active run is producing one. */
  | 'unanswered'

export type HistoryTurn = Readonly<{
  id: string
  /** Full prompt, redacted and bounded. */
  prompt: string
  /** Reply summary, redacted and bounded; absent until the agent replied. */
  reply?: string
  state: HistoryTurnState
  toolCalls: number
  generation: number
  occurredAt: string
  jump: ConversationSearchJump
}>

export type BuildHistoryTurnsOptions = Readonly<{
  /** True while the newest harness run is working or awaiting input/approval. */
  runActive?: boolean
  /** Newest first by default, matching "what did I send last". */
  order?: 'newest-first' | 'oldest-first'
}>

const MAX_PROMPT = 2_000
const MAX_REPLY = 1_000

function sequence(event: RuntimeEvent): bigint {
  try {
    return BigInt(event.seq)
  } catch {
    return -1n
  }
}

function payloadText(event: RuntimeEvent, keys: readonly string[], limit: number) {
  if (event.payload === null || typeof event.payload !== 'object') return undefined
  const payload = event.payload as Record<string, unknown>
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim().length > 0)
      return redactSearchText(value.trim(), limit)
  }
  return undefined
}

function resultFailed(event: RuntimeEvent): boolean {
  if (event.payload === null || typeof event.payload !== 'object') return false
  const payload = event.payload as Record<string, unknown>
  if (payload.isError === true || payload.is_error === true) return true
  const status = payload.status ?? payload.outcome
  return status === 'failed' || status === 'error'
}

/**
 * A transcript that lost events (`resync_required`), disagrees with itself
 * (`conflict`) or belongs to an older generation (`stale_generation`) cannot
 * back a truthful prompt list. Chat detaches and offers a reconnect in those
 * cases; History does the same instead of presenting a partial window as ready.
 */
export function transcriptIsStale(availability: { status: string }): boolean {
  return (
    availability.status === 'resync_required' ||
    availability.status === 'conflict' ||
    availability.status === 'stale_generation'
  )
}

const ACTIVE_RUN_STATES: ReadonlySet<string> = new Set([
  'working',
  'awaiting_input',
  'awaiting_approval',
])

/**
 * The session's newest harness run. A later generation always supersedes an
 * earlier one: `version` only counts revisions within one generation, so an
 * older generation with a higher version must not win.
 */
export function newestRun(runs: readonly HarnessRun[]): HarnessRun | undefined {
  let newest: HarnessRun | undefined
  for (const run of runs) {
    if (
      !newest ||
      run.generation > newest.generation ||
      (run.generation === newest.generation && run.version > newest.version)
    )
      newest = run
  }
  return newest
}

/** Whether the session's newest harness run is still going. */
export function newestRunActive(runs: readonly HarnessRun[]): boolean {
  const newest = newestRun(runs)
  return newest !== undefined && ACTIVE_RUN_STATES.has(newest.state)
}

export function buildHistoryTurns(
  events: readonly RuntimeEvent[],
  options: BuildHistoryTurnsOptions = {}
): readonly HistoryTurn[] {
  const ordered = events
    .filter((event) => event.classification !== 'credential')
    .toSorted((left, right) => (sequence(left) < sequence(right) ? -1 : 1))
  type Draft = {
    event: RuntimeEvent
    prompt: string
    assistant?: string
    result?: { text?: string; failed: boolean }
    toolCalls: number
  }
  const drafts: Draft[] = []
  for (const event of ordered) {
    if (event.kind === 'turn.user_input') {
      drafts.push({
        event,
        prompt: payloadText(event, ['text', 'content', 'message'], MAX_PROMPT) ?? event.kind,
        toolCalls: 0,
      })
      continue
    }
    const current = drafts.at(-1)
    if (!current) continue
    if (event.kind === 'turn.assistant_message') {
      const text = payloadText(event, ['text', 'content', 'message'], MAX_REPLY)
      if (text !== undefined) current.assistant = text
    } else if (event.kind === 'turn.result') {
      const text = payloadText(event, ['summary', 'result', 'text', 'content'], MAX_REPLY)
      current.result = { ...(text !== undefined ? { text } : {}), failed: resultFailed(event) }
    } else if (event.kind === 'tool.requested') {
      current.toolCalls += 1
    }
  }
  const turns = drafts.map((draft, index): HistoryTurn => {
    const reply = draft.result?.text ?? draft.assistant
    const answered = draft.result !== undefined || draft.assistant !== undefined
    const latest = index === drafts.length - 1
    const state: HistoryTurnState = draft.result?.failed
      ? 'failed'
      : draft.result !== undefined
        ? 'done'
        : latest && options.runActive === true
          ? 'working'
          : answered
            ? 'done'
            : 'unanswered'
    return {
      id: draft.event.eventId,
      prompt: draft.prompt,
      ...(reply !== undefined ? { reply } : {}),
      state,
      toolCalls: draft.toolCalls,
      generation: draft.event.generation,
      occurredAt: draft.event.occurredAt,
      jump: {
        runtimeSessionId: draft.event.runtimeSessionId,
        eventId: draft.event.eventId,
        sequence: draft.event.seq,
      },
    }
  })
  return options.order === 'oldest-first' ? turns : turns.toReversed()
}

/** "just now", "14 min ago", "2 h ago", "3 d ago": presentation only. */
export function formatRelativeTime(iso: string, nowMs: number): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const seconds = Math.max(0, Math.floor((nowMs - then) / 1_000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.floor(hours / 24)} d ago`
}
