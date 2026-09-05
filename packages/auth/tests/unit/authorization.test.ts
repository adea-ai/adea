import { describe, expect, test } from 'bun:test'

import { type PrincipalRef, type WorkspacePermission, workspacePermissions } from '@agent-hq/types'

import { authorizeWorkspaceAction, workspaceRolePermissions } from '../../src/authorization'

describe('workspace authorization', () => {
  test('keeps role bundles deny-by-default and owner-only operations explicit', () => {
    expect(workspaceRolePermissions.owner).toContain('workspace.archive')
    expect(workspaceRolePermissions.owner).toContain('billing.manage')
    expect(workspaceRolePermissions.admin).not.toContain('workspace.archive')
    expect(workspaceRolePermissions.member).toEqual([
      'workspace.read',
      'workspace.events.read',
      'membership.read',
    ])
  })

  test('classifies every shared workspace permission in each initial role bundle', () => {
    const rolePermission = new Set(
      Object.values(workspaceRolePermissions).flatMap((permissions) => permissions)
    )
    expect(
      [...workspacePermissions].filter((permission) => permission !== 'workspace.create')
    ).toEqual(expect.arrayContaining([...rolePermission]))
    expect([...rolePermission]).toEqual(
      expect.arrayContaining(
        [...workspacePermissions].filter((permission) => permission !== 'workspace.create')
      )
    )
    expect(workspaceRolePermissions.admin).toEqual([
      'workspace.read',
      'workspace.update',
      'workspace.events.read',
      'membership.read',
      'membership.manage',
      'runtime.invoke',
    ])
  })

  test('allows only permissions present in the resolved workspace role', async () => {
    const audited: Array<{ decision: string; permission: WorkspacePermission }> = []
    const principal = { kind: 'user', userId: 'user-a' } as const
    const dependencies = {
      audit: async (record: {
        decision: 'allowed' | 'denied'
        permission: WorkspacePermission
      }) => {
        audited.push(record)
      },
      findMembership: async () => ({ role: 'member' as const }),
    }

    expect(
      await authorizeWorkspaceAction(
        { permission: 'workspace.read', principal, workspaceId: 'workspace-a' },
        dependencies
      )
    ).toEqual({ allowed: true })
    expect(
      await authorizeWorkspaceAction(
        { permission: 'workspace.update', principal, workspaceId: 'workspace-a' },
        dependencies
      )
    ).toEqual({ allowed: false, reason: 'workspace_unavailable' })
    expect(audited).toEqual([
      {
        decision: 'denied',
        permission: 'workspace.update',
        principal,
        reason: 'permission_missing',
        workspaceId: 'workspace-a',
      },
    ])
  })

  test('does not grant service or runtime principals implicit user permissions', async () => {
    for (const principal of [
      { kind: 'service', serviceId: 'service-a' },
      { kind: 'runtime_node', runtimeNodeId: 'runtime-a' },
    ] satisfies PrincipalRef[]) {
      expect(
        await authorizeWorkspaceAction(
          { permission: 'workspace.read', principal, workspaceId: 'workspace-a' },
          { findMembership: async () => ({ role: 'owner' }) }
        )
      ).toEqual({ allowed: false, reason: 'workspace_unavailable' })
    }
  })

  test('allows a user principal to create a workspace without prior membership', async () => {
    expect(
      await authorizeWorkspaceAction(
        {
          permission: 'workspace.create',
          principal: { kind: 'user', userId: 'temporary-user' },
          workspaceId: null,
        },
        { findMembership: async () => null }
      )
    ).toEqual({ allowed: true })
  })
})
