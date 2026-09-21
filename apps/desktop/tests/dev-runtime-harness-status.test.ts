// Canonical HarnessRun status machine and bounded run history (#400).
//
// Pure, clock-free coverage: every transition edge is pinned against the
// table (the issue's machine — resolving/starting → working ↔
// awaiting_input/awaiting_approval → completed|failed|cancelled|disconnected|
// unknown), terminal states refuse everything, same-state re-observation is
// an idempotent replay, and the bounded history store drops the oldest
// terminal records while never evicting a live run. Observed transitions are
// caller-timestamped, so tests inject the clock.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HarnessRun, HarnessRunState, Scope } from '../../../../packages/types/src/dev-runtime'
import {
  MAX_RETAINED_RUNS,
  MAX_TRANSITIONS_PER_RUN,
  createRunHistoryStore,
} from '../shell/src/dev-runtime/harness/runs'
import {
  RUN_TERMINAL_STATES,
  RunStatusError,
  assertRunTransition,
  canTransitionRun,
  runEventKind,
  RUN_TRANSITIONS,
} from '../shell/src/dev-runtime/harness/status'

const SCOPE: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const ALL_STATES: readonly HarnessRunState[] = [
  'resolving',
  'starting',
  'working',
  'awaiting_input',
  'awaiting_approval',
  'completed',
  'failed',
  'cancelled',
  'disconnected',
  'unknown',
]

describe('canonical run transition table', () => {
  test('every legal edge in the machine is reachable and mutually consistent', () => {
    // The table must cover every state exactly once.
    expect(Object.keys(RUN_TRANSITIONS).toSorted()).toEqual([...ALL_STATES].toSorted())
    // Every target of every edge is itself a known state.
    for (const [, targets] of Object.entries(RUN_TRANSITIONS)) {
      for (const target of targets) expect(ALL_STATES).toContain(target)
    }
    // No terminal state has an exit; every non-terminal state has one.
    for (const state of ALL_STATES) {
      if (RUN_TERMINAL_STATES.includes(state)) {
        expect(RUN_TRANSITIONS[state]).toHaveLength(0)
      } else {
        expect(RUN_TRANSITIONS[state].length).toBeGreaterThan(0)
      }
    }
  })

  test('the issue machine holds: starting → working ↔ awaiting → terminal', () => {
    expect(canTransitionRun('starting', 'working')).toBe(true)
    expect(canTransitionRun('working', 'awaiting_input')).toBe(true)
    expect(canTransitionRun('working', 'awaiting_approval')).toBe(true)
    expect(canTransitionRun('awaiting_input', 'working')).toBe(true)
    expect(canTransitionRun('awaiting_approval', 'working')).toBe(true)
    for (const terminal of RUN_TERMINAL_STATES) {
      expect(canTransitionRun('working', terminal)).toBe(true)
    }
    // Time never runs backwards and states never collide sideways.
    expect(canTransitionRun('working', 'starting')).toBe(false)
    expect(canTransitionRun('starting', 'resolving')).toBe(false)
    expect(canTransitionRun('completed', 'failed')).toBe(false)
    // A terminal state accepts nothing, including itself minus the no-op.
    for (const terminal of RUN_TERMINAL_STATES) {
      for (const target of ALL_STATES) {
        if (target !== terminal) expect(canTransitionRun(terminal, target)).toBe(false)
      }
    }
  })

  test('same-state re-observation is an idempotent no-op, not an edge', () => {
    for (const state of ALL_STATES) {
      expect(assertRunTransition(state, state)).toBe(false)
    }
  })

  test('illegal edges throw the typed invalid_transition refusal', () => {
    expect(() => assertRunTransition('working', 'starting')).toThrow(RunStatusError)
    try {
      assertRunTransition('starting', 'resolving')
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(RunStatusError)
      expect((error as RunStatusError).code).toBe('invalid_transition')
    }
    try {
      assertRunTransition('completed', 'working')
      expect.unreachable()
    } catch (error) {
      expect((error as RunStatusError).code).toBe('already_completed')
    }
  })

  test('event kinds map truthfully: liveness → run.ready, ends → their kind', () => {
    expect(runEventKind('working')).toBe('run.ready')
    expect(runEventKind('awaiting_input')).toBe('run.ready')
    expect(runEventKind('awaiting_approval')).toBe('run.ready')
    expect(runEventKind('starting')).toBe('run.starting')
    expect(runEventKind('resolving')).toBe('run.starting')
    expect(runEventKind('completed')).toBe('run.completed')
    expect(runEventKind('failed')).toBe('run.failed')
    expect(runEventKind('cancelled')).toBe('run.cancelled')
    expect(runEventKind('disconnected')).toBe('run.disconnected')
    expect(runEventKind('unknown')).toBeUndefined()
  })
})

describe('bounded run history store', () => {
  function makeRun(overrides: Partial<HarnessRun> = {}): HarnessRun {
    return {
      id: `run-${Math.random().toString(36).slice(2, 10)}`,
      scope: SCOPE,
      runtimeSessionId: '00000000-0000-4000-8000-0000000000d1',
      installationId: '00000000-0000-4000-8000-0000000000e1',
      agentProfile: {
        id: 'profile-1',
        version: 1,
        displayName: 'profile-1',
        capabilityPolicyVersion: 1,
      },
      state: 'starting',
      generation: 1,
      version: 1,
      ...overrides,
    }
  }

  function open() {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-run-history-'))
    return {
      runs: createRunHistoryStore({ dataDir, scope: SCOPE }),
      cleanup: () => rmSync(dataDir, { recursive: true, force: true }),
    }
  }

  test('observe applies legal edges on injected clocks and stamps terminal time', () => {
    const s = open()
    try {
      const run = makeRun()
      s.runs.append(run)
      const working = s.runs.observe({
        runId: run.id,
        to: 'working',
        source: 'acp',
        observedAt: '2026-09-19T10:00:00.000Z',
      })
      expect(working.state).toBe('working')
      expect(working.version).toBe(run.version + 1)
      expect(working.finishedAt).toBeUndefined()
      const completed = s.runs.observe({
        runId: run.id,
        to: 'completed',
        source: 'native',
        observedAt: '2026-09-19T10:05:00.000Z',
      })
      expect(completed.state).toBe('completed')
      expect(completed.finishedAt).toBe('2026-09-19T10:05:00.000Z')
      // The transitions journal holds the observed facts in order.
      expect(s.runs.transitions(run.id).map((t) => `${t.from}→${t.to}@${t.source}`)).toEqual([
        'starting→working@acp',
        'working→completed@native',
      ])
    } finally {
      s.cleanup()
    }
  })

  test('same-state observe is idempotent; illegal edges and terminals refuse typed', () => {
    const s = open()
    try {
      const run = makeRun({ state: 'working' })
      s.runs.append(run)
      const unchanged = s.runs.observe({
        runId: run.id,
        to: 'working',
        source: 'acp',
        observedAt: '2026-09-19T10:00:01.000Z',
      })
      expect(unchanged.version).toBe(run.version)
      expect(s.runs.transitions(run.id)).toHaveLength(0)
      expect(() =>
        s.runs.observe({
          runId: run.id,
          to: 'starting',
          source: 'host',
          observedAt: '2026-09-19T10:00:02.000Z',
        })
      ).toThrow(/cannot move/)
      s.runs.observe({
        runId: run.id,
        to: 'failed',
        source: 'host',
        observedAt: '2026-09-19T10:01:00.000Z',
      })
      expect(() =>
        s.runs.observe({
          runId: run.id,
          to: 'working',
          source: 'host',
          observedAt: '2026-09-19T10:02:00.000Z',
        })
      ).toThrow(/already completed|already failed/)
    } finally {
      s.cleanup()
    }
  })

  test('retention drops the oldest terminal runs and never evicts a live one', () => {
    const s = open()
    try {
      const live = makeRun({ id: 'run-live', startedAt: '2026-09-19T00:00:00.000Z' })
      s.runs.append(live)
      for (let i = 0; i < MAX_RETAINED_RUNS + 5; i++) {
        const run = makeRun({
          state: 'working',
          startedAt: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
        })
        s.runs.append(run)
        s.runs.observe({
          runId: run.id,
          to: 'completed',
          source: 'host',
          observedAt: new Date(Date.UTC(2026, 8, 1, 0, i, 30)).toISOString(),
        })
      }
      const all = s.runs.list()
      expect(all.length).toBeLessThanOrEqual(MAX_RETAINED_RUNS)
      // The live run survives every eviction.
      expect(s.runs.get('run-live')).toBeDefined()
      // The oldest terminal runs were evicted: the cap counts total records
      // (live included), so 199 terminal runs remain and the first six
      // evictions are minutes 0–5.
      const terminalStarted = all
        .filter((entry) => entry.id !== 'run-live')
        .map((entry) => entry.startedAt ?? '')
        .toSorted()
      expect(terminalStarted).toHaveLength(MAX_RETAINED_RUNS - 1)
      expect(terminalStarted[0]).toBe(new Date(Date.UTC(2026, 8, 1, 0, 6)).toISOString())
    } finally {
      s.cleanup()
    }
  }, 30_000)

  test('the transitions journal is bounded per run', () => {
    const s = open()
    try {
      const run = makeRun()
      s.runs.append(run)
      let tick = 0
      const flip = () => {
        const current = s.runs.get(run.id)!.state
        const next = current === 'working' ? 'awaiting_input' : 'working'
        s.runs.observe({
          runId: run.id,
          to: next,
          source: 'acp',
          observedAt: new Date(Date.UTC(2026, 8, 1, 0, tick++)).toISOString(),
        })
      }
      for (let i = 0; i < MAX_TRANSITIONS_PER_RUN + 10; i++) flip()
      expect(s.runs.transitions(run.id).length).toBeLessThanOrEqual(MAX_TRANSITIONS_PER_RUN)
      // The journal keeps the NEWEST observations.
      const transitions = s.runs.transitions(run.id)
      expect(transitions.at(-1)!.observedAt).toBe(
        new Date(Date.UTC(2026, 8, 1, 0, MAX_TRANSITIONS_PER_RUN + 9)).toISOString()
      )
    } finally {
      s.cleanup()
    }
  }, 30_000)

  test('records of another scope are invisible and never mutated', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-run-history-scope-'))
    try {
      const a = createRunHistoryStore({ dataDir, scope: SCOPE })
      const otherScope: Scope = { ...SCOPE, workspaceId: '00000000-0000-4000-8000-000000000077' }
      const b = createRunHistoryStore({ dataDir, scope: otherScope })
      const run = makeRun()
      a.append(run)
      expect(a.list()).toHaveLength(1)
      expect(b.list()).toHaveLength(0)
      expect(b.get(run.id)).toBeUndefined()
      expect(() =>
        b.observe({ runId: run.id, to: 'working', source: 'host', observedAt: 'x' })
      ).toThrow()
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
