import { describe, expect, test } from 'bun:test'
import type {
  ChannelSummary,
  GroupAdmission,
  GroupAgentEnlistmentGrant,
  GroupAudienceGrant,
  GroupSharingGrant,
} from '@adea-ai/types'

import {
  admissionForParticipant,
  assertGroupChannelGate,
  authorizeGroupChannelHistoryRead,
  authorizeGroupChannelPublication,
  authorizeGroupChannelSummaryRead,
  authorizeGroupChannelTurn,
  createGroupChannelWithGrants,
  groupCreationCandidatesFromGrants,
  groupCreationPayloadHash,
  GroupCreationError,
  partitionGroupChannelHistory,
  resolveAdmissionWindow,
  setGroupChannelParticipantsWithGrants,
  type GroupChannelGate,
} from '../../src/group-channels'

const ISSUED = '2026-10-01T00:00:00.000Z'
const NOW = '2026-10-08T12:00:00.000Z'
const COMPLETED = '2026-10-08T11:00:00.000Z'
const WORKSPACE = 'wsp_adea'
const OTHER_WORKSPACE = 'wsp_elsewhere'
const CHANNEL = 'ch_group'
const OTHER_CHANNEL = 'ch_elsewhere'

const ALICE = { kind: 'user' as const, userId: 'usr_alice' }
const BOB = { kind: 'user' as const, userId: 'usr_bob' }
const AGENT = { agentId: 'agt_doc', kind: 'agent' as const }

function channel(overrides: Partial<ChannelSummary> = {}): ChannelSummary {
  return {
    createdAt: NOW,
    id: CHANNEL,
    isPrimaryProjectChannel: false,
    kind: 'group',
    lifecycleState: 'active',
    participants: [ALICE],
    sortOrder: 0,
    title: 'Group',
    updatedAt: NOW,
    version: 1,
    visibility: 'participants',
    workspaceId: WORKSPACE,
    ...overrides,
  }
}

function gate(overrides: Partial<ChannelSummary> = {}): GroupChannelGate {
  return { channel: channel(overrides), workspaceId: WORKSPACE }
}

function audienceGrant(
  overrides: Partial<GroupAudienceGrant> = {},
  participant = ALICE
): GroupAudienceGrant {
  return {
    expiresAt: null,
    grantId: 'gra_alice',
    groupId: CHANNEL,
    issuedAt: ISSUED,
    participant,
    revision: 1,
    revokedAt: null,
    ...overrides,
  }
}

function enlistmentGrant(
  overrides: Partial<GroupAgentEnlistmentGrant> = {},
  agent = { agentId: 'agt_doc', workspaceId: WORKSPACE }
): GroupAgentEnlistmentGrant {
  return {
    agent,
    expiresAt: null,
    grantId: 'gra_doc',
    groupId: CHANNEL,
    issuedAt: ISSUED,
    revision: 1,
    revokedAt: null,
    ...overrides,
  }
}

function sharingGrant(
  scope: 'earlier_history' | 'earlier_summary',
  overrides: Partial<GroupSharingGrant> = {}
): GroupSharingGrant {
  return {
    expiresAt: null,
    grantId: 'gra_share',
    groupId: CHANNEL,
    issuedAt: ISSUED,
    participant: ALICE,
    revision: 1,
    revokedAt: null,
    scope,
    ...overrides,
  }
}

function admission(overrides: Partial<GroupAdmission> = {}): GroupAdmission {
  return {
    authorization: { groupId: CHANNEL, grantId: 'gra_alice', revision: 1 },
    grant: { expiresAt: null, issuedAt: ISSUED, revokedAt: null },
    joinPoint: { joinedAt: NOW, joinedSequence: 0 },
    participant: ALICE,
    ...overrides,
  }
}

describe('group creation candidates from grants', () => {
  test('maps audience and enlistment grants to tenant-checked candidates', () => {
    const candidates = groupCreationCandidatesFromGrants(WORKSPACE, {
      audienceGrants: [audienceGrant()],
      enlistmentGrants: [enlistmentGrant()],
    })
    expect(candidates).toHaveLength(2)
    expect(candidates[0]).toEqual({
      audienceGrant: audienceGrant(),
      kind: 'human',
      participant: ALICE,
      workspaceId: WORKSPACE,
    })
    expect(candidates[1]).toEqual({
      agentId: 'agt_doc',
      enlistmentGrant: enlistmentGrant(),
      kind: 'agent',
      workspaceId: WORKSPACE,
    })
  })

  test('preserves a foreign Agent workspace so the policy rejects it as cross-tenant', () => {
    const foreign = enlistmentGrant({}, { agentId: 'agt_doc', workspaceId: OTHER_WORKSPACE })
    const candidates = groupCreationCandidatesFromGrants(WORKSPACE, {
      audienceGrants: [audienceGrant()],
      enlistmentGrants: [foreign],
    })
    expect(candidates[1]).toMatchObject({ kind: 'agent', workspaceId: OTHER_WORKSPACE })
  })
})

describe('group channel isolation gate', () => {
  test('accepts a participants-scoped group channel in its owning workspace', () => {
    expect(() => assertGroupChannelGate(gate())).not.toThrow()
  })

  test('rejects project lanes, direct topics, workspace-visible channels and foreign workspaces', () => {
    expect(() => assertGroupChannelGate(gate({ kind: 'project' }))).toThrow('Channel unavailable')
    expect(() => assertGroupChannelGate(gate({ kind: 'direct_agent' }))).toThrow(
      'Channel unavailable'
    )
    expect(() => assertGroupChannelGate(gate({ visibility: 'workspace' }))).toThrow(
      'Channel unavailable'
    )
    expect(() => assertGroupChannelGate(gate({ projectId: 'prj_1' }))).toThrow(
      'Channel unavailable'
    )
    expect(() => assertGroupChannelGate(gate({ agentId: 'agt_doc' }))).toThrow(
      'Channel unavailable'
    )
    expect(() =>
      assertGroupChannelGate({ channel: channel(), workspaceId: OTHER_WORKSPACE })
    ).toThrow('Channel unavailable')
  })

  test('decision helpers enforce the gate before the policy runs', () => {
    const foreign = gate({ kind: 'direct_agent' })
    expect(() => authorizeGroupChannelTurn(foreign, { admission: admission(), now: NOW })).toThrow(
      'Channel unavailable'
    )
    expect(() =>
      authorizeGroupChannelHistoryRead(foreign, {
        admission: admission(),
        entry: { occurredAt: NOW, sequence: 0 },
        now: NOW,
        sharingGrants: [],
      })
    ).toThrow('Channel unavailable')
  })
})

describe('channel-pinned history, summary and turns', () => {
  test('a founder reads from the join point onward by default', () => {
    const decision = authorizeGroupChannelHistoryRead(gate(), {
      admission: admission(),
      entry: { occurredAt: NOW, sequence: 0 },
      now: NOW,
      sharingGrants: [],
    })
    expect(decision).toEqual({
      action: 'allow',
      basis: 'within_join_point',
      participationState: 'effective',
    })
  })

  test('earlier history needs an audience-aware sharing grant, and history never unlocks summaries', () => {
    const denied = authorizeGroupChannelHistoryRead(gate(), {
      admission: admission({ joinPoint: { joinedAt: NOW, joinedSequence: 4 } }),
      entry: { occurredAt: NOW, sequence: 1 },
      now: NOW,
      sharingGrants: [],
    })
    expect(denied).toMatchObject({ action: 'deny', reason: 'history_before_join_point' })
    const late = admission({ joinPoint: { joinedAt: NOW, joinedSequence: 4 } })
    const unlocked = authorizeGroupChannelHistoryRead(gate(), {
      admission: late,
      entry: { occurredAt: NOW, sequence: 1 },
      now: NOW,
      sharingGrants: [sharingGrant('earlier_history')],
    })
    expect(unlocked).toMatchObject({ action: 'allow', basis: 'earlier_history_grant' })
    const summaryStillDenied = authorizeGroupChannelSummaryRead(gate(), {
      admission: late,
      fromSequence: 1,
      now: NOW,
      sharingGrants: [sharingGrant('earlier_history')],
    })
    expect(summaryStillDenied).toMatchObject({
      action: 'deny',
      reason: 'summary_before_join_point',
    })
    const summaryUnlocked = authorizeGroupChannelSummaryRead(gate(), {
      admission: late,
      fromSequence: 1,
      now: NOW,
      sharingGrants: [sharingGrant('earlier_summary')],
    })
    expect(summaryUnlocked).toMatchObject({ action: 'allow', basis: 'earlier_summary_grant' })
  })

  test('a revoked grant denies future reads and turns immediately', () => {
    const revoked = admission({
      grant: { expiresAt: null, issuedAt: ISSUED, revokedAt: NOW },
    })
    expect(
      authorizeGroupChannelHistoryRead(gate(), {
        admission: revoked,
        entry: { occurredAt: NOW, sequence: 9 },
        now: NOW,
        sharingGrants: [],
      })
    ).toMatchObject({ action: 'deny', reason: 'history_participation_revoked' })
    expect(authorizeGroupChannelTurn(gate(), { admission: revoked, now: NOW })).toMatchObject({
      action: 'deny',
      reason: 'turn_participation_revoked',
    })
  })

  test('one group admission never reads or turns in another group', () => {
    const foreignAdmission = admission({
      authorization: { groupId: OTHER_CHANNEL, grantId: 'gra_alice', revision: 1 },
    })
    expect(
      authorizeGroupChannelHistoryRead(gate(), {
        admission: foreignAdmission,
        entry: { occurredAt: NOW, sequence: 9 },
        now: NOW,
        sharingGrants: [],
      })
    ).toMatchObject({ action: 'deny', reason: 'grant_mismatched_group' })
    expect(
      authorizeGroupChannelTurn(gate(), { admission: foreignAdmission, now: NOW })
    ).toMatchObject({ action: 'deny', reason: 'grant_mismatched_group' })
    expect(
      authorizeGroupChannelHistoryRead(gate(), {
        admission: admission(),
        entry: { occurredAt: NOW, sequence: 9 },
        now: NOW,
        sharingGrants: [sharingGrant('earlier_history', { groupId: OTHER_CHANNEL })],
      })
    ).toMatchObject({
      action: 'allow',
      basis: 'within_join_point',
      participationState: 'effective',
    })
  })
})

describe('channel-pinned publication', () => {
  const job = {
    authorization: { groupId: CHANNEL, grantId: 'gra_alice', revision: 1 },
    completedAt: COMPLETED,
    jobId: 'job_1',
    participant: ALICE,
  }

  test('an effective participant publishes; a hold carries only the gate verdict', () => {
    const published = authorizeGroupChannelPublication(gate(), {
      admission: admission(),
      job,
      now: NOW,
      publisher: ALICE,
    })
    expect(published).toEqual({
      action: 'publish',
      basis: 'participant_authorized',
      jobId: 'job_1',
    })
    const before = structuredClone(job)
    const held = authorizeGroupChannelPublication(gate(), {
      admission: admission({
        grant: { expiresAt: null, issuedAt: ISSUED, revokedAt: NOW },
      }),
      job,
      now: NOW,
      publisher: ALICE,
    })
    expect(held).toEqual({
      action: 'hold',
      jobId: 'job_1',
      reason: 'publication_participation_revoked',
    })
    expect(Object.keys(held)).toEqual(['action', 'jobId', 'reason'])
    expect(job).toEqual(before)
  })

  test('a foreign admission and job pair that match each other is still held here', () => {
    const foreignAdmission = admission({
      authorization: { groupId: OTHER_CHANNEL, grantId: 'gra_x', revision: 2 },
    })
    const foreignJob = {
      ...job,
      authorization: { groupId: OTHER_CHANNEL, grantId: 'gra_x', revision: 2 },
    }
    expect(
      authorizeGroupChannelPublication(gate(), {
        admission: foreignAdmission,
        job: foreignJob,
        now: NOW,
        publisher: ALICE,
      })
    ).toEqual({ action: 'hold', jobId: 'job_1', reason: 'publication_binding_mismatch' })
  })

  test('publication never transfers authority to another participant', () => {
    expect(
      authorizeGroupChannelPublication(gate(), {
        admission: admission(),
        job,
        now: NOW,
        publisher: BOB,
      })
    ).toMatchObject({ action: 'hold', reason: 'publication_authority_mismatch' })
  })
})

describe('partitionGroupChannelHistory', () => {
  test('splits visible from held earlier entries while preserving order', () => {
    const late = admission({ joinPoint: { joinedAt: NOW, joinedSequence: 4 } })
    const entries = [
      { occurredAt: NOW, sequence: 1 },
      { occurredAt: NOW, sequence: 5 },
      { occurredAt: NOW, sequence: 2 },
      { occurredAt: NOW, sequence: 7 },
    ]
    const { hidden, visible } = partitionGroupChannelHistory(gate(), {
      admission: late,
      entries,
      now: NOW,
      sharingGrants: [],
    })
    expect(visible).toEqual([
      { occurredAt: NOW, sequence: 5 },
      { occurredAt: NOW, sequence: 7 },
    ])
    expect(hidden).toEqual([
      { occurredAt: NOW, sequence: 1 },
      { occurredAt: NOW, sequence: 2 },
    ])
  })
})

describe('admissionForParticipant', () => {
  test('resolves users and Agents by identity, never by display name', () => {
    const roster = [
      admission(),
      admission({
        authorization: { groupId: CHANNEL, grantId: 'gra_doc', revision: 1 },
        participant: AGENT,
      }),
    ]
    expect(admissionForParticipant(roster, ALICE)?.authorization.grantId).toBe('gra_alice')
    expect(admissionForParticipant(roster, AGENT)?.authorization.grantId).toBe('gra_doc')
    expect(admissionForParticipant(roster, BOB)).toBeNull()
  })
})

describe('groupCreationPayloadHash', () => {
  test('is stable across roster order and sensitive to title, workspace and grant revision', () => {
    const left = groupCreationPayloadHash('Group', WORKSPACE, [
      admission(),
      admission({
        authorization: { groupId: CHANNEL, grantId: 'gra_doc', revision: 1 },
        participant: AGENT,
      }),
    ])
    const reordered = groupCreationPayloadHash('Group', WORKSPACE, [
      admission({
        authorization: { groupId: CHANNEL, grantId: 'gra_doc', revision: 1 },
        participant: AGENT,
      }),
      admission(),
    ])
    expect(reordered).toBe(left)
    expect(groupCreationPayloadHash('Other', WORKSPACE, [admission()])).not.toBe(
      groupCreationPayloadHash('Group', WORKSPACE, [admission()])
    )
    expect(
      groupCreationPayloadHash('Group', WORKSPACE, [
        admission({ authorization: { groupId: CHANNEL, grantId: 'gra_alice', revision: 2 } }),
      ])
    ).not.toBe(groupCreationPayloadHash('Group', WORKSPACE, [admission()]))
  })
})

function stubDatabase(calls: { count: number }) {
  return {
    transaction: () => {
      calls.count += 1
      throw new Error('stub-transaction must not run on rejected input')
    },
  } as never
}

describe('grant-gated writes fail closed before any database access', () => {
  test('creation rejects an ungranted roster with typed rejections and zero writes', async () => {
    const calls = { count: 0 }
    const candidates = groupCreationCandidatesFromGrants(WORKSPACE, {
      audienceGrants: [],
      enlistmentGrants: [],
    })
    const failure = await createGroupChannelWithGrants(stubDatabase(calls), WORKSPACE, ALICE, {
      candidates,
      channelId: CHANNEL,
      idempotencyKey: 'group-1',
      now: NOW,
      title: 'Group',
    }).then(
      () => {
        throw new Error('creation must reject')
      },
      (error: unknown) => error
    )
    expect(failure).toBeInstanceOf(GroupCreationError)
    expect((failure as GroupCreationError).rejections).toMatchObject([
      { reason: 'audience_empty', scope: 'group' },
    ])
    expect(calls.count).toBe(0)
  })

  test('creation validates before writing: a valid roster enters exactly one transaction', async () => {
    const calls = { count: 0 }
    const candidates = groupCreationCandidatesFromGrants(WORKSPACE, {
      audienceGrants: [audienceGrant()],
      enlistmentGrants: [enlistmentGrant()],
    })
    await expect(
      createGroupChannelWithGrants(stubDatabase(calls), WORKSPACE, ALICE, {
        candidates,
        channelId: CHANNEL,
        idempotencyKey: 'group-1',
        now: NOW,
        title: 'Group',
      })
    ).rejects.toThrow('stub-transaction must not run on rejected input')
    expect(calls.count).toBe(1)
  })

  test('roster replacement rejects an ungranted roster with zero writes', async () => {
    const calls = { count: 0 }
    const failure = await setGroupChannelParticipantsWithGrants(
      stubDatabase(calls),
      WORKSPACE,
      CHANNEL,
      ALICE,
      { candidates: [], expectedVersion: 1, now: NOW }
    ).then(
      () => {
        throw new Error('replacement must reject')
      },
      (error: unknown) => error
    )
    expect(failure).toBeInstanceOf(GroupCreationError)
    expect(calls.count).toBe(0)
  })
})

describe('resolveAdmissionWindow binds every identity and revision field', () => {
  const bound = admission({
    authorization: { groupId: CHANNEL, grantId: 'gra_alice', revision: 1 },
  })
  const grants = {
    audience: [audienceGrant()],
    enlistment: [enlistmentGrant()],
  }

  test('a fully matching row resolves its live window', () => {
    expect(resolveAdmissionWindow(bound, grants)).toEqual({
      expiresAt: null,
      issuedAt: ISSUED,
      revokedAt: null,
    })
  })

  test('a regrant revision never revives an admission bound to the revoked revision', () => {
    const regranted = {
      audience: [audienceGrant({ revision: 2, revokedAt: null })],
      enlistment: [],
    }
    expect(resolveAdmissionWindow(bound, regranted)).toEqual({
      expiresAt: null,
      issuedAt: 'invalid-grant-absent',
      revokedAt: null,
    })
  })

  test('a retargeted grant id never authorizes the wrong participant', () => {
    const retargeted = {
      audience: [audienceGrant({ participant: BOB, revision: 2 })],
      enlistment: [],
    }
    expect(resolveAdmissionWindow(bound, retargeted)).toEqual({
      expiresAt: null,
      issuedAt: 'invalid-grant-absent',
      revokedAt: null,
    })
    const stranger = admission({
      authorization: { groupId: CHANNEL, grantId: 'gra_alice', revision: 2 },
      participant: BOB,
    })
    expect(resolveAdmissionWindow(stranger, grants)).toEqual({
      expiresAt: null,
      issuedAt: 'invalid-grant-absent',
      revokedAt: null,
    })
  })

  test('an Agent grant never resolves a human admission and vice versa', () => {
    const agentBound = admission({
      authorization: { groupId: CHANNEL, grantId: 'gra_doc', revision: 1 },
      participant: { agentId: 'agt_doc', kind: 'agent' },
    })
    expect(
      resolveAdmissionWindow(agentBound, {
        audience: [audienceGrant({ grantId: 'gra_doc' })],
        enlistment: [],
      })
    ).toEqual({ expiresAt: null, issuedAt: 'invalid-grant-absent', revokedAt: null })
    expect(
      resolveAdmissionWindow(bound, { audience: [], enlistment: [enlistmentGrant()] })
    ).toEqual({ expiresAt: null, issuedAt: 'invalid-grant-absent', revokedAt: null })
  })
})
