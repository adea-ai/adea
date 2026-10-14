import { describe, expect, test } from 'bun:test'
import type { RuntimeEvent } from '@adea-ai/types/dev-runtime'

import { buildHistoryTurns, formatRelativeTime } from '../src/history/turns-model'

function event(seq: number, overrides: Partial<RuntimeEvent>): RuntimeEvent {
  return {
    schemaVersion: 1,
    eventId: `event-${seq}`,
    runtimeSessionId: 'session-1',
    generation: 2,
    seq: String(seq),
    occurredAt: '2026-09-22T10:00:10.000Z',
    receivedAt: '2026-09-22T10:00:10.000Z',
    source: 'host',
    sourceEventId: `source-${seq}`,
    confidence: 'authoritative',
    classification: 'workspace_metadata',
    kind: 'turn.user_input',
    payload: {},
    ...overrides,
  }
}

const prompt = (seq: number, text: string) =>
  event(seq, { kind: 'turn.user_input', payload: { text } })
const reply = (seq: number, text: string) =>
  event(seq, { kind: 'turn.assistant_message', payload: { text } })
const result = (seq: number, payload: Record<string, unknown>) =>
  event(seq, { kind: 'turn.result', payload })
const tool = (seq: number) => event(seq, { kind: 'tool.requested', payload: { name: 'bash' } })

describe('buildHistoryTurns', () => {
  test('lists one turn per prompt, newest first, with the reply summary', () => {
    const turns = buildHistoryTurns([
      prompt(1, 'add a login page'),
      tool(2),
      tool(3),
      result(4, { summary: 'Added the login page' }),
      prompt(5, 'now add tests'),
      reply(6, 'Writing tests'),
    ])
    expect(turns.map((turn) => turn.prompt)).toEqual(['now add tests', 'add a login page'])
    expect(turns[1]).toMatchObject({
      reply: 'Added the login page',
      state: 'done',
      toolCalls: 2,
      jump: { runtimeSessionId: 'session-1', eventId: 'event-1', sequence: '1' },
    })
    expect(turns[0]).toMatchObject({ reply: 'Writing tests', state: 'done', toolCalls: 0 })
  })

  test('can list oldest first', () => {
    const turns = buildHistoryTurns([prompt(1, 'one'), prompt(2, 'two')], {
      order: 'oldest-first',
    })
    expect(turns.map((turn) => turn.prompt)).toEqual(['one', 'two'])
  })

  test('orders by sequence, not arrival order', () => {
    const turns = buildHistoryTurns([prompt(3, 'second'), prompt(1, 'first')])
    expect(turns.map((turn) => turn.prompt)).toEqual(['second', 'first'])
  })

  test('only the newest unanswered prompt is working, and only while a run is active', () => {
    const events = [prompt(1, 'old'), prompt(2, 'new')]
    expect(buildHistoryTurns(events, { runActive: true }).map((turn) => turn.state)).toEqual([
      'working',
      'unanswered',
    ])
    expect(buildHistoryTurns(events).map((turn) => turn.state)).toEqual([
      'unanswered',
      'unanswered',
    ])
  })

  test('marks a turn failed only when the result event says so', () => {
    const turns = buildHistoryTurns([
      prompt(1, 'a'),
      result(2, { isError: true, summary: 'It broke' }),
      prompt(3, 'b'),
      result(4, { status: 'failed' }),
      prompt(5, 'c'),
      result(6, { summary: 'fine' }),
    ])
    expect(turns.map((turn) => turn.state)).toEqual(['done', 'failed', 'failed'])
  })

  test('redacts secrets and skips credential-classified events', () => {
    const turns = buildHistoryTurns([
      prompt(1, 'use token_sk-secret-value from /Users/example/private'),
      event(2, { classification: 'credential', kind: 'turn.user_input', payload: { text: 'x' } }),
    ])
    expect(turns).toHaveLength(1)
    expect(turns[0]?.prompt).not.toContain('sk-secret-value')
    expect(turns[0]?.prompt).not.toContain('/Users/example')
  })

  test('bounds long prompts and replies', () => {
    const [turn] = buildHistoryTurns([prompt(1, 'p'.repeat(10_000)), reply(2, 'r'.repeat(10_000))])
    expect(turn!.prompt.length).toBeLessThanOrEqual(2_100)
    expect(turn!.reply!.length).toBeLessThanOrEqual(1_100)
  })

  test('ignores events that precede the first prompt', () => {
    expect(buildHistoryTurns([reply(1, 'orphan'), tool(2)])).toEqual([])
  })
})

describe('formatRelativeTime', () => {
  const now = Date.parse('2026-09-22T12:00:00.000Z')
  test.each([
    ['2026-09-22T11:59:30.000Z', 'just now'],
    ['2026-09-22T11:46:00.000Z', '14 min ago'],
    ['2026-09-22T10:00:00.000Z', '2 h ago'],
    ['2026-09-19T12:00:00.000Z', '3 d ago'],
    ['not a date', ''],
  ])('%s -> %s', (iso, expected) => {
    expect(formatRelativeTime(iso, now)).toBe(expected)
  })
})
