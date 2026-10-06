import { describe, expect, test } from 'bun:test'
import type { AgentHqApiClient } from '@adea-ai/api-client'
import { QueryClient } from '@tanstack/solid-query'

import { sharingMutationOptions, sharingQueryKeys, sharingQueryOptions } from '../../src'

function recordingClient() {
  const calls: unknown[][] = []
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args])
      return {}
    }
  const api = {
    acceptWorkspaceInvitation: record('accept'),
    createWorkspaceInvitation: record('invite'),
    listProjectMembers: record('projectMembers'),
    listWorkspaceInvitations: record('invitations'),
    listWorkspaceMembers: record('members'),
    removeProjectMember: record('removeMember'),
    revokeWorkspaceInvitation: record('revoke'),
    setProjectMember: record('setMember'),
    setProjectVisibility: record('visibility'),
  } as unknown as AgentHqApiClient
  return { api, calls }
}

describe('sharing query contracts', () => {
  test('keys sit under the workspace prefix that events refresh', async () => {
    const { api, calls } = recordingClient()
    expect(sharingQueryKeys.workspaceMembers('w')).toEqual(['workspaces', 'w', 'members'])
    expect(sharingQueryKeys.invitations('w')).toEqual(['workspaces', 'w', 'invitations'])
    // Under the project prefix, so `project.*` events refresh member lists.
    expect(sharingQueryKeys.projectMembers('w', 'p')).toEqual([
      'workspaces',
      'w',
      'projects',
      'members',
      'p',
    ])
    expect(sharingQueryOptions.projectMembers(api, 'w', undefined).enabled).toBe(false)
    expect(sharingQueryOptions.invitations(api, 'w', false).enabled).toBe(false)
    await sharingQueryOptions.projectMembers(api, 'w', 'p').queryFn()
    await sharingQueryOptions.workspaceMembers(api, 'w').queryFn()
    expect(calls).toEqual([
      ['projectMembers', 'w', 'p'],
      ['members', 'w'],
    ])
  })

  test('mutations call the API and refresh what they change', async () => {
    const { api, calls } = recordingClient()
    const queryClient = new QueryClient()
    const invalidated: unknown[] = []
    queryClient.invalidateQueries = (async (filters: { queryKey: unknown }) => {
      invalidated.push(filters.queryKey)
    }) as QueryClient['invalidateQueries']

    const visibility = sharingMutationOptions.setProjectVisibility(api, queryClient, 'w', 'p')
    await visibility.mutationFn('members')
    await visibility.onSuccess()
    const member = sharingMutationOptions.setProjectMember(api, queryClient, 'w', 'p')
    await member.mutationFn({ role: 'viewer', userId: 'u' })
    await member.onSuccess()
    const invite = sharingMutationOptions.createInvitation(api, queryClient, 'w')
    await invite.mutationFn({ email: 'a@example.com', role: 'member' })
    await invite.onSuccess()

    expect(calls).toEqual([
      ['visibility', 'w', 'p', 'members'],
      ['setMember', 'w', 'p', 'u', 'viewer'],
      ['invite', 'w', { email: 'a@example.com', role: 'member' }],
    ])
    expect(invalidated).toEqual([
      ['workspaces', 'w'],
      ['workspaces', 'w', 'projects', 'members', 'p'],
      ['workspaces', 'w', 'invitations'],
    ])
  })
})
