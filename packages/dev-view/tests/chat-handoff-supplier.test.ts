// Direct-session handoff supplier (#1177): the production derivation of the
// handoff input from one canonical ChatConversation plus surface facts —
// modes from durable facts plus the latest transfer receipt, run candidates
// by register binding, drafts live. No receipt, no coordination: a bound run
// alone never invents a handoff.
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
  const live = {
    lifecycle: 'active',
    archived: false,
    connected: true,
    generationCurrent: true,
    sessionId: 'session-1',
    sessionGeneration: 3,
  } as const

  test('archived and terminal sessions review; nothing coordinates them', () => {
    for (const lifecycle of ['completed', 'failed', 'cancelled'] as const) {
      expect(deriveHandoffModeForSurface({ ...live, lifecycle, receipt: undefined })).toBe(
        'one_time_review'
      )
    }
    expect(deriveHandoffModeForSurface({ ...live, archived: true, receipt: undefined })).toBe(
      'one_time_review'
    )
  })

  test('a stale or offline view attaches read-only until resync', () => {
    expect(deriveHandoffModeForSurface({ ...live, connected: false, receipt: undefined })).toBe(
      'attached'
    )
    expect(
      deriveHandoffModeForSurface({
        ...live,
        generationCurrent: false,
        receipt: {
          sessionId: 'session-1',
          fromView: 'chat',
          toView: 'dev',
          generation: 3,
        },
      })
    ).toBe('attached')
  })

  test('a live session without a receipt attaches even with a run bound', () => {
    expect(deriveHandoffModeForSurface({ ...live, receipt: undefined })).toBe('attached')
  })

  test('a current receipt enters the coordinating mode of its direction', () => {
    expect(
      deriveHandoffModeForSurface({
        ...live,
        receipt: { sessionId: 'session-1', fromView: 'chat', toView: 'dev', generation: 3 },
      })
    ).toBe('coordination_handoff')
    expect(
      deriveHandoffModeForSurface({
        ...live,
        receipt: { sessionId: 'session-1', fromView: 'dev', toView: 'chat', generation: 3 },
      })
    ).toBe('returned_to_user')
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
    expect(supplied.supersededReceipt).toBe(false)
  })

  test('a matching receipt drives the coordinating mode', () => {
    const handedOff = deriveHandoffInputFromConversation({
      conversation: conversation({ generation: 4 }),
      connected: true,
      receipt: { sessionId: 'session-1', fromView: 'chat', toView: 'dev', generation: 4 },
    })
    expect(handedOff.mode).toBe('coordination_handoff')
    expect(handedOff.supersededReceipt).toBe(false)

    const returned = deriveHandoffInputFromConversation({
      conversation: conversation({ generation: 5 }),
      connected: true,
      receipt: { sessionId: 'session-1', fromView: 'dev', toView: 'chat', generation: 5 },
    })
    expect(returned.mode).toBe('returned_to_user')
  })

  test('a superseded receipt falls back to attachment with its flag set', () => {
    const supplied = deriveHandoffInputFromConversation({
      conversation: conversation({ generation: 6 }),
      connected: true,
      receipt: { sessionId: 'session-1', fromView: 'dev', toView: 'chat', generation: 4 },
    })
    expect(supplied.mode).toBe('attached')
    expect(supplied.supersededReceipt).toBe(true)
  })

  test('a foreign receipt never applies', () => {
    const supplied = deriveHandoffInputFromConversation({
      conversation: conversation(),
      connected: true,
      receipt: { sessionId: 'session-2', fromView: 'dev', toView: 'chat', generation: 3 },
    })
    expect(supplied.mode).toBe('attached')
    expect(supplied.supersededReceipt).toBe(false)
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
    })
    expect(stale.mode).toBe('attached')
    expect(stale.generationCurrent).toBe(false)
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
