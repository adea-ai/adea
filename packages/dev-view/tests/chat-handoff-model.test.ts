// Direct-session handoff model (#1177): distinct attachment, one-time review,
// explicit coordination handoff, and return-to-user states over one preserved
// RuntimeSession/transcript/harness/execution location.
import { describe, expect, test } from 'bun:test'

import type { HarnessRun, RuntimeSession, Scope } from '@adea-ai/types/dev-runtime'
import {
  deriveDirectSessionHandoff,
  HANDOFF_MODE_LABELS,
  type DirectSessionHandoffInput,
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
