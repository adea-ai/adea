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
  admissionFromRow,
  assertGroupChannelGate,
  audienceGrantFromRow,
  authorizeGroupChannelHistoryRead,
  authorizeGroupChannelPublication,
  authorizeGroupChannelSummaryRead,
  authorizeGroupChannelTurn,
  canonicalKey,
  enlistmentGrantFromRow,
  groupCreationCandidatesFromGrants,
  groupCreationPayloadHash,
  GroupCreationError,
  loadGroupAdmission,
  loadGroupRoster,
  loadGroupSharingGrants,
  participantKey,
  partitionGroupChannelHistory,
  resolveAdmissionWindow,
  resolveGroupLeadAgent,
  resolveGroupLeadAgentId,
  sharingGrantFromRow,
  type GroupChannelGate,
} from '../../src/group-participation-store'
import {
  agents,
  groupAdmissions,
  groupAudienceGrants,
  groupEnlistmentGrants,
  groupSharingGrants,
} from '../../src/schema'

const ISSUED = '2026-10-01T00:00:00.000Z'

type FakeRows = Record<string, readonly unknown[]>

/**
 * Chainable query stand-in built on a NATIVE promise: every link returns the
 * same promise (so select/from/where/orderBy/limit compose in any shape the
 * loaders use) while awaiting resolves the addressed table's rows. No custom
 * thenable, no query engine.
 */
function fakeTerminal(rows: readonly unknown[]) {
  const terminal = Promise.resolve(rows) as Promise<readonly unknown[]> & {
    limit(): typeof terminal
    orderBy(): typeof terminal
    where(): typeof terminal
  }
  terminal.limit = () => terminal
  terminal.orderBy = () => terminal
  terminal.where = () => terminal
  return terminal
}

function fakeDatabase(tables: FakeRows) {
  return {
    select: () => ({
      from: (table: unknown) =>
        fakeTerminal(
          table === groupAdmissions
            ? tables.admissions
            : table === groupAudienceGrants
              ? tables.audience
              : table === groupEnlistmentGrants
                ? tables.enlistment
                : table === groupSharingGrants
                  ? tables.sharing
                  : table === agents
                    ? tables.agents
                    : []
        ),
    }),
  } as never
}
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

describe('resolveAdmissionWindow binds every identity and revision field', () => {
  const bound = admission({
    authorization: { groupId: CHANNEL, grantId: 'gra_alice', revision: 1 },
  })
  const grants = {
    audience: [audienceGrant()],
    enlistment: [enlistmentGrant()],
  }

  test('a fully matching row resolves its live window', () => {
    expect(resolveAdmissionWindow(bound, grants, CHANNEL)).toEqual({
      expiresAt: null,
      issuedAt: ISSUED,
      revokedAt: null,
    })
  })

  test('a retained binding for another group resolves nothing here', () => {
    const foreign = admission({
      authorization: { groupId: 'grp_elsewhere', grantId: 'gra_alice', revision: 1 },
    })
    expect(resolveAdmissionWindow(foreign, grants, CHANNEL)).toEqual({
      expiresAt: null,
      issuedAt: 'invalid-grant-absent',
      revokedAt: null,
    })
    const malformed = admission({
      authorization: { groupId: '   ', grantId: 'gra_alice', revision: 1 },
    })
    expect(resolveAdmissionWindow(malformed, grants, CHANNEL)).toEqual({
      expiresAt: null,
      issuedAt: 'invalid-grant-absent',
      revokedAt: null,
    })
  })

  test('a regrant revision never revives an admission bound to the revoked revision', () => {
    const regranted = {
      audience: [audienceGrant({ revision: 2, revokedAt: null })],
      enlistment: [],
    }
    expect(resolveAdmissionWindow(bound, regranted, CHANNEL)).toEqual({
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
    expect(resolveAdmissionWindow(bound, retargeted, CHANNEL)).toEqual({
      expiresAt: null,
      issuedAt: 'invalid-grant-absent',
      revokedAt: null,
    })
    const stranger = admission({
      authorization: { groupId: CHANNEL, grantId: 'gra_alice', revision: 2 },
      participant: BOB,
    })
    expect(resolveAdmissionWindow(stranger, grants, CHANNEL)).toEqual({
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
      resolveAdmissionWindow(
        agentBound,
        {
          audience: [audienceGrant({ grantId: 'gra_doc' })],
          enlistment: [],
        },
        CHANNEL
      )
    ).toEqual({ expiresAt: null, issuedAt: 'invalid-grant-absent', revokedAt: null })
    expect(
      resolveAdmissionWindow(bound, { audience: [], enlistment: [enlistmentGrant()] }, CHANNEL)
    ).toEqual({ expiresAt: null, issuedAt: 'invalid-grant-absent', revokedAt: null })
  })

  test('row mappers preserve every grant, admission and sharing field', () => {
    expect(
      audienceGrantFromRow('grp_1', {
        expiresAt: null,
        grantId: 'gra_alice',
        issuedAt: ISSUED,
        revokedAt: null,
        revision: 1,
        userId: 'usr_alice',
      } as never)
    ).toEqual({
      expiresAt: null,
      grantId: 'gra_alice',
      groupId: 'grp_1',
      issuedAt: ISSUED,
      participant: { kind: 'user', userId: 'usr_alice' },
      revision: 1,
      revokedAt: null,
    })
    expect(
      enlistmentGrantFromRow('grp_1', 'wsp_adea', {
        agentId: 'agt_doc',
        expiresAt: null,
        grantId: 'gra_doc',
        issuedAt: ISSUED,
        revokedAt: null,
        revision: 2,
      } as never)
    ).toEqual({
      agent: { agentId: 'agt_doc', workspaceId: 'wsp_adea' },
      expiresAt: null,
      grantId: 'gra_doc',
      groupId: 'grp_1',
      issuedAt: ISSUED,
      revision: 2,
      revokedAt: null,
    })
    const window = { expiresAt: null, issuedAt: ISSUED, revokedAt: null }
    expect(
      admissionFromRow(
        'grp_1',
        {
          authGrantId: 'gra_alice',
          authGroupId: 'grp_1',
          authRevision: 1,
          joinedAt: NOW,
          joinedSequence: 7,
          principalKind: 'user',
          userId: 'usr_alice',
        } as never,
        window
      )
    ).toEqual({
      authorization: { groupId: 'grp_1', grantId: 'gra_alice', revision: 1 },
      grant: window,
      joinPoint: { joinedAt: NOW, joinedSequence: 7 },
      participant: { kind: 'user', userId: 'usr_alice' },
    })
    expect(
      admissionFromRow(
        'grp_1',
        {
          agentId: 'agt_doc',
          authGrantId: 'gra_doc',
          authGroupId: 'grp_1',
          authRevision: 2,
          joinedAt: NOW,
          joinedSequence: 3,
          principalKind: 'agent',
        } as never,
        window
      )
    ).toMatchObject({ participant: { agentId: 'agt_doc', kind: 'agent' } })
    expect(
      sharingGrantFromRow('grp_1', {
        expiresAt: null,
        grantId: 'gra_share',
        issuedAt: ISSUED,
        principalKind: 'agent',
        agentId: 'agt_doc',
        revision: 1,
        revokedAt: null,
        scope: 'earlier_history',
      } as never)
    ).toMatchObject({
      groupId: 'grp_1',
      participant: { agentId: 'agt_doc', kind: 'agent' },
      scope: 'earlier_history',
    })
    expect(
      sharingGrantFromRow('grp_1', {
        expiresAt: null,
        grantId: 'gra_share',
        issuedAt: ISSUED,
        principalKind: 'user',
        userId: 'usr_bob',
        revision: 1,
        revokedAt: null,
        scope: 'earlier_summary',
      } as never)
    ).toMatchObject({
      participant: { kind: 'user', userId: 'usr_bob' },
      scope: 'earlier_summary',
    })
  })

  test('creation errors carry typed rejections and qualify participants by workspace', () => {
    const failure = new GroupCreationError([{ reason: 'audience_empty', scope: 'group' }])
    expect(failure).toBeInstanceOf(Error)
    expect(failure.name).toBe('GroupCreationError')
    expect(failure.message).toMatch(/valid explicit grant/)
    expect(failure.rejections).toEqual([{ reason: 'audience_empty', scope: 'group' }])
    expect(participantKey('wsp_adea', { kind: 'user', userId: 'usr_alice' })).toBe('user:usr_alice')
    expect(participantKey('wsp_adea', { agentId: 'agt_doc', kind: 'agent' })).toBe(
      'agent:wsp_adea:agt_doc'
    )
    // Canonical keys stringify undefined without throwing (object fields
    // drop it; array slots become null).
    expect(canonicalKey(undefined)).toBe('null')
    expect(canonicalKey({ a: undefined, b: [undefined] })).toBe('{"b":[null]}')
  })
})

describe('canonical loaders over a chainable select surface', () => {
  const admissionRow = {
    authGrantId: 'gra_alice',
    authGroupId: 'grp_1',
    authRevision: 1,
    joinedAt: NOW,
    joinedSequence: 4,
    principalKind: 'user',
    userId: 'usr_alice',
  }
  const agentRow = {
    agentId: 'agt_doc',
    authGrantId: 'gra_doc',
    authGroupId: 'grp_1',
    authRevision: 2,
    joinedAt: NOW,
    joinedSequence: 9,
    principalKind: 'agent',
  }
  const audienceRow = {
    expiresAt: null,
    grantId: 'gra_alice',
    issuedAt: ISSUED,
    revokedAt: null,
    revision: 1,
    userId: 'usr_alice',
  }
  const enlistmentRow = {
    agentId: 'agt_doc',
    expiresAt: null,
    grantId: 'gra_doc',
    issuedAt: ISSUED,
    revokedAt: null,
    revision: 2,
  }
  const sharingRow = {
    agentId: null,
    expiresAt: null,
    grantId: 'gra_share',
    issuedAt: ISSUED,
    principalKind: 'user',
    revision: 1,
    revokedAt: null,
    scope: 'earlier_history',
    userId: 'usr_alice',
  }
  // Table rows per fixture below; queries resolve through the module-scope
  // fakeDatabase stand-in.
  const tables = {
    admissions: [admissionRow, agentRow],
    agents: [{ id: 'agt_doc' }],
    audience: [audienceRow],
    enlistment: [enlistmentRow],
    sharing: [sharingRow],
  }

  test('loadGroupRoster maps admissions and binds live windows', async () => {
    const roster = await loadGroupRoster(fakeDatabase(tables), 'wsp_adea', 'grp_1')
    expect(roster).toHaveLength(2)
    expect(roster[0]).toMatchObject({
      authorization: { groupId: 'grp_1', grantId: 'gra_alice', revision: 1 },
      joinPoint: { joinedAt: NOW, joinedSequence: 4 },
      participant: { kind: 'user', userId: 'usr_alice' },
    })
    expect(roster[0]?.grant).toMatchObject({ issuedAt: ISSUED, revokedAt: null })
    expect(roster[1]?.participant).toEqual({ agentId: 'agt_doc', kind: 'agent' })
  })

  test('a stale retained binding resolves fail-closed while others stay live', async () => {
    const staleTables = {
      ...tables,
      admissions: [{ ...admissionRow, authRevision: 9 }, agentRow],
    }
    const roster = await loadGroupRoster(fakeDatabase(staleTables), 'wsp_adea', 'grp_1')
    expect(roster[0]?.grant).toMatchObject({ issuedAt: 'invalid-grant-absent' })
    expect(roster[1]?.grant).toMatchObject({ issuedAt: ISSUED })
  })

  test('loadGroupAdmission and loadGroupSharingGrants scope to channel and subject', async () => {
    const database = fakeDatabase(tables)
    expect(
      await loadGroupAdmission(database, 'wsp_adea', 'grp_1', {
        kind: 'user',
        userId: 'usr_alice',
      })
    )?.toMatchObject({ participant: { kind: 'user', userId: 'usr_alice' } })
    expect(
      await loadGroupAdmission(database, 'wsp_adea', 'grp_1', {
        kind: 'user',
        userId: 'usr_nobody',
      })
    ).toBeNull()
    const sharing = await loadGroupSharingGrants(database, 'wsp_adea', 'grp_1')
    expect(sharing).toHaveLength(1)
    expect(sharing[0]).toMatchObject({ scope: 'earlier_history' })
  })

  test('resolveGroupLeadAgentId honors exactly one effective enlisted lead', async () => {
    const database = fakeDatabase(tables)
    expect(await resolveGroupLeadAgentId(database, 'wsp_adea', 'grp_1', NOW)).toBe('agt_doc')
    expect(await resolveGroupLeadAgent(database, 'wsp_adea', 'grp_1', NOW)).toBe('agt_doc')
    const revokedTables = {
      ...tables,
      enlistment: [{ ...enlistmentRow, revokedAt: NOW }],
    }
    expect(
      await resolveGroupLeadAgentId(fakeDatabase(revokedTables), 'wsp_adea', 'grp_1', NOW)
    ).toBeNull()
  })
})
