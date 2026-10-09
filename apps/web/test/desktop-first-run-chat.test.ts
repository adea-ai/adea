import { describe, expect, test } from 'bun:test'

import {
  ensureFirstRunLead,
  provisionFirstRunLeadIfCurrent,
  resolveDesktopFirstRun,
} from '../src/lib/desktop-first-run-chat'
import type { ChatConversation, ChatConversationModel } from '@adea-ai/dev-view/chat/model'
import {
  attachFirstRunConversationIfCurrent,
  createDesktopChatLifecycleFence,
} from '../src/lib/desktop-chat-host'
import type { AgentSummary } from '@adea-ai/types'
import { ApiClientError } from '@adea-ai/api-client'

const projection = {
  projects: [
    {
      id: 'project-1',
      repoIds: ['repo-1'],
      branch: 'main',
      sessions: [],
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
      modelAccess: 'byok',
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

  test('a guest traverses onboarding identically: BYOK is the model path, never a gate', () => {
    const resolved = resolveDesktopFirstRun({
      temporary: true,
      managedPi: { state: 'ready' },
      projection,
      worktrees: [worktree],
      agents: [agent],
    })

    expect(resolved.facts.identity).toBe('guest')
    expect(resolved.facts.modelAccess).toBe('byok')
    expect(resolved.context).toEqual({
      projectId: 'project-1',
      repoId: 'repo-1',
      worktreeId: 'worktree-1',
      agentProfileId: 'profile-1',
      agentProfileVersion: 7,
    })
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

describe('desktop first-run lead provisioning', () => {
  const unconfiguredLead = {
    id: 'lead-1',
    isWorkspaceLead: true,
    lifecycleState: 'active',
    profile: { id: 'workspace-lead-unconfigured', state: 'missing', version: 'unconfigured' },
  } as AgentSummary

  test('provisions a missing lead without making agent setup ready', async () => {
    const calls: string[] = []
    const client = {
      ensureWorkspaceLead: async (workspaceId: string) => {
        calls.push(workspaceId)
        return { lead: unconfiguredLead }
      },
    }
    const outcome = await ensureFirstRunLead(client, 'workspace-1', [])
    expect(calls).toEqual(['workspace-1'])
    expect(outcome.status).toBe('provisioned')
    expect(outcome.agents.map((item) => item.id)).toEqual(['lead-1'])

    const resolved = resolveDesktopFirstRun({
      temporary: false,
      lead: outcome.status,
      managedPi: { state: 'ready' },
      projection,
      worktrees: [worktree],
      agents: outcome.agents,
    })
    expect(resolved.facts.identity).toBe('signed_in')
    expect(resolved.facts.leadProvisioning).toBeUndefined()
    expect(resolved.facts.agentProfileReady).toBe(false)
    expect(resolved.context).toBeUndefined()
  })

  test('does not call the provisioning route when a lead already exists', async () => {
    let calls = 0
    const existing = { ...unconfiguredLead, id: 'lead-2' }
    const outcome = await ensureFirstRunLead(
      {
        ensureWorkspaceLead: async () => {
          calls += 1
          return { lead: unconfiguredLead }
        },
      },
      'workspace-1',
      [existing]
    )
    expect(calls).toBe(0)
    expect(outcome).toEqual({ status: 'present', agents: [existing] })
  })

  test('a refused, empty, or failed provisioning is reported as failed, never as a lead', async () => {
    const roster = [agent]
    const refused = await ensureFirstRunLead(
      {
        ensureWorkspaceLead: async () => {
          throw new ApiClientError('Workspace unavailable', 404, 'workspace_unavailable')
        },
      },
      'workspace-1',
      roster
    )
    const empty = await ensureFirstRunLead(
      { ensureWorkspaceLead: async () => ({ lead: null }) },
      'workspace-1',
      roster
    )
    expect(refused).toEqual({ status: 'failed', agents: roster })
    expect(empty).toEqual({ status: 'failed', agents: roster })
  })

  test('an expired session reports auth_required so sign-in is offered', async () => {
    const outcome = await ensureFirstRunLead(
      {
        ensureWorkspaceLead: async () => {
          throw new ApiClientError('Workspace unavailable', 401, 'workspace_unavailable')
        },
      },
      'workspace-1',
      []
    )
    expect(outcome.status).toBe('auth_required')

    const resolved = resolveDesktopFirstRun({
      temporary: false,
      lead: outcome.status,
      managedPi: { state: 'ready' },
      projection,
      worktrees: [worktree],
      agents: outcome.agents,
    })
    expect(resolved.facts.identity).toBe('auth_required')
  })

  test('a failed provisioning is carried into facts and never marks agent setup ready', () => {
    const resolved = resolveDesktopFirstRun({
      temporary: false,
      lead: 'failed',
      managedPi: { state: 'ready' },
      projection,
      worktrees: [worktree],
      agents: [],
    })
    expect(resolved.facts.leadProvisioning).toBe('failed')
    expect(resolved.facts.agentProfileReady).toBe(false)
    expect(resolved.context).toBeUndefined()
  })

  test('guests are never provisioned and carry no lead outcome', () => {
    const resolved = resolveDesktopFirstRun({
      temporary: true,
      managedPi: { state: 'ready' },
      projection,
      worktrees: [worktree],
      agents: [],
    })
    expect(resolved.facts.identity).toBe('guest')
    expect(resolved.facts.leadProvisioning).toBeUndefined()
  })
})

describe('desktop first-run lead provisioning scope guard', () => {
  test('a scope switch while reads are parked never issues a lead write', async () => {
    const lifecycle = createDesktopChatLifecycleFence()
    const request = lifecycle.begin()
    let writes = 0
    const client = {
      ensureWorkspaceLead: async () => {
        writes += 1
        return { lead: null }
      },
    }
    let releaseReads!: () => void
    const reads = new Promise<void>((resolve) => {
      releaseReads = resolve
    })
    const pending = (async () => {
      await reads
      return provisionFirstRunLeadIfCurrent({
        isCurrent: () => lifecycle.isCurrent(request),
        client,
        workspaceId: 'workspace-old',
        agents: [],
      })
    })()

    lifecycle.invalidate()
    releaseReads()

    expect(await pending).toBeUndefined()
    expect(writes).toBe(0)
  })

  test('the current request provisions exactly once', async () => {
    const lifecycle = createDesktopChatLifecycleFence()
    const request = lifecycle.begin()
    let writes = 0
    const client = {
      ensureWorkspaceLead: async () => {
        writes += 1
        return {
          lead: {
            id: 'lead-current',
            isWorkspaceLead: true,
            lifecycleState: 'active',
            profile: {
              id: 'workspace-lead-unconfigured',
              state: 'missing',
              version: 'unconfigured',
            },
          } as AgentSummary,
        }
      },
    }
    const outcome = await provisionFirstRunLeadIfCurrent({
      isCurrent: () => lifecycle.isCurrent(request),
      client,
      workspaceId: 'workspace-1',
      agents: [],
    })
    expect(outcome?.status).toBe('provisioned')
    expect(writes).toBe(1)
  })
})
