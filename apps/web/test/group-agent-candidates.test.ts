import { describe, expect, test } from 'bun:test'

import {
  GROUP_AGENT_CANDIDATE_LIMITS,
  listGroupAgentCandidates,
  parseGroupAgentCandidateScope,
  type GroupAgentCandidateScope,
  type GroupAgentCandidateSummary,
} from '../src/server/group-agent-candidates'

const principal = { kind: 'user', userId: '11111111-1111-4111-8111-111111111111' } as const
const tenantWorkspaceId = '22222222-2222-4222-8222-222222222222'
const sourceWorkspaceId = '33333333-3333-4333-8333-333333333333'
const otherSourceWorkspaceId = '44444444-4444-4444-8444-444444444444'

function candidate(
  overrides: Partial<GroupAgentCandidateSummary> = {}
): GroupAgentCandidateSummary {
  return {
    agentId: '55555555-5555-4555-8555-555555555555',
    name: 'Ada',
    workspaceId: sourceWorkspaceId,
    ...overrides,
  }
}

function scope(overrides: Partial<GroupAgentCandidateScope> = {}): GroupAgentCandidateScope {
  return {
    principal,
    sourceWorkspaceIds: [sourceWorkspaceId],
    workspaceId: tenantWorkspaceId,
    ...overrides,
  }
}

describe('foreign-Agent candidate read model', () => {
  test('parses a canonical scope and bounds the named source workspaces', () => {
    const parsed = parseGroupAgentCandidateScope(
      {
        sourceWorkspaceIds: [
          sourceWorkspaceId,
          sourceWorkspaceId,
          otherSourceWorkspaceId,
          'not-a-uuid',
          42,
          null,
        ],
        workspaceId: tenantWorkspaceId,
      },
      principal
    )
    expect(parsed?.sourceWorkspaceIds).toEqual([sourceWorkspaceId, otherSourceWorkspaceId])
    expect(parsed?.workspaceId).toBe(tenantWorkspaceId)
    expect(parsed?.principal).toBe(principal)
  })

  test('caps the number of source workspaces it will consider', () => {
    const sources = Array.from(
      { length: GROUP_AGENT_CANDIDATE_LIMITS.sourceWorkspaces + 5 },
      (_value, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
    )
    const parsed = parseGroupAgentCandidateScope(
      { sourceWorkspaceIds: sources, workspaceId: tenantWorkspaceId },
      principal
    )
    expect(parsed?.sourceWorkspaceIds).toHaveLength(GROUP_AGENT_CANDIDATE_LIMITS.sourceWorkspaces)
  })

  test('fails closed on a malformed scope', () => {
    expect(parseGroupAgentCandidateScope(null, principal)).toBeNull()
    expect(parseGroupAgentCandidateScope('nope', principal)).toBeNull()
    expect(
      parseGroupAgentCandidateScope(
        { sourceWorkspaceIds: [], workspaceId: 'not-a-uuid' },
        principal
      )
    ).toBeNull()
    expect(
      parseGroupAgentCandidateScope(
        { sourceWorkspaceIds: 'nope', workspaceId: tenantWorkspaceId },
        principal
      )
    ).toBeNull()
    expect(parseGroupAgentCandidateScope({ workspaceId: tenantWorkspaceId }, principal)).toBeNull()
  })

  test('answers with stable workspace-qualified identities and no duplicate', async () => {
    const listing = await listGroupAgentCandidates(scope(), {
      listCandidates: async () => [
        candidate(),
        candidate(),
        candidate({ agentId: '66666666-6666-4666-8666-666666666666', name: 'Grace' }),
      ],
    })
    expect(listing.status).toBe('available')
    expect(listing.candidates).toEqual([
      candidate(),
      candidate({ agentId: '66666666-6666-4666-8666-666666666666', name: 'Grace' }),
    ])
    expect(listing.candidates.map((entry) => `${entry.workspaceId}:${entry.agentId}`)).toEqual([
      `${sourceWorkspaceId}:55555555-5555-4555-8555-555555555555`,
      `${sourceWorkspaceId}:66666666-6666-4666-8666-666666666666`,
    ])
  })

  test('drops a candidate that claims the tenant workspace or a malformed identity', async () => {
    const listing = await listGroupAgentCandidates(scope(), {
      listCandidates: async () => [
        candidate({ workspaceId: tenantWorkspaceId }),
        candidate({ workspaceId: 'not-a-uuid' }),
        candidate({ name: 42 as unknown as string }),
        candidate(),
      ],
    })
    expect(listing.candidates).toEqual([candidate()])
  })

  test('never reports enlistment authority and never carries a grant identity', async () => {
    const listing = await listGroupAgentCandidates(scope(), {
      listCandidates: async () => [candidate()],
    })
    expect(listing.grantsEnlistment).toBe(false)
    expect(Object.keys(listing).toSorted()).toEqual(['candidates', 'grantsEnlistment', 'status'])
    expect(Object.keys(listing.candidates[0]!).toSorted()).toEqual([
      'agentId',
      'name',
      'workspaceId',
    ])
    expect(JSON.stringify(listing)).not.toContain('grantId')
    expect(JSON.stringify(listing)).not.toContain('revision')
  })

  test('a failed read is unavailable, empty and leaks no upstream detail', async () => {
    const listing = await listGroupAgentCandidates(scope(), {
      listCandidates: async () => {
        throw new Error('database password leaked into the response')
      },
    })
    expect(listing.status).toBe('unavailable')
    expect(listing.candidates).toEqual([])
    expect(listing.grantsEnlistment).toBe(false)
    expect(JSON.stringify(listing)).not.toContain('password')
  })

  test('passes exactly the validated scope to the candidate read', async () => {
    const requested: GroupAgentCandidateScope[] = []
    await listGroupAgentCandidates(
      scope({
        sourceWorkspaceIds: [sourceWorkspaceId, otherSourceWorkspaceId, 'not-a-uuid'],
      }),
      {
        listCandidates: async (input) => {
          requested.push(input)
          return []
        },
      }
    )
    expect(requested).toHaveLength(1)
    expect(requested[0]?.sourceWorkspaceIds).toEqual([sourceWorkspaceId, otherSourceWorkspaceId])
    expect(requested[0]?.workspaceId).toBe(tenantWorkspaceId)
    expect(requested[0]?.principal).toBe(principal)
  })
})
