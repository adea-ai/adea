import { describe, expect, test } from 'bun:test'

import { resolveDesktopFirstRun } from '../src/lib/desktop-first-run-chat'
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
})
