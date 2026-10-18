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
// - Assistant content that carries a producer-assigned `messageId` is one message.
//   The deltas of that message, the final `turn.assistant_message` that replaces
//   them (`supersedes: 'deltas'`) and the `turn.result` that references it share one
//   entry, drawn where the first delta arrived, so a finished answer is never shown
//   twice and a stream that is replaced does not jump. The identity is scoped to its
//   session, generation, run and source: the same id from another run or source is a
//   different message. Events with no `messageId` (rows retained from before it
//   existed) keep the run-and-generation grouping below.
// - An approval or question outcome (`*.resolved`, `*.expired`) is drawn on its request
//   only when the wire gate accepted both payloads and they agree: the outcome's
//   `requestEventId` is the request's canonical event id in the same session and
//   generation, its `requestId` is the request's own, and both are the same kind of
//   interaction. The first outcome settles the request; an outcome that pairs with
//   nothing (its request left the window, or it conflicts) stays a line of its own that
//   says only what its event kind says. A legacy payload is never paired by its text.
// - A tool or subagent observation is correlated only through the producer's call
//   identity, and only when the wire gate accepted the whole versioned event. The
//   events of one call (session, generation, run, source, family and `callId`) share
//   one entry, drawn where the first arrived; its phase moves forward only and a
//   terminal phase is final. A call whose `parentCallId` names another call of the
//   same turn and scope is drawn inside it. An absent or unknown parent, a parent
//   the producer reported two ways, a cycle or an ambiguous parent leave the call
//   where it arrived; nesting is never guessed from names, order or timing. A call
//   deeper than `CHAT_CALL_DEPTH_LIMIT` levels is listed beside its deepest drawn
//   ancestor's children. Any other `tool.*` event (a legacy payload with no
//   `schemaVersion`) stays its own line and carries a status only when its own event
//   kind states one (`*.completed`, `*.failed`).
// - A structured result (`terminal.output`, `test_run.observed`, `failure.observed`,
//   `files.changed`, `plan.observed`, `task.observed`) is drawn only after the wire
//   gate accepted the whole event. Snapshots of one identity (terminal and command,
//   test run, change set, plan, task) share one entry at the position of the first;
//   a later snapshot replaces it by arrival unless the producer already ended it
//   (a terminal status, a finished command, `complete: true`), after which it only
//   joins the entry's event ids. Terminal chunks extend the output by their
//   `sequence`, an old or repeated sequence is ignored, and the text is redacted
//   once over the joined start of the output, never chunk by chunk. A failure is a
//   fact and keeps its own entry.
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
  redactDisplay,
  redactAssistantDeltaFragments,
  assistantMessageKey as assistantKey,
  redactAssistantDeltaGroup,
  sameRun,
  type ChatCall,
  type ChatResponseReferences,
  type ChatTranscriptItem,
} from '../presentation'
import {
  resultIdentity,
  resultSettled,
  TERMINAL_TEXT_LIMIT,
  type ChatResult,
  type ChatTerminalResult,
} from './results'

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
  /** The summary a `turn.result` sent for this message, bounded; the message's end, not a second answer. */
  summary?: string
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

/**
 * A structured result the producer observed (terminal output, test run, failure,
 * changed files, plan, task). Snapshots of one identity share an entry; terminal
 * chunks extend it. See `buildChatTurns`.
 */
export type ChatTurnResult = Readonly<{
  type: 'result'
  /** Stable for the result's lifetime: its first event's id. */
  id: string
  result: ChatResult
  eventIds: readonly string[]
}>

/** How deep a call tree is drawn; a deeper call is listed with its deepest drawn ancestor's children. */
export const CHAT_CALL_DEPTH_LIMIT = 6

/**
 * One tool or subagent call: every event the producer sent for its `callId`, merged,
 * and the calls it parented. `call` is the merged view (see `buildChatTurns`).
 */
export type ChatTurnCall = Readonly<{
  type: 'call'
  /** Stable for the call's lifetime: its first event's id. */
  id: string
  call: ChatCall
  /** This call's own events, not its children's. */
  eventIds: readonly string[]
  children: readonly ChatTurnCall[]
  /** The producer named two different parents for this call, so it is not nested. */
  parentConflict?: true
}>

/**
 * How a request ended, once the runtime reported it and the canvas could pair the
 * report with the request it answers (see `buildChatTurns`).
 */
export type ChatTurnOutcome = Readonly<{
  decision: 'approved' | 'denied' | 'answered' | 'expired'
  /** The outcome event, so a reveal request for it lands on the request's entry. */
  eventId: string
  decidedAt?: string
}>
export type ChatTurnApproval = Readonly<{
  type: 'approval'
  id: string
  item: ChatTranscriptItem
  outcome?: ChatTurnOutcome
}>
export type ChatTurnQuestion = Readonly<{
  type: 'question'
  id: string
  item: ChatTranscriptItem
  outcome?: ChatTurnOutcome
}>
export type ChatTurnNotice = Readonly<{ type: 'notice'; id: string; item: ChatTranscriptItem }>

export type ChatTurnEntry =
  | ChatTurnText
  | ChatTurnReasoning
  | ChatTurnMethod
  | ChatTurnActivity
  | ChatTurnCall
  | ChatTurnResult
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
  if (text.length <= CHAT_ASSISTANT_TEXT_LIMIT) return { text, truncated: alreadyTruncated }
  // The redacted body keeps whole code points, so the limit can fall between the
  // halves of an astral character; drop the high half rather than show half a
  // character.
  const last = text.charCodeAt(CHAT_ASSISTANT_TEXT_LIMIT - 1)
  const end =
    last >= 0xd800 && last <= 0xdbff ? CHAT_ASSISTANT_TEXT_LIMIT - 1 : CHAT_ASSISTANT_TEXT_LIMIT
  return { text: text.slice(0, end), truncated: true }
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

type ResultState = {
  entries: ChatTurnEntry[]
  at: number
  id: string
  eventIds: string[]
  result: ChatResult
  /** Terminal only: the unredacted start of the output, bounded to the scan window. */
  raw: string
  lastSequence: bigint
  streams: Set<string>
}

function terminalDisplay(state: ResultState, next: ChatTerminalResult): ChatTerminalResult {
  const shown = redactDisplay(state.raw, TERMINAL_TEXT_LIMIT, { layout: true })
  return {
    ...next,
    text: shown.text,
    cut: shown.truncated || state.raw.length >= TERMINAL_RAW_LIMIT,
    streams: [...state.streams] as ChatTerminalResult['streams'],
  }
}

/** The most raw terminal text kept to join and redact: the wire's own string maximum. */
const TERMINAL_RAW_LIMIT = 65_536

type CallState = {
  entries: ChatTurnEntry[]
  at: number
  /** The scope the call id is unique in, with the family; parents are looked up in it. */
  scope: string
  id: string
  eventIds: string[]
  call: ChatCall
  terminal: boolean
  parentConflict: boolean
}

const CALL_PHASE_RANK: Record<ChatCall['phase'], number> = {
  requested: 0,
  started: 1,
  progress: 2,
  completed: 3,
  failed: 3,
  cancelled: 3,
}

const isTerminal = (status: string) =>
  status === 'completed' || status === 'failed' || status === 'cancelled'

/** Two runs, generations, sessions or sources that reuse an id are different summaries. */
function summaryScope(item: ChatTranscriptItem): readonly unknown[] {
  const event = item.event
  return [event?.runtimeSessionId, event?.generation, event?.harnessRunId, event?.source]
}

/** A slot whose entry was folded into an earlier one; removed once the turn is built. */
const FOLDED = Object.freeze({}) as unknown as ChatTurnEntry

type OpenRequest = {
  entries: ChatTurnEntry[]
  at: number
  requestId: string
  family: 'approval' | 'question'
  settled: boolean
}

type MessageProse = {
  entries: ChatTurnEntry[]
  /** Where the message is drawn: the position of its first block. */
  at: number
  id: string
  settled: boolean
  /** Positions of later blocks of the same message, folded away once it settles. */
  later: { at: number; ids: string[] }[]
  eventIds: string[]
  failed: boolean
  summary?: string
}

/** The most of a result's summary kept with its message. */
const RESULT_SUMMARY_LIMIT = 500

function boundedSummary(body: string): string {
  const characters = Array.from(body)
  return characters.length <= RESULT_SUMMARY_LIMIT
    ? body
    : characters.slice(0, RESULT_SUMMARY_LIMIT).join('')
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
    | {
        first: ChatTranscriptItem
        items: ChatTranscriptItem[]
        ids: string[]
        truncated: boolean
        key: string | undefined
      }
    | undefined

  const index = (eventId: string, entryId: string) => entryByEventId.set(eventId, entryId)
  const prose = new Map<string, MessageProse>()
  const requests = new Map<string, OpenRequest>()

  const reasoning = new Map<string, ReasoningState>()
  const methods = new Map<string, MethodState>()
  const results = new Map<string, ResultState>()
  const foldResult = (turn: OpenTurn, item: ChatTranscriptItem) => {
    const result = item.result as ChatResult
    const identity = resultIdentity(result)
    const key = identity === undefined ? undefined : JSON.stringify([summaryScope(item), identity])
    const known = key === undefined ? undefined : results.get(key)
    const payload = item.event?.payload as { text?: string; sequence?: string } | undefined
    const chunk = typeof payload?.text === 'string' ? payload.text : ''
    const sequence = result.type === 'terminal' ? BigInt(payload?.sequence ?? '0') : 0n
    if (!known) {
      const state: ResultState = {
        entries: turn.entries,
        at: turn.entries.length,
        id: item.id,
        eventIds: [item.id],
        result,
        raw: chunk.replace(/\r\n?/g, '\n').slice(0, TERMINAL_RAW_LIMIT),
        lastSequence: sequence,
        streams: new Set(result.type === 'terminal' ? result.streams : []),
      }
      if (result.type === 'terminal') state.result = terminalDisplay(state, result)
      turn.entries.push({ type: 'result', id: item.id, result: state.result, eventIds: [item.id] })
      if (key !== undefined) results.set(key, state)
      index(item.id, item.id)
      return
    }
    known.eventIds.push(item.id)
    index(item.id, known.id)
    if (!resultSettled(known.result)) {
      if (result.type === 'terminal') {
        // An old or repeated chunk adds nothing; the stream is ordered by `sequence`.
        if (sequence > known.lastSequence) {
          known.lastSequence = sequence
          if (known.raw.length < TERMINAL_RAW_LIMIT)
            known.raw = (known.raw + chunk.replace(/\r\n?/g, '\n')).slice(0, TERMINAL_RAW_LIMIT)
          for (const stream of result.streams) known.streams.add(stream)
          const previous = known.result as ChatTerminalResult
          known.result = terminalDisplay(known, {
            ...result,
            ...(result.command === undefined && previous.command !== undefined
              ? { command: previous.command }
              : {}),
          })
        }
      } else known.result = result
    }
    known.entries[known.at] = {
      type: 'result',
      id: known.id,
      result: known.result,
      eventIds: [...known.eventIds],
    }
  }
  const calls = new Map<string, CallState>()
  const callStates: CallState[] = []
  const foldCall = (turn: OpenTurn, item: ChatTranscriptItem) => {
    const call = item.call as ChatCall
    const scope = JSON.stringify(summaryScope(item))
    const key = JSON.stringify([scope, call.family, call.callId])
    const known = calls.get(key)
    if (!known) {
      const state: CallState = {
        entries: turn.entries,
        at: turn.entries.length,
        scope,
        id: item.id,
        eventIds: [item.id],
        call,
        terminal: isTerminal(call.phase),
        parentConflict: false,
      }
      calls.set(key, state)
      callStates.push(state)
      turn.entries.push({ type: 'call', id: item.id, call, eventIds: [item.id], children: [] })
      return
    }
    known.eventIds.push(item.id)
    if (known.terminal) return
    const merged = known.call
    const parent = merged.parentCallId === undefined ? call.parentCallId : merged.parentCallId
    if (
      merged.parentCallId !== undefined &&
      call.parentCallId !== undefined &&
      merged.parentCallId !== call.parentCallId
    )
      known.parentConflict = true
    const advances = CALL_PHASE_RANK[call.phase] >= CALL_PHASE_RANK[merged.phase]
    known.call = {
      ...merged,
      ...(advances ? { phase: call.phase } : {}),
      ...(parent !== undefined ? { parentCallId: parent } : {}),
      ...(merged.name === undefined && call.name !== undefined ? { name: call.name } : {}),
      ...(merged.input === undefined && call.input !== undefined ? { input: call.input } : {}),
      ...(advances && call.output !== undefined ? { output: call.output } : {}),
      ...(advances && call.durationMs !== undefined ? { durationMs: call.durationMs } : {}),
    }
    known.terminal = isTerminal(known.call.phase)
  }
  /** Lay the turn's calls out as trees once every event of the window has been seen. */
  const nestCalls = () => {
    const byScope = new Map<string, CallState[]>()
    for (const state of callStates) {
      const id = JSON.stringify([state.scope, state.call.callId])
      byScope.set(id, [...(byScope.get(id) ?? []), state])
    }
    const parentOf = new Map<CallState, CallState>()
    for (const state of callStates) {
      const parentId = state.call.parentCallId
      if (typeof parentId !== 'string' || state.parentConflict) continue
      const candidates = (byScope.get(JSON.stringify([state.scope, parentId])) ?? []).filter(
        (candidate) => candidate !== state && candidate.entries === state.entries
      )
      // Two calls of different families with the parent's id: which one is meant is unknown.
      if (candidates.length === 1) parentOf.set(state, candidates[0]!)
    }
    // Break a cycle at the call that arrived first, so its members still all appear.
    for (const state of callStates) {
      const seen = new Set<CallState>([state])
      for (let up = parentOf.get(state); up !== undefined; up = parentOf.get(up)) {
        if (seen.has(up)) {
          parentOf.delete(state)
          break
        }
        seen.add(up)
      }
    }
    const depth = new Map<CallState, number>()
    const drawnParent = (state: CallState): CallState | undefined => {
      let parent = parentOf.get(state)
      while (parent !== undefined && drawnDepth(parent) >= CHAT_CALL_DEPTH_LIMIT - 1)
        parent = parentOf.get(parent)
      return parent
    }
    const drawnDepth = (state: CallState): number => {
      const known = depth.get(state)
      if (known !== undefined) return known
      const parent = drawnParent(state)
      const value = parent === undefined ? 0 : drawnDepth(parent) + 1
      depth.set(state, value)
      return value
    }
    const children = new Map<CallState, CallState[]>()
    for (const state of callStates) {
      const parent = drawnParent(state)
      if (parent !== undefined) children.set(parent, [...(children.get(parent) ?? []), state])
    }
    const build = (state: CallState): ChatTurnCall => ({
      type: 'call',
      id: state.id,
      call: state.call,
      eventIds: [...state.eventIds],
      children: (children.get(state) ?? []).map(build),
      ...(state.parentConflict ? { parentConflict: true as const } : {}),
    })
    const root = (state: CallState): CallState => {
      let top = state
      for (let up = drawnParent(top); up !== undefined; up = drawnParent(up)) top = up
      return top
    }
    for (const state of callStates) {
      const top = root(state)
      // A reveal request for any event of the tree lands on the line that is drawn.
      for (const eventId of state.eventIds) entryByEventId.set(eventId, top.id)
      state.entries[state.at] = top === state ? build(state) : FOLDED
    }
  }
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
    const { first, items: deltaItems, ids, truncated: cut, key } = pendingDelta
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
    if (key === undefined) return
    const at = open.entries.length - 1
    const known = prose.get(key)
    if (known && known.entries === open.entries) known.later.push({ at, ids })
    else
      prose.set(key, {
        entries: open.entries,
        at,
        id: first.id,
        settled: false,
        later: [],
        eventIds: [...ids],
        failed: false,
      })
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
      const key = assistantKey(item)
      const settled = key === undefined ? undefined : prose.get(key)
      if (settled?.settled === true && settled.entries === turn.entries) {
        // A late fragment of a message its final text already replaced: the final
        // text is the complete message, so the fragment only joins its event ids.
        settled.eventIds.push(item.id)
        turn.entries[settled.at] = {
          ...(turn.entries[settled.at] as ChatTurnText),
          eventIds: [...settled.eventIds],
        }
        index(item.id, settled.id)
        continue
      }
      const safe = safeDelta.get(item)
      // `undefined` from an existing sanitizer result means sanitized/omitted,
      // not "try the raw body again". Only an absent result may fall back.
      const text = safe === undefined ? item.body : safe.body
      if (
        (text === undefined || text.length === 0) &&
        safe?.continuation !== true &&
        item.withheldRun === undefined
      ) {
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
      if (pendingDelta && (!sameRun(pendingDelta.first, item) || pendingDelta.key !== key))
        flushDelta()
      if (!pendingDelta) pendingDelta = { first: item, items: [], ids: [], truncated: false, key }
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
    if (item.call !== undefined && item.event !== undefined) {
      foldCall(turn, item)
      continue
    }
    if (item.result !== undefined && item.event !== undefined) {
      foldResult(turn, item)
      continue
    }
    if (item.role === 'reasoning' && item.summary) {
      foldReasoning(turn, item)
      continue
    }
    if (item.role === 'method' && item.summary) {
      foldMethod(turn, item)
      continue
    }
    const interaction = item.interaction
    if (interaction?.phase === 'outcome' && item.event !== undefined) {
      const family = item.kind.startsWith('approval.') ? 'approval' : 'question'
      const target = requests.get(
        JSON.stringify([
          item.event.runtimeSessionId,
          item.event.generation,
          interaction.requestEventId,
        ])
      )
      const entry = target?.entries[target.at]
      if (
        target !== undefined &&
        entry !== undefined &&
        (entry.type === 'approval' || entry.type === 'question') &&
        !target.settled &&
        target.family === family &&
        target.requestId === interaction.requestId
      ) {
        target.settled = true
        target.entries[target.at] = {
          ...entry,
          outcome: {
            decision: interaction.decision,
            eventId: item.id,
            ...(interaction.decidedAt !== undefined ? { decidedAt: interaction.decidedAt } : {}),
          },
        }
        index(item.id, entry.id)
        continue
      }
    }
    if (item.kind === 'turn.assistant_message' || item.kind === 'turn.result') {
      const key = assistantKey(item)
      const known = key === undefined ? undefined : prose.get(key)
      const mine = known !== undefined && known.entries === turn.entries ? known : undefined
      if (item.kind === 'turn.result' && mine !== undefined) {
        // The result references a message already drawn: it ends that message, it is
        // not a second answer, whether or not it carries a summary. A failure it
        // reports marks that message; its summary stays with the message.
        mine.eventIds.push(item.id)
        mine.failed ||= resultFailed(item)
        if (item.body !== undefined) mine.summary = boundedSummary(item.body)
        turn.entries[mine.at] = {
          ...(turn.entries[mine.at] as ChatTurnText),
          failed: mine.failed,
          eventIds: [...mine.eventIds],
          ...(mine.summary !== undefined ? { summary: mine.summary } : {}),
        }
        index(item.id, mine.id)
        continue
      }
      // A final that passed the supersession contract is the whole message. When it is
      // blank (`body` is undefined) it still replaces the stream: the message is empty,
      // and the deltas it replaces must not stay on screen as if they were its text.
      const supersedes = item.kind === 'turn.assistant_message' && mine !== undefined
      if (item.body === undefined && !supersedes) {
        turn.entries.push({ type: 'notice', id: item.id, item })
      } else {
        const { text, truncated } =
          item.body === undefined
            ? { text: '', truncated: false }
            : join([item.body], item.bodyTruncated === true)
        // Spans are in the coordinates of the body; once the display cut shortens
        // it, a span reaching past the cut cites words that are no longer shown.
        // It stays counted in `cited` and is reported as unmarked.
        const references =
          item.references !== undefined && item.body !== undefined && text.length < item.body.length
            ? {
                ...item.references,
                citations: item.references.citations.filter(
                  (citation) => citation.end <= text.length
                ),
              }
            : item.references
        const entry: ChatTurnText = {
          type: 'text',
          id: item.id,
          text,
          source: item.kind === 'turn.result' ? 'result' : 'message',
          truncated,
          failed: item.kind === 'turn.result' && resultFailed(item),
          eventIds: [item.id],
          ...(references !== undefined ? { references } : {}),
        }
        if (supersedes) {
          // The final text replaces the stream it supersedes, in the stream's place and
          // under its id, so the drawn block keeps its node and position.
          for (const later of mine.later) {
            turn.entries[later.at] = FOLDED
            for (const id of later.ids) index(id, mine.id)
            mine.eventIds.push(...later.ids)
          }
          mine.later = []
          mine.eventIds.push(item.id)
          mine.settled = true
          turn.entries[mine.at] = {
            ...entry,
            id: mine.id,
            failed: mine.failed,
            eventIds: [...mine.eventIds],
            ...(mine.summary !== undefined ? { summary: mine.summary } : {}),
          }
          index(item.id, mine.id)
          continue
        }
        turn.entries.push(entry)
        if (key !== undefined && item.kind === 'turn.assistant_message')
          prose.set(key, {
            entries: turn.entries,
            at: turn.entries.length - 1,
            id: item.id,
            settled: true,
            later: [],
            eventIds: [item.id],
            failed: false,
          })
      }
    } else if (item.role === 'approval' || item.role === 'question') {
      turn.entries.push({ type: item.role, id: item.id, item })
      if (interaction?.phase === 'requested' && item.event !== undefined)
        requests.set(
          JSON.stringify([item.event.runtimeSessionId, item.event.generation, item.id]),
          {
            entries: turn.entries,
            at: turn.entries.length - 1,
            requestId: interaction.requestId,
            family: item.role,
            settled: false,
          }
        )
    } else if (item.role === 'status') {
      turn.entries.push({ type: 'notice', id: item.id, item })
    } else {
      turn.entries.push({ type: 'activity', id: item.id, item })
    }
    index(item.id, item.id)
  }
  flushDelta()
  nestCalls()
  for (const turn of turns)
    if (turn.entries.includes(FOLDED))
      turn.entries = turn.entries.filter((entry) => entry !== FOLDED)
  return { turns, entryByEventId }
}

/** The entries that share the turn's one quiet column of lines. */
export type ChatTurnColumnEntry =
  | ChatTurnActivity
  | ChatTurnCall
  | ChatTurnResult
  | ChatTurnReasoning
  | ChatTurnMethod

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
    if (
      entry.type === 'activity' ||
      entry.type === 'call' ||
      entry.type === 'result' ||
      entry.type === 'reasoning' ||
      entry.type === 'method'
    ) {
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
