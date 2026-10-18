import { expect, test } from 'bun:test'
import type { RuntimeEvent, RuntimeEventHistoryPage } from '@adea-ai/types/dev-runtime'
import { createRuntimeHistoryLoader, prependRuntimeHistory } from '../src/chat/model/history'
import {
  acceptRuntimeEvent,
  CHAT_EVENT_RETENTION_LIMIT,
  createTranscriptAccumulator,
  type TranscriptAccumulator,
} from '../src/chat/model/transcript'
import { projectTranscriptEvents } from '../src/chat/presentation'
import { buildChatTurns } from '../src/chat/model/turns'

function event(seq: number, text?: string): RuntimeEvent {
  return {
    schemaVersion: 1,
    eventId: `history-${seq}`,
    sourceEventId: `history-${seq}`,
    runtimeSessionId: 'session-a',
    harnessRunId: 'run-a',
    generation: 1,
    seq: String(seq),
    occurredAt: '2026-10-17T00:00:00Z',
    receivedAt: '2026-10-17T00:00:00Z',
    source: 'host',
    confidence: 'authoritative',
    classification: 'workspace_metadata',
    kind: text === undefined ? 'session.ready' : 'turn.assistant_delta',
    payload: text === undefined ? {} : { text, messageId: 'message-a', deltaIndex: seq - 1 },
  }
}
function initial(seq: number) {
  return acceptRuntimeEvent(
    createTranscriptAccumulator({ runtimeSessionId: 'session-a', generation: 1 }),
    event(seq)
  )
}
function page(before: number, items: RuntimeEvent[], more = true): RuntimeEventHistoryPage {
  return {
    runtimeSessionId: 'session-a',
    generation: 1,
    beforeSequence: String(before),
    retainedFromSequence: '1',
    retainedThroughSequence: String(before),
    historyStart: 'generation_start',
    items,
    ...(more ? { nextCursor: 'older' } : {}),
  }
}
function displayed(state: TranscriptAccumulator) {
  const rows = projectTranscriptEvents(state.events, undefined, state)
  return { rows, text: JSON.stringify(buildChatTurns(rows)) }
}
function expectWithheld(state: TranscriptAccumulator, suffix: string) {
  expect(state.assistantContextLost).toBe(true)
  const result = displayed(state)
  expect(result.text).not.toContain(suffix)
  expect(result.rows[0]).toMatchObject({ bodyTruncated: true })
  expect(result.rows[0]?.event).toBeUndefined()
}

test('a backward page starting inside a split secret withholds its suffix and event reference', () => {
  const live = initial(3)
  expect(live.assistantContextLost).toBe(false)
  const loaded = prependRuntimeHistory(live, page(3, [event(2, 'supersecretvalue1234')]))
  expectWithheld(loaded, 'supersecretvalue1234')
  expect(loaded.expectedSequence).toBe(live.expectedSequence)
  expect(live.events).toEqual([event(3)])
})

test('multiple backward pages stay withheld until the full prefix is restored and redacted', () => {
  let state = initial(4)
  state = prependRuntimeHistory(state, page(4, [event(3, 'value1234')]))
  expectWithheld(state, 'value1234')
  state = prependRuntimeHistory(state, page(3, [event(2, 'supersecret')]))
  expectWithheld(state, 'supersecret')
  expect(displayed(state).text).not.toContain('value1234')
  state = prependRuntimeHistory(state, page(2, [event(1, 'sk-')], false))
  expect(state.assistantContextLost).toBe(false)
  expect(state.retention.complete).toBe(true)
  expect(displayed(state).text).not.toContain('supersecret')
  expect(displayed(state).text).not.toContain('value1234')
})

test('restoring a safe generation prefix makes the full safe response visible', () => {
  let state = prependRuntimeHistory(initial(3), page(3, [event(2, 'world.')]))
  expectWithheld(state, 'world.')
  state = prependRuntimeHistory(state, page(2, [event(1, 'Hello ')], false))
  expect(state.assistantContextLost).toBe(false)
  expect(displayed(state).text).toContain('Hello world.')
})

test('a restored canonical non-delta boundary releases the following safe response', () => {
  let state = prependRuntimeHistory(initial(4), page(4, [event(3, 'Safe response.')]))
  expectWithheld(state, 'Safe response.')
  state = prependRuntimeHistory(state, page(3, [event(2)]))
  expect(state.assistantContextLost).toBe(false)
  expect(displayed(state).text).toContain('Safe response.')
})

test('retention slicing cannot expose a split-secret suffix even after loading its full prefix', () => {
  let state = initial(3)
  for (let seq = 4; seq <= CHAT_EVENT_RETENTION_LIMIT + 1; seq++)
    state = acceptRuntimeEvent(state, event(seq))
  state = prependRuntimeHistory(
    state,
    page(3, [event(1, 'sk-'), event(2, 'supersecretvalue1234')], false)
  )
  expect(state.events).toHaveLength(CHAT_EVENT_RETENTION_LIMIT)
  expect(state.events[0]?.seq).toBe('2')
  expect(state.retention.complete).toBe(false)
  expectWithheld(state, 'supersecretvalue1234')
  state = acceptRuntimeEvent(state, event(CHAT_EVENT_RETENTION_LIMIT + 2))
  expect(state.assistantContextLost).toBe(false)
})

test('retention slicing at a known boundary preserves a safe leading response on retry', () => {
  let state = initial(3)
  for (let seq = 4; seq <= CHAT_EVENT_RETENTION_LIMIT + 1; seq++)
    state = acceptRuntimeEvent(state, event(seq))
  const history = page(3, [event(1), event(2, 'Safe retained response.')], false)
  state = prependRuntimeHistory(state, history)
  expect(state.events[0]?.seq).toBe('2')
  expect(state.assistantContextLost).toBe(false)
  expect(displayed(state).text).toContain('Safe retained response.')
  state = prependRuntimeHistory(state, {
    ...page(2, [], false),
    retainedFromSequence: '2',
    historyStart: 'retention_boundary',
  })
  expect(state.assistantContextLost).toBe(false)
  expect(displayed(state).text).toContain('Safe retained response.')
})

test('a pending history read preserves privacy and concurrent live appends through later trimming', async () => {
  let state = initial(3)
  let deliver!: (value: RuntimeEventHistoryPage) => void
  const loader = createRuntimeHistoryLoader({
    state: () => state,
    commit: (next) => {
      state = next
    },
    read: () =>
      new Promise((resolve) => {
        deliver = resolve
      }),
  })
  const loading = loader.loadOlder()
  state = acceptRuntimeEvent(state, event(4, 'Visible after the boundary.'))
  deliver(page(3, [event(2, 'supersecretvalue1234')]))
  await loading
  expect(state.expectedSequence).toBe('5')
  expect(state.events.map((entry) => entry.seq)).toEqual(['2', '3', '4'])
  expectWithheld(state, 'supersecretvalue1234')
  expect(displayed(state).text).toContain('Visible after the boundary.')
  for (let seq = 5; seq <= CHAT_EVENT_RETENTION_LIMIT + 1; seq++)
    state = acceptRuntimeEvent(state, event(seq))
  expectWithheld(state, 'supersecretvalue1234')
  state = acceptRuntimeEvent(state, event(CHAT_EVENT_RETENTION_LIMIT + 2))
  expect(state.assistantContextLost).toBe(false)
  expect(displayed(state).text).toContain('Visible after the boundary.')
  loader.close()
})
