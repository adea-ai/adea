// Direct-session handoff model (#1177): distinct attachment, one-time review,
// explicit coordination handoff, and return-to-user states over one preserved
// RuntimeSession/transcript/harness/execution location.
import { describe, expect, test } from 'bun:test'

import type { HarnessRun, RuntimeSession, Scope } from '@adea-ai/types/dev-runtime'
import {
  deriveDirectSessionHandoff,
  deriveHandoffModeForSurface,
  handoffActionReducer,
  handoffControlReasonId,
  HANDOFF_MODE_LABELS,
  initialHandoffActionState,
  resolveHarnessRunBinding,
  runHandoffActionOnce,
  type DirectSessionHandoffInput,
  type HandoffActionKind,
  type HandoffActionState,
  type HandoffControlKind,
} from '../src/chat/model/handoff'

const SCOPE: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}

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

function run(overrides: Partial<HarnessRun> = {}): HarnessRun {
  return {
    id: 'run-1',
    scope: SCOPE,
    runtimeSessionId: 'session-1',
    installationId: 'inst-1',
    agentProfile: {
      id: 'profile-1',
      version: 1,
      displayName: 'profile-1',
      capabilityPolicyVersion: 1,
    },
    state: 'working',
    generation: 3,
    version: 1,
    ...overrides,
  }
}

function input(overrides: Partial<DirectSessionHandoffInput> = {}): DirectSessionHandoffInput {
  return {
    session: session(),
    activeHarnessRun: run(),
    mode: 'attached',
    connected: true,
    generationCurrent: true,
    scopeAuthorized: true,
    hasUnsentDraft: false,
    controlConflict: false,
    awaitingApproval: false,
    ...overrides,
  }
}

describe('direct-session handoff modes', () => {
  test('the four modes render distinctly and never mint a second session', () => {
    const modes = [
      'attached',
      'one_time_review',
      'coordination_handoff',
      'returned_to_user',
    ] as const
    const labels = new Set(modes.map((mode) => HANDOFF_MODE_LABELS[mode].label))
    expect(labels.size).toBe(4)
    for (const mode of modes) {
      const view = deriveDirectSessionHandoff(input({ mode }))
      expect(view.mode).toBe(mode)
      expect(view.preserves.runtimeSessionId).toBe('session-1')
      expect(view.preserves.generation).toBe(3)
      expect(view.preserves.harnessRunId).toBe('run-1')
      expect(view.preserves.worktreeId).toBe('worktree-1')
      expect(view.preserves.projectId).toBe('project-1')
    }
  })

  test('read-only attachment grants no control', () => {
    const view = deriveDirectSessionHandoff(input({ mode: 'attached' }))
    expect(view.controls.lead_stop.available).toBe(false)
    expect(view.controls.job_cancel.available).toBe(false)
    expect(view.controls.descendant_cancel.available).toBe(false)
  })

  test('coordination handoff keeps truthful lead/job/descendant separation', () => {
    const view = deriveDirectSessionHandoff(input({ mode: 'coordination_handoff' }))
    // Lead-stop maps to the existing bound harness control; job and
    // descendant cancellation require the absent Control Plane contract.
    expect(view.controls.lead_stop.available).toBe(true)
    expect(view.controls.job_cancel.available).toBe(false)
    expect(view.controls.job_cancel.reason).toMatch(/control-plane/i)
    expect(view.controls.descendant_cancel.available).toBe(false)
    expect(view.controls.descendant_cancel.reason).toMatch(/control-plane/i)
  })

  test('offline disables controls without silent fallback and preserves the draft', () => {
    const view = deriveDirectSessionHandoff(
      input({ mode: 'coordination_handoff', connected: false, hasUnsentDraft: true })
    )
    expect(view.reconnectRequired).toBe(true)
    expect(view.draftPreserved).toBe(true)
    expect(view.controls.lead_stop.available).toBe(false)
    expect(view.controls.lead_stop.reason).toMatch(/offline|reconnect/i)
    expect(view.notice).toMatch(/reconnect/i)
  })

  test('stale generation and control conflicts block without fallback', () => {
    const stale = deriveDirectSessionHandoff(
      input({ mode: 'coordination_handoff', generationCurrent: false })
    )
    expect(stale.controls.lead_stop.available).toBe(false)
    expect(stale.controls.lead_stop.reason).toMatch(/generation|resync/i)

    const conflict = deriveDirectSessionHandoff(
      input({ mode: 'coordination_handoff', controlConflict: true })
    )
    expect(conflict.controls.lead_stop.available).toBe(false)
    expect(conflict.controls.lead_stop.reason).toMatch(/conflict/i)
  })

  test('scope mismatch preserves worktree/project authority', () => {
    const view = deriveDirectSessionHandoff(
      input({ mode: 'coordination_handoff', scopeAuthorized: false })
    )
    expect(view.controls.lead_stop.available).toBe(false)
    expect(view.preserves.worktreeId).toBe('worktree-1')
    expect(view.preserves.projectId).toBe('project-1')
  })

  test('return-to-user preserves the unsent draft', () => {
    const view = deriveDirectSessionHandoff(
      input({ mode: 'returned_to_user', hasUnsentDraft: true })
    )
    expect(view.draftPreserved).toBe(true)
    expect(view.mode).toBe('returned_to_user')
  })
})

function coordinated(
  overrides: Partial<DirectSessionHandoffInput> = {}
): DirectSessionHandoffInput {
  return input({ mode: 'coordination_handoff', ...overrides })
}

describe('harness-run binding', () => {
  test('a run bound by register id, session, and scope authorizes lead-stop', () => {
    const view = deriveDirectSessionHandoff(input({ mode: 'coordination_handoff' }))
    expect(view.binding).toBe('bound')
    expect(view.controls.lead_stop.available).toBe(true)
    expect(view.preserves.harnessRunId).toBe('run-1')
  })

  test('a run from another session is a mismatch and never steals control', () => {
    const foreign = run({ runtimeSessionId: 'session-2' })
    expect(resolveHarnessRunBinding(session(), foreign).status).toBe('mismatch')
    const view = deriveDirectSessionHandoff(
      input({ mode: 'coordination_handoff', activeHarnessRun: foreign })
    )
    expect(view.binding).toBe('mismatch')
    expect(view.controls.lead_stop.available).toBe(false)
    expect(view.controls.lead_stop.reason).toMatch(/another session or scope/i)
    // The register binding is still preserved, not replaced by the foreign run.
    expect(view.preserves.harnessRunId).toBe('run-1')
  })

  test('a run from another scope is a mismatch', () => {
    const otherScope = run({
      scope: {
        accountId: '00000000-0000-4000-8000-000000000009',
        workspaceId: SCOPE.workspaceId,
        runtimeNodeId: SCOPE.runtimeNodeId,
      },
    })
    expect(resolveHarnessRunBinding(session(), otherScope).status).toBe('mismatch')
  })

  test('a superseded run id is stale', () => {
    const old = run({ id: 'run-0' })
    expect(resolveHarnessRunBinding(session(), old).status).toBe('stale')
    const view = deriveDirectSessionHandoff(
      input({ mode: 'coordination_handoff', activeHarnessRun: old })
    )
    expect(view.binding).toBe('stale')
    expect(view.controls.lead_stop.available).toBe(false)
    expect(view.controls.lead_stop.reason).toMatch(/superseded/i)
    expect(view.preserves.harnessRunId).toBe('run-1')
  })

  test.each(['completed', 'failed', 'cancelled', 'disconnected'] as const)(
    'a %s run names its terminal state instead of offering a stop',
    (state) => {
      const view = deriveDirectSessionHandoff(
        input({ mode: 'coordination_handoff', activeHarnessRun: run({ state }) })
      )
      expect(view.binding).toBe('terminal')
      expect(view.controls.lead_stop.available).toBe(false)
      expect(view.controls.lead_stop.reason).toMatch(new RegExp(state))
      expect(view.controls.lead_stop.remediation).toMatch(/resume/i)
    }
  )

  test('a run from an older session generation still binds: transfers do not replace runs', () => {
    // transferInput bumps the session generation without touching the run.
    const view = deriveDirectSessionHandoff(
      input({
        mode: 'coordination_handoff',
        session: session({ generation: 5 }),
        activeHarnessRun: run({ generation: 3 }),
      })
    )
    expect(view.binding).toBe('bound')
    expect(view.controls.lead_stop.available).toBe(true)
  })

  test('register id without run facts authorizes like cancelHarness; nothing authorizes nothing', () => {
    const registered = deriveDirectSessionHandoff(
      input({ mode: 'coordination_handoff', activeHarnessRun: undefined })
    )
    expect(registered.binding).toBe('registered')
    expect(registered.controls.lead_stop.available).toBe(true)

    const absent = deriveDirectSessionHandoff(
      input({
        mode: 'coordination_handoff',
        session: session({ activeHarnessRunId: undefined }),
        activeHarnessRun: undefined,
      })
    )
    expect(absent.binding).toBe('absent')
    expect(absent.preserves.harnessRunId).toBeUndefined()
    expect(absent.controls.lead_stop.available).toBe(false)
    expect(absent.controls.lead_stop.remediation).toMatch(/launch/i)
  })
})

describe('return-to-user guards', () => {
  test('available only while coordinating with input held elsewhere', () => {
    const view = deriveDirectSessionHandoff(coordinated())
    expect(view.controls.return_to_user.available).toBe(true)
  })

  test('read-only modes and already-returned states stay unavailable', () => {
    for (const mode of ['attached', 'one_time_review'] as const) {
      const view = deriveDirectSessionHandoff(input({ mode }))
      expect(view.controls.return_to_user.available).toBe(false)
    }
    const returned = deriveDirectSessionHandoff(input({ mode: 'returned_to_user' }))
    expect(returned.controls.return_to_user.available).toBe(false)
    expect(returned.controls.return_to_user.reason).toMatch(/already/i)
  })

  test('an already-returned session needs no transfer', () => {
    const view = deriveDirectSessionHandoff(input({ mode: 'returned_to_user' }))
    expect(view.controls.return_to_user.available).toBe(false)
    expect(view.controls.return_to_user.reason).toMatch(/already user-held/i)
  })

  test('offline, stale, conflict, scope, and archived each block with a remedy', () => {
    const cases = [
      coordinated({ connected: false }),
      coordinated({ generationCurrent: false }),
      coordinated({ controlConflict: true }),
      coordinated({ scopeAuthorized: false }),
      coordinated({ session: session({ archived: true }) }),
    ] as const
    for (const candidate of cases) {
      const view = deriveDirectSessionHandoff(candidate)
      const control = view.controls.return_to_user
      expect(control.available).toBe(false)
      expect(typeof control.reason === 'string' && control.reason.length > 0).toBe(true)
      expect(typeof control.remediation === 'string' && control.remediation.length > 0).toBe(true)
      expect(typeof view.notice === 'string' && view.notice.length > 0).toBe(true)
    }
  })
})

describe('assistive-technology content contract', () => {
  const modes = ['attached', 'one_time_review', 'coordination_handoff', 'returned_to_user'] as const

  test('every mode carries a nonblank label and description', () => {
    for (const mode of modes) {
      expect(HANDOFF_MODE_LABELS[mode].label.length).toBeGreaterThan(0)
      expect(HANDOFF_MODE_LABELS[mode].description.length).toBeGreaterThan(0)
    }
  })

  test('every unavailable control names its reason and remedy', () => {
    const blockedInputs: readonly DirectSessionHandoffInput[] = [
      input({ mode: 'attached' }),
      input({ mode: 'one_time_review' }),
      input({ mode: 'coordination_handoff', connected: false }),
      input({ mode: 'coordination_handoff', generationCurrent: false }),
      input({ mode: 'coordination_handoff', controlConflict: true }),
      input({ mode: 'coordination_handoff', scopeAuthorized: false }),
      input({
        mode: 'coordination_handoff',
        session: session({ archived: true }),
      }),
      input({
        mode: 'coordination_handoff',
        session: session({ activeHarnessRunId: undefined }),
        activeHarnessRun: undefined,
      }),
      input({
        mode: 'coordination_handoff',
        activeHarnessRun: run({ state: 'completed' }),
      }),
    ]
    const kinds: readonly HandoffControlKind[] = [
      'lead_stop',
      'handoff_to_lead',
      'job_cancel',
      'descendant_cancel',
      'return_to_user',
    ]
    for (const candidate of blockedInputs) {
      const view = deriveDirectSessionHandoff(candidate)
      for (const kind of kinds) {
        const control = view.controls[kind]
        if (!control.available) {
          expect(typeof control.reason === 'string' && control.reason.length > 0).toBe(true)
          expect(typeof control.remediation === 'string' && control.remediation.length > 0).toBe(
            true
          )
        }
      }
    }
  })

  test('a notice accompanies every transport or authority block', () => {
    const blockedInputs = [
      input({ mode: 'coordination_handoff', connected: false }),
      input({ mode: 'coordination_handoff', generationCurrent: false }),
      input({ mode: 'coordination_handoff', controlConflict: true }),
      input({ mode: 'coordination_handoff', scopeAuthorized: false }),
    ]
    for (const candidate of blockedInputs) {
      expect(deriveDirectSessionHandoff(candidate).notice?.length ?? 0).toBeGreaterThan(0)
    }
  })

  test('reason-element ids are deterministic and unique per row', () => {
    const kinds: readonly HandoffControlKind[] = [
      'lead_stop',
      'handoff_to_lead',
      'job_cancel',
      'descendant_cancel',
      'return_to_user',
    ]
    const ids = new Set([
      ...kinds.map((kind) => handoffControlReasonId('handoff-1', kind)),
      handoffControlReasonId('handoff-1', 'notice'),
    ])
    expect(ids.size).toBe(6)
    for (const id of ids) expect(id.startsWith('handoff-1-')).toBe(true)
    expect(handoffControlReasonId('handoff-2', 'lead_stop')).not.toBe(
      handoffControlReasonId('handoff-1', 'lead_stop')
    )
  })
})

describe('coordination-action machine', () => {
  test('busy runs to idle on success', () => {
    const busy = handoffActionReducer(initialHandoffActionState, {
      type: 'start',
      action: 'return_to_user',
    })
    expect(busy).toEqual({ status: 'busy', action: 'return_to_user' })
    expect(handoffActionReducer(busy, { type: 'succeed' })).toEqual({ status: 'idle' })
  })

  test('a second start while busy is ignored: no double-submit', () => {
    const busy = handoffActionReducer(initialHandoffActionState, {
      type: 'start',
      action: 'lead_stop',
    })
    expect(handoffActionReducer(busy, { type: 'start', action: 'return_to_user' })).toBe(busy)
  })

  test('failure parks the message for an explicit retry', () => {
    const busy = handoffActionReducer(initialHandoffActionState, {
      type: 'start',
      action: 'return_to_user',
    })
    const failed = handoffActionReducer(busy, {
      type: 'fail',
      action: 'return_to_user',
      message: 'stale_version: input owner version conflict',
    })
    expect(failed.status).toBe('error')
    const retried = handoffActionReducer(failed, { type: 'start', action: 'return_to_user' })
    expect(retried).toEqual({ status: 'busy', action: 'return_to_user' })
    expect(handoffActionReducer(retried, { type: 'succeed' })).toEqual({ status: 'idle' })
  })

  test('a foreign failure never clobbers the busy action', () => {
    const busy = handoffActionReducer(initialHandoffActionState, {
      type: 'start',
      action: 'lead_stop',
    })
    expect(
      handoffActionReducer(busy, { type: 'fail', action: 'return_to_user', message: 'x' })
    ).toBe(busy)
  })
})

function handoffMachine() {
  let state: HandoffActionState = initialHandoffActionState
  const committed: HandoffActionState[] = []
  return {
    current: () => state,
    commit: (next: HandoffActionState) => {
      committed.push(next)
      state = next
    },
    committed,
  }
}

function deferredGate() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('production action admission', () => {
  test('concurrent starts admit once: the second never invokes work', async () => {
    const harness = handoffMachine()
    let workCalls = 0
    const gate = deferredGate()
    const first = runHandoffActionOnce({
      ...harness,
      action: 'return_to_user',
      work: () => {
        workCalls += 1
        return gate.promise
      },
    })
    const second = runHandoffActionOnce({
      ...harness,
      action: 'return_to_user',
      work: () => {
        workCalls += 1
        return Promise.resolve()
      },
    })
    gate.resolve()
    await expect(first).resolves.toBe('completed')
    await expect(second).resolves.toBe('rejected')
    expect(workCalls).toBe(1)
    expect(harness.committed).toEqual([
      { status: 'busy', action: 'return_to_user' },
      { status: 'idle' },
    ])
  })

  test('failure parks the message and reports conflicts', async () => {
    const harness = handoffMachine()
    let conflicted = 0
    let succeeded = 0
    const outcome = await runHandoffActionOnce({
      ...harness,
      action: 'return_to_user',
      work: () => Promise.reject(new Error('stale_version: input owner version conflict')),
      isConflict: (error) => error instanceof Error && error.message.startsWith('stale_version'),
      onConflict: () => {
        conflicted += 1
      },
      onSuccess: () => {
        succeeded += 1
      },
    })
    expect(outcome).toBe('completed')
    expect(conflicted).toBe(1)
    expect(succeeded).toBe(0)
    expect(harness.current()).toEqual({
      status: 'error',
      action: 'return_to_user',
      message: 'stale_version: input owner version conflict',
    })
  })

  test('a late completion after navigation commits nothing', async () => {
    const harness = handoffMachine()
    let currentSession = 'session-1'
    let succeeded = 0
    const gate = deferredGate()
    const pending = runHandoffActionOnce({
      ...harness,
      action: 'return_to_user',
      work: () => gate.promise,
      isCurrent: () => currentSession === 'session-1',
      onSuccess: () => {
        succeeded += 1
      },
    })
    currentSession = 'session-2'
    gate.resolve()
    await expect(pending).resolves.toBe('superseded')
    expect(succeeded).toBe(0)
    expect(harness.committed).toEqual([{ status: 'busy', action: 'return_to_user' }])
  })

  test('a late failure after navigation commits nothing', async () => {
    const harness = handoffMachine()
    let conflicted = 0
    let currentSession = 'session-1'
    const gate = deferredGate()
    const pending = runHandoffActionOnce({
      ...harness,
      action: 'lead_stop',
      work: () => gate.promise,
      isCurrent: () => currentSession === 'session-1',
      isConflict: () => true,
      onConflict: () => {
        conflicted += 1
      },
    })
    currentSession = 'session-2'
    gate.reject(new Error('stale_generation: runtime session generation conflict'))
    await expect(pending).resolves.toBe('superseded')
    expect(conflicted).toBe(0)
    expect(harness.committed).toEqual([{ status: 'busy', action: 'lead_stop' }])
  })

  test('non-error rejections surface a stable message', async () => {
    const harness = handoffMachine()
    const action: HandoffActionKind = 'lead_stop'
    const outcome = await runHandoffActionOnce({
      ...harness,
      action,
      work: () => Promise.reject('transport lost'),
    })
    expect(outcome).toBe('completed')
    expect(harness.current()).toEqual({
      status: 'error',
      action,
      message: 'Handoff action failed.',
    })
  })
})

describe('handoff-to-lead action', () => {
  test('attached sessions offer an explicit handoff establishing coordination', () => {
    const view = deriveDirectSessionHandoff(input({ mode: 'attached' }))
    expect(view.controls.handoff_to_lead.available).toBe(true)
    expect(view.controls.return_to_user.available).toBe(false)
    expect(view.controls.lead_stop.available).toBe(false)
  })

  test('an active handoff needs no second handoff; a return may re-hand off', () => {
    const active = deriveDirectSessionHandoff(input({ mode: 'coordination_handoff' }))
    expect(active.controls.handoff_to_lead.available).toBe(false)
    expect(active.controls.handoff_to_lead.reason).toMatch(/already handed off/i)
    const returned = deriveDirectSessionHandoff(input({ mode: 'returned_to_user' }))
    expect(returned.controls.handoff_to_lead.available).toBe(true)
  })

  test('read-only review never offers handoff, and transport gates apply', () => {
    const review = deriveDirectSessionHandoff(input({ mode: 'one_time_review' }))
    expect(review.controls.handoff_to_lead.available).toBe(false)
    for (const candidate of [
      input({ mode: 'attached', connected: false }),
      input({ mode: 'attached', generationCurrent: false }),
      input({ mode: 'attached', controlConflict: true }),
      input({ mode: 'attached', scopeAuthorized: false }),
      input({ mode: 'attached', session: session({ archived: true }) }),
    ]) {
      const view = deriveDirectSessionHandoff(candidate)
      const control = view.controls.handoff_to_lead
      expect(control.available).toBe(false)
      expect(typeof control.reason === 'string' && control.reason.length > 0).toBe(true)
      expect(typeof control.remediation === 'string' && control.remediation.length > 0).toBe(true)
    }
  })
})

describe('receipt currency', () => {
  const base = {
    lifecycle: 'active',
    archived: false,
    connected: true,
    generationCurrent: true,
  } as const

  test('a current receipt enters the coordinating mode of its direction', () => {
    expect(
      deriveHandoffModeForSurface({
        ...base,
        receipt: { sessionId: 's', fromView: 'chat', toView: 'dev', generation: 4 },
        sessionId: 's',
        sessionGeneration: 4,
      })
    ).toBe('coordination_handoff')
    expect(
      deriveHandoffModeForSurface({
        ...base,
        receipt: { sessionId: 's', fromView: 'dev', toView: 'chat', generation: 4 },
        sessionId: 's',
        sessionGeneration: 4,
      })
    ).toBe('returned_to_user')
  })

  test('a receipt newer than the props is our unobserved commit: it applies', () => {
    expect(
      deriveHandoffModeForSurface({
        ...base,
        receipt: { sessionId: 's', fromView: 'dev', toView: 'chat', generation: 5 },
        sessionId: 's',
        sessionGeneration: 4,
      })
    ).toBe('returned_to_user')
  })

  test('a receipt behind canonical ownership is superseded and never overwrites', () => {
    expect(
      deriveHandoffModeForSurface({
        ...base,
        receipt: { sessionId: 's', fromView: 'dev', toView: 'chat', generation: 4 },
        sessionId: 's',
        sessionGeneration: 6,
      })
    ).toBe('attached')
    expect(
      deriveHandoffModeForSurface({
        ...base,
        receipt: { sessionId: 'other', fromView: 'dev', toView: 'chat', generation: 6 },
        sessionId: 's',
        sessionGeneration: 6,
      })
    ).toBe('attached')
  })

  test('no receipt means attachment even with a bound run: runs prove execution, not handoff', () => {
    expect(
      deriveHandoffModeForSurface({
        ...base,
        receipt: undefined,
        sessionId: 's',
        sessionGeneration: 3,
      })
    ).toBe('attached')
  })
})
