// Run-history pane model (#400): bounded, newest-first, redacted-by-
// construction rows with caller-clock elapsed times and resume lineage.
import { describe, expect, test } from 'bun:test'

import type { HarnessRun, Scope } from '@adea-ai/types/dev-runtime'
import { buildRunHistoryRows, virtualHistoryRows } from '../src/history/run-history-model'

const SCOPE: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}

function run(overrides: Partial<HarnessRun> = {}): HarnessRun {
  return {
    id: 'run-1',
    scope: SCOPE,
    runtimeSessionId: 'session-1',
    installationId: 'inst-1',
    agentProfile: {
      id: 'profile-1',
      version: 3,
      displayName: 'profile-1',
      capabilityPolicyVersion: 3,
    },
    state: 'starting',
    generation: 1,
    version: 1,
    ...overrides,
  }
}

describe('buildRunHistoryRows', () => {
  test('rows are newest-first and carry state, lineage, and model facts', () => {
    const older = run({
      id: 'gen-1',
      state: 'disconnected',
      generation: 1,
      startedAt: '2026-09-19T10:00:00Z',
      finishedAt: '2026-09-19T10:04:00Z',
    })
    const resumed = run({
      id: 'gen-2',
      state: 'working',
      generation: 2,
      modelId: 'pi-large',
      startedAt: '2026-09-19T10:05:00Z',
    })
    const rows = buildRunHistoryRows([older, resumed])
    expect(rows.map((row) => row.runId)).toEqual(['gen-2', 'gen-1'])
    expect(rows[0]).toMatchObject({
      runtimeSessionId: 'session-1',
      generation: 2,
      modelId: 'pi-large',
      state: 'working',
      stateLabel: 'Harness working',
      tone: 'success',
    })
    expect(rows[1]).toMatchObject({
      generation: 1,
      state: 'disconnected',
      tone: 'failure',
      resumable: true,
      resumeReason: 'available',
    })
  })

  test('elapsed times derive from the run record or an injected clock only', () => {
    const finished = run({
      startedAt: '2026-09-19T10:00:00Z',
      finishedAt: '2026-09-19T10:01:30Z',
    })
    const running = run({ id: 'live', state: 'working', startedAt: '2026-09-19T10:00:00Z' })
    const rows = buildRunHistoryRows([finished, running], {
      nowMs: Date.parse('2026-09-19T10:00:42Z'),
    })
    expect(rows[0]!.elapsedMs).toBe(90_000)
    expect(rows[1]!.elapsedMs).toBe(42_000)
    // No clock and no finish: no fabricated elapsed time.
    const untouched = buildRunHistoryRows([running])
    expect(untouched[0]!.elapsedMs).toBeUndefined()
  })

  test('the limit bounds the window and never drops correctness for ordering', () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      run({ id: `run-${index}`, startedAt: new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString() })
    )
    const rows = buildRunHistoryRows(many, { limit: 10 })
    expect(rows).toHaveLength(10)
    expect(rows[0]!.runId).toBe('run-29')
  })

  test('cancel is not resumable; reconnect and completion are', () => {
    const rows = buildRunHistoryRows([
      run({ id: 'c', state: 'cancelled' }),
      run({ id: 'd', state: 'disconnected', startedAt: '2026-09-19T10:00:00Z' }),
      run({ id: 'e', state: 'completed', startedAt: '2026-09-19T10:00:00Z' }),
      run({ id: 'f', state: 'working' }),
    ])
    const resumable = Object.fromEntries(rows.map((row) => [row.runId, row.resumable]))
    expect(resumable).toEqual({ c: false, d: true, e: true, f: false })
    expect(rows.find((row) => row.runId === 'c')?.resumeReason).toBe('cancelled')
    expect(rows.find((row) => row.runId === 'f')?.resumeReason).toBe('missing_start')
  })

  test('rows carry no credential- or path-shaped fields', () => {
    const rows = buildRunHistoryRows([run()])
    for (const row of rows) {
      const encoded = JSON.stringify(row)
      expect(encoded).not.toMatch(/token|secret|password|credential/i)
      expect(encoded).not.toMatch(/\//)
    }
  })

  test('virtual history window bounds rows with controlled overscan', () => {
    const rows = buildRunHistoryRows(
      Array.from({ length: 40 }, (_, index) =>
        run({
          id: `run-${index}`,
          startedAt: new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString(),
        })
      ),
      { limit: 40 }
    )
    const visible = virtualHistoryRows(rows, { start: 20, visible: 4, overscan: 2 })
    expect(visible.map((row) => row.runId)).toEqual([
      'run-21',
      'run-20',
      'run-19',
      'run-18',
      'run-17',
      'run-16',
      'run-15',
      'run-14',
    ])
  })
})
