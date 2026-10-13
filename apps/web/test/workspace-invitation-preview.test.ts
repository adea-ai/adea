import { describe, expect, test } from 'bun:test'

import {
  describeInvitationContext,
  invitationRoleLabel,
} from '../src/lib/workspace-invitation-preview'

const preview = {
  expiresAt: '2026-10-20T00:00:00.000Z',
  memberCount: 4,
  ownerName: 'Acme Ops',
  role: 'member' as const,
  workspaceName: 'Acme',
}

describe('invitation context copy', () => {
  test('names the owner, the current audience, the role and the unknown placement', () => {
    expect(describeInvitationContext(preview)).toBe(
      'Owned by Acme Ops · 4 members now · You would join as a member · Location unknown'
    )
  })

  test('says so when the owner has no name, and uses the singular for one member', () => {
    expect(
      describeInvitationContext({ ...preview, memberCount: 1, ownerName: null, role: 'admin' })
    ).toBe('Owner not named · 1 member now · You would join as an admin · Location unknown')
  })

  test('labels both invitation roles', () => {
    expect(invitationRoleLabel('admin')).toBe('an admin')
    expect(invitationRoleLabel('member')).toBe('a member')
  })
})
