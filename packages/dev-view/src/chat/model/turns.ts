// Pure projection from the bounded transcript rows to the turns the chat canvas
// draws: one person's prompt, then everything the agent did after it, in the
// order it arrived.
//
// What this module may decide, and what it may not:
//
// - A turn BOUNDARY is a `turn.user_input` event. That is the same boundary the
//   History pane already uses for its prompt list, and it is a fact about the
//   event kind, not about payload content.
// - Consecutive `turn.assistant_delta` events from one harness run and one
//   generation are joined into one block of prose, because a delta is by
//   definition a fragment of the text that follows it. Anything else between two
//   deltas (a tool, an approval, a different run) ends the block.
// - Nothing is correlated by payload. A `tool.started` and the `tool.completed`
//   that follows it stay two lines: the spec ("Payload hints and run completion
//   cannot authorize grouping or hide an action") gives the canvas no validated
//   call identity, and a spinner on a line whose completion is somewhere below it
//   would be a claim nobody made. A line carries a status only when its own event
//   kind states one (`*.completed`, `*.failed`).
// - No event disappears. A kind the chat has no dedicated presentation for is an
//   `other` entry with its kind as the label, in position.
import type { ChatTranscriptItem } from '../presentation'

/** Longest assistant block the canvas renders; longer text is cut and says so. */
export const CHAT_ASSISTANT_TEXT_LIMIT = 32_768

export type ChatTurnText = Readonly<{
  type: 'text'
  /** Stable for the block's lifetime: the first event's id. */
  id: string
  text: string
  /** Where the prose came from; `delta` blocks are the ones that can still grow. */
  source: 'delta' | 'message' | 'result'
  truncated: boolean
  failed: boolean
  eventIds: readonly string[]
}>

export type ChatTurnActivity = Readonly<{
  type: 'activity'
  id: string
  item: ChatTranscriptItem
}>

export type ChatTurnApproval = Readonly<{ type: 'approval'; id: string; item: ChatTranscriptItem }>
export type ChatTurnQuestion = Readonly<{ type: 'question'; id: string; item: ChatTranscriptItem }>
export type ChatTurnNotice = Readonly<{ type: 'notice'; id: string; item: ChatTranscriptItem }>

export type ChatTurnEntry =
  | ChatTurnText
  | ChatTurnActivity
  | ChatTurnApproval
  | ChatTurnQuestion
  | ChatTurnNotice

export type ChatTurn = Readonly<{
  /** The prompt's event id, or `lead` for events that precede any prompt. */
  id: string
  user?: ChatTranscriptItem
  entries: readonly ChatTurnEntry[]
}>

export type ChatTurnProjection = Readonly<{
  turns: readonly ChatTurn[]
  /** Event id → the entry id that renders it, so a reveal request finds a merged block. */
  entryByEventId: ReadonlyMap<string, string>
}>

const LEAD_TURN_ID = 'lead'

function sameRun(a: ChatTranscriptItem, b: ChatTranscriptItem): boolean {
  return (
    a.event?.harnessRunId === b.event?.harnessRunId && a.event?.generation === b.event?.generation
  )
}

function resultFailed(item: ChatTranscriptItem): boolean {
  const payload = item.event?.payload
  if (payload === null || typeof payload !== 'object') return false
  const record = payload as Record<string, unknown>
  return record.isError === true || record.is_error === true
}

function join(
  parts: readonly string[],
  alreadyTruncated: boolean
): { text: string; truncated: boolean } {
  const text = parts.join('')
  return text.length > CHAT_ASSISTANT_TEXT_LIMIT
    ? { text: text.slice(0, CHAT_ASSISTANT_TEXT_LIMIT), truncated: true }
    : { text, truncated: alreadyTruncated }
}

/**
 * Group projected transcript rows into turns.
 *
 * The input order is the arrival order and is preserved; this never sorts,
 * dedupes or drops. Prose comes from each row's `body`, the layout-preserving
 * form (a delta's whitespace is part of the text that follows it); the row's
 * `text` is the trimmed one-line form used for labels.
 */
export function buildChatTurns(items: readonly ChatTranscriptItem[]): ChatTurnProjection {
  const turns: { id: string; user?: ChatTranscriptItem; entries: ChatTurnEntry[] }[] = []
  const entryByEventId = new Map<string, string>()
  let open: { id: string; user?: ChatTranscriptItem; entries: ChatTurnEntry[] } | undefined
  let pendingDelta:
    | { first: ChatTranscriptItem; parts: string[]; ids: string[]; truncated: boolean }
    | undefined

  const index = (eventId: string, entryId: string) => entryByEventId.set(eventId, entryId)

  const flushDelta = () => {
    if (!pendingDelta || !open) return
    const { first, parts, ids, truncated: cut } = pendingDelta
    pendingDelta = undefined
    const { text, truncated } = join(parts, cut)
    open.entries.push({
      type: 'text',
      id: first.id,
      text,
      source: 'delta',
      truncated,
      failed: false,
      eventIds: ids,
    })
    for (const id of ids) index(id, first.id)
  }

  const current = () => {
    if (!open) {
      open = { id: LEAD_TURN_ID, entries: [] }
      turns.push(open)
    }
    return open
  }

  for (const item of items) {
    if (item.kind === 'turn.user_input') {
      flushDelta()
      open = { id: item.id, user: item, entries: [] }
      turns.push(open)
      index(item.id, item.id)
      continue
    }
    const turn = current()
    if (item.kind === 'turn.assistant_delta') {
      const text = item.body
      if (text === undefined || text.length === 0) {
        // An empty fragment adds no prose but is still an event: keep it visible.
        flushDelta()
        turn.entries.push({ type: 'activity', id: item.id, item })
        index(item.id, item.id)
        continue
      }
      if (pendingDelta && !sameRun(pendingDelta.first, item)) flushDelta()
      if (!pendingDelta) pendingDelta = { first: item, parts: [], ids: [], truncated: false }
      pendingDelta.truncated ||= item.bodyTruncated === true
      pendingDelta.parts.push(text)
      pendingDelta.ids.push(item.id)
      continue
    }
    flushDelta()
    if (item.kind === 'turn.assistant_message' || item.kind === 'turn.result') {
      if (item.body === undefined) {
        turn.entries.push({ type: 'notice', id: item.id, item })
      } else {
        const { text, truncated } = join([item.body], item.bodyTruncated === true)
        turn.entries.push({
          type: 'text',
          id: item.id,
          text,
          source: item.kind === 'turn.result' ? 'result' : 'message',
          truncated,
          failed: item.kind === 'turn.result' && resultFailed(item),
          eventIds: [item.id],
        })
      }
    } else if (item.role === 'approval') {
      turn.entries.push({ type: 'approval', id: item.id, item })
    } else if (item.role === 'question') {
      turn.entries.push({ type: 'question', id: item.id, item })
    } else if (item.role === 'status') {
      turn.entries.push({ type: 'notice', id: item.id, item })
    } else {
      turn.entries.push({ type: 'activity', id: item.id, item })
    }
    index(item.id, item.id)
  }
  flushDelta()
  return { turns, entryByEventId }
}

export type ChatTurnSegment =
  | Readonly<{ type: 'activity'; id: string; entries: readonly ChatTurnActivity[] }>
  | Readonly<{ type: 'entry'; id: string; entry: Exclude<ChatTurnEntry, ChatTurnActivity> }>

/**
 * Lay a turn's entries out for drawing: consecutive activity lines share one
 * quiet column, everything else stands alone. This is presentation only; the
 * order is the arrival order and every entry appears exactly once. A segment's id
 * is its first entry's id, which does not change as the run grows, so the
 * drawn column keeps its DOM while lines are appended.
 */
export function segmentTurnEntries(entries: readonly ChatTurnEntry[]): readonly ChatTurnSegment[] {
  const segments: ChatTurnSegment[] = []
  let run: ChatTurnActivity[] | undefined
  for (const entry of entries) {
    if (entry.type === 'activity') {
      if (!run) {
        run = []
        segments.push({ type: 'activity', id: entry.id, entries: run })
      }
      run.push(entry)
    } else {
      run = undefined
      segments.push({ type: 'entry', id: entry.id, entry })
    }
  }
  return segments
}
