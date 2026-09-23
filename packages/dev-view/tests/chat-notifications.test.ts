import { describe, expect, test } from 'bun:test'
import type { HarnessRun, RuntimeSession, Scope } from '@adea-ai/types/dev-runtime'

import { deriveChatNotifications, publishChatNotifications } from '../src/chat/notifications'

const SCOPE: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}

const session: RuntimeSession = {
  id: 'session-1',
  scope: SCOPE,
  projectId: 'project-1',
  repoId: 'repo-1',
  worktreeId: 'worktree-1',
  displayName: 'Deploy /Users/example/private token_sk-secret-value',
  lifecycle: 'active',
  archived: false,
  projection: 'structured',
  generation: 1,
  version: 1,
}

function run(state: HarnessRun['state'], version = 2): HarnessRun {
  return {
    id: 'run-1',
    scope: SCOPE,
    runtimeSessionId: session.id,
    installationId: 'installation-1',
    agentProfile: { id: 'profile-1', version: 1, displayName: 'Agent', capabilityPolicyVersion: 1 },
    state,
    generation: 1,
    version,
    startedAt: '2026-09-22T10:00:00.000Z',
  }
}

describe('deriveChatNotifications', () => {
  test('emits only canonical state transitions with redacted generic bodies', () => {
    const notifications = deriveChatNotifications({
      currentRuns: [run('awaiting_approval')],
      previousRuns: [run('working', 1)],
      sessions: [session],
      windowFocused: false,
    })
    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toMatchObject({
      kind: 'awaiting_approval',
      runtimeSessionId: session.id,
      body: 'Conversation needs approval',
    })
    expect(notifications[0]?.title).toContain('[private path]')
    expect(notifications[0]?.title).toContain('[secret redacted]')
    expect(JSON.stringify(notifications[0])).not.toContain('secret-value')
  })

  test('suppresses focused or authority-owned transitions and initial snapshots', () => {
    const input = {
      currentRuns: [run('completed')],
      previousRuns: [run('working', 1)],
      sessions: [session],
      windowFocused: true,
      focusedSessionId: session.id,
    }
    expect(deriveChatNotifications(input)).toEqual([])
    expect(
      deriveChatNotifications({
        ...input,
        windowFocused: false,
        focusedSessionId: undefined,
        authoritySessionId: session.id,
      })
    ).toEqual([])
    expect(
      deriveChatNotifications({
        ...input,
        windowFocused: false,
        focusedSessionId: undefined,
        previousRuns: [],
      })
    ).toEqual([])
  })

  test('publishes through an injected sink without retaining notification state', () => {
    const seen: string[] = []
    const count = publishChatNotifications(
      {
        currentRuns: [run('completed')],
        previousRuns: [run('working', 1)],
        sessions: [session],
        windowFocused: false,
      },
      (notification) => seen.push(notification.id)
    )
    expect(count).toBe(1)
    expect(seen).toHaveLength(1)
  })
})
