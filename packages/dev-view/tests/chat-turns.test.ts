import { describe, expect, test } from 'bun:test'
import type { RuntimeEvent } from '@adea-ai/types/dev-runtime'

import { projectTranscriptEvents } from '../src/chat/presentation'
import { buildChatTurns, CHAT_ASSISTANT_TEXT_LIMIT } from '../src/chat/model/turns'

let sequence = 0
function event(kind: RuntimeEvent['kind'], payload: unknown, id?: string, run = 'run-1') {
  sequence += 1
  return {
    schemaVersion: 1,
    eventId: id ?? `e${sequence}`,
    runtimeSessionId: 'session-1',
    harnessRunId: run,
    generation: 1,
    seq: String(sequence),
    occurredAt: '2026-10-14T10:00:00.000Z',
    receivedAt: '2026-10-14T10:00:00.000Z',
    source: 'host',
    sourceEventId: `s${sequence}`,
    confidence: 'authoritative',
    classification: 'workspace_metadata',
    kind,
    payload,
  } satisfies RuntimeEvent
}

const turns = (events: readonly RuntimeEvent[]) => buildChatTurns(projectTranscriptEvents(events))

describe('buildChatTurns', () => {
  test('a user prompt opens a turn and everything after it nests inside', () => {
    const { turns: built } = turns([
      event('turn.user_input', { text: 'fix the build' }, 'u1'),
      event('tool.started', { name: 'bash' }, 't1'),
      event('turn.assistant_message', { text: 'Done.' }, 'a1'),
      event('turn.user_input', { text: 'thanks' }, 'u2'),
    ])
    expect(built.map((turn) => turn.id)).toEqual(['u1', 'u2'])
    expect(built[0]?.entries.map((entry) => `${entry.type}:${entry.id}`)).toEqual([
      'activity:t1',
      'text:a1',
    ])
    expect(built[1]?.entries).toHaveLength(0)
  })

  test('events before any prompt form a lead turn without a user message', () => {
    const { turns: built } = turns([
      event('session.ready', {}, 's1'),
      event('turn.user_input', { text: 'hi' }, 'u1'),
    ])
    expect(built[0]).toMatchObject({ id: 'lead' })
    expect(built[0]?.user).toBeUndefined()
    expect(built[0]?.entries.map((entry) => entry.type)).toEqual(['notice'])
  })

  test('consecutive deltas of one run join into one block with their whitespace intact', () => {
    const { turns: built, entryByEventId } = turns([
      event('turn.user_input', { text: 'q' }, 'u1'),
      event('turn.assistant_delta', { text: 'Hel' }, 'd1'),
      event('turn.assistant_delta', { text: 'lo ' }, 'd2'),
      event('turn.assistant_delta', { text: 'world' }, 'd3'),
    ])
    const [entry] = built[0]?.entries ?? []
    expect(entry).toMatchObject({ type: 'text', id: 'd1', text: 'Hello world', source: 'delta' })
    expect(entryByEventId.get('d3')).toBe('d1')
  })

  test('a tool, an approval or another run ends the block; nothing is reordered', () => {
    const { turns: built } = turns([
      event('turn.user_input', { text: 'q' }, 'u1'),
      event('turn.assistant_delta', { text: 'before ' }, 'd1'),
      event('tool.started', { name: 'bash' }, 't1'),
      event('turn.assistant_delta', { text: 'after ' }, 'd2'),
      event('turn.assistant_delta', { text: 'other run' }, 'd3', 'run-2'),
    ])
    expect(built[0]?.entries.map((entry) => entry.id)).toEqual(['d1', 't1', 'd2', 'd3'])
  })

  test('lifecycle is never inferred by pairing started and completed events', () => {
    const { turns: built } = turns([
      event('turn.user_input', { text: 'q' }, 'u1'),
      event('tool.started', { name: 'bash', id: 'call-1' }, 't1'),
      event('tool.completed', { name: 'bash', id: 'call-1' }, 't2'),
    ])
    expect(built[0]?.entries).toHaveLength(2)
    expect(built[0]?.entries.every((entry) => entry.type === 'activity')).toBe(true)
  })

  test('unknown kinds, terminal and usage events stay visible, in position', () => {
    const { turns: built } = turns([
      event('turn.user_input', { text: 'q' }, 'u1'),
      event('file.observed', { path: '/Users/me/secret.txt' }, 'f1'),
      event('usage.observed', { tokens: 3 }, 'x1'),
      event('terminal.cwd_changed', {}, 'c1'),
      event('wat.is.this' as RuntimeEvent['kind'], { a: 1 }, 'z1'),
    ])
    expect(built[0]?.entries.map((entry) => entry.id)).toEqual(['f1', 'x1', 'c1', 'z1'])
    const shown = built[0]?.entries.map((entry) =>
      entry.type === 'activity' ? { label: entry.item.label, text: entry.item.text } : entry
    )
    expect(JSON.stringify(shown)).not.toContain('/Users/me/secret.txt')
  })

  test('credential-classified events never reach a turn', () => {
    const credential = { ...event('turn.assistant_message', { text: 'sk-abcdefghijkl' }, 'k1') }
    const { turns: built } = turns([
      event('turn.user_input', { text: 'q' }, 'u1'),
      { ...credential, classification: 'credential' },
    ])
    expect(built[0]?.entries).toHaveLength(0)
  })

  test('an explicit error flag on turn.result marks the block failed, nothing else does', () => {
    const { turns: built } = turns([
      event('turn.user_input', { text: 'q' }, 'u1'),
      event('turn.result', { text: 'It broke.', isError: true }, 'r1'),
      event('turn.result', { text: 'status: failed in prose' }, 'r2'),
    ])
    const [first, second] = built[0]?.entries ?? []
    expect(first).toMatchObject({ type: 'text', source: 'result', failed: true })
    expect(second).toMatchObject({ type: 'text', source: 'result', failed: false })
  })

  test('long streamed prose is cut at the limit and flagged', () => {
    const chunk = 'x'.repeat(20_000)
    const { turns: built } = turns([
      event('turn.user_input', { text: 'q' }, 'u1'),
      event('turn.assistant_delta', { text: chunk }, 'd1'),
      event('turn.assistant_delta', { text: chunk }, 'd2'),
    ])
    const [entry] = built[0]?.entries ?? []
    expect(entry?.type === 'text' && entry.text.length).toBe(CHAT_ASSISTANT_TEXT_LIMIT)
    expect(entry?.type === 'text' && entry.truncated).toBe(true)
  })

  test('approvals and questions keep their own entries and event ids', () => {
    const { turns: built } = turns([
      event('turn.user_input', { text: 'q' }, 'u1'),
      event('approval.requested', { name: 'deploy' }, 'p1'),
      event('question.requested', { question: 'Which env?' }, 'q1'),
    ])
    expect(built[0]?.entries.map((entry) => `${entry.type}:${entry.id}`)).toEqual([
      'approval:p1',
      'question:q1',
    ])
  })
})

describe('question wording', () => {
  test("a question's own wording outranks its name, so the person sees what to answer", () => {
    const [row] = projectTranscriptEvents([
      event('question.requested', { name: 'Target', question: 'Which environment?' }, 'q1'),
    ])
    expect(row?.label).toBe('Which environment?')
  })

  test('a tool keeps its name as the label', () => {
    const [row] = projectTranscriptEvents([
      event('tool.started', { name: 'bash', question: 'ignored for tools' }, 't1'),
    ])
    expect(row?.label).toBe('bash')
  })
})
