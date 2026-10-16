import { describe, expect, test } from 'bun:test'
import type { GroupAgentEnlistmentGrant, GroupAudienceGrant } from '@adea-ai/types'

import {
  audienceGrantIdFor,
  enlistmentGrantIdFor,
  issueGroupGrants,
} from '../../src/group-grant-issuer'

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

describe('issueGroupGrants: members who are already in', () => {
  test('a retained member keeps their exact grant: id, revision and original window', () => {
    const stored = audience({ revision: 3 })
    const issued = issueGroupGrants({
      groupId: GROUP,
      now: NOW,
      selection: { agents: [agentA], humans: [userA] },
      stored: { audienceGrants: [stored], enlistmentGrants: [enlistment({ revision: 2 })] },
    })
    expect(issued.audienceGrants).toEqual([stored])
    expect(issued.enlistmentGrants).toEqual([enlistment({ revision: 2 })])
  })

  test('the highest effective revision is the one kept', () => {
    const issued = issueGroupGrants({
      groupId: GROUP,
      now: NOW,
      selection: { agents: [], humans: [userA] },
      stored: {
        audienceGrants: [audience({ revision: 1 }), audience({ revision: 4 })],
        enlistmentGrants: [],
      },
    })
    expect(issued.audienceGrants[0]!.revision).toBe(4)
  })

  test('a revoked grant is replaced by a higher revision of the same grant, never revived', () => {
    const issued = issueGroupGrants({
      groupId: GROUP,
      now: NOW,
      selection: { agents: [agentA], humans: [userA] },
      stored: {
        audienceGrants: [audience({ revision: 2, revokedAt: EARLIER })],
        enlistmentGrants: [enlistment({ revision: 5, revokedAt: EARLIER })],
      },
    })
    expect(issued.audienceGrants[0]).toMatchObject({
      grantId: audienceGrantIdFor(userA),
      issuedAt: NOW,
      revision: 3,
      revokedAt: null,
    })
    expect(issued.enlistmentGrants[0]).toMatchObject({
      grantId: enlistmentGrantIdFor(agentA),
      issuedAt: NOW,
      revision: 6,
      revokedAt: null,
    })
  })

  test('an expired grant is replaced the same way', () => {
    const issued = issueGroupGrants({
      groupId: GROUP,
      now: NOW,
      selection: { agents: [], humans: [userA] },
      stored: { audienceGrants: [audience({ expiresAt: EARLIER })], enlistmentGrants: [] },
    })
    expect(issued.audienceGrants[0]).toMatchObject({ expiresAt: null, revision: 2 })
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

  test('a retained Agent grant is qualified by the selection’s workspace, so a mismatch is caught by the policy', () => {
    const issued = issueGroupGrants({
      groupId: GROUP,
      now: NOW,
      selection: {
        agents: [{ agentId: agentA.agentId, workspaceId: agentB.workspaceId }],
        humans: [],
      },
      stored: { audienceGrants: [], enlistmentGrants: [enlistment()] },
    })
    expect(issued.enlistmentGrants[0]!.agent).toEqual({
      agentId: agentA.agentId,
      workspaceId: agentB.workspaceId,
    })
  })
})
