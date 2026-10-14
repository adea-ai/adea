import { describe, expect, test } from 'bun:test'
import { sql, type SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import {
  groupChannelIdsInForce,
  groupHistoryAccessByUser,
  groupHistoryMessageAndThreadVisibleCondition,
  groupHistoryMessageVisibleCondition,
  groupSummaryMessageAndThreadVisibleCondition,
  groupSummaryMessageVisibleCondition,
  requireGroupManagementAuthority,
  requireGroupParticipantLiveness,
} from '../../src/group-participation-store'

const NOW = '2026-10-08T12:00:00.000Z'
const USER = 'usr_reader'
const CHANNEL = 'ch_group'
const WORKSPACE = 'wsp_host'
const dialect = new PgDialect()
const query = (value: SQL) => dialect.sqlToQuery(value)

// These are joined query results, not a fake SQL engine. Capture the predicates
// separately so tests also check the tenant/user restrictions sent to PostgreSQL.
function database(rows: readonly unknown[]) {
  const predicates: SQL[] = []
  const terminal = Object.assign(Promise.resolve(rows), {
    leftJoin: () => terminal,
    where: (predicate: SQL) => {
      predicates.push(predicate)
      return terminal
    },
    limit: () => terminal,
  })
  const db = { select: () => ({ from: () => terminal }) }
  return { db: db as never, predicates }
}

function row(sequence = 7, overrides: Record<string, unknown> = {}) {
  return {
    admission: {
      id: `adm_${sequence}`,
      channelId: CHANNEL,
      workspaceId: WORKSPACE,
      authGroupId: CHANNEL,
      authGrantId: 'gra_reader',
      authRevision: 1,
      principalKind: 'user',
      userId: USER,
      joinedAt: NOW,
      joinedSequence: sequence,
    },
    grant: {
      channelId: CHANNEL,
      workspaceId: WORKSPACE,
      grantId: 'gra_reader',
      userId: USER,
      revision: 1,
      issuedAt: '2026-10-01T00:00:00.000Z',
      expiresAt: null,
      revokedAt: null,
    },
    sharing: null,
    ...overrides,
  }
}

function sharing(scope: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `share_${scope}`,
    grantId: `gra_${scope}`,
    revision: 1,
    principalKind: 'user',
    userId: USER,
    scope,
    issuedAt: '2026-10-01T00:00:00.000Z',
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  }
}

describe('retained group history standing', () => {
  test('restricts both reads to the authenticated user and requested workspace', async () => {
    for (const read of [groupHistoryAccessByUser, groupChannelIdsInForce]) {
      const { db, predicates } = database([row()])
      await read(db, USER, NOW, WORKSPACE)
      expect(query(predicates[0]!).params).toEqual(['user', USER, WORKSPACE])
    }
  })

  for (const [label, grant] of [
    ['missing', null],
    ['revoked', { ...row().grant, revokedAt: NOW }],
    ['expired', { ...row().grant, expiresAt: NOW }],
    ['stale revision', { ...row().grant, revision: 2 }],
    ['other user', { ...row().grant, userId: 'usr_other' }],
  ] as const) {
    test(`${label} audience grant leaves no readable history or live channel`, async () => {
      const { db } = database([row(7, { grant })])
      expect((await groupHistoryAccessByUser(db, USER, NOW)).size).toBe(0)
      expect((await groupChannelIdsInForce(db, USER, NOW)).size).toBe(0)
    })
  }

  test('retains the earliest join point across duplicate join results and admissions', async () => {
    const { db } = database([row(12), row(7), row(7)])
    expect(await groupHistoryAccessByUser(db, USER, NOW)).toEqual(
      new Map([
        [
          CHANNEL,
          {
            joinedSequence: 7,
            includesEarlierHistory: false,
            includesEarlierSummary: false,
          },
        ],
      ])
    )
    expect(await groupChannelIdsInForce(db, USER, NOW)).toEqual(new Set([CHANNEL]))
  })

  for (const scope of ['earlier_history', 'earlier_summary'] as const) {
    test(`${scope} only widens its own read boundary`, async () => {
      const joined = row(7, { sharing: sharing(scope) })
      const { db } = database([joined, joined])
      expect((await groupHistoryAccessByUser(db, USER, NOW)).get(CHANNEL)).toEqual({
        joinedSequence: 7,
        includesEarlierHistory: scope === 'earlier_history',
        includesEarlierSummary: scope === 'earlier_summary',
      })
    })
  }

  test('revoked and foreign-user sharing grants do not widen either boundary', async () => {
    const { db } = database([
      row(7, { sharing: sharing('earlier_history', { revokedAt: NOW }) }),
      row(7, { sharing: sharing('earlier_summary', { userId: 'usr_other' }) }),
    ])
    expect((await groupHistoryAccessByUser(db, USER, NOW)).get(CHANNEL)).toEqual({
      joinedSequence: 7,
      includesEarlierHistory: false,
      includesEarlierSummary: false,
    })
  })

  test('founder at sequence zero needs no earlier-history grant', async () => {
    const { db } = database([row(0, { sharing: sharing('earlier_history') })])
    expect((await groupHistoryAccessByUser(db, USER, NOW)).get(CHANNEL)).toEqual({
      joinedSequence: 0,
      includesEarlierHistory: false,
      includesEarlierSummary: false,
    })
  })
})

describe('group SQL read boundaries', () => {
  const input = {
    channelId: sql.raw('candidate.channel_id'),
    sequence: sql.raw('candidate.sequence'),
    threadRootMessageId: sql.raw('candidate.thread_root_message_id'),
    replyToMessageId: sql.raw('candidate.reply_to_message_id'),
    access: new Map([
      [
        CHANNEL,
        {
          joinedSequence: 7,
          includesEarlierHistory: true,
          includesEarlierSummary: false,
        },
      ],
    ]),
  }
  test('empty standing is denied and summary keeps its own join-point restriction', () => {
    expect(query(groupHistoryMessageVisibleCondition({ ...input, access: new Map() })).sql).toBe(
      'false'
    )
    expect(query(groupHistoryMessageVisibleCondition(input)).params).toEqual([CHANNEL])
    expect(query(groupSummaryMessageVisibleCondition(input)).params).toEqual([CHANNEL, 7])
  })
  test('root and reply parent must be in the same channel with their own visible sequence', () => {
    const history = query(groupHistoryMessageAndThreadVisibleCondition(input))
    const summary = query(groupSummaryMessageAndThreadVisibleCondition(input))
    expect(history.sql).toContain('history_root.channel_id = candidate.channel_id')
    expect(history.sql).toContain('history_reply_parent.channel_id = candidate.channel_id')
    expect(summary.sql).toContain('history_root.sequence >=')
    expect(summary.sql).toContain('history_reply_parent.sequence >=')
    expect(history.params).toEqual([CHANNEL, CHANNEL, CHANNEL])
    expect(summary.params).toEqual([CHANNEL, 7, CHANNEL, 7, CHANNEL, 7])
    const { replyToMessageId: _, ...withoutReply } = input
    expect(query(groupHistoryMessageAndThreadVisibleCondition(withoutReply)).sql).not.toContain(
      'history_reply_parent'
    )
  })
})

describe('group management and participant authority', () => {
  for (const role of ['owner', 'admin', 'member', null]) {
    test(`${role ?? 'absent'} membership management decision`, async () => {
      const { db } = database(role ? [{ role }] : [])
      const decision = requireGroupManagementAuthority(db, WORKSPACE, {
        kind: 'user',
        userId: USER,
      })
      if (role === 'owner' || role === 'admin') await expect(decision).resolves.toBeUndefined()
      else await expect(decision).rejects.toThrow('Channel unavailable')
    })
  }
  test('human liveness requires host membership and never establishes agent authority', async () => {
    await expect(
      requireGroupParticipantLiveness(database([{ id: 'membership' }]).db, WORKSPACE, {
        kind: 'user',
        userId: USER,
      })
    ).resolves.toBeUndefined()
    await expect(
      requireGroupParticipantLiveness(database([]).db, WORKSPACE, { kind: 'user', userId: USER })
    ).rejects.toThrow('Conversation participant unavailable')
    await expect(
      requireGroupParticipantLiveness(database([{ id: 'membership' }]).db, WORKSPACE, {
        kind: 'agent',
        agentId: 'agt_foreign',
      })
    ).rejects.toThrow('Agent unavailable')
  })
})
