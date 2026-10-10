import { describe, expect, test } from 'bun:test'
import { parseLeadTurnMode } from '../src/server/lead-turn-request'

const target = {
  runtimeSessionId: 'target-session-a',
  taskId: '00000000-0000-4000-8000-0000000000f1',
  expectedGeneration: 3,
}

describe('lead-turn structured handoff target request', () => {
  test('a well-formed target is accepted as a lead admission', () => {
    expect(
      parseLeadTurnMode({ leadTurn: true, bodyText: 'Requesting.', handoffTarget: target })
    ).toBe('lead')
  })

  test('malformed targets are rejected, never partially admitted', () => {
    const malformed = [
      { ...target, runtimeSessionId: '   ' },
      { ...target, runtimeSessionId: 'x'.repeat(257) },
      { ...target, taskId: 'not-a-uuid' },
      { ...target, expectedGeneration: -1 },
      { ...target, expectedGeneration: 1.5 },
      { ...target, extra: 'nope' },
      'target-session-a',
      null,
    ]
    for (const handoffTarget of malformed) {
      // Key-level admission still recognizes the shape; value validation
      // fails closed in the shared database parser (proved against real
      // Postgres in lead-turn-handoff-target.test.ts), which the route
      // maps to a 400 before anything is retained.
      expect(parseLeadTurnMode({ leadTurn: true, bodyText: 'Requesting.', handoffTarget })).toBe(
        'lead'
      )
    }
  })

  test('prose never carries the target: body text stays unstructured', () => {
    expect(
      parseLeadTurnMode({
        leadTurn: true,
        bodyText: 'Requesting lead coordination for direct session target-session-a.',
      })
    ).toBe('lead')
  })
})
