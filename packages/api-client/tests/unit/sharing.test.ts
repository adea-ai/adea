import { describe, expect, test } from 'bun:test'
import { createApiClient } from '../../src'

describe('Sharing API client', () => {
  test('routes invitations, membership lists, visibility and project members', async () => {
    const requests: Request[] = []
    const client = createApiClient({
      baseUrl: 'https://hq.example/api',
      fetchImpl: async (input, init) => {
        requests.push(new Request(input, init))
        return Response.json({})
      },
    })
    await client.listWorkspaceMembers('workspace-1')
    await client.listWorkspaceInvitations('workspace-1')
    await client.createWorkspaceInvitation('workspace-1', {
      email: 'ada@example.com',
      role: 'member',
    })
    await client.revokeWorkspaceInvitation('workspace-1', 'invitation-1')
    await client.acceptWorkspaceInvitation('token-value')
    await client.setProjectVisibility('workspace-1', 'project-1', 'members')
    await client.listProjectMembers('workspace-1', 'project-1')
    await client.setProjectMember('workspace-1', 'project-1', 'user-1', 'editor')
    await client.removeProjectMember('workspace-1', 'project-1', 'user-1')

    expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
      ['GET', '/api/v1/workspaces/workspace-1/members'],
      ['GET', '/api/v1/workspaces/workspace-1/invitations'],
      ['POST', '/api/v1/workspaces/workspace-1/invitations'],
      ['POST', '/api/v1/workspaces/workspace-1/invitations/invitation-1/revoke'],
      ['POST', '/api/workspace-invitations/accept'],
      ['PATCH', '/api/v1/workspaces/workspace-1/projects/project-1/visibility'],
      ['GET', '/api/v1/workspaces/workspace-1/projects/project-1/members'],
      ['PUT', '/api/v1/workspaces/workspace-1/projects/project-1/members/user-1'],
      ['DELETE', '/api/v1/workspaces/workspace-1/projects/project-1/members/user-1'],
    ])
    expect(await requests[2]!.json()).toEqual({ email: 'ada@example.com', role: 'member' })
    // The token never rides in the URL.
    expect(requests[4]!.url).not.toContain('token-value')
    expect(await requests[4]!.json()).toEqual({ token: 'token-value' })
    expect(await requests[5]!.json()).toEqual({ visibility: 'members' })
    expect(await requests[7]!.json()).toEqual({ role: 'editor' })
  })
})
