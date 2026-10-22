import { describe, expect, test } from 'bun:test'

import type { UserPrincipalRef } from '@adea-ai/types'

import {
  GroupStandingUnavailableError,
  readGroupStanding,
  type GroupStandingSource,
} from '../src/server/group-standing-read'

// The server surface of the #1178 group-standing read. The canonical read is faked here: this
// file proves the application boundary — the authenticated requester, the wire shape and the
// redaction — without a database.

const owner: UserPrincipalRef = { userId: 'user-owner', kind: 'user' } as UserPrincipalRef
const member: UserPrincipalRef = { userId: 'user-member', kind: 'user' } as UserPrincipalRef

const source: GroupStandingSource = {
  channelId: 'channel-1',
  members: [
    {
      expiresAt: null,
      inForce: true,
      joinPoint: { joinedAt: '2026-10-20T10:00:00.000Z', joinedSequence: 0 },
      participant: { kind: 'user', userId: 'user-owner' },
      state: 'effective',
    },
    {
      expiresAt: '2026-11-20T10:00:00.000Z',
      inForce: true,
      joinPoint: { joinedAt: '2026-10-21T10:00:00.000Z', joinedSequence: 7 },
      participant: { kind: 'user', userId: 'user-member' },
      state: 'effective',
    },
    {
      expiresAt: null,
      inForce: false,
      joinPoint: { joinedAt: '2026-10-19T10:00:00.000Z', joinedSequence: 3 },
      participant: { agentId: 'agent-1', kind: 'agent' },
      state: 'revoked',
    },
  ],
}

describe('the group standing server surface (#1178)', () => {
  test('the read carries the standing, the join point and the expiry, and nothing else', async () => {
    const calls: unknown[] = []
    const standing = await readGroupStanding(owner, 'channel-1', {
      readStanding: async (input) => {
        calls.push(input)
        return source
      },
    })
    expect(standing.channelId).toBe('channel-1')
    expect(standing.members).toHaveLength(3)
    // The wire shape is exactly the standing facts, field by field.
    expect(Object.keys(standing.members[0]!).toSorted()).toEqual([
      'expiresAt',
      'inForce',
      'joinedAt',
      'joinedSequence',
      'participant',
      'state',
    ])
    expect(standing.members[1]).toEqual({
      expiresAt: '2026-11-20T10:00:00.000Z',
      inForce: true,
      joinedAt: '2026-10-21T10:00:00.000Z',
      joinedSequence: 7,
      participant: { kind: 'user', userId: 'user-member' },
      state: 'effective',
    })
    // The Agent's standing is projected too, with the same shape.
    expect(standing.members[2]?.participant).toEqual({ agentId: 'agent-1', kind: 'agent' })
    expect(standing.members[2]?.state).toBe('revoked')
    expect(standing.members[2]?.inForce).toBe(false)
    // The authenticated requester is the one the canonical read is asked about.
    expect(calls).toEqual([{ channelId: 'channel-1', requester: owner }])
  })

  test('no grant identity, issue or revocation instant, and no content reaches the client', async () => {
    const standing = await readGroupStanding(owner, 'channel-1', {
      readStanding: async () => ({
        ...source,
        members: [
          {
            ...source.members[0]!,
            // A canonical projection that grew a field must not leak it through the wire shape.
            ...({ authorization: { grantId: 'gra_secret', revision: 3 } } as Record<
              string,
              unknown
            >),
          },
        ],
      }),
    })
    const serialized = JSON.stringify(standing)
    expect(serialized).not.toContain('gra_secret')
    expect(serialized).not.toContain('authorization')
    expect(serialized).not.toContain('grantId')
    expect(serialized).not.toContain('revision')
    expect(serialized).not.toContain('issuedAt')
    expect(serialized).not.toContain('revokedAt')
    expect(Object.keys(standing.members[0]!).toSorted()).toEqual([
      'expiresAt',
      'inForce',
      'joinedAt',
      'joinedSequence',
      'participant',
      'state',
    ])
  })

  test('a request without an authenticated principal is refused before any read', async () => {
    let read = false
    const dependency = {
      readStanding: async () => {
        read = true
        return source
      },
    }
    await expect(
      readGroupStanding({ userId: '' } as UserPrincipalRef, 'channel-1', dependency)
    ).rejects.toBeInstanceOf(GroupStandingUnavailableError)
    await expect(
      readGroupStanding({ userId: '   ' } as UserPrincipalRef, 'channel-1', dependency)
    ).rejects.toBeInstanceOf(GroupStandingUnavailableError)
    await expect(
      readGroupStanding(undefined as unknown as UserPrincipalRef, 'channel-1', dependency)
    ).rejects.toBeInstanceOf(GroupStandingUnavailableError)
    expect(read).toBe(false)
  })

  test('a request without a group is refused before any read', async () => {
    let read = false
    await expect(
      readGroupStanding(member, '', {
        readStanding: async () => {
          read = true
          return source
        },
      })
    ).rejects.toBeInstanceOf(GroupStandingUnavailableError)
    expect(read).toBe(false)
  })

  test('the canonical refusal is not translated into something else', async () => {
    // The canonical read refuses an unauthorized requester with the product's own unavailable
    // answer. The surface does not turn a denial into a success, and it does not turn a failure
    // into a denial either: only the canonical layer knows which one it is.
    await expect(
      readGroupStanding(member, 'channel-1', {
        readStanding: async () => {
          throw new Error('Channel unavailable')
        },
      })
    ).rejects.toThrow('Channel unavailable')
    await expect(
      readGroupStanding(member, 'channel-1', {
        readStanding: async () => {
          throw new Error('the database is unreachable')
        },
      })
    ).rejects.toThrow('the database is unreachable')
  })
})
