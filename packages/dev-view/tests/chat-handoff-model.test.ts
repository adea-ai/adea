// Direct-session handoff model (#1177): distinct attachment, one-time review,
// explicit coordination handoff, and return-to-user states over one preserved
// RuntimeSession/transcript/harness/execution location, driven only by
// observed canonical lead-turn facts — never invented.
import { describe, expect, test } from 'bun:test'

import type { HarnessRun, RuntimeSession, Scope } from '@adea-ai/types/dev-runtime'
import {
  deriveDirectSessionHandoff,
  deriveHandoffModeForSurface,
  hasOpenApproval,
  resolveLeadClaim,
  resolveLeadCoordination,
  handoffActionReducer,
  handoffControlReasonId,
  leadTurnCoordination,
  HANDOFF_MODE_LABELS,
  initialHandoffActionState,
  resolveHarnessRunBinding,
  runHandoffActionOnce,
  type DirectSessionHandoffInput,
  type HandoffActionKind,
  type HandoffActionState,
  type HandoffControlKind,
  type HandoffLeadAgent,
  type HandoffLeadTurn,
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

function leadTurn(overrides: Partial<HandoffLeadTurn> = {}): HandoffLeadTurn {
  return {
    intentId: '00000000-0000-4000-8000-0000000000a1',
    agentId: '00000000-0000-4000-8000-0000000000b2',
    dispatchId: 'dispatch_11111111111111111111111111111111',
    state: 'running',
    canCancel: true,
    handoffTarget: {
      runtimeSessionId: 'session-1',
      taskId: '00000000-0000-4000-8000-0000000000f1',
      observedGeneration: 3,
    },
    observedRuntimeSessionId: 'session-1',
    ...overrides,
  }
}

function leadAgent(overrides: Partial<HandoffLeadAgent> = {}): HandoffLeadAgent {
  return {
    id: '00000000-0000-4000-8000-0000000000b2',
    isWorkspaceLead: true,
    lifecycleState: 'active',
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
    awaitingApproval: false,
    ...overrides,
  }
}

function coordinated(
  overrides: Partial<DirectSessionHandoffInput> = {}
): DirectSessionHandoffInput {
  return input({
    mode: 'coordination_handoff',
    leadTurn: leadTurn(),
    leadAgent: leadAgent(),
    leadMismatch: false,
    ...overrides,
  })
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

  test('attachment without lead facts grants no lead control and names the gap', () => {
    const view = deriveDirectSessionHandoff(input({ mode: 'attached' }))
    expect(view.controls.lead_stop.available).toBe(false)
    expect(view.controls.lead_stop.reason).toMatch(/no lead turn is bound/i)
    expect(view.controls.lead_stop.remediation).toMatch(/control-plane#933/i)
    expect(view.controls.job_cancel.available).toBe(false)
    expect(view.controls.descendant_cancel.available).toBe(false)
    expect(view.coordination).toBeUndefined()
  })

  test('an observed live turn coordinates and authorizes lead-stop, never session-stop', () => {
    const view = deriveDirectSessionHandoff(coordinated())
    expect(view.mode).toBe('coordination_handoff')
    expect(view.controls.lead_stop.available).toBe(true)
    expect(view.controls.session_stop.available).toBe(true)
    expect(view.coordination).toMatchObject({
      intentId: '00000000-0000-4000-8000-0000000000a1',
      state: 'running',
    })
    // Lead and session cancellation stay distinct authorities.
    expect(view.controls.job_cancel.available).toBe(false)
    expect(view.controls.job_cancel.reason).toMatch(/control-plane/i)
    expect(view.controls.descendant_cancel.available).toBe(false)
  })

  test('a turn that cannot cancel blocks lead-stop without touching session-stop', () => {
    const view = deriveDirectSessionHandoff(
      coordinated({ leadTurn: leadTurn({ canCancel: false }) })
    )
    expect(view.controls.lead_stop.available).toBe(false)
    expect(view.controls.lead_stop.reason).toMatch(/cannot accept cancellation/i)
    expect(view.controls.session_stop.available).toBe(true)
  })

  test('offline disables controls without silent fallback and preserves the draft', () => {
    const view = deriveDirectSessionHandoff(coordinated({ connected: false, hasUnsentDraft: true }))
    expect(view.reconnectRequired).toBe(true)
    expect(view.draftPreserved).toBe(true)
    expect(view.controls.lead_stop.available).toBe(false)
    expect(view.controls.lead_stop.reason).toMatch(/offline|reconnect/i)
    expect(view.controls.session_stop.available).toBe(false)
    expect(view.notice).toMatch(/reconnect/i)
  })

  test('stale generation blocks without fallback', () => {
    const stale = deriveDirectSessionHandoff(coordinated({ generationCurrent: false }))
    expect(stale.controls.lead_stop.available).toBe(false)
    expect(stale.controls.lead_stop.reason).toMatch(/generation|resync/i)
    expect(stale.controls.session_stop.available).toBe(false)
  })

  test('scope mismatch preserves worktree/project authority', () => {
    const view = deriveDirectSessionHandoff(coordinated({ scopeAuthorized: false }))
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

describe('lead-turn mode derivation', () => {
  const live = {
    lifecycle: 'active',
    archived: false,
    connected: true,
    generationCurrent: true,
  } as const

  test('retained coordination decides the mode; nothing asserted attaches', () => {
    expect(deriveHandoffModeForSurface({ ...live, coordination: 'lead' })).toBe(
      'coordination_handoff'
    )
    expect(deriveHandoffModeForSurface({ ...live, coordination: 'user' })).toBe('returned_to_user')
    expect(deriveHandoffModeForSurface({ ...live, coordination: undefined })).toBe('attached')
  })

  test('leadTurnCoordination maps bound states; blocked and unknown assert nothing', () => {
    for (const state of [
      'prepared',
      'dispatch_pending',
      'starting',
      'running',
      'awaiting_input',
      'cancelling',
    ] as const) {
      expect(leadTurnCoordination(leadTurn({ state }))).toBe('lead')
    }
    for (const state of ['completed', 'failed', 'cancelled', 'timed_out'] as const) {
      expect(leadTurnCoordination(leadTurn({ state }))).toBe('user')
    }
    expect(leadTurnCoordination(leadTurn({ state: 'blocked' }))).toBeUndefined()
    expect(leadTurnCoordination(leadTurn({ state: 'unknown' }))).toBeUndefined()
  })

  test('a blocked turn names its refusal instead of coordinating silently', () => {
    const view = deriveDirectSessionHandoff(
      input({
        mode: 'attached',
        leadTurn: leadTurn({ state: 'blocked', reasonCode: 'ADMISSION_SERVICE_UNAVAILABLE' }),
        leadAgent: leadAgent(),
        leadMismatch: false,
      })
    )
    expect(view.mode).toBe('attached')
    expect(view.notice).toMatch(/ADMISSION_SERVICE_UNAVAILABLE/)
    expect(view.controls.lead_stop.available).toBe(false)
  })
})

describe('harness-run binding', () => {
  test('a run bound by register id, session, and scope authorizes session-stop', () => {
    const view = deriveDirectSessionHandoff(coordinated())
    expect(view.binding).toBe('bound')
    expect(view.controls.session_stop.available).toBe(true)
    expect(view.preserves.harnessRunId).toBe('run-1')
  })

  test('a run from another session is a mismatch and never steals control', () => {
    const foreign = run({ runtimeSessionId: 'session-2' })
    expect(resolveHarnessRunBinding(session(), foreign).status).toBe('mismatch')
    const view = deriveDirectSessionHandoff(coordinated({ activeHarnessRun: foreign }))
    expect(view.binding).toBe('mismatch')
    expect(view.controls.session_stop.available).toBe(false)
    expect(view.controls.session_stop.reason).toMatch(/another session or scope/i)
    // The register binding is still preserved, not replaced by the foreign run.
    expect(view.preserves.harnessRunId).toBe('run-1')
    // Lead-stop (bound to the observed turn, not the run) is unaffected.
    expect(view.controls.lead_stop.available).toBe(true)
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

  test('a superseded run id is stale: replacement never inherits the old candidate', () => {
    const old = run({ id: 'run-0' })
    expect(resolveHarnessRunBinding(session(), old).status).toBe('stale')
    const view = deriveDirectSessionHandoff(coordinated({ activeHarnessRun: old }))
    expect(view.binding).toBe('stale')
    expect(view.controls.session_stop.available).toBe(false)
    expect(view.controls.session_stop.reason).toMatch(/superseded/i)
    expect(view.preserves.harnessRunId).toBe('run-1')
  })

  test.each(['completed', 'failed', 'cancelled', 'disconnected'] as const)(
    'a %s run names its terminal state instead of offering a stop',
    (state) => {
      const view = deriveDirectSessionHandoff(coordinated({ activeHarnessRun: run({ state }) }))
      expect(view.binding).toBe('terminal')
      expect(view.controls.session_stop.available).toBe(false)
      expect(view.controls.session_stop.reason).toMatch(new RegExp(state))
      expect(view.controls.session_stop.remediation).toMatch(/resume/i)
    }
  )

  test('a run from an older session generation still binds: coordination transfers bump the session without replacing the run', () => {
    const view = deriveDirectSessionHandoff(
      coordinated({
        session: session({ generation: 5 }),
        activeHarnessRun: run({ generation: 3 }),
      })
    )
    expect(view.binding).toBe('bound')
    expect(view.controls.session_stop.available).toBe(true)
  })

  test('register id without run facts authorizes like cancelHarness; nothing authorizes nothing', () => {
    const registered = deriveDirectSessionHandoff(coordinated({ activeHarnessRun: undefined }))
    expect(registered.binding).toBe('registered')
    expect(registered.controls.session_stop.available).toBe(true)

    const absent = deriveDirectSessionHandoff(
      coordinated({
        session: session({ activeHarnessRunId: undefined }),
        activeHarnessRun: undefined,
      })
    )
    expect(absent.binding).toBe('absent')
    expect(absent.preserves.harnessRunId).toBeUndefined()
    expect(absent.controls.session_stop.available).toBe(false)
    expect(absent.controls.session_stop.remediation).toMatch(/launch/i)
  })
})

describe('session-side handoff availability', () => {
  test('handoff needs an attached or returned session with a linked channel', () => {
    const noChannel = deriveDirectSessionHandoff(input({ mode: 'attached' }))
    expect(noChannel.controls.handoff_to_lead.available).toBe(false)
    expect(noChannel.controls.handoff_to_lead.reason).toMatch(/no lead channel/i)
    const linked = deriveDirectSessionHandoff(
      input({ mode: 'attached', leadChannelId: 'channel-1' })
    )
    expect(linked.controls.handoff_to_lead.available).toBe(true)
    const handedOff = deriveDirectSessionHandoff(
      input({ mode: 'coordination_handoff', leadChannelId: 'channel-1' })
    )
    expect(handedOff.controls.handoff_to_lead.available).toBe(false)
  })

  test('job and descendant rows fail closed with the integration gap in every mode', () => {
    for (const mode of [
      'attached',
      'one_time_review',
      'coordination_handoff',
      'returned_to_user',
    ] as const) {
      const view = deriveDirectSessionHandoff(
        mode === 'attached' || mode === 'one_time_review'
          ? input({ mode })
          : coordinated(mode === 'returned_to_user' ? { mode } : {})
      )
      for (const kind of ['job_cancel', 'descendant_cancel'] as const) {
        const control = view.controls[kind]
        expect(control.available).toBe(false)
        expect(control.reason ?? '').toMatch(/control-plane/i)
      }
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
      coordinated({ connected: false }),
      coordinated({ generationCurrent: false }),
      coordinated({ scopeAuthorized: false }),
      coordinated({
        session: session({ archived: true }),
      }),
      coordinated({
        session: session({ activeHarnessRunId: undefined }),
        activeHarnessRun: undefined,
      }),
      coordinated({
        activeHarnessRun: run({ state: 'completed' }),
      }),
      coordinated({ leadTurn: leadTurn({ canCancel: false }) }),
    ]
    const kinds: readonly HandoffControlKind[] = [
      'lead_stop',
      'session_stop',
      'handoff_to_lead',
      'job_cancel',
      'descendant_cancel',
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
      coordinated({ connected: false }),
      coordinated({ generationCurrent: false }),
      coordinated({ scopeAuthorized: false }),
      input({
        mode: 'attached',
        leadTurn: leadTurn({ state: 'blocked', reasonCode: 'FUNDING_CONFIRMATION_REQUIRED' }),
      }),
    ]
    for (const candidate of blockedInputs) {
      expect(deriveDirectSessionHandoff(candidate).notice?.length ?? 0).toBeGreaterThan(0)
    }
  })

  test('reason-element ids are deterministic and unique per row', () => {
    const kinds: readonly HandoffControlKind[] = [
      'lead_stop',
      'session_stop',
      'handoff_to_lead',
      'job_cancel',
      'descendant_cancel',
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
      action: 'session_stop',
    })
    expect(busy).toEqual({ status: 'busy', action: 'session_stop' })
    expect(handoffActionReducer(busy, { type: 'succeed' })).toEqual({ status: 'idle' })
  })

  test('a second start while busy is ignored: no double-submit', () => {
    const busy = handoffActionReducer(initialHandoffActionState, {
      type: 'start',
      action: 'lead_stop',
    })
    expect(handoffActionReducer(busy, { type: 'start', action: 'session_stop' })).toBe(busy)
  })

  test('failure parks the message for an explicit retry', () => {
    const busy = handoffActionReducer(initialHandoffActionState, {
      type: 'start',
      action: 'lead_stop',
    })
    const failed = handoffActionReducer(busy, {
      type: 'fail',
      action: 'lead_stop',
      message: 'stale_version: coordination owner version conflict',
    })
    expect(failed.status).toBe('error')
    const retried = handoffActionReducer(failed, { type: 'start', action: 'lead_stop' })
    expect(retried).toEqual({ status: 'busy', action: 'lead_stop' })
    expect(handoffActionReducer(retried, { type: 'succeed' })).toEqual({ status: 'idle' })
  })

  test('a foreign failure never clobbers the busy action', () => {
    const busy = handoffActionReducer(initialHandoffActionState, {
      type: 'start',
      action: 'lead_stop',
    })
    expect(handoffActionReducer(busy, { type: 'fail', action: 'session_stop', message: 'x' })).toBe(
      busy
    )
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
      action: 'lead_stop',
      work: () => {
        workCalls += 1
        return gate.promise
      },
    })
    void first
    const second = runHandoffActionOnce({
      ...harness,
      action: 'session_stop',
      work: () => {
        workCalls += 1
        return Promise.resolve()
      },
    })
    gate.resolve()
    await expect(second).resolves.toBe('rejected')
    expect(workCalls).toBe(1)
  })

  test('failure parks the message and reports conflicts', async () => {
    const harness = handoffMachine()
    let conflicted = 0
    let succeeded = 0
    const outcome = await runHandoffActionOnce({
      ...harness,
      action: 'lead_stop',
      work: () => Promise.reject(new Error('stale_version: coordination owner version conflict')),
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
      action: 'lead_stop',
      message: 'stale_version: coordination owner version conflict',
    })
  })

  test('a late completion after navigation commits nothing', async () => {
    const harness = handoffMachine()
    let currentSession = 'session-1'
    let succeeded = 0
    const gate = deferredGate()
    const pending = runHandoffActionOnce({
      ...harness,
      action: 'lead_stop',
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
    expect(harness.committed).toEqual([{ status: 'busy', action: 'lead_stop' }])
  })

  test('a late failure after navigation commits nothing', async () => {
    const harness = handoffMachine()
    let conflicted = 0
    let currentSession = 'session-1'
    const gate = deferredGate()
    const pending = runHandoffActionOnce({
      ...harness,
      action: 'session_stop',
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
    expect(harness.committed).toEqual([{ status: 'busy', action: 'session_stop' }])
  })

  test('non-error rejections surface a stable message', async () => {
    const harness = handoffMachine()
    const action: HandoffActionKind = 'session_stop'
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

function epochHarness() {
  let state = initialHandoffActionState
  let epoch = 0
  const committed: unknown[] = []
  return {
    current: () => state,
    commit: (next: typeof state) => {
      committed.push(next)
      state = next
    },
    committed,
    epoch: () => epoch,
    advance: () => {
      epoch += 1
    },
  }
}

describe('view/action epoch', () => {
  test('admission advances the epoch exactly once; rejection never does', async () => {
    const harness = epochHarness()
    let admitted = 0
    const gate = deferredGate()
    const first = runHandoffActionOnce({
      ...harness,
      action: 'lead_stop',
      work: () => gate.promise,
      onAdmitted: () => {
        admitted += 1
        harness.advance()
      },
    })
    void first
    const second = runHandoffActionOnce({
      ...harness,
      action: 'session_stop',
      work: () => Promise.resolve(),
      onAdmitted: () => {
        admitted += 1
        harness.advance()
      },
    })
    await expect(second).resolves.toBe('rejected')
    expect(admitted).toBe(1)
    expect(harness.epoch()).toBe(1)
    expect(harness.committed).toEqual([{ status: 'busy', action: 'lead_stop' }])
  })

  test('a replaced invocation fails currency even when the session matches', async () => {
    const harness = epochHarness()
    let resolveWork!: () => void
    const gate = new Promise<void>((resolve) => {
      resolveWork = resolve
    })
    const captured: number[] = []
    const pending = runHandoffActionOnce({
      ...harness,
      action: 'lead_stop',
      work: () => gate,
      onAdmitted: () => harness.advance(),
      isCurrent: () => harness.epoch() === captured[0],
    })
    captured.push(harness.epoch())
    // Navigation and a newer admitted action each advance the epoch.
    harness.advance()
    harness.advance()
    resolveWork()
    await expect(pending).resolves.toBe('superseded')
    // Only the admission committed; the late completion committed nothing.
    expect(harness.committed).toEqual([{ status: 'busy', action: 'lead_stop' }])
  })
})

describe('open approvals', () => {
  test('counts requested against resolved and expired within the window', () => {
    expect(hasOpenApproval([])).toBe(false)
    expect(hasOpenApproval([{ kind: 'turn.assistant_message' }])).toBe(false)
    expect(hasOpenApproval([{ kind: 'approval.requested' }])).toBe(true)
    expect(hasOpenApproval([{ kind: 'approval.requested' }, { kind: 'approval.resolved' }])).toBe(
      false
    )
    expect(hasOpenApproval([{ kind: 'approval.requested' }, { kind: 'approval.expired' }])).toBe(
      false
    )
    expect(
      hasOpenApproval([
        { kind: 'approval.requested' },
        { kind: 'approval.requested' },
        { kind: 'approval.resolved' },
      ])
    ).toBe(true)
  })
})

describe('lead-agent binding', () => {
  test('a turn bound to the active workspace lead coordinates', () => {
    expect(resolveLeadCoordination(leadTurn(), leadAgent())).toEqual({ bound: true })
    const view = deriveDirectSessionHandoff(coordinated())
    expect(view.mode).toBe('coordination_handoff')
    expect(view.controls.lead_stop.available).toBe(true)
    expect(view.coordination).toMatchObject({
      intentId: '00000000-0000-4000-8000-0000000000a1',
      state: 'running',
    })
  })

  test('a turn owned by another agent never authorizes lead control', () => {
    const turn = leadTurn({ agentId: '00000000-0000-4000-8000-0000000000c3' })
    expect(resolveLeadCoordination(turn, leadAgent()).bound).toBe(false)
    const view = deriveDirectSessionHandoff(
      coordinated({ leadTurn: turn, leadAgent: leadAgent(), leadMismatch: true })
    )
    expect(view.controls.lead_stop.available).toBe(false)
    expect(view.coordination).toBeUndefined()
    expect(view.notice).toMatch(/not bound to the active workspace lead/i)
  })

  test('a non-lead designation never authorizes lead control', () => {
    const agent = leadAgent({ isWorkspaceLead: false })
    expect(resolveLeadCoordination(leadTurn(), agent).bound).toBe(false)
    const view = deriveDirectSessionHandoff(
      coordinated({ leadTurn: leadTurn(), leadAgent: agent, leadMismatch: true })
    )
    expect(view.controls.lead_stop.available).toBe(false)
    expect(view.coordination).toBeUndefined()
    expect(view.notice).toMatch(/not bound to the active workspace lead/i)
  })

  test('an inactive lead designation fails closed', () => {
    expect(
      resolveLeadCoordination(leadTurn(), leadAgent({ lifecycleState: 'archived' })).bound
    ).toBe(false)
  })

  test('a missing turn or agent binds nothing without failing', () => {
    expect(resolveLeadCoordination(undefined, leadAgent())).toEqual({ bound: false })
    expect(resolveLeadCoordination(leadTurn(), undefined)).toEqual({ bound: false })
    expect(
      resolveLeadCoordination(leadTurn(), leadAgent(), { id: 'session-1', generation: 3 })
    ).toEqual({ bound: true })
    expect(
      resolveLeadCoordination(
        leadTurn({
          handoffTarget: {
            runtimeSessionId: 'session-other',
            taskId: '00000000-0000-4000-8000-0000000000f1',
            observedGeneration: 3,
          },
        }),
        leadAgent(),
        { id: 'session-1', generation: 3 }
      )
    ).toEqual({ bound: false, reason: 'the observed turn targets another session' })
    const { handoffTarget: _target, ...targetless } = leadTurn()
    expect(
      resolveLeadCoordination(targetless, leadAgent(), { id: 'session-1', generation: 3 })
    ).toEqual({
      bound: false,
      reason: 'the observed turn names no handoff target',
    })
    expect(
      resolveLeadCoordination(leadTurn({ observedRuntimeSessionId: undefined }), leadAgent(), {
        id: 'session-1',
        generation: 3,
      })
    ).toEqual({
      bound: false,
      reason: 'the observed turn has no runtime-validated execution binding',
    })
    expect(resolveLeadClaim(leadTurn(), leadAgent(), 'session-1')).toEqual({ bound: true })
    expect(resolveLeadClaim(leadTurn(), leadAgent(), 'session-other')).toEqual({
      bound: false,
      reason: 'the observed turn targets another session',
    })
    const { handoffTarget: _claimed, ...unclaimed } = leadTurn()
    expect(resolveLeadClaim(unclaimed, leadAgent(), 'session-1')).toEqual({
      bound: false,
      reason: 'the observed turn names no handoff target',
    })
    expect(
      resolveLeadCoordination(
        leadTurn({ observedRuntimeSessionId: 'session-other' }),
        leadAgent(),
        { id: 'session-1', generation: 3 }
      )
    ).toEqual({
      bound: false,
      reason: 'the observed turn executes in another session',
    })
    expect(
      resolveLeadCoordination(
        leadTurn({ handoffTarget: { runtimeSessionId: 'session-1', observedGeneration: 9999 } }),
        leadAgent(),
        { id: 'session-1', generation: 3 }
      )
    ).toEqual({
      bound: false,
      reason: 'the observed turn targets generation 9999 but the session is at generation 3',
    })
    expect(
      resolveLeadCoordination(leadTurn(), leadAgent(), { id: 'session-1', generation: 5 })
    ).toEqual({
      bound: false,
      reason: 'the observed turn targets generation 3 but the session is at generation 5',
    })
  })
})
