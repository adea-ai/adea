import { describe, expect, test } from 'bun:test'

import { resolveDesktopFirstRun } from '../src/lib/desktop-first-run-chat'
import type { ChatConversation, ChatConversationModel } from '@adea-ai/dev-view/chat/model'
import {
  attachFirstRunConversationIfCurrent,
  createDesktopChatLifecycleFence,
} from '../src/lib/desktop-chat-host'
import type { AgentSummary } from '@adea-ai/types'

const projection = {
  groups: [
    {
      id: 'group-1',
      name: 'Workspace',
      projects: [
        {
          id: 'project-1',
          name: 'Project',
          repository: 'repo-1',
          branch: 'main',
          sessions: [],
        },
      ],
    },
  ],
} as const

const worktree = {
  id: 'worktree-1',
  projectId: 'project-1',
  repoId: 'repo-1',
  lifecycle: 'ready',
  archived: false,
} as const

const agent = {
  id: 'agent-1',
  lifecycleState: 'active',
  profile: { id: 'profile-1', state: 'available', version: '7' },
} as AgentSummary

describe('desktop first-run authority projection', () => {
  test('binds launch context only from matching canonical project, worktree, and profile records', () => {
    const resolved = resolveDesktopFirstRun({
      temporary: false,
      managedPi: { state: 'ready' },
      projection,
      worktrees: [worktree],
      agents: [agent],
    })

    expect(resolved.facts).toEqual({
      identity: 'signed_in',
      managedPi: { state: 'ready' },
      modelAccess: 'unknown',
      projectReady: true,
      agentProfileReady: true,
    })
    expect(resolved.context).toEqual({
      projectId: 'project-1',
      repoId: 'repo-1',
      worktreeId: 'worktree-1',
      agentProfileId: 'profile-1',
      agentProfileVersion: 7,
    })
  })

  test('does not fabricate a context when the worktree or profile authority is missing', () => {
    const withoutWorktree = resolveDesktopFirstRun({
      temporary: false,
      managedPi: { state: 'resolving' },
      projection,
      worktrees: [],
      agents: [agent],
    })
    const withoutProfile = resolveDesktopFirstRun({
      temporary: false,
      managedPi: { state: 'resolving' },
      projection,
      worktrees: [worktree],
      agents: [],
    })

    expect(withoutWorktree.context).toBeUndefined()
    expect(withoutWorktree.facts.projectReady).toBe(false)
    expect(withoutProfile.context).toBeUndefined()
    expect(withoutProfile.facts.agentProfileReady).toBe(false)
  })

  test('keeps guest model access gated even if a stale projection claims access', () => {
    const resolved = resolveDesktopFirstRun({
      temporary: true,
      managedPi: { state: 'ready' },
      projection,
      worktrees: [worktree],
      agents: [agent],
    })

    expect(resolved.facts.identity).toBe('guest')
    expect(resolved.facts.modelAccess).toBe('none')
  })

  test('does not attach a deferred onboarding creation from a replaced scope', async () => {
    const lifecycle = createDesktopChatLifecycleFence()
    const created = { runtimeSessionId: 'runtime-session-1' } as ChatConversation
    let attachCalls = 0
    let resolveAttach: ((conversation: ChatConversation) => void) | undefined
    const model = {
      attach: async () => {
        attachCalls += 1
        return new Promise<ChatConversation>((resolve) => {
          resolveAttach = resolve
        })
      },
    } as unknown as ChatConversationModel
    let attached = 0
    const firstRequest = lifecycle.begin()

    attachFirstRunConversationIfCurrent({
      created,
      currentModel: () => model,
      lifecycle,
      model,
      onAttached: () => {
        attached += 1
      },
      request: firstRequest,
    })
    expect(attachCalls).toBe(1)

    lifecycle.invalidate()
    resolveAttach?.(created)
    await Promise.resolve()
    expect(attached).toBe(0)

    // A callback arriving from the old onboarding instance after a new scope
    // starts must be rejected before it calls the new model or attaches.
    const nextRequest = lifecycle.begin()
    attachFirstRunConversationIfCurrent({
      created,
      currentModel: () => model,
      lifecycle,
      model,
      onAttached: () => {
        attached += 1
      },
      request: firstRequest,
    })
    expect(attachCalls).toBe(1)

    attachFirstRunConversationIfCurrent({
      created,
      currentModel: () => model,
      lifecycle,
      model,
      onAttached: () => {
        attached += 1
      },
      request: nextRequest,
    })
    expect(attachCalls).toBe(2)
  })
})
