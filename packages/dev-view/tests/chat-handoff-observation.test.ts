// Target-aware handoff observation, child-job controls, and truthful activity
// (#1177). A supplied session id, a running lead, or a retained claim never
// grants control; only an authenticated observation that binds session, task,
// generation, and owning intent/attempt together does.
import { describe, expect, test } from 'bun:test'

import type { RuntimeSession, Scope } from '@adea-ai/types/dev-runtime'
import {
  deriveDirectSessionHandoff,
  handoffActionReducer,
  initialHandoffActionState,
  resolveLeadCoordination,
  runHandoffActionOnce,
  type DirectSessionHandoffInput,
  type HandoffActionState,
  type HandoffLeadAgent,
  type HandoffLeadTurn,
} from '../src/chat/model/handoff'
import {
  bindTargetObservation,
  deriveChildJobRows,
  deriveHandoffActivity,
  type HandoffChildJob,
  type HandoffObservationExpectation,
  type HandoffTargetObservation,
} from '../src/chat/model/handoff-observation'

const SCOPE: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const INTENT = '00000000-0000-4000-8000-0000000000a1'
const ATTEMPT = 'dispatch_11111111111111111111111111111111'
const TASK = '00000000-0000-4000-8000-0000000000f1'

function session(overrides: Partial<RuntimeSession> = {}): RuntimeSession {
  return {
    id: 'session-1',
    scope: SCOPE,
    projectId: 'project-1',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    lifecycle: 'active',
    archived: false,
    projection: 'structured',
    generation: 3,
    version: 7,
    activeHarnessRunId: 'run-1',
    ...overrides,
  }
}

function observation(overrides: Partial<HandoffTargetObservation> = {}): HandoffTargetObservation {
  return {
    source: 'runtime_authenticated',
    sessionId: 'session-1',
    taskId: TASK,
    generation: 3,
    intentId: INTENT,
    attemptId: ATTEMPT,
    ...overrides,
  }
}

function leadTurn(overrides: Partial<HandoffLeadTurn> = {}): HandoffLeadTurn {
  return {
    intentId: INTENT,
    agentId: '00000000-0000-4000-8000-0000000000b2',
    dispatchId: ATTEMPT,
    state: 'running',
    canCancel: true,
    handoffTarget: { runtimeSessionId: 'session-1', taskId: TASK, observedGeneration: 3 },
    executionRuntimeSessionId: 'session-1',
    ...overrides,
  }
}

const AGENT: HandoffLeadAgent = {
  id: '00000000-0000-4000-8000-0000000000b2',
  isWorkspaceLead: true,
  lifecycleState: 'active',
}

const EXPECTED: HandoffObservationExpectation = {
  sessionId: 'session-1',
  taskId: TASK,
  generation: 3,
  intentId: INTENT,
  attemptId: ATTEMPT,
}

function job(overrides: Partial<HandoffChildJob> = {}): HandoffChildJob {
  return {
    jobId: 'job-1',
    label: 'Index the repository',
    state: 'running',
    descendantCount: 2,
    observation: observation(),
    ...overrides,
  }
}

function coordinated(
  overrides: Partial<DirectSessionHandoffInput> = {}
): DirectSessionHandoffInput {
  return {
    session: session(),
    mode: 'coordination_handoff',
    leadTurn: leadTurn({ targetObservation: observation() }),
    leadAgent: AGENT,
    leadMismatch: false,
    connected: true,
    generationCurrent: true,
    scopeAuthorized: true,
    hasUnsentDraft: false,
    awaitingApproval: false,
    ...overrides,
  }
}

describe('target observation binding', () => {
  test('binds only when session, task, generation, intent, and attempt all agree', () => {
    expect(bindTargetObservation(observation(), EXPECTED)).toEqual({ bound: true })
  })

  test.each([
    ['absent', undefined, 'absent'],
    [
      'a control-plane-style report',
      { ...observation(), source: 'control_plane' },
      'unauthenticated',
    ],
    ['another session', observation({ sessionId: 'session-2' }), 'session'],
    ['another task', observation({ taskId: 'task-other' }), 'task'],
    ['another generation', observation({ generation: 4 }), 'generation'],
    ['another intent', observation({ intentId: 'intent-other' }), 'intent'],
    ['another attempt', observation({ attemptId: 'attempt-other' }), 'attempt'],
  ] as const)('%s never binds and is named by code', (_name, value, code) => {
    const result = bindTargetObservation(value as HandoffTargetObservation | undefined, EXPECTED)
    expect(result.bound).toBe(false)
    if (!result.bound) {
      expect(result.code).toBe(code)
      expect(result.reason.length).toBeGreaterThan(10)
    }
  })

  test('a claim without a task or an undispatched attempt fails closed', () => {
    expect(bindTargetObservation(observation(), { ...EXPECTED, taskId: undefined })).toMatchObject({
      bound: false,
      code: 'task',
    })
    expect(
      bindTargetObservation(observation(), { ...EXPECTED, attemptId: undefined })
    ).toMatchObject({ bound: false, code: 'attempt' })
  })
})

describe('coordination only through the authenticated observation', () => {
  const live = { id: 'session-1', generation: 3 }

  test('a running lead with the claim and a same-session execution still does not coordinate', () => {
    const result = resolveLeadCoordination(leadTurn(), AGENT, live)
    expect(result.bound).toBe(false)
    expect(result.reason).toMatch(/no explicit target-bound execution observation/i)
  })

  test('the full authenticated observation establishes coordination', () => {
    expect(
      resolveLeadCoordination(leadTurn({ targetObservation: observation() }), AGENT, live)
    ).toEqual({ bound: true })
  })

  test('an observation bound to a different attempt names that proof instead', () => {
    const result = resolveLeadCoordination(
      leadTurn({ targetObservation: observation({ attemptId: 'attempt-other' }) }),
      AGENT,
      live
    )
    expect(result.bound).toBe(false)
    expect(result.reason).toMatch(/different attempt/i)
  })

  test('an independently observed newer generation does not coordinate a stale claim', () => {
    const result = resolveLeadCoordination(
      leadTurn({ targetObservation: observation({ generation: 4 }) }),
      AGENT,
      live
    )
    expect(result.bound).toBe(false)
    expect(result.reason).toMatch(/different generation/i)
  })
})

describe('child-job and descendant controls', () => {
  test('a bound job with a wired cancel path is cancellable, separately from the lead', () => {
    const rows = deriveChildJobRows({
      jobs: [job()],
      coordinationBound: true,
      expected: EXPECTED,
      cancelWired: true,
    })
    expect(rows[0]?.job.available).toBe(true)
    expect(rows[0]?.descendants.available).toBe(true)
  })

  test('without the control-plane cancel path every job control explains why', () => {
    const rows = deriveChildJobRows({
      jobs: [job()],
      coordinationBound: true,
      expected: EXPECTED,
      cancelWired: false,
    })
    expect(rows[0]?.job.available).toBe(false)
    expect(rows[0]?.job.reason).toMatch(/control-plane issue 935/i)
    expect(rows[0]?.descendants.available).toBe(false)
  })

  test('nothing is cancellable before coordination binds', () => {
    const rows = deriveChildJobRows({
      jobs: [job()],
      coordinationBound: false,
      expected: EXPECTED,
      cancelWired: true,
    })
    expect(rows[0]?.job.available).toBe(false)
    expect(rows[0]?.job.reason).toMatch(/authenticated observation/i)
  })

  test('a job observed under another attempt is never cancellable here', () => {
    const rows = deriveChildJobRows({
      jobs: [job({ observation: observation({ attemptId: 'attempt-other' }) })],
      coordinationBound: true,
      expected: EXPECTED,
      cancelWired: true,
    })
    expect(rows[0]?.job.available).toBe(false)
    expect(rows[0]?.job.reason).toMatch(/different attempt/i)
  })

  test('a pending cancel stays pending and cannot be requested twice', () => {
    const rows = deriveChildJobRows({
      jobs: [job({ state: 'cancel_pending' })],
      coordinationBound: true,
      expected: EXPECTED,
      cancelWired: true,
    })
    expect(rows[0]?.job.available).toBe(false)
    expect(rows[0]?.job.reason).toMatch(/pending until the runtime confirms/i)
  })

  test('terminal jobs and jobs without descendants name why', () => {
    const [done, leaf] = deriveChildJobRows({
      jobs: [job({ state: 'completed' }), job({ jobId: 'job-2', descendantCount: 0 })],
      coordinationBound: true,
      expected: EXPECTED,
      cancelWired: true,
    })
    expect(done?.job.reason).toMatch(/completed/)
    expect(leaf?.job.available).toBe(true)
    expect(leaf?.descendants).toMatchObject({ available: false })
    expect(leaf?.descendants.reason).toMatch(/no observed descendants/i)
  })
})

describe('derived handoff view', () => {
  test('an unobserved lead keeps lead and job controls apart and unavailable by default', () => {
    const view = deriveDirectSessionHandoff(
      coordinated({ leadTurn: leadTurn(), mode: 'attached', leadMismatch: true })
    )
    expect(view.holder).toBe('none')
    expect(view.childJobs).toEqual([])
    expect(view.controls.job_cancel.available).toBe(false)
  })

  test('a bound coordination holds the lead and lists child rows', () => {
    const view = deriveDirectSessionHandoff(
      coordinated({ childJobs: [job()], jobCancelWired: true })
    )
    expect(view.holder).toBe('lead')
    expect(view.controls.lead_stop.available).toBe(true)
    expect(view.controls.job_cancel.available).toBe(true)
    expect(view.childJobs).toHaveLength(1)
  })

  test('offline pauses job controls even when the observation binds', () => {
    const view = deriveDirectSessionHandoff(
      coordinated({ childJobs: [job()], jobCancelWired: true, connected: false })
    )
    expect(view.controls.job_cancel.available).toBe(false)
    expect(view.controls.job_cancel.reason).toMatch(/authenticated observation/i)
  })

  test('return-to-user names why the lead let go', () => {
    for (const state of ['completed', 'cancelled', 'failed', 'timed_out'] as const) {
      const view = deriveDirectSessionHandoff(
        coordinated({
          mode: 'returned_to_user',
          leadTurn: leadTurn({ state, canCancel: false, targetObservation: observation() }),
        })
      )
      expect(view.holder).toBe('user')
      expect(view.returnedReason).toBe(state === 'cancelled' ? 'cancelled' : state)
    }
  })

  test('reference and review hold nothing', () => {
    for (const mode of ['attached', 'one_time_review'] as const) {
      expect(
        deriveDirectSessionHandoff(coordinated({ mode, leadTurn: undefined, leadMismatch: false }))
          .holder
      ).toBe('none')
    }
  })
})

function ev(kind: string, seq: string) {
  return { kind: kind as never, seq, occurredAt: '2026-10-15T00:00:00.000Z' }
}

describe('activity is only what the retained window proves', () => {
  test('counts open approvals, files, subagents, and degraded capabilities', () => {
    const activity = deriveHandoffActivity({
      events: [
        ev('approval.requested', '1'),
        ev('approval.requested', '2'),
        ev('approval.resolved', '3'),
        ev('file.observed', '4'),
        ev('subagent.observed', '5'),
        ev('capability.degraded', '6'),
        ev('capability.degraded', '7'),
        ev('capability.restored', '8'),
      ],
      projection: 'structured',
      windowComplete: true,
    })
    expect(activity).toMatchObject({
      pendingApprovals: 1,
      filesObserved: 1,
      subagentsObserved: 1,
      degradedCapabilityEvents: 1,
      windowComplete: true,
      structured: true,
    })
    expect(activity.lastEvent).toMatchObject({ kind: 'capability.restored', seq: '8' })
  })

  test('an incomplete window and a terminal fallback never overclaim', () => {
    const activity = deriveHandoffActivity({
      events: [ev('approval.requested', '1')],
      projection: 'terminal_fallback',
      windowComplete: false,
    })
    expect(activity.pendingApprovals).toBe(0)
    expect(activity.structured).toBe(false)
    expect(activity.windowComplete).toBe(false)
  })

  test('an empty window reports no last event', () => {
    expect(
      deriveHandoffActivity({ events: [], projection: 'structured', windowComplete: true })
        .lastEvent
    ).toBeUndefined()
  })
})

describe('interrupted actions', () => {
  test('a failure with an unknown outcome is flagged, a refusal is not', async () => {
    let state: HandoffActionState = initialHandoffActionState
    const commit = (next: HandoffActionState) => {
      state = next
    }
    const transport = new Error('network lost')
    await runHandoffActionOnce({
      current: () => state,
      commit,
      action: 'handoff_to_lead',
      work: () => {
        throw transport
      },
      isUnknownOutcome: (error) => error === transport,
    })
    expect(state).toMatchObject({ status: 'error', outcomeUnknown: true })
    state = initialHandoffActionState
    await runHandoffActionOnce({
      current: () => state,
      commit,
      action: 'handoff_to_lead',
      work: () => {
        throw new Error('refused')
      },
    })
    expect(state.status).toBe('error')
    expect('outcomeUnknown' in state).toBe(false)
  })

  test('a second start while one is in flight is rejected without a second effect', async () => {
    let state: HandoffActionState = initialHandoffActionState
    let calls = 0
    const { promise: gate, resolve: release } = Promise.withResolvers<void>()
    const run = (action: 'lead_stop' | 'session_stop') =>
      runHandoffActionOnce({
        current: () => state,
        commit: (next) => {
          state = next
        },
        action,
        work: async () => {
          calls += 1
          await gate
        },
      })
    const first = run('lead_stop')
    // A simultaneous request for a different control is also rejected.
    expect(await run('session_stop')).toBe('rejected')
    expect(await run('lead_stop')).toBe('rejected')
    release()
    expect(await first).toBe('completed')
    expect(calls).toBe(1)
    expect(handoffActionReducer(state, { type: 'succeed' })).toEqual({ status: 'idle' })
  })
})
