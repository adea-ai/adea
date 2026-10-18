import { describe, expect, test } from 'bun:test'
import type { RuntimeEvent } from '@adea-ai/types/dev-runtime'

import { projectTranscriptEvents } from '../src/chat/presentation'
import {
  buildChatTurns,
  CHAT_CALL_DEPTH_LIMIT,
  type ChatTurnCall,
  type ChatTurnEntry,
} from '../src/chat/model/turns'

let sequence = 0
type Phase = 'requested' | 'started' | 'progress' | 'completed' | 'failed' | 'cancelled'

function raw(
  kind: RuntimeEvent['kind'],
  payload: unknown,
  id: string,
  over: Partial<RuntimeEvent>
) {
  sequence += 1
  return {
    schemaVersion: 1,
    eventId: id,
    runtimeSessionId: 'session-1',
    harnessRunId: 'run-1',
    generation: 1,
    seq: String(sequence),
    occurredAt: '2026-10-14T10:00:00.000Z',
    receivedAt: '2026-10-14T10:00:00.000Z',
    source: 'native',
    sourceEventId: `s${sequence}`,
    confidence: 'authoritative',
    classification: 'workspace_private',
    kind,
    payload,
    ...over,
  } satisfies RuntimeEvent
}

/** A tool observation that passes the wire gate. */
function tool(
  id: string,
  callId: string,
  phase: Phase,
  extra: Record<string, unknown> = {},
  over: Partial<RuntimeEvent> = {}
) {
  return raw(
    `tool.${phase}` as RuntimeEvent['kind'],
    { schemaVersion: 1, callId, phase, permissionEligibility: 'unknown', ...extra },
    id,
    over
  )
}

function subagent(
  id: string,
  callId: string,
  phase: Phase,
  extra: Record<string, unknown> = {},
  over: Partial<RuntimeEvent> = {}
) {
  return raw(
    'subagent.observed',
    { schemaVersion: 1, callId, phase, permissionEligibility: 'unknown', ...extra },
    id,
    over
  )
}

const prompt = (id: string) => raw('turn.user_input', { text: 'go' }, id, { source: 'host' })

const build = (events: readonly RuntimeEvent[]) => buildChatTurns(projectTranscriptEvents(events))

const calls = (entries: readonly ChatTurnEntry[]) =>
  entries.filter((entry): entry is ChatTurnCall => entry.type === 'call')

/** `id(children…)` for every call in the tree, so a shape is one readable string. */
const shape = (entry: ChatTurnCall): string =>
  entry.children.length === 0 ? entry.id : `${entry.id}(${entry.children.map(shape).join(',')})`

describe('tool and subagent calls', () => {
  test('the events of one call are one entry that stays where the first arrived', () => {
    const { turns, entryByEventId } = build([
      prompt('u1'),
      tool('t1', 'call-1', 'requested', { name: 'bash' }),
      raw(
        'turn.assistant_message',
        { messageId: 'm1', text: 'Working.', supersedes: 'deltas' },
        'a1',
        {}
      ),
      tool('t2', 'call-1', 'started'),
      tool('t3', 'call-1', 'completed', { durationMs: 1500 }),
    ])
    const entries = turns[0]!.entries
    expect(entries.map((entry) => `${entry.type}:${entry.id}`)).toEqual(['call:t1', 'text:a1'])
    const [call] = calls(entries)
    expect(call).toMatchObject({
      eventIds: ['t1', 't2', 't3'],
      call: {
        family: 'tool',
        callId: 'call-1',
        phase: 'completed',
        name: 'bash',
        durationMs: 1500,
      },
    })
    expect(['t1', 't2', 't3'].map((id) => entryByEventId.get(id))).toEqual(['t1', 't1', 't1'])
  })

  test('a phase only moves forward and a terminal phase is final', () => {
    const { turns } = build([
      prompt('u1'),
      tool('t1', 'call-1', 'progress'),
      tool('t2', 'call-1', 'started'),
      tool('t3', 'call-1', 'failed'),
      tool(
        't4',
        'call-1',
        'completed',
        { output: { type: 'inline', value: 'late' } },
        { classification: 'restricted_local' }
      ),
      tool('t5', 'call-1', 'started'),
    ])
    const [call] = calls(turns[0]!.entries)
    expect(call?.call.phase).toBe('failed')
    expect(call?.call.output).toBeUndefined()
    expect(call?.eventIds).toEqual(['t1', 't2', 't3', 't4', 't5'])
  })

  test('a call is drawn inside the call its producer named as its parent', () => {
    const { turns, entryByEventId } = build([
      prompt('u1'),
      subagent('s1', 'agent', 'started', { name: 'reviewer', parentCallId: null }),
      tool('t1', 'read', 'started', { parentCallId: 'agent' }),
      tool('t2', 'read', 'completed', { parentCallId: 'agent' }),
      tool('t3', 'edit', 'started', { parentCallId: 'agent' }),
      subagent('s2', 'agent', 'completed'),
    ])
    const entries = turns[0]!.entries
    expect(entries.map((entry) => entry.id)).toEqual(['s1'])
    expect(shape(calls(entries)[0]!)).toBe('s1(t1,t3)')
    expect(calls(entries)[0]).toMatchObject({
      call: { family: 'subagent', phase: 'completed', parentCallId: null },
    })
    // A reveal request for a nested call lands on the line that is drawn.
    expect(['s1', 's2', 't1', 't2', 't3'].map((id) => entryByEventId.get(id))).toEqual(
      Array(5).fill('s1')
    )
  })

  test('a parent that arrives after its child still holds it', () => {
    const { turns } = build([
      prompt('u1'),
      tool('t1', 'child', 'started', { parentCallId: 'parent' }),
      subagent('s1', 'parent', 'started'),
    ])
    expect(turns[0]!.entries.map((entry) => entry.id)).toEqual(['s1'])
    expect(shape(calls(turns[0]!.entries)[0]!)).toBe('s1(t1)')
  })

  test('nesting is never guessed: unknown, absent and null parents stay where they arrived', () => {
    const { turns } = build([
      prompt('u1'),
      subagent('s1', 'agent', 'started'),
      tool('t1', 'a', 'started', { parentCallId: 'not-in-the-window' }),
      tool('t2', 'b', 'started'),
      tool('t3', 'c', 'started', { parentCallId: null }),
    ])
    expect(turns[0]!.entries.map((entry) => entry.id)).toEqual(['s1', 't1', 't2', 't3'])
    expect(calls(turns[0]!.entries).every((entry) => entry.children.length === 0)).toBe(true)
  })

  test('two different parents for one call leave it unnested and say so', () => {
    const { turns } = build([
      prompt('u1'),
      subagent('s1', 'one', 'started'),
      subagent('s2', 'two', 'started'),
      tool('t1', 'x', 'started', { parentCallId: 'one' }),
      tool('t2', 'x', 'progress', { parentCallId: 'two' }),
    ])
    expect(turns[0]!.entries.map((entry) => entry.id)).toEqual(['s1', 's2', 't1'])
    expect(calls(turns[0]!.entries)[2]).toMatchObject({ parentConflict: true })
    expect(calls(turns[0]!.entries).every((entry) => entry.children.length === 0)).toBe(true)
  })

  test('a cycle is broken at the call that arrived first and loses no call', () => {
    const { turns, entryByEventId } = build([
      prompt('u1'),
      subagent('s1', 'a', 'started', { parentCallId: 'b' }),
      subagent('s2', 'b', 'started', { parentCallId: 'a' }),
    ])
    expect(turns[0]!.entries.map((entry) => entry.id)).toEqual(['s1'])
    expect(shape(calls(turns[0]!.entries)[0]!)).toBe('s1(s2)')
    expect(entryByEventId.get('s2')).toBe('s1')
  })

  test('a call that names itself as its parent fails the gate and stays a line', () => {
    const { turns } = build([prompt('u1'), tool('t1', 'x', 'started', { parentCallId: 'x' })])
    expect(turns[0]!.entries.map((entry) => `${entry.type}:${entry.id}`)).toEqual(['activity:t1'])
  })

  test('the same call id from another run, source or generation is another call', () => {
    const { turns } = build([
      prompt('u1'),
      tool('t1', 'call-1', 'started'),
      tool('t2', 'call-1', 'started', {}, { harnessRunId: 'run-2' }),
      tool('t3', 'call-1', 'started', {}, { source: 'acp' }),
      tool('t4', 'call-1', 'started', {}, { generation: 2 }),
    ])
    expect(calls(turns[0]!.entries).map((entry) => entry.id)).toEqual(['t1', 't2', 't3', 't4'])
  })

  test('a parent from another run or another turn is not a parent', () => {
    const { turns } = build([
      prompt('u1'),
      subagent('s1', 'agent', 'started', {}, { harnessRunId: 'run-2' }),
      tool('t1', 'child', 'started', { parentCallId: 'agent' }),
      prompt('u2'),
      tool('t2', 'child', 'started', { parentCallId: 'agent' }, { harnessRunId: 'run-2' }),
    ])
    expect(turns[0]!.entries.map((entry) => entry.id)).toEqual(['s1', 't1'])
    expect(turns[1]!.entries.map((entry) => entry.id)).toEqual(['t2'])
  })

  test('a tool and a subagent that share an id make the parent ambiguous, so nothing nests', () => {
    const { turns } = build([
      prompt('u1'),
      subagent('s1', 'same', 'started'),
      tool('t1', 'same', 'started'),
      tool('t2', 'child', 'started', { parentCallId: 'same' }),
    ])
    expect(turns[0]!.entries.map((entry) => entry.id)).toEqual(['s1', 't1', 't2'])
  })

  test('depth is limited and the deeper calls are listed beside the deepest drawn ancestor', () => {
    const depth = CHAT_CALL_DEPTH_LIMIT + 3
    const { turns, entryByEventId } = build([
      prompt('u1'),
      ...Array.from({ length: depth }, (_, level) =>
        subagent(
          `s${level}`,
          `c${level}`,
          'started',
          level === 0 ? {} : { parentCallId: `c${level - 1}` }
        )
      ),
    ])
    const [root] = calls(turns[0]!.entries)
    let levels = 0
    let seen = 0
    const walk = (entry: ChatTurnCall, level: number) => {
      levels = Math.max(levels, level + 1)
      seen += 1
      entry.children.forEach((child) => walk(child, level + 1))
    }
    walk(root!, 0)
    expect(levels).toBe(CHAT_CALL_DEPTH_LIMIT)
    expect(seen).toBe(depth)
    expect(Array.from({ length: depth }, (_, n) => entryByEventId.get(`s${n}`))).toEqual(
      Array(depth).fill('s0')
    )
  })

  test('a legacy tool event and a versioned claim the gate refuses stay their own lines', () => {
    const { turns } = build([
      prompt('u1'),
      raw('tool.started', { name: 'bash' }, 't1', {}),
      raw('tool.completed', { name: 'bash' }, 't2', {}),
      tool('t3', 'call-1', 'started', {}, { source: 'host' }),
      tool('t4', 'call-2', 'started', {}, { harnessRunId: undefined }),
    ])
    expect(turns[0]!.entries.map((entry) => `${entry.type}:${entry.id}`)).toEqual([
      'activity:t1',
      'activity:t2',
      'activity:t3',
      'activity:t4',
    ])
  })

  test('input and output are redacted and bounded, and a reference is not fetched', () => {
    const { turns } = build([
      prompt('u1'),
      tool(
        't1',
        'call-1',
        'completed',
        {
          input: {
            type: 'inline',
            value: { command: 'cat /home/someone/.env', token: 'sk-abcdefgh12345678' },
          },
          output: { type: 'reference', referenceId: 'blob-1', byteLength: 2048 },
        },
        { classification: 'restricted_local' }
      ),
    ])
    const [call] = calls(turns[0]!.entries)
    expect(call?.call.input).toMatchObject({ type: 'inline', truncated: false })
    const text = call?.call.input?.type === 'inline' ? call.call.input.text : ''
    expect(text).toContain('[private path]')
    expect(text).toContain('[secret redacted]')
    expect(text).not.toContain('sk-abcdefgh12345678')
    expect(text).not.toContain('/home/someone')
    expect(call?.call.output).toEqual({ type: 'reference', byteLength: 2048 })
  })

  test('long inline data is cut and says so', () => {
    const { turns } = build([
      prompt('u1'),
      tool(
        't1',
        'call-1',
        'completed',
        { output: { type: 'inline', value: 'x'.repeat(10_000) } },
        { classification: 'restricted_local' }
      ),
    ])
    const output = calls(turns[0]!.entries)[0]?.call.output
    expect(output).toMatchObject({ type: 'inline', truncated: true })
    expect(output?.type === 'inline' ? output.text.length : 0).toBeLessThanOrEqual(4_096)
  })
})
