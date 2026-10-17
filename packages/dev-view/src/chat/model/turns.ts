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
// - Source-reported summaries are snapshots, not a stream. A `turn.reasoning_summary`
//   (identity `summaryId`) and a `turn.method_step_summary` (identity `methodId` +
//   `stepId`) each carry the whole current text and a revision. The canvas draws one
//   stable entry per identity at the position its first snapshot arrived, replaced
//   by a later snapshot only when its revision is higher and the last one was not
//   already terminal; an older, repeated or post-terminal snapshot is folded into
//   that entry without changing it. The identity includes session, generation, run
//   and source, so two runs that reuse an id never merge.
// - No event disappears. A kind the chat has no dedicated presentation for is an
//   `other` entry with its kind as the label, in position.
import type { RuntimeMethodStepSummary, RuntimeReasoningSummary } from '@adea-ai/types/dev-runtime'
import {
  redactAssistantDeltaFragments,
  redactAssistantDeltaGroup,
  type ChatResponseReferences,
  type ChatTranscriptItem,
} from '../presentation'

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
  /** Sources and cited spans the producer sent with this final message, when they validated. */
  references?: ChatResponseReferences
}>

export type ChatTurnReasoning = Readonly<{
  type: 'reasoning'
  /** Stable for the summary's lifetime: its first snapshot's event id. */
  id: string
  summary: RuntimeReasoningSummary
  eventIds: readonly string[]
}>

export type ChatTurnMethodStep = Readonly<{
  stepId: string
  position: number
  summary: RuntimeMethodStepSummary
}>

export type ChatTurnMethod = Readonly<{
  type: 'method'
  /** Stable for the method's lifetime: its first step snapshot's event id. */
  id: string
  methodId: string
  /** Ordered by the producer's `position`; arrival order breaks a tie. */
  steps: readonly ChatTurnMethodStep[]
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
  | ChatTurnReasoning
  | ChatTurnMethod
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
  const left = a.event?.harnessRunId
  const right = b.event?.harnessRunId
  return (
    typeof left === 'string' &&
    left.trim().length > 0 &&
    typeof right === 'string' &&
    right.trim().length > 0 &&
    left === right &&
    typeof a.event?.generation === 'number' &&
    a.event.generation === b.event?.generation
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

type OpenTurn = { id: string; user?: ChatTranscriptItem; entries: ChatTurnEntry[] }
type ReasoningState = {
  entries: ChatTurnEntry[]
  at: number
  id: string
  revision: number
  terminal: boolean
  eventIds: string[]
  summary: RuntimeReasoningSummary
}
type MethodState = {
  entries: ChatTurnEntry[]
  at: number
  id: string
  methodId: string
  steps: Map<
    string,
    { order: number; summary: RuntimeMethodStepSummary; revision: number; terminal: boolean }
  >
  eventIds: string[]
}

const isTerminal = (status: string) =>
  status === 'completed' || status === 'failed' || status === 'cancelled'

/** Two runs, generations, sessions or sources that reuse an id are different summaries. */
function summaryScope(item: ChatTranscriptItem): readonly unknown[] {
  const event = item.event
  return [event?.runtimeSessionId, event?.generation, event?.harnessRunId, event?.source]
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
  const safeDelta = new Map<
    ChatTranscriptItem,
    { body?: string; truncated: boolean; continuation?: boolean }
  >()
  for (let index = 0; index < items.length;) {
    if (items[index]?.kind !== 'turn.assistant_delta') {
      index += 1
      continue
    }
    const start = index
    while (index < items.length && items[index]?.kind === 'turn.assistant_delta') index += 1
    const streak = items.slice(start, index)
    const sanitized = redactAssistantDeltaFragments(streak)
    streak.forEach((item, partIndex) => safeDelta.set(item, sanitized[partIndex]!))
  }
  let pendingDelta:
    | { first: ChatTranscriptItem; items: ChatTranscriptItem[]; ids: string[]; truncated: boolean }
    | undefined

  const index = (eventId: string, entryId: string) => entryByEventId.set(eventId, entryId)

  const reasoning = new Map<string, ReasoningState>()
  const methods = new Map<string, MethodState>()
  const foldReasoning = (turn: OpenTurn, item: ChatTranscriptItem) => {
    const summary = item.summary as RuntimeReasoningSummary
    const key = JSON.stringify([summaryScope(item), summary.summaryId])
    const known = reasoning.get(key)
    if (!known) {
      const entry: ChatTurnReasoning = {
        type: 'reasoning',
        id: item.id,
        summary,
        eventIds: [item.id],
      }
      turn.entries.push(entry)
      reasoning.set(key, {
        entries: turn.entries,
        at: turn.entries.length - 1,
        id: item.id,
        revision: summary.revision,
        terminal: isTerminal(summary.status),
        eventIds: [item.id],
        summary,
      })
      index(item.id, item.id)
      return
    }
    known.eventIds.push(item.id)
    index(item.id, known.id)
    if (summary.revision > known.revision && !known.terminal) {
      known.summary = summary
      known.revision = summary.revision
      known.terminal = isTerminal(summary.status)
    }
    known.entries[known.at] = {
      type: 'reasoning',
      id: known.id,
      summary: known.summary,
      eventIds: [...known.eventIds],
    }
  }
  const foldMethod = (turn: OpenTurn, item: ChatTranscriptItem) => {
    const summary = item.summary as RuntimeMethodStepSummary
    const key = JSON.stringify([summaryScope(item), summary.methodId])
    let known = methods.get(key)
    if (!known) {
      known = {
        entries: turn.entries,
        at: turn.entries.length,
        id: item.id,
        methodId: summary.methodId,
        steps: new Map(),
        eventIds: [],
      }
      methods.set(key, known)
      turn.entries.push({
        type: 'method',
        id: item.id,
        methodId: summary.methodId,
        steps: [],
        eventIds: [],
      })
    }
    known.eventIds.push(item.id)
    index(item.id, known.id)
    const step = known.steps.get(summary.stepId)
    if (!step) {
      known.steps.set(summary.stepId, {
        order: known.steps.size,
        summary,
        revision: summary.revision,
        terminal: isTerminal(summary.status),
      })
    } else if (summary.revision > step.revision && !step.terminal) {
      // A step keeps the position its first snapshot gave it.
      step.summary = { ...summary, position: step.summary.position }
      step.revision = summary.revision
      step.terminal = isTerminal(summary.status)
    }
    known.entries[known.at] = {
      type: 'method',
      id: known.id,
      methodId: known.methodId,
      steps: [...known.steps.entries()]
        .toSorted(
          ([, left], [, right]) =>
            left.summary.position - right.summary.position || left.order - right.order
        )
        .map(([stepId, entry]) => ({
          stepId,
          position: entry.summary.position,
          summary: entry.summary,
        })),
      eventIds: [...known.eventIds],
    }
  }

  const flushDelta = () => {
    if (!pendingDelta || !open) return
    const { first, items: deltaItems, ids, truncated: cut } = pendingDelta
    pendingDelta = undefined
    const safeItems = deltaItems.map((item) => {
      const safe = safeDelta.get(item)
      return safe
        ? {
            ...item,
            body: safe.body,
            bodyTruncated: item.bodyTruncated || safe.truncated,
            event: undefined,
          }
        : item
    })
    const body = redactAssistantDeltaGroup(safeItems)
    const { text, truncated } = join([body.body], cut || body.truncated)
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
      const safe = safeDelta.get(item)
      // `undefined` from an existing sanitizer result means sanitized/omitted,
      // not "try the raw body again". Only an absent result may fall back.
      const text = safe === undefined ? item.body : safe.body
      if ((text === undefined || text.length === 0) && safe?.continuation !== true) {
        // An empty fragment adds no prose but is still an event: keep it visible.
        // The LF half of a CRLF split across fragments is empty too, yet it
        // continues the prose run instead of interrupting it.
        flushDelta()
        const truncated = item.bodyTruncated === true || safe?.truncated === true
        if (truncated) {
          // Preserve an explicit safety/truncation signal even when no safe
          // prose remains to display.
          turn.entries.push({
            type: 'text',
            id: item.id,
            text: '',
            source: 'delta',
            truncated: true,
            failed: false,
            eventIds: [item.id],
          })
        } else {
          const safeItem = safe
            ? {
                ...item,
                text: undefined,
                body: safe.body,
                bodyTruncated: item.bodyTruncated || safe.truncated,
                event: undefined,
              }
            : item
          turn.entries.push({ type: 'activity', id: item.id, item: safeItem })
        }
        index(item.id, item.id)
        continue
      }
      if (pendingDelta && !sameRun(pendingDelta.first, item)) flushDelta()
      if (!pendingDelta) pendingDelta = { first: item, items: [], ids: [], truncated: false }
      pendingDelta.truncated ||= item.bodyTruncated === true || safe?.truncated === true
      pendingDelta.items.push(
        safe
          ? {
              ...item,
              body: safe.body,
              bodyTruncated: item.bodyTruncated || safe.truncated,
              event: undefined,
            }
          : item
      )
      pendingDelta.ids.push(item.id)
      continue
    }
    flushDelta()
    if (item.role === 'reasoning' && item.summary) {
      foldReasoning(turn, item)
      continue
    }
    if (item.role === 'method' && item.summary) {
      foldMethod(turn, item)
      continue
    }
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
          ...(item.references !== undefined ? { references: item.references } : {}),
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

/** The entries that share the turn's one quiet column of lines. */
export type ChatTurnColumnEntry = ChatTurnActivity | ChatTurnReasoning | ChatTurnMethod

export type ChatTurnSegment =
  | Readonly<{ type: 'activity'; id: string; entries: readonly ChatTurnColumnEntry[] }>
  | Readonly<{ type: 'entry'; id: string; entry: Exclude<ChatTurnEntry, ChatTurnColumnEntry> }>

/**
 * Lay a turn's entries out for drawing: consecutive activity lines share one
 * quiet column, everything else stands alone. This is presentation only; the
 * order is the arrival order and every entry appears exactly once. A segment's id
 * is its first entry's id, which does not change as the run grows, so the
 * drawn column keeps its DOM while lines are appended.
 */
export function segmentTurnEntries(entries: readonly ChatTurnEntry[]): readonly ChatTurnSegment[] {
  const segments: ChatTurnSegment[] = []
  let run: ChatTurnColumnEntry[] | undefined
  for (const entry of entries) {
    if (entry.type === 'activity' || entry.type === 'reasoning' || entry.type === 'method') {
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
