// ADR 0011 leaf activity: a worktree leaf's sessions' runs map to
// needs_you / running / idle with the activity model's own state sets.
import { describe, expect, test } from 'bun:test'

import type { HarnessRun } from '@adea-ai/types/dev-runtime'

import { leafActivity } from '../src/resources/leaf-activity'

const run = (runtimeSessionId: string, state: HarnessRun['state']) => ({ runtimeSessionId, state })
const sessions = [{ id: 'session-a' }, { id: 'session-b' }]

describe('leafActivity', () => {
  test('a run awaiting input or approval needs you, ahead of running work', () => {
    expect(
      leafActivity([run('session-a', 'working'), run('session-b', 'awaiting_input')], sessions)
    ).toBe('needs_you')
    expect(leafActivity([run('session-a', 'awaiting_approval')], sessions)).toBe('needs_you')
  })

  test('resolving, starting, and working runs are running', () => {
    for (const state of ['resolving', 'starting', 'working'] as const)
      expect(leafActivity([run('session-b', state)], sessions)).toBe('running')
  })

  test('terminal runs, other sessions, and no runs are idle', () => {
    expect(leafActivity([], sessions)).toBe('idle')
    expect(
      leafActivity([run('session-a', 'completed'), run('session-b', 'failed')], sessions)
    ).toBe('idle')
    expect(leafActivity([run('session-z', 'awaiting_input')], sessions)).toBe('idle')
    expect(leafActivity([run('session-a', 'awaiting_input')], [])).toBe('idle')
  })
})
