import { describe, expect, test } from 'bun:test'
import type {
  GroupAdmission,
  GroupAgentEnlistmentGrant,
  GroupAudienceGrant,
  GroupSharingGrant,
} from '@adea-ai/types'

import {
  decideGroupHistoryRead,
  decideGroupPublication,
  decideGroupSummaryRead,
  decideGroupTurn,
  evaluateGroupGrantWindow,
  GROUP_CREATION_JOIN_SEQUENCE,
  sameQualifiedAgentIdentity,
  validateGroupCreation,
  workspaceQualifiedAgentKey,
} from '../../src/group-participation-policy'

const ISSUED = '2026-10-01T00:00:00.000Z'
const CREATED = '2026-10-05T00:00:00.000Z'
const NOW = '2026-10-08T12:00:00.000Z'
const WORKSPACE = 'wsp_adea'
const OTHER_WORKSPACE = 'wsp_elsewhere'

const ALICE = { kind: 'user' as const, userId: 'usr_alice' }
const BOB = { kind: 'user' as const, userId: 'usr_bob' }

function audienceGrant(
  overrides: Partial<GroupAudienceGrant> = {},
  participant = ALICE
): GroupAudienceGrant {
  return {
    expiresAt: null,
    grantId: 'gra_alice',
    issuedAt: ISSUED,
    participant,
    revokedAt: null,
    ...overrides,
  }
}

function enlistmentGrant(
  overrides: Partial<GroupAgentEnlistmentGrant> = {},
  agentId = 'agt_scout'
): GroupAgentEnlistmentGrant {
  return {
    agent: { agentId, workspaceId: WORKSPACE },
    expiresAt: null,
    grantId: `grn_${agentId}`,
    issuedAt: ISSUED,
    revokedAt: null,
    ...overrides,
  }
}

function admission(overrides: Partial<GroupAdmission> = {}): GroupAdmission {
  return {
    grant: { expiresAt: null, issuedAt: ISSUED, revokedAt: null },
    joinPoint: { joinedAt: CREATED, joinedSequence: 100 },
    participant: ALICE,
    ...overrides,
  }
}

function sharingGrant(
  scope: GroupSharingGrant['scope'],
  overrides: Partial<GroupSharingGrant> = {},
  participant = ALICE
): GroupSharingGrant {
  return {
    expiresAt: null,
    grantId: `grs_${scope}`,
    issuedAt: ISSUED,
    participant,
    revokedAt: null,
    scope,
    ...overrides,
  }
}

describe('group grant windows', () => {
  test('is effective inside the issued/expiry window', () => {
    expect(evaluateGroupGrantWindow(admission().grant, NOW)).toBe('effective')
  })

  test('is not yet issued before issuedAt and expired from expiresAt on', () => {
    expect(
      evaluateGroupGrantWindow(
        { expiresAt: null, issuedAt: '2026-10-08T12:00:00.001Z', revokedAt: null },
        NOW
      )
    ).toBe('not_yet_issued')
    const expiring = { expiresAt: NOW, issuedAt: ISSUED, revokedAt: null }
    expect(evaluateGroupGrantWindow(expiring, NOW)).toBe('expired')
    expect(evaluateGroupGrantWindow(expiring, '2026-10-08T11:59:59.999Z')).toBe('effective')
  })

  test('is revoked from revokedAt on, never before', () => {
    const revoked = { expiresAt: null, issuedAt: ISSUED, revokedAt: NOW }
    expect(evaluateGroupGrantWindow(revoked, NOW)).toBe('revoked')
    expect(evaluateGroupGrantWindow(revoked, '2026-10-07T23:59:59.999Z')).toBe('effective')
  })

  test('fails closed on unreadable timestamps: stale grants behave as absent', () => {
    expect(
      evaluateGroupGrantWindow({ expiresAt: null, issuedAt: 'not-a-date', revokedAt: null }, NOW)
    ).toBe('expired')
    expect(
      evaluateGroupGrantWindow({ expiresAt: 'junk', issuedAt: ISSUED, revokedAt: null }, NOW)
    ).toBe('expired')
    expect(evaluateGroupGrantWindow(admission().grant, 'junk')).toBe('expired')
  })
})

describe('group creation validation', () => {
  test('admits a fully granted human audience and enlisted Agents at the creation join point', () => {
    const validation = validateGroupCreation({
      candidates: [
        {
          audienceGrant: audienceGrant(),
          kind: 'human',
          participant: ALICE,
          workspaceId: WORKSPACE,
        },
        {
          enlistmentGrant: enlistmentGrant(),
          agentId: 'agt_scout',
          kind: 'agent',
          workspaceId: WORKSPACE,
        },
      ],
      now: CREATED,
      workspaceId: WORKSPACE,
    })

    expect(validation.ok).toBeTrue()
    if (!validation.ok) return
    expect(validation.roster).toHaveLength(2)
    for (const member of validation.roster) {
      expect(member.joinPoint).toEqual({
        joinedAt: CREATED,
        joinedSequence: GROUP_CREATION_JOIN_SEQUENCE,
      })
    }
    expect(validation.roster.map((member) => member.participant)).toEqual([
      ALICE,
      { agentId: 'agt_scout', kind: 'agent' },
    ])
  })

  test('is all-or-nothing: one invalid participant fails the whole creation', () => {
    const validation = validateGroupCreation({
      candidates: [
        {
          audienceGrant: audienceGrant(),
          kind: 'human',
          participant: ALICE,
          workspaceId: WORKSPACE,
        },
        {
          audienceGrant: audienceGrant({}, BOB),
          kind: 'human',
          participant: BOB,
          workspaceId: OTHER_WORKSPACE,
        },
        {
          enlistmentGrant: null,
          agentId: 'agt_unenlisted',
          kind: 'agent',
          workspaceId: WORKSPACE,
        },
      ],
      now: CREATED,
      workspaceId: WORKSPACE,
    })

    expect(validation.ok).toBeFalse()
    if (validation.ok) return
    // Both invalid participants are enumerated with typed reasons; the valid
    // human produces no rejection and no partial roster is produced.
    expect(validation.rejections).toEqual([
      {
        candidateIndex: 1,
        participant: BOB,
        reason: 'participant_cross_tenant',
        scope: 'candidate',
      },
      {
        candidateIndex: 2,
        participant: { agentId: 'agt_unenlisted', kind: 'agent' },
        reason: 'grant_absent',
        scope: 'candidate',
      },
    ])
  })

  test('rejects cross-tenant humans and Agents', () => {
    const validation = validateGroupCreation({
      candidates: [
        {
          audienceGrant: audienceGrant(),
          kind: 'human',
          participant: ALICE,
          workspaceId: OTHER_WORKSPACE,
        },
        {
          enlistmentGrant: enlistmentGrant({
            agent: { agentId: 'agt_scout', workspaceId: OTHER_WORKSPACE },
          }),
          agentId: 'agt_scout',
          kind: 'agent',
          workspaceId: OTHER_WORKSPACE,
        },
      ],
      now: CREATED,
      workspaceId: WORKSPACE,
    })

    expect(validation.ok).toBeFalse()
    if (validation.ok) return
    expect(validation.rejections.map((rejection) => rejection.reason)).toEqual([
      'participant_cross_tenant',
      'participant_cross_tenant',
    ])
  })

  test('rejects unqualified or unauthorized enlistment', () => {
    const validation = validateGroupCreation({
      candidates: [
        {
          audienceGrant: audienceGrant(),
          kind: 'human',
          participant: ALICE,
          workspaceId: WORKSPACE,
        },
        {
          enlistmentGrant: enlistmentGrant(),
          agentId: '   ',
          kind: 'agent',
          workspaceId: WORKSPACE,
        },
        {
          // A grant bound to a different qualified identity authorizes nothing.
          enlistmentGrant: enlistmentGrant(undefined, 'agt_other'),
          agentId: 'agt_scout',
          kind: 'agent',
          workspaceId: WORKSPACE,
        },
      ],
      now: CREATED,
      workspaceId: WORKSPACE,
    })

    expect(validation.ok).toBeFalse()
    if (validation.ok) return
    expect(validation.rejections.map((rejection) => rejection.reason)).toEqual([
      'participant_unqualified',
      'grant_mismatched_participant',
    ])
  })

  test('rejects stale participation grants with typed reasons', () => {
    const validation = validateGroupCreation({
      candidates: [
        {
          audienceGrant: audienceGrant({ expiresAt: CREATED }),
          kind: 'human',
          participant: ALICE,
          workspaceId: WORKSPACE,
        },
        {
          enlistmentGrant: enlistmentGrant({ issuedAt: '2026-10-20T00:00:00.000Z' }, 'agt_pending'),
          agentId: 'agt_pending',
          kind: 'agent',
          workspaceId: WORKSPACE,
        },
        {
          enlistmentGrant: enlistmentGrant({ revokedAt: ISSUED }, 'agt_revoked'),
          agentId: 'agt_revoked',
          kind: 'agent',
          workspaceId: WORKSPACE,
        },
      ],
      now: NOW,
      workspaceId: WORKSPACE,
    })

    expect(validation.ok).toBeFalse()
    if (validation.ok) return
    expect(validation.rejections.map((rejection) => rejection.reason)).toEqual([
      'grant_expired',
      'grant_not_yet_issued',
      'grant_revoked',
    ])
  })

  test('rejects an audience grant naming a different human', () => {
    const validation = validateGroupCreation({
      candidates: [
        {
          audienceGrant: audienceGrant(undefined, ALICE),
          kind: 'human',
          participant: BOB,
          workspaceId: WORKSPACE,
        },
      ],
      now: CREATED,
      workspaceId: WORKSPACE,
    })

    expect(validation.ok).toBeFalse()
    if (validation.ok) return
    expect(validation.rejections).toEqual([
      {
        candidateIndex: 0,
        participant: BOB,
        reason: 'grant_mismatched_participant',
        scope: 'candidate',
      },
    ])
  })

  test('rejects duplicate participants by identity, not by name', () => {
    const validation = validateGroupCreation({
      candidates: [
        {
          audienceGrant: audienceGrant(),
          kind: 'human',
          participant: ALICE,
          workspaceId: WORKSPACE,
        },
        {
          audienceGrant: audienceGrant({ grantId: 'gra_again' }),
          kind: 'human',
          participant: ALICE,
          workspaceId: WORKSPACE,
        },
        {
          enlistmentGrant: enlistmentGrant(),
          agentId: 'agt_scout',
          kind: 'agent',
          workspaceId: WORKSPACE,
        },
        {
          enlistmentGrant: enlistmentGrant({ grantId: 'grn_again' }),
          agentId: 'agt_scout',
          kind: 'agent',
          workspaceId: WORKSPACE,
        },
      ],
      now: CREATED,
      workspaceId: WORKSPACE,
    })

    expect(validation.ok).toBeFalse()
    if (validation.ok) return
    expect(validation.rejections.map((rejection) => rejection.reason)).toEqual([
      'duplicate_participant',
      'duplicate_participant',
    ])
  })

  test('rejects an empty audience, an Agents-only roster and a missing owning workspace', () => {
    const empty = validateGroupCreation({ candidates: [], now: CREATED, workspaceId: WORKSPACE })
    expect(empty).toEqual({ ok: false, rejections: [{ reason: 'audience_empty', scope: 'group' }] })

    const agentsOnly = validateGroupCreation({
      candidates: [
        {
          enlistmentGrant: enlistmentGrant(),
          agentId: 'agt_scout',
          kind: 'agent',
          workspaceId: WORKSPACE,
        },
      ],
      now: CREATED,
      workspaceId: WORKSPACE,
    })
    expect(agentsOnly).toEqual({
      ok: false,
      rejections: [{ reason: 'audience_requires_human', scope: 'group' }],
    })

    const noWorkspace = validateGroupCreation({
      candidates: [
        {
          audienceGrant: audienceGrant(),
          kind: 'human',
          participant: ALICE,
          workspaceId: WORKSPACE,
        },
      ],
      now: CREATED,
      workspaceId: '   ',
    })
    expect(noWorkspace).toEqual({
      ok: false,
      rejections: [{ reason: 'group_workspace_missing', scope: 'group' }],
    })
  })

  test('distinguishes same-name Agents by their workspace-qualified identity', () => {
    // Two Agents that would both be displayed as "Scout" share nothing but a
    // name; their qualified identities differ, so both enlist cleanly and a
    // grant bound to one never validates the other.
    const east = { agentId: 'agt_scout', workspaceId: WORKSPACE }
    const west = { agentId: 'agt_scout', workspaceId: OTHER_WORKSPACE }
    const twin = { agentId: 'agt_scout_twin', workspaceId: WORKSPACE }

    expect(workspaceQualifiedAgentKey(east)).toBe(`${WORKSPACE}:agt_scout`)
    expect(workspaceQualifiedAgentKey(east)).not.toBe(workspaceQualifiedAgentKey(west))
    expect(workspaceQualifiedAgentKey(east)).not.toBe(workspaceQualifiedAgentKey(twin))
    expect(sameQualifiedAgentIdentity(east, east)).toBeTrue()
    expect(sameQualifiedAgentIdentity(east, west)).toBeFalse()
    expect(sameQualifiedAgentIdentity(east, twin)).toBeFalse()

    const validation = validateGroupCreation({
      candidates: [
        {
          audienceGrant: audienceGrant(),
          kind: 'human',
          participant: ALICE,
          workspaceId: WORKSPACE,
        },
        {
          enlistmentGrant: enlistmentGrant(),
          agentId: 'agt_scout',
          kind: 'agent',
          workspaceId: WORKSPACE,
        },
        {
          enlistmentGrant: enlistmentGrant({ grantId: 'grn_twin' }, 'agt_scout_twin'),
          agentId: 'agt_scout_twin',
          kind: 'agent',
          workspaceId: WORKSPACE,
        },
      ],
      now: CREATED,
      workspaceId: WORKSPACE,
    })
    expect(validation.ok).toBeTrue()
  })
})

describe('join-point history policy', () => {
  test('allows history from the join point onward by default', () => {
    const member = admission()
    expect(
      decideGroupHistoryRead({
        admission: member,
        entry: { occurredAt: CREATED, sequence: 100 },
        now: NOW,
        sharingGrants: [],
      })
    ).toEqual({ action: 'allow', basis: 'within_join_point', participationState: 'effective' })
    expect(
      decideGroupHistoryRead({
        admission: member,
        entry: { occurredAt: NOW, sequence: 140 },
        now: NOW,
        sharingGrants: [],
      })
    ).toMatchObject({ action: 'allow', basis: 'within_join_point' })
  })

  test('denies earlier history without an explicit sharing grant', () => {
    const decision = decideGroupHistoryRead({
      admission: admission(),
      entry: { occurredAt: '2026-10-01T00:00:00.000Z', sequence: 99 },
      now: NOW,
      sharingGrants: [],
    })
    expect(decision).toEqual({
      action: 'deny',
      participationState: 'effective',
      reason: 'history_before_join_point',
    })
  })

  test('denies readers who were never admitted', () => {
    expect(
      decideGroupHistoryRead({
        admission: null,
        entry: { occurredAt: NOW, sequence: 140 },
        now: NOW,
        sharingGrants: [],
      })
    ).toEqual({ action: 'deny', reason: 'history_not_participant' })
  })

  test('revocation denies future reads immediately', () => {
    const decision = decideGroupHistoryRead({
      admission: admission({ grant: { expiresAt: null, issuedAt: ISSUED, revokedAt: NOW } }),
      entry: { occurredAt: NOW, sequence: 140 },
      now: NOW,
      sharingGrants: [],
    })
    expect(decision).toEqual({
      action: 'deny',
      participationState: 'revoked',
      reason: 'history_participation_revoked',
    })
  })

  test('an expired participation grant behaves as absent', () => {
    const decision = decideGroupHistoryRead({
      admission: admission({ grant: { expiresAt: NOW, issuedAt: ISSUED, revokedAt: null } }),
      entry: { occurredAt: NOW, sequence: 140 },
      now: NOW,
      sharingGrants: [],
    })
    expect(decision).toEqual({
      action: 'deny',
      participationState: 'expired',
      reason: 'history_not_participant',
    })
  })
})

describe('explicit earlier-history sharing', () => {
  test('an audience-aware grant unlocks earlier history for its reader', () => {
    const decision = decideGroupHistoryRead({
      admission: admission(),
      entry: { occurredAt: '2026-09-30T00:00:00.000Z', sequence: 10 },
      now: NOW,
      sharingGrants: [sharingGrant('earlier_history')],
    })
    expect(decision).toEqual({
      action: 'allow',
      basis: 'earlier_history_grant',
      participationState: 'effective',
    })
  })

  test('a sharing grant scoped to another participant authorizes nothing', () => {
    const decision = decideGroupHistoryRead({
      admission: admission(),
      entry: { occurredAt: '2026-09-30T00:00:00.000Z', sequence: 10 },
      now: NOW,
      sharingGrants: [sharingGrant('earlier_history', {}, BOB)],
    })
    expect(decision).toMatchObject({ action: 'deny', reason: 'history_before_join_point' })
  })

  test('an expired or revoked sharing grant behaves as absent', () => {
    const expired = decideGroupHistoryRead({
      admission: admission(),
      entry: { occurredAt: '2026-09-30T00:00:00.000Z', sequence: 10 },
      now: NOW,
      sharingGrants: [sharingGrant('earlier_history', { expiresAt: NOW })],
    })
    expect(expired).toMatchObject({ action: 'deny', reason: 'history_before_join_point' })

    const revoked = decideGroupHistoryRead({
      admission: admission(),
      entry: { occurredAt: '2026-09-30T00:00:00.000Z', sequence: 10 },
      now: NOW,
      sharingGrants: [sharingGrant('earlier_history', { revokedAt: ISSUED })],
    })
    expect(revoked).toMatchObject({ action: 'deny', reason: 'history_before_join_point' })
  })

  test('a history grant never unlocks earlier summaries', () => {
    const decision = decideGroupSummaryRead({
      admission: admission(),
      fromSequence: 10,
      now: NOW,
      sharingGrants: [sharingGrant('earlier_history')],
    })
    expect(decision).toEqual({
      action: 'deny',
      participationState: 'effective',
      reason: 'summary_before_join_point',
    })
  })
})

describe('explicit earlier-summary sharing', () => {
  test('summaries within the join point need no grant', () => {
    const decision = decideGroupSummaryRead({
      admission: admission(),
      fromSequence: 100,
      now: NOW,
      sharingGrants: [],
    })
    expect(decision).toEqual({
      action: 'allow',
      basis: 'within_join_point',
      participationState: 'effective',
    })
  })

  test('an earlier-summary grant unlocks earlier summaries for its reader', () => {
    const decision = decideGroupSummaryRead({
      admission: admission(),
      fromSequence: 10,
      now: NOW,
      sharingGrants: [sharingGrant('earlier_summary')],
    })
    expect(decision).toEqual({
      action: 'allow',
      basis: 'earlier_summary_grant',
      participationState: 'effective',
    })
  })

  test('a summary grant never unlocks earlier history', () => {
    const decision = decideGroupHistoryRead({
      admission: admission(),
      entry: { occurredAt: '2026-09-30T00:00:00.000Z', sequence: 10 },
      now: NOW,
      sharingGrants: [sharingGrant('earlier_summary')],
    })
    expect(decision).toMatchObject({ action: 'deny', reason: 'history_before_join_point' })
  })

  test('denies readers who were never admitted', () => {
    expect(
      decideGroupSummaryRead({
        admission: null,
        fromSequence: 10,
        now: NOW,
        sharingGrants: [sharingGrant('earlier_summary')],
      })
    ).toEqual({ action: 'deny', reason: 'summary_not_participant' })
  })
})

describe('turn policy', () => {
  test('allows a turn for an effective participant', () => {
    expect(decideGroupTurn({ admission: admission(), now: NOW })).toEqual({ action: 'allow' })
  })

  test('denies turns immediately after revocation', () => {
    expect(
      decideGroupTurn({
        admission: admission({ grant: { expiresAt: null, issuedAt: ISSUED, revokedAt: NOW } }),
        now: NOW,
      })
    ).toEqual({
      action: 'deny',
      participationState: 'revoked',
      reason: 'turn_participation_revoked',
    })
  })

  test('an expired grant or absent admission behaves as not a participant', () => {
    expect(
      decideGroupTurn({
        admission: admission({ grant: { expiresAt: CREATED, issuedAt: ISSUED, revokedAt: null } }),
        now: NOW,
      })
    ).toEqual({
      action: 'deny',
      participationState: 'expired',
      reason: 'turn_not_participant',
    })
    expect(decideGroupTurn({ admission: null, now: NOW })).toEqual({
      action: 'deny',
      reason: 'turn_not_participant',
    })
  })
})

describe('revocation as a publication gate', () => {
  const job = {
    completedAt: '2026-10-08T11:00:00.000Z',
    jobId: 'job_1',
    participant: ALICE,
  }

  test('publishes a result whose participant is still authorized', () => {
    expect(
      decideGroupPublication({ admission: admission(), job, now: NOW, publisher: ALICE })
    ).toEqual({ action: 'publish', basis: 'participant_authorized', jobId: 'job_1' })
  })

  test('holds a revoked participant late result completing after revocation', () => {
    // Revoked at 10:00; the job completed at 11:00 and tries to publish now.
    const revokedAt = '2026-10-08T10:00:00.000Z'
    const decision = decideGroupPublication({
      admission: admission({ grant: { expiresAt: null, issuedAt: ISSUED, revokedAt } }),
      job,
      now: NOW,
      publisher: ALICE,
    })
    expect(decision).toEqual({
      action: 'hold',
      jobId: 'job_1',
      reason: 'publication_participation_revoked',
    })
  })

  test('holds late publication even when the work completed before revocation', () => {
    const decision = decideGroupPublication({
      admission: admission({ grant: { expiresAt: null, issuedAt: ISSUED, revokedAt: NOW } }),
      job: { ...job, completedAt: '2026-10-07T00:00:00.000Z' },
      now: NOW,
      publisher: ALICE,
    })
    expect(decision).toEqual({
      action: 'hold',
      jobId: 'job_1',
      reason: 'publication_participation_revoked',
    })
  })

  test('holds without cancelling: the decision is a pure gate on one result', () => {
    const decision = decideGroupPublication({
      admission: admission({ grant: { expiresAt: null, issuedAt: ISSUED, revokedAt: NOW } }),
      job,
      now: NOW,
      publisher: ALICE,
    })
    expect(decision).toEqual({
      action: 'hold',
      jobId: 'job_1',
      reason: 'publication_participation_revoked',
    })
    // The gate names no cancellation, reassignment or retry semantics: the
    // job's lifecycle stays independently owned.
    expect(Object.keys(decision).toSorted()).toEqual(['action', 'jobId', 'reason'])
  })

  test('an expired participation grant holds late publication', () => {
    const decision = decideGroupPublication({
      admission: admission({
        grant: { expiresAt: '2026-10-08T11:30:00.000Z', issuedAt: ISSUED, revokedAt: null },
      }),
      job,
      now: NOW,
      publisher: ALICE,
    })
    expect(decision).toEqual({
      action: 'hold',
      jobId: 'job_1',
      reason: 'publication_participation_stale',
    })
  })

  test('holds work that was already unauthorized at completion', () => {
    const decision = decideGroupPublication({
      admission: admission({ grant: { expiresAt: null, issuedAt: NOW, revokedAt: null } }),
      job,
      now: NOW,
      publisher: ALICE,
    })
    expect(decision).toEqual({
      action: 'hold',
      jobId: 'job_1',
      reason: 'publication_unauthorized_at_completion',
    })
  })

  test('never transfers authority: a different publisher or admission is a mismatch', () => {
    expect(
      decideGroupPublication({ admission: admission(), job, now: NOW, publisher: BOB })
    ).toEqual({
      action: 'hold',
      jobId: 'job_1',
      reason: 'publication_authority_mismatch',
    })
    expect(
      decideGroupPublication({
        admission: admission({ participant: BOB }),
        job,
        now: NOW,
        publisher: ALICE,
      })
    ).toEqual({
      action: 'hold',
      jobId: 'job_1',
      reason: 'publication_authority_mismatch',
    })
  })

  test('holds publication for a participant who was never admitted', () => {
    expect(decideGroupPublication({ admission: null, job, now: NOW, publisher: ALICE })).toEqual({
      action: 'hold',
      jobId: 'job_1',
      reason: 'publication_unauthorized_at_completion',
    })
  })
})
