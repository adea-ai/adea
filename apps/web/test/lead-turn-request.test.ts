import { describe, expect, test } from 'bun:test'
import { parseLeadTurnMode } from '../src/server/lead-turn-request'

describe('explicit lead-turn admission request', () => {
  test('history requests retain their direct-session and execution references', () => {
    expect(
      parseLeadTurnMode({ bodyText: 'User message', externalSessionRef: 'canonical-session' })
    ).toBe('history')
    expect(parseLeadTurnMode({ executionRef: 'historical-execution' })).toBe('history')
  })
  test('requested role refs require explicit lead admission', () => {
    const requestedModelSelections = {
      lead: { selectionRef: `msel_${'a'.repeat(32)}`, selectionRevision: 1 },
    }
    expect(parseLeadTurnMode({ bodyText: 'Question', requestedModelSelections })).toBeNull()
    expect(
      parseLeadTurnMode({ leadTurn: true, bodyText: 'Question', requestedModelSelections })
    ).toBe('lead')
  })
  test('only true opts in and only canonical message content is accepted', () => {
    expect(
      parseLeadTurnMode({ leadTurn: true, bodyText: 'User message', mentions: [], artifactIds: [] })
    ).toBe('lead')
    for (const value of [false, null, 'true', 1])
      expect(parseLeadTurnMode({ leadTurn: value })).toBeNull()
    for (const key of [
      'executionRef',
      'externalSessionRef',
      'taskId',
      'replyToMessageId',
      'threadRootMessageId',
      'principalId',
      'provider',
      'credentialRef',
      'selection',
      'runtimeSessionId',
    ]) {
      expect(
        parseLeadTurnMode({ leadTurn: true, bodyText: 'User message', [key]: 'caller-value' })
      ).toBeNull()
    }
  })
})
