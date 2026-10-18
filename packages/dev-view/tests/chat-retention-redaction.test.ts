import { expect, test } from 'bun:test'
import type { RuntimeEvent } from '@adea-ai/types/dev-runtime'
import {
  acceptRuntimeEvent,
  createTranscriptAccumulator,
  transcriptWindow,
  type TranscriptAccumulator,
} from '../src/chat/model/transcript'
import { projectTranscriptEvents } from '../src/chat/presentation'
import { buildChatTurns } from '../src/chat/model/turns'

function event(seq: number, kind: RuntimeEvent['kind'], text?: string): RuntimeEvent {
  return {
    schemaVersion: 1,
    eventId: `retention-${seq}`,
    sourceEventId: `retention-${seq}`,
    runtimeSessionId: 'session-1',
    harnessRunId: 'run-1',
    generation: 1,
    seq: String(seq),
    occurredAt: '2026-10-17T00:00:00Z',
    receivedAt: '2026-10-17T00:00:00Z',
    source: 'host',
    confidence: 'authoritative',
    classification: 'workspace_metadata',
    kind,
    payload:
      text === undefined
        ? {}
        : {
            text,
            messageId: seq < 1000 ? 'message-1' : 'message-2',
            deltaIndex: seq < 1000 ? seq - 1 : 0,
          },
  }
}

function displayed(state: TranscriptAccumulator) {
  // The same accumulator -> projection -> turn-model path used by ChatTranscript.
  const rows = projectTranscriptEvents(state.events, undefined, state)
  return { rows, text: JSON.stringify(buildChatTurns(rows)) }
}

test('evicting a split-secret prefix never reveals its formerly redacted suffix', () => {
  let state = createTranscriptAccumulator({ runtimeSessionId: 'session-1', generation: 1 })
  state = acceptRuntimeEvent(state, event(1, 'turn.assistant_delta', 'sk-'))
  state = acceptRuntimeEvent(state, event(2, 'turn.assistant_delta', 'supersecretvalue1234'))
  expect(displayed(state).text).not.toContain('supersecretvalue1234')
  for (let seq = 3; seq <= 1001; seq += 1)
    state = acceptRuntimeEvent(state, event(seq, 'session.ready'))
  expect(state.events).toHaveLength(1000)
  expect(state.events[0]?.seq).toBe('2')
  expect(displayed(state).text).not.toContain('supersecretvalue1234')
  expect(displayed(state).rows[0]).toMatchObject({ bodyTruncated: true })
  expect(displayed(state).rows[0]?.event).toBeUndefined()
  expect(state.assistantContextLost).toBe(true)
})

test('unknown-prefix protection follows every leading delta until a canonical boundary', () => {
  let state = createTranscriptAccumulator({ runtimeSessionId: 'session-1', generation: 1 })
  state = acceptRuntimeEvent(state, event(1, 'turn.assistant_delta', 'sk-'))
  state = acceptRuntimeEvent(state, event(2, 'turn.assistant_delta', 'supersecret'))
  state = acceptRuntimeEvent(state, event(3, 'turn.assistant_delta', 'value1234'))
  for (let seq = 4; seq <= 1002; seq += 1)
    state = acceptRuntimeEvent(state, event(seq, 'session.ready'))
  expect(state.events[0]?.seq).toBe('3')
  expect(displayed(state).text).not.toContain('value1234')
  state = acceptRuntimeEvent(state, event(1003, 'turn.assistant_delta', 'A new safe response.'))
  expect(displayed(state).text).toContain('A new safe response.')
  expect(state.assistantContextLost).toBe(false)
  // The safety provenance is one boolean, not retained secret text or an unbounded ID set.
  expect(typeof state.assistantContextLost).toBe('boolean')
})

test('a replay window beginning inside an assistant streak fails closed', () => {
  const state = transcriptWindow(
    [
      event(1, 'turn.assistant_delta', 'sk-'),
      event(2, 'turn.assistant_delta', 'supersecretvalue1234'),
      event(3, 'session.ready'),
      event(4, 'turn.assistant_delta', 'Visible after a known boundary.'),
    ],
    { runtimeSessionId: 'session-1', generation: 1, fromSequence: '2' }
  )
  expect(displayed(state).text).not.toContain('supersecretvalue1234')
  expect(displayed(state).text).toContain('Visible after a known boundary.')
})

test('withheld retained deltas keep one bounded block without retaining payload references', () => {
  let state = createTranscriptAccumulator({ runtimeSessionId: 'session-1', generation: 1 })
  for (let seq = 1; seq <= 1001; seq += 1)
    state = acceptRuntimeEvent(state, event(seq, 'turn.assistant_delta', `fragment-${seq} `))
  const rows = projectTranscriptEvents(state.events, undefined, state)
  expect(rows.every((row) => row.event === undefined)).toBe(true)
  const entries = buildChatTurns(rows).turns[0]!.entries
  expect(entries).toHaveLength(1)
  expect(entries[0]).toMatchObject({ type: 'text', text: '', truncated: true })
})
