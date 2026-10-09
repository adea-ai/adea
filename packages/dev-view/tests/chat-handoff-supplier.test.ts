// Direct-session handoff supplier (#1177): the production derivation of the
// handoff input from one canonical ChatConversation plus surface facts.
// Coordination comes only from supplied canonical lead-turn facts — a bound
// run alone never invents a handoff. Drafts read live.
import { describe, expect, test } from 'bun:test'

import type { HarnessRun, RuntimeSession, Scope } from '@adea-ai/types/dev-runtime'
import {
  deriveDirectSessionHandoff,
  deriveHandoffInputFromConversation,
  deriveHandoffModeForSurface,
  resolveLeadCoordination,
  type HandoffLeadAgent,
  type HandoffLeadTurn,
} from '../src/chat/model/handoff'
import type { ChatConversation } from '../src/chat/model/types'

const SCOPE: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}

function conversation(overrides: Partial<ChatConversation> = {}): ChatConversation {
  return {
    runtimeSessionId: 'session-1',
    scope: SCOPE,
    projectId: 'project-1',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    title: 'Session',
    status: 'active',
    archived: false,
    projection: 'structured',
    generation: 3,
    version: 7,
    activeHarnessRunId: 'run-1',
    draft: '',
    draftBlocks: [],
    events: [],
    retention: { maxEvents: 1000, complete: true },
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

function boundTurn(overrides: Partial<HandoffLeadTurn> = {}): {
  leadTurn: HandoffLeadTurn
  leadAgent: HandoffLeadAgent
} {
  return { leadTurn: leadTurn(overrides), leadAgent: leadAgent() }
}

describe('deriveHandoffModeForSurface', () => {
  const live = {
    lifecycle: 'active',
    archived: false,
    connected: true,
    generationCurrent: true,
  } as const

  test('archived and terminal sessions review; nothing coordinates them', () => {
    for (const lifecycle of ['completed', 'failed', 'cancelled'] as const) {
      expect(deriveHandoffModeForSurface({ ...live, lifecycle, leadTurn: leadTurn() })).toBe(
        'one_time_review'
      )
    }
    expect(deriveHandoffModeForSurface({ ...live, archived: true })).toBe('one_time_review')
  })

  test('a stale or offline view attaches read-only until resync', () => {
    expect(deriveHandoffModeForSurface({ ...live, connected: false })).toBe('attached')
    expect(deriveHandoffModeForSurface({ ...live, generationCurrent: false })).toBe('attached')
  })

  test('without lead-turn facts the session attaches even with a run bound', () => {
    expect(deriveHandoffModeForSurface({ ...live })).toBe('attached')
  })

  test('retained coordination decides the mode; nothing asserted attaches', () => {
    expect(deriveHandoffModeForSurface({ ...live, coordination: 'lead' })).toBe(
      'coordination_handoff'
    )
    expect(deriveHandoffModeForSurface({ ...live, coordination: 'user' })).toBe('returned_to_user')
    expect(deriveHandoffModeForSurface({ ...live, coordination: undefined })).toBe('attached')
  })

  test('agent binding gates the turn before modes are derived', () => {
    expect(resolveLeadCoordination(leadTurn(), leadAgent())).toEqual({ bound: true })
    expect(resolveLeadCoordination(leadTurn({ agentId: 'other' }), leadAgent()).bound).toBe(false)
    expect(resolveLeadCoordination(leadTurn(), leadAgent({ isWorkspaceLead: false })).bound).toBe(
      false
    )
    expect(
      resolveLeadCoordination(leadTurn(), leadAgent({ lifecycleState: 'archived' })).bound
    ).toBe(false)
    expect(resolveLeadCoordination(undefined, leadAgent())).toEqual({ bound: false })
    expect(resolveLeadCoordination(leadTurn(), undefined)).toEqual({ bound: false })
  })
})

describe('deriveHandoffInputFromConversation', () => {
  test('a direct session attaches without inventing coordination', () => {
    const supplied = deriveHandoffInputFromConversation({
      conversation: conversation(),
      connected: true,
    })
    expect(supplied.session).toMatchObject({
      id: 'session-1',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      generation: 3,
      version: 7,
    })
    expect(supplied.mode).toBe('attached')
    expect(supplied.hasUnsentDraft).toBe(false)
    expect(supplied.leadTurn).toBeUndefined()
  })

  test('supplied lead-turn facts drive the coordinating modes', () => {
    const handedOff = deriveHandoffInputFromConversation({
      conversation: conversation(),
      connected: true,
      ...boundTurn(),
    })
    expect(handedOff.mode).toBe('coordination_handoff')
    expect(handedOff.leadTurn?.intentId).toBe('00000000-0000-4000-8000-0000000000a1')

    const returned = deriveHandoffInputFromConversation({
      conversation: conversation(),
      connected: true,
      ...boundTurn({ state: 'completed' }),
    })
    expect(returned.mode).toBe('returned_to_user')
  })

  test('resolves the run candidate by register binding and never guesses', () => {
    const supplied = deriveHandoffInputFromConversation({
      conversation: conversation(),
      connected: true,
      harnessRuns: [run({ id: 'run-9' }), run()],
    })
    expect(supplied.activeHarnessRun?.id).toBe('run-1')
  })

  test('no candidate when the register binds nothing, even with runs present', () => {
    const supplied = deriveHandoffInputFromConversation({
      conversation: conversation({ activeHarnessRunId: undefined }),
      connected: true,
      harnessRuns: [run()],
    })
    expect(supplied.activeHarnessRun).toBeUndefined()
  })

  test('draft text and blocks both mark unsent work', () => {
    const withText = deriveHandoffInputFromConversation({
      conversation: conversation({ draft: '  hello  ' }),
      connected: true,
    })
    expect(withText.hasUnsentDraft).toBe(true)
    const blank = deriveHandoffInputFromConversation({
      conversation: conversation({ draft: '   ' }),
      connected: true,
    })
    expect(blank.hasUnsentDraft).toBe(false)
  })

  test('an explicit mode overrides derivation; stale transcript forces attachment', () => {
    const overridden = deriveHandoffInputFromConversation({
      conversation: conversation(),
      connected: true,
      mode: 'returned_to_user',
    })
    expect(overridden.mode).toBe('returned_to_user')

    const stale = deriveHandoffInputFromConversation({
      conversation: conversation({ status: 'stale_generation' }),
      connected: true,
      ...boundTurn(),
    })
    expect(stale.mode).toBe('attached')
    expect(stale.generationCurrent).toBe(false)
  })

  test('awaiting approval derives from open transcript approvals unless overridden', () => {
    const requested = {
      schemaVersion: 1,
      eventId: 'approval-1',
      runtimeSessionId: 'session-1',
      generation: 3,
      seq: '9',
      occurredAt: '2026-09-22T10:00:00.000Z',
      receivedAt: '2026-09-22T10:00:00.000Z',
      source: 'host',
      sourceEventId: 'source-9',
      confidence: 'authoritative',
      classification: 'workspace_metadata',
      kind: 'approval.requested',
      payload: { name: 'deploy' },
    } as const
    const derived = deriveHandoffInputFromConversation({
      conversation: conversation({ events: [requested] }),
      connected: true,
    })
    expect(derived.awaitingApproval).toBe(true)
    const overridden = deriveHandoffInputFromConversation({
      conversation: conversation({ events: [requested] }),
      connected: true,
      awaitingApproval: false,
    })
    expect(overridden.awaitingApproval).toBe(false)
  })

  test('a linked channel flows through for handoff availability', () => {
    const linked = deriveHandoffInputFromConversation({
      conversation: conversation(),
      connected: true,
      leadChannelId: 'channel-1',
    })
    expect(linked.mode).toBe('attached')
    const view = deriveDirectSessionHandoff(linked)
    expect(view.controls.handoff_to_lead.available).toBe(true)
    const unlinked = deriveHandoffInputFromConversation({
      conversation: conversation(),
      connected: true,
    })
    expect(deriveDirectSessionHandoff(unlinked).controls.handoff_to_lead.available).toBe(false)
  })

  test('a blocked observed turn flags awaiting admission', () => {
    const supplied = deriveHandoffInputFromConversation({
      conversation: conversation(),
      connected: true,
      leadTurn: leadTurn({ state: 'blocked' }),
      leadAgent: leadAgent(),
      leadChannelId: 'channel-1',
    })
    expect(supplied.mode).toBe('attached')
    expect(deriveDirectSessionHandoff(supplied).awaitingTurn).toBe(true)
    const live = deriveHandoffInputFromConversation({
      conversation: conversation(),
      connected: true,
      leadTurn: leadTurn(),
      leadAgent: leadAgent(),
      leadChannelId: 'channel-1',
    })
    expect(deriveDirectSessionHandoff(live).awaitingTurn).toBe(false)
  })

  test('session type completeness is preserved for the derivation', () => {
    const supplied = deriveHandoffInputFromConversation({
      conversation: conversation(),
      connected: true,
    })
    const session: RuntimeSession = supplied.session
    expect(session.repoId).toBe('repo-1')
  })
})
