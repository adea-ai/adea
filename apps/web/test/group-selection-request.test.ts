import { describe, expect, test } from 'bun:test'

import { parseGroupSelection } from '../src/server/conversation-request'

const human = '44444444-0000-4000-8000-0000000000d1'
const agent = '5a1c0e11-0000-4000-8000-0000000000e1'
const home = '11111111-0000-4000-8000-0000000000a1'

describe('parseGroupSelection', () => {
  test('an absent selection is the empty selection', () => {
    expect(parseGroupSelection(undefined)).toEqual({ agents: [], humans: [] })
  })

  test('keeps qualified identities exactly as sent', () => {
    expect(
      parseGroupSelection({ agents: [{ agentId: agent, workspaceId: home }], humans: [human] })
    ).toEqual({ agents: [{ agentId: agent, workspaceId: home }], humans: [human] })
  })

  test('treats a missing list as empty', () => {
    expect(parseGroupSelection({ humans: [human] })).toEqual({ agents: [], humans: [human] })
    expect(parseGroupSelection({ agents: [{ agentId: agent, workspaceId: home }] })).toEqual({
      agents: [{ agentId: agent, workspaceId: home }],
      humans: [],
    })
  })

  test.each([
    ['a non-object', 'all'],
    ['an array', []],
    ['null', null],
    ['an unknown key', { agents: [], humans: [], grants: [] }],
    ['a grant smuggled into a human', { agents: [], humans: [{ userId: human, grantId: 'g' }] }],
    ['a non-uuid human', { agents: [], humans: ['someone'] }],
    ['an Agent without a workspace', { agents: [{ agentId: agent }], humans: [] }],
    ['an Agent with a name instead of ids', { agents: [{ name: 'Aria' }], humans: [] }],
    [
      'an Agent carrying a grant field',
      { agents: [{ agentId: agent, workspaceId: home, revision: 9 }], humans: [] },
    ],
    ['a non-list humans', { agents: [], humans: human }],
    [
      'more than the limit',
      {
        agents: [],
        humans: Array.from(
          { length: 101 },
          (_, index) => `44444444-0000-4000-8000-${String(index).padStart(12, '0')}`
        ),
      },
    ],
  ])('rejects %s', (_label, value) => {
    expect(parseGroupSelection(value)).toBeNull()
  })
})
