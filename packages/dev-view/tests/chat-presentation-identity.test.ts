import { describe, expect, test } from 'bun:test'
import type { RuntimeEvent } from '@adea-ai/types/dev-runtime'

import { createChatPresentationIdentity, type PresentedTurn } from '../src/chat/model/identity'
import { buildChatTurns } from '../src/chat/model/turns'
import {
  acceptRuntimeEvent,
  CHAT_EVENT_RETENTION_LIMIT,
  createTranscriptAccumulator,
  type TranscriptAccumulator,
} from '../src/chat/model/transcript'
import { projectTranscriptEvents } from '../src/chat/presentation'

function eventFactory(session = 'session-1', generation = 1) {
  let sequence = 0
  return (kind: RuntimeEvent['kind'], payload: unknown, id?: string): RuntimeEvent => {
    sequence += 1
    return {
      schemaVersion: 1,
      eventId: id ?? `${session}-${generation}-e${sequence}`,
      runtimeSessionId: session,
      harnessRunId: 'run-1',
      generation,
      seq: String(sequence),
      occurredAt: '2026-10-14T10:00:00.000Z',
      receivedAt: '2026-10-14T10:00:00.000Z',
      source: 'host',
      sourceEventId: `s${session}-${generation}-${sequence}`,
      confidence: 'authoritative',
      classification: 'workspace_metadata',
      kind,
      payload,
    } satisfies RuntimeEvent
  }
}

/** The real accumulator: dedupes, orders and drops the oldest past the window. */
function transcript(session = 'session-1', generation = 1) {
  let state: TranscriptAccumulator = createTranscriptAccumulator({
    runtimeSessionId: session,
    generation,
  })
  return {
    push(next: RuntimeEvent) {
      state = acceptRuntimeEvent(state, next)
    },
    events: () => state.events,
  }
}

const present = (
  identity: ReturnType<typeof createChatPresentationIdentity>,
  events: readonly RuntimeEvent[]
) => identity.present(buildChatTurns(projectTranscriptEvents(events)))

const keys = (turn: PresentedTurn | undefined) => ({
  turn: turn?.key,
  segments: turn?.segments.map((segment) => segment.key),
  entries: turn?.entries.map((entry) => entry.key),
})

describe('presentation keys across the retention window', () => {
  test('the first pass names things by their own ids', () => {
    const next = eventFactory()
    const log = transcript()
    log.push(next('turn.user_input', { text: 'go' }, 'u1'))
    log.push(next('tool.started', { name: 'bash' }, 't1'))
    log.push(next('turn.assistant_message', { text: 'Done.' }, 'a1'))
    const [turn] = present(createChatPresentationIdentity(), log.events()).turns
    expect(turn).toMatchObject({ id: 'u1', key: 'u1' })
    expect(turn?.entries.map((entry) => entry.key)).toEqual(['t1', 'a1'])
    expect(turn?.segments.map((segment) => segment.key)).toEqual(['t1', 'a1'])
  })

  test('the turn keeps its key when its prompt is evicted from a full window', () => {
    const next = eventFactory()
    const log = transcript()
    const identity = createChatPresentationIdentity()
    log.push(next('turn.user_input', { text: 'go' }, 'prompt'))
    log.push(next('tool.started', { name: 'bash' }, 'tool'))
    const before = present(identity, log.events()).turns[0]
    expect(before?.key).toBe('prompt')

    // Fill the window past its limit with the reply's own events, drawn as it
    // fills (the transcript redraws on every event, so some pass always sees the
    // events that outlive the prompt).
    for (let n = 0; n < CHAT_EVENT_RETENTION_LIMIT; n += 1) {
      log.push(next('tool.completed', { name: `step ${n}` }, `step-${n}`))
      if (n % 100 === 0) present(identity, log.events())
    }
    expect(log.events().some((e) => e.eventId === 'prompt')).toBe(false)

    const after = present(identity, log.events()).turns
    // Built alone, the surviving events would be a `lead` turn.
    expect(buildChatTurns(projectTranscriptEvents(log.events())).turns[0]?.id).toBe('lead')
    expect(after).toHaveLength(1)
    expect(after[0]?.id).toBe('lead')
    expect(after[0]?.key).toBe('prompt')
    expect(after[0]?.user).toBeUndefined()
  })

  test('a reply longer than the window keeps one key while its leading deltas are evicted', () => {
    const next = eventFactory()
    const log = transcript()
    const identity = createChatPresentationIdentity()
    log.push(next('turn.user_input', { text: 'go' }, 'prompt'))
    const seen = new Set<string>()
    const replyKeys: (string | undefined)[] = []
    const entryIds: (string | undefined)[] = []
    for (let n = 0; n < CHAT_EVENT_RETENTION_LIMIT + 300; n += 1) {
      log.push(next('turn.assistant_delta', { text: `w${n} ` }, `d${n}`))
      if (n % 100 !== 0 && n !== CHAT_EVENT_RETENTION_LIMIT + 299) continue
      const [turn] = present(identity, log.events()).turns
      seen.add(turn?.key ?? '')
      replyKeys.push(turn?.entries[0]?.key)
      entryIds.push(turn?.entries[0]?.id)
    }
    // One block, named after the first delta, for the whole run.
    expect(new Set(replyKeys)).toEqual(new Set(['d0']))
    // Its runtime-facing id is not frozen: it is the oldest delta still retained.
    expect(entryIds.at(-1)).not.toBe('d0')
    expect(entryIds.at(-1)).toMatch(/^d\d+$/)
    expect(seen).toEqual(new Set(['prompt']))
    expect(log.events().length).toBe(CHAT_EVENT_RETENTION_LIMIT)
  })

  test('a column of lines keeps its key when its first line is evicted', () => {
    const next = eventFactory()
    const log = transcript()
    const identity = createChatPresentationIdentity()
    log.push(next('turn.user_input', { text: 'go' }, 'prompt'))
    for (let n = 0; n < 5; n += 1) log.push(next('tool.started', { name: `t${n}` }, `t${n}`))
    const before = keys(present(identity, log.events()).turns[0])
    for (let n = 5; n < CHAT_EVENT_RETENTION_LIMIT + 3; n += 1) {
      log.push(next('tool.started', { name: `t${n}` }, `t${n}`))
      if (n % 100 === 0) present(identity, log.events())
    }
    const after = keys(present(identity, log.events()).turns[0])
    expect(after.turn).toBe(before.turn)
    expect(after.segments).toEqual(before.segments)
    expect(before.segments).toEqual(['t0'])
    // Each surviving line keeps the key it first had.
    expect(after.entries?.[0]).toBe('t3')
  })

  test('keys are only ever ids the session delivered, or `lead`', () => {
    const next = eventFactory()
    const log = transcript()
    const identity = createChatPresentationIdentity()
    const delivered = new Set<string>(['lead'])
    const push = (event: RuntimeEvent) => {
      delivered.add(event.eventId)
      log.push(event)
    }
    push(next('session.ready', {}, 'ready'))
    push(next('turn.user_input', { text: 'go' }, 'prompt'))
    for (let n = 0; n < CHAT_EVENT_RETENTION_LIMIT + 200; n += 1) {
      push(next('turn.assistant_delta', { text: `w${n} ` }, `d${n}`))
      if (n % 100 !== 0) continue
      for (const turn of present(identity, log.events()).turns) {
        expect(delivered.has(turn.key)).toBe(true)
        for (const entry of turn.entries) expect(delivered.has(entry.key)).toBe(true)
        for (const segment of turn.segments) expect(delivered.has(segment.key)).toBe(true)
      }
    }
  })

  test('a new instance, as made for a new session or generation, starts from the ids again', () => {
    const next = eventFactory()
    const log = transcript()
    log.push(next('turn.user_input', { text: 'go' }, 'prompt'))
    for (let n = 0; n < CHAT_EVENT_RETENTION_LIMIT + 5; n += 1)
      log.push(next('turn.assistant_delta', { text: 'x ' }, `d${n}`))
    const identity = createChatPresentationIdentity()
    present(identity, log.events().slice(0, 10))
    expect(present(identity, log.events()).turns[0]?.key).toBe('lead')

    // Another generation of the same session reuses ids; it gets a fresh memory.
    const nextGeneration = eventFactory('session-1', 2)
    const other = transcript('session-1', 2)
    other.push(nextGeneration('turn.user_input', { text: 'again' }, 'prompt'))
    expect(present(createChatPresentationIdentity(), other.events()).turns[0]?.key).toBe('prompt')
  })

  test('two things in one pass never share a key', () => {
    const next = eventFactory()
    const log = transcript()
    const identity = createChatPresentationIdentity()
    log.push(next('turn.user_input', { text: 'go' }, 'prompt'))
    log.push(next('turn.assistant_delta', { text: 'before ' }, 'd1'))
    log.push(next('turn.assistant_delta', { text: 'after' }, 'd2'))
    expect(present(identity, log.events()).turns[0]?.entries.map((e) => e.key)).toEqual(['d1'])

    // An approval now lands between the two fragments of what was one block.
    log.push(next('turn.assistant_delta', { text: ' more' }, 'd3'))
    const interleaved = [...log.events()]
    interleaved.splice(2, 0, {
      ...next('approval.requested', { name: 'x', text: 'y' }, 'ask'),
      seq: '1.5',
    })
    const entryKeys = present(identity, interleaved).turns[0]?.entries.map((e) => e.key) ?? []
    expect(new Set(entryKeys).size).toBe(entryKeys.length)
  })
})
