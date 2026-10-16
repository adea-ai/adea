import { describe, expect, test } from 'bun:test'
import type { GroupAdmission, GroupAgentEnlistmentGrant, GroupAudienceGrant } from '@adea-ai/types'

import {
  audienceGrantIdFor,
  enlistmentGrantIdFor,
  issueGroupGrants,
} from '../../src/group-grant-issuance'
import { GroupCreationError } from '../../src/group-participation-store'

const GROUP = '33333333-0000-4000-8000-0000000000c3'
const OTHER_GROUP = '33333333-0000-4000-8000-0000000000c4'
const NOW = '2026-10-16T12:00:00.000Z'
const EARLIER = '2026-10-01T00:00:00.000Z'
const userA = '44444444-0000-4000-8000-0000000000d1'
const userB = '44444444-0000-4000-8000-0000000000d2'
const agentA = { agentId: '5a1c0e11-0000-4000-8000-0000000000e1', workspaceId: '1'.repeat(8) }
const agentB = {
  agentId: '9f20b7c4-0000-4000-8000-0000000000e2',
  workspaceId: '2'.repeat(8),
}

const audience = (overrides: Partial<GroupAudienceGrant> = {}): GroupAudienceGrant => ({
  expiresAt: null,
  grantId: audienceGrantIdFor(userA),
  groupId: GROUP,
  issuedAt: EARLIER,
  participant: { kind: 'user', userId: userA },
  revision: 1,
  revokedAt: null,
  ...overrides,
})
const enlistment = (
  overrides: Partial<GroupAgentEnlistmentGrant> = {}
): GroupAgentEnlistmentGrant => ({
  agent: agentA,
  expiresAt: null,
  grantId: enlistmentGrantIdFor(agentA),
  groupId: GROUP,
  issuedAt: EARLIER,
  revision: 1,
  revokedAt: null,
  ...overrides,
})

describe('issueGroupGrants: first issuance', () => {
  test('issues a deterministic revision-1 grant bound to the group for each identity', () => {
    const issued = issueGroupGrants({
      groupId: GROUP,
      now: NOW,
      selection: { agents: [agentA], humans: [userA, userB] },
    })
    expect(issued.audienceGrants).toEqual([
      {
        expiresAt: null,
        grantId: `audience:${userA}`,
        groupId: GROUP,
        issuedAt: NOW,
        participant: { kind: 'user', userId: userA },
        revision: 1,
        revokedAt: null,
      },
      {
        expiresAt: null,
        grantId: `audience:${userB}`,
        groupId: GROUP,
        issuedAt: NOW,
        participant: { kind: 'user', userId: userB },
        revision: 1,
        revokedAt: null,
      },
    ])
    expect(issued.enlistmentGrants).toEqual([
      {
        agent: agentA,
        expiresAt: null,
        grantId: `enlistment:${agentA.workspaceId}:${agentA.agentId}`,
        groupId: GROUP,
        issuedAt: NOW,
        revision: 1,
        revokedAt: null,
      },
    ])
  })

  test('is a pure function of its inputs, so a retried request issues identical grants', () => {
    const input = { groupId: GROUP, now: NOW, selection: { agents: [agentA], humans: [userA] } }
    expect(issueGroupGrants(input)).toEqual(issueGroupGrants(input))
  })

  test('never reuses a grant id across groups of the same person: ids carry the identity, the group binding is separate', () => {
    const one = issueGroupGrants({
      groupId: GROUP,
      now: NOW,
      selection: { agents: [], humans: [userA] },
    })
    const two = issueGroupGrants({
      groupId: OTHER_GROUP,
      now: NOW,
      selection: { agents: [], humans: [userA] },
    })
    expect(one.audienceGrants[0]!.groupId).toBe(GROUP)
    expect(two.audienceGrants[0]!.groupId).toBe(OTHER_GROUP)
  })

  test('same-named Agents in different workspaces get different grant ids', () => {
    const issued = issueGroupGrants({
      groupId: GROUP,
      now: NOW,
      selection: {
        agents: [agentA, { agentId: agentA.agentId, workspaceId: agentB.workspaceId }],
        humans: [],
      },
    })
    expect(new Set(issued.enlistmentGrants.map(({ grantId }) => grantId)).size).toBe(2)
  })

  test('an empty selection issues nothing', () => {
    expect(
      issueGroupGrants({ groupId: GROUP, now: NOW, selection: { agents: [], humans: [] } })
    ).toEqual({ audienceGrants: [], enlistmentGrants: [] })
  })
})

const admissionFor = (
  grant: GroupAudienceGrant | GroupAgentEnlistmentGrant,
  participant: GroupAdmission['participant']
): GroupAdmission => ({
  authorization: { grantId: grant.grantId, groupId: GROUP, revision: grant.revision },
  grant: {
    expiresAt: grant.expiresAt,
    issuedAt: grant.issuedAt,
    revokedAt: grant.revokedAt,
  },
  joinPoint: { joinedAt: EARLIER, joinedSequence: 1 },
  participant,
})
const humanAdmission = (grant: GroupAudienceGrant) => admissionFor(grant, grant.participant)
const agentAdmission = (grant: GroupAgentEnlistmentGrant) =>
  admissionFor(grant, { agentId: grant.agent.agentId, kind: 'agent' })

describe('issueGroupGrants: members who are on the roster', () => {
  test('a retained member keeps their exact grant: id, revision and original window', () => {
    const stored = audience({ revision: 3 })
    const storedAgent = enlistment({ revision: 2 })
    const issued = issueGroupGrants({
      groupId: GROUP,
      now: NOW,
      roster: [humanAdmission(stored), agentAdmission(storedAgent)],
      selection: { agents: [agentA], humans: [userA] },
      stored: { audienceGrants: [stored], enlistmentGrants: [storedAgent] },
    })
    expect(issued.audienceGrants).toEqual([stored])
    expect(issued.enlistmentGrants).toEqual([storedAgent])
  })

  test('the grant the admission is bound to is the one kept, not just the highest revision', () => {
    const bound = audience({ grantId: 'legacy-grant', revision: 2 })
    const issued = issueGroupGrants({
      groupId: GROUP,
      now: NOW,
      roster: [humanAdmission(bound)],
      selection: { agents: [], humans: [userA] },
      stored: { audienceGrants: [bound, audience({ revision: 9 })], enlistmentGrants: [] },
    })
    expect(issued.audienceGrants[0]).toEqual(bound)
  })

  test('a retained member whose grant was revoked is passed through unchanged, never renewed', () => {
    const revoked = audience({ revision: 2, revokedAt: EARLIER })
    const revokedAgent = enlistment({ revision: 5, revokedAt: EARLIER })
    const issued = issueGroupGrants({
      groupId: GROUP,
      now: NOW,
      roster: [humanAdmission(revoked), agentAdmission(revokedAgent)],
      selection: { agents: [agentA], humans: [userA] },
      stored: { audienceGrants: [revoked], enlistmentGrants: [revokedAgent] },
    })
    expect(issued.audienceGrants).toEqual([revoked])
    expect(issued.enlistmentGrants).toEqual([revokedAgent])
  })

  test('a retained member whose grant expired is passed through unchanged too', () => {
    const expired = audience({ expiresAt: EARLIER })
    const issued = issueGroupGrants({
      groupId: GROUP,
      now: NOW,
      roster: [humanAdmission(expired)],
      selection: { agents: [], humans: [userA] },
      stored: { audienceGrants: [expired], enlistmentGrants: [] },
    })
    expect(issued.audienceGrants).toEqual([expired])
  })

  test('a retained Agent grant is qualified by the selection’s workspace, so a mismatch is caught by the policy', () => {
    const held = enlistment()
    const issued = issueGroupGrants({
      groupId: GROUP,
      now: NOW,
      roster: [agentAdmission(held)],
      selection: {
        agents: [{ agentId: agentA.agentId, workspaceId: agentB.workspaceId }],
        humans: [],
      },
      stored: { audienceGrants: [], enlistmentGrants: [held] },
    })
    expect(issued.enlistmentGrants[0]!.agent).toEqual({
      agentId: agentA.agentId,
      workspaceId: agentB.workspaceId,
    })
  })
})

const refusal = (attempt: () => unknown) => {
  try {
    attempt()
  } catch (error) {
    expect(error).toBeInstanceOf(GroupCreationError)
    return (error as GroupCreationError).rejections
  }
  throw new Error('Expected the request to be refused')
}

describe('issueGroupGrants: a retained admission must keep its exact binding', () => {
  test('a binding whose grant is missing from storage is refused, not repaired', () => {
    const bound = audience({ grantId: 'legacy-grant' })
    const boundAgent = enlistment({ grantId: 'legacy-agent-grant' })
    const rejections = refusal(() =>
      issueGroupGrants({
        groupId: GROUP,
        now: NOW,
        roster: [humanAdmission(bound), agentAdmission(boundAgent)],
        selection: { agents: [agentA], humans: [userA] },
        // Storage holds other grants for the same people, which must not stand in.
        stored: { audienceGrants: [audience()], enlistmentGrants: [enlistment()] },
      })
    )
    expect(rejections).toEqual([
      {
        candidateIndex: 0,
        participant: { kind: 'user', userId: userA },
        reason: 'grant_absent',
        scope: 'candidate',
      },
      {
        candidateIndex: 1,
        participant: { agentId: agentA.agentId, kind: 'agent' },
        reason: 'grant_absent',
        scope: 'candidate',
      },
    ])
  })

  test('a binding with no stored grant at all is refused too', () => {
    const rejections = refusal(() =>
      issueGroupGrants({
        groupId: GROUP,
        now: NOW,
        roster: [humanAdmission(audience())],
        selection: { agents: [], humans: [userA] },
      })
    )
    expect(rejections.map(({ reason }) => reason)).toEqual(['grant_absent'])
  })

  test('a stored revision that moved past the bound one is refused, not adopted', () => {
    const rejections = refusal(() =>
      issueGroupGrants({
        groupId: GROUP,
        now: NOW,
        roster: [humanAdmission(audience({ revision: 1 })), agentAdmission(enlistment())],
        selection: { agents: [agentA], humans: [userA] },
        stored: {
          audienceGrants: [audience({ revision: 3 })],
          enlistmentGrants: [enlistment({ revision: 2 })],
        },
      })
    )
    expect(rejections.map(({ reason }) => reason)).toEqual([
      'grant_revision_invalid',
      'grant_revision_invalid',
    ])
  })

  test('a grant of the same id that belongs to someone else never matches', () => {
    const rejections = refusal(() =>
      issueGroupGrants({
        groupId: GROUP,
        now: NOW,
        roster: [humanAdmission(audience())],
        selection: { agents: [], humans: [userA] },
        stored: {
          audienceGrants: [audience({ participant: { kind: 'user', userId: userB } })],
          enlistmentGrants: [],
        },
      })
    )
    expect(rejections.map(({ reason }) => reason)).toEqual(['grant_absent'])
  })

  test('one divergent binding refuses the whole request: nothing is issued for the others', () => {
    const rejections = refusal(() =>
      issueGroupGrants({
        groupId: GROUP,
        now: NOW,
        roster: [humanAdmission(audience({ revision: 4 }))],
        selection: { agents: [], humans: [userA, userB] },
        stored: { audienceGrants: [audience({ revision: 5 })], enlistmentGrants: [] },
      })
    )
    expect(rejections).toHaveLength(1)
  })
})

describe('issueGroupGrants: people who are not on the roster', () => {
  test('even a still-effective stored grant is replaced by the next revision, never reused', () => {
    const issued = issueGroupGrants({
      groupId: GROUP,
      now: NOW,
      roster: [],
      selection: { agents: [agentA], humans: [userA] },
      stored: {
        audienceGrants: [audience({ revision: 3 })],
        enlistmentGrants: [enlistment({ revision: 2 })],
      },
    })
    expect(issued.audienceGrants[0]).toMatchObject({
      grantId: audienceGrantIdFor(userA),
      issuedAt: NOW,
      revision: 4,
      revokedAt: null,
    })
    expect(issued.enlistmentGrants[0]).toMatchObject({
      grantId: enlistmentGrantIdFor(agentA),
      issuedAt: NOW,
      revision: 3,
      revokedAt: null,
    })
  })

  test('a revoked or expired grant is replaced the same way', () => {
    const issued = issueGroupGrants({
      groupId: GROUP,
      now: NOW,
      selection: { agents: [agentA], humans: [userA, userB] },
      stored: {
        audienceGrants: [
          audience({ revision: 2, revokedAt: EARLIER }),
          audience({
            expiresAt: EARLIER,
            grantId: audienceGrantIdFor(userB),
            participant: { kind: 'user', userId: userB },
          }),
        ],
        enlistmentGrants: [enlistment({ revision: 5, revokedAt: EARLIER })],
      },
    })
    expect(issued.audienceGrants.map(({ revision }) => revision)).toEqual([3, 2])
    expect(issued.enlistmentGrants[0]!.revision).toBe(6)
  })

  test('a stored grant for someone else is never applied to the person asked for', () => {
    const issued = issueGroupGrants({
      groupId: GROUP,
      now: NOW,
      selection: { agents: [agentB], humans: [userB] },
      stored: { audienceGrants: [audience()], enlistmentGrants: [enlistment()] },
    })
    expect(issued.audienceGrants[0]).toMatchObject({
      grantId: audienceGrantIdFor(userB),
      participant: { userId: userB },
      revision: 1,
    })
    expect(issued.enlistmentGrants[0]).toMatchObject({ agent: agentB, revision: 1 })
  })
})
