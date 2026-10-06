import { describe, expect, test } from 'bun:test'
import { createRoot } from 'solid-js'

import { createProjectShare } from '../../src/project-share'
import {
  canManageSharing,
  invitationDetail,
  memberLabel,
  pendingInvitations,
  shareCandidates,
} from '../../src/project-share-model'

const members = [
  { displayName: 'Owner', role: 'owner' as const, userId: 'u-owner' },
  { displayName: 'Admin', role: 'admin' as const, userId: 'u-admin' },
  { displayName: null, role: 'member' as const, userId: '12345678-member' },
]

const invitation = (
  id: string,
  overrides: Partial<{
    createdAt: string
    expiresAt: string
    state: 'pending' | 'accepted' | 'revoked' | 'expired'
  }> = {}
) => ({
  createdAt: '2026-10-01T00:00:00.000Z',
  email: `${id}@example.com`,
  expiresAt: '2026-10-08T00:00:00.000Z',
  id,
  invitedByUserId: 'u-owner',
  role: 'member' as const,
  state: 'pending' as const,
  workspaceId: 'w',
  ...overrides,
})

describe('project share dialog model', () => {
  test('only owners and admins manage sharing', () => {
    expect(canManageSharing(members, 'u-owner')).toBe(true)
    expect(canManageSharing(members, 'u-admin')).toBe(true)
    expect(canManageSharing(members, '12345678-member')).toBe(false)
    expect(canManageSharing(members, undefined)).toBe(false)
    expect(canManageSharing(members, 'stranger')).toBe(false)
  })

  test('offers workspace members not yet on the project', () => {
    const listed = [
      {
        createdAt: '2026-10-01T00:00:00.000Z',
        displayName: 'Admin',
        projectId: 'p',
        role: 'viewer' as const,
        updatedAt: '2026-10-01T00:00:00.000Z',
        userId: 'u-admin',
      },
    ]
    expect(shareCandidates(members, listed)).toEqual([
      { label: 'Owner', value: 'u-owner' },
      { label: 'Member 12345678', value: '12345678-member' },
    ])
    expect(memberLabel({ displayName: '  ', userId: 'abcdefghij' })).toBe('Member abcdefgh')
  })

  test('lists only live pending invitations, newest first', () => {
    const now = new Date('2026-10-05T00:00:00.000Z')
    const listed = pendingInvitations(
      [
        invitation('older'),
        invitation('newer', { createdAt: '2026-10-03T00:00:00.000Z' }),
        invitation('accepted', { state: 'accepted' }),
        invitation('revoked', { state: 'revoked' }),
        invitation('expired', { state: 'expired' }),
        // Still `pending` in the summary, but past its expiry by the client clock.
        invitation('lapsed', { expiresAt: '2026-10-04T00:00:00.000Z' }),
      ],
      now
    )
    expect(listed.map(({ id }) => id)).toEqual(['newer', 'older'])
    expect(pendingInvitations([], now)).toEqual([])
  })

  test('describes a pending invitation by role and expiry', () => {
    expect(
      invitationDetail({ expiresAt: '2026-10-09T12:00:00.000Z', role: 'member' }, 'en-US')
    ).toBe('Member · expires Oct 9')
    expect(
      invitationDetail({ expiresAt: '2026-10-09T12:00:00.000Z', role: 'admin' }, 'en-US')
    ).toBe('Admin · expires Oct 9')
  })

  test('open and close track the project being shared', () => {
    createRoot((dispose) => {
      const share = createProjectShare()
      expect(share.project()).toBeNull()
      const project = {
        createdAt: '2026-10-01T00:00:00.000Z',
        iconKey: 'secret',
        id: 'p',
        lifecycleState: 'active' as const,
        name: 'Secret',
        sortOrder: 0,
        sourceKind: 'none' as const,
        updatedAt: '2026-10-01T00:00:00.000Z',
        visibility: 'members' as const,
        workspaceId: 'w',
      }
      share.open(project)
      expect(share.project()).toEqual(project)
      share.close()
      expect(share.project()).toBeNull()
      dispose()
    })
  })
})
