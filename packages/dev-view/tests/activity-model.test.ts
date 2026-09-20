// #424 activity model: attention-first sorting, truthful elapsed time, and
// no fabricated state.
import { describe, expect, test } from 'bun:test'

import type { HarnessRun } from '@adea-ai/types/dev-runtime'

import { activityRows, formatElapsed } from '../src/resources/activity-model'

const SCOPE = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '0000-0000',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
} as never

function run(overrides: Partial<HarnessRun>): HarnessRun {
  return {
    id: 'run-1',
    scope: SCOPE,
    runtimeSessionId: 'session-1',
    installationId: 'install-1',
    agentProfile: {
      id: 'profile-1',
      version: 1,
      displayName: 'Planner',
      capabilityPolicyVersion: 1,
    },
    state: 'working',
    generation: 1,
    version: 1,
    ...overrides,
  }
}

const NOW = Date.parse('2026-09-19T12:00:00Z')

describe('activity rows', () => {
  test('attention runs sort first, then running, then terminal', () => {
    const rows = activityRows(
      [
        run({ id: 'done', state: 'completed', startedAt: '2026-09-19T11:00:00Z' }),
        run({ id: 'working', state: 'working', startedAt: '2026-09-19T11:30:00Z' }),
        run({ id: 'approval', state: 'awaiting_approval', startedAt: '2026-09-19T11:59:00Z' }),
      ],
      NOW
    )
    expect(rows.map((row) => row.id)).toEqual(['approval', 'working', 'done'])
    expect(rows[0]?.attention).toBe(true)
    expect(rows[1]?.running).toBe(true)
  })

  test('elapsed time is derived from startedAt and absent when not started', () => {
    const rows = activityRows(
      [run({ id: 'a', startedAt: '2026-09-19T11:59:30Z' }), run({ id: 'b', state: 'resolving' })],
      NOW
    )
    const started = rows.find((row) => row.id === 'a')!
    expect(started.elapsedMs).toBe(30_000)
    const unstarted = rows.find((row) => row.id === 'b')!
    expect(unstarted.elapsedMs).toBeUndefined()
  })

  test('formatElapsed renders bounded human units and unknown', () => {
    expect(formatElapsed(Number.NaN)).toBe('unknown')
    expect(formatElapsed(45_000)).toBe('45s')
    expect(formatElapsed(90_000)).toBe('1m 30s')
    expect(formatElapsed(3_600_000 + 120_000)).toBe('1h 2m')
  })
})
