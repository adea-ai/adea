// Direct-session handoff supplier (#1177): the production derivation of the
// handoff input from one canonical ChatConversation plus surface facts —
// modes from durable facts, run candidates by register binding, drafts live.
import { describe, expect, test } from 'bun:test'

import type { HarnessRun, RuntimeSession, Scope } from '@adea-ai/types/dev-runtime'
import {
  deriveHandoffInputFromConversation,
  deriveHandoffModeForSurface,
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

describe('deriveHandoffModeForSurface', () => {
  test('archived and terminal sessions review; nothing coordinates them', () => {
    for (const lifecycle of ['completed', 'failed', 'cancelled'] as const) {
      expect(
        deriveHandoffModeForSurface({
          authority: 'chat',
          lifecycle,
          archived: false,
          connected: true,
          generationCurrent: true,
        })
      ).toBe('one_time_review')
    }
    expect(
      deriveHandoffModeForSurface({
        authority: 'chat',
        lifecycle: 'active',
        archived: true,
        connected: true,
        generationCurrent: true,
      })
    ).toBe('one_time_review')
  })

  test('a stale or offline view attaches read-only until resync', () => {
    expect(
      deriveHandoffModeForSurface({
        authority: 'chat',
        lifecycle: 'active',
        archived: false,
        connected: false,
        generationCurrent: true,
      })
    ).toBe('attached')
    expect(
      deriveHandoffModeForSurface({
        authority: 'chat',
        lifecycle: 'active',
        archived: false,
        connected: true,
        generationCurrent: false,
      })
    ).toBe('attached')
  })

  test('the input owner decides between coordination and attachment', () => {
    const live = {
      lifecycle: 'active',
      archived: false,
      connected: true,
      generationCurrent: true,
    } as const
    expect(deriveHandoffModeForSurface({ ...live, authority: 'chat' })).toBe('coordination_handoff')
    expect(deriveHandoffModeForSurface({ ...live, authority: 'dev' })).toBe('attached')
    expect(deriveHandoffModeForSurface({ ...live, authority: 'none' })).toBe('attached')
  })
})

describe('deriveHandoffInputFromConversation', () => {
  test('rebuilds the register session without minting identity', () => {
    const supplied = deriveHandoffInputFromConversation({
      conversation: conversation(),
      authority: 'chat',
      connected: true,
    })
    expect(supplied.session).toMatchObject({
      id: 'session-1',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      generation: 3,
      version: 7,
    })
    expect(supplied.mode).toBe('coordination_handoff')
    expect(supplied.inputOwnedHere).toBe(true)
    expect(supplied.hasUnsentDraft).toBe(false)
  })

  test('resolves the run candidate by register binding and never guesses', () => {
    const supplied = deriveHandoffInputFromConversation({
      conversation: conversation(),
      authority: 'chat',
      connected: true,
      harnessRuns: [run({ id: 'run-9' }), run()],
    })
    expect(supplied.activeHarnessRun?.id).toBe('run-1')
  })

  test('no candidate when the register binds nothing, even with runs present', () => {
    const supplied = deriveHandoffInputFromConversation({
      conversation: conversation({ activeHarnessRunId: undefined }),
      authority: 'chat',
      connected: true,
      harnessRuns: [run()],
    })
    expect(supplied.activeHarnessRun).toBeUndefined()
  })

  test('draft text and blocks both mark unsent work', () => {
    const withText = deriveHandoffInputFromConversation({
      conversation: conversation({ draft: '  hello  ' }),
      authority: 'dev',
      connected: true,
    })
    expect(withText.hasUnsentDraft).toBe(true)
    const blank = deriveHandoffInputFromConversation({
      conversation: conversation({ draft: '   ' }),
      authority: 'dev',
      connected: true,
    })
    expect(blank.hasUnsentDraft).toBe(false)
  })

  test('an explicit mode overrides derivation; stale transcript forces attachment', () => {
    const overridden = deriveHandoffInputFromConversation({
      conversation: conversation(),
      authority: 'chat',
      connected: true,
      mode: 'returned_to_user',
    })
    expect(overridden.mode).toBe('returned_to_user')

    const stale = deriveHandoffInputFromConversation({
      conversation: conversation({ status: 'stale_generation' }),
      authority: 'chat',
      connected: true,
    })
    expect(stale.mode).toBe('attached')
    expect(stale.generationCurrent).toBe(false)
  })

  test('session type completeness is preserved for the derivation', () => {
    const supplied = deriveHandoffInputFromConversation({
      conversation: conversation(),
      authority: 'chat',
      connected: true,
    })
    const session: RuntimeSession = supplied.session
    expect(session.repoId).toBe('repo-1')
  })
})
