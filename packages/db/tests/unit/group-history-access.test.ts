import { describe, expect, test } from 'bun:test'
import { sql, type SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import {
  channelIsAmongGroups,
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
    // One bound parameter per predicate: the channel's lowest visible sequence, 0 when earlier
    // history is included and the join point otherwise.
    expect(query(groupHistoryMessageVisibleCondition(input)).params).toEqual([
      JSON.stringify({ [CHANNEL]: 0 }),
    ])
    expect(query(groupSummaryMessageVisibleCondition(input)).params).toEqual([
      JSON.stringify({ [CHANNEL]: 7 }),
    ])
  })
  test('root and reply parent must be in the same channel with their own visible sequence', () => {
    const history = query(groupHistoryMessageAndThreadVisibleCondition(input))
    const summary = query(groupSummaryMessageAndThreadVisibleCondition(input))
    expect(history.sql).toContain('history_root.channel_id = candidate.channel_id')
    expect(history.sql).toContain('history_reply_parent.channel_id = candidate.channel_id')
    expect(summary.sql).toContain('history_root.sequence >=')
    expect(summary.sql).toContain('history_reply_parent.sequence >=')
    expect(history.params).toEqual(Array(3).fill(JSON.stringify({ [CHANNEL]: 0 })))
    expect(summary.params).toEqual(Array(3).fill(JSON.stringify({ [CHANNEL]: 7 })))
    const { replyToMessageId: _, ...withoutReply } = input
    expect(query(groupHistoryMessageAndThreadVisibleCondition(withoutReply)).sql).not.toContain(
      'history_reply_parent'
    )
  })
})

// Hoisted fixtures for the constant-size predicate tests below.
const groupAccess = (count: number) =>
  new Map(
    Array.from({ length: count }, (_, index) => [
      `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
      {
        joinedSequence: index,
        includesEarlierHistory: index % 2 === 0,
        includesEarlierSummary: index % 3 === 0,
      },
    ])
  )
const members = (count: number) =>
  query(channelIsAmongGroups(sql.raw('candidate.channel_id'), groupAccess(count).keys()))
const key = (index: number) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`

const predicateInput = (count: number) => ({
  channelId: sql.raw('candidate.channel_id'),
  sequence: sql.raw('candidate.sequence'),
  threadRootMessageId: sql.raw('candidate.thread_root_message_id'),
  replyToMessageId: sql.raw('candidate.reply_to_message_id'),
  access: groupAccess(count),
})

describe('group SQL predicates stay constant-size however many groups the reader holds', () => {
  // A reader's groups used to be spread into per-group terms: 22 to 37 bound parameters per group on
  // the account summary and inbox, and the protocol allows 65,534 per statement. The predicates now
  // bind each group map as one JSON parameter, so the statement and its parameter count do not
  // depend on the number of groups.
  test('statement text and parameter count do not grow with the number of groups', () => {
    for (const build of [
      groupHistoryMessageAndThreadVisibleCondition,
      groupSummaryMessageAndThreadVisibleCondition,
    ]) {
      const small = query(build(predicateInput(2)))
      const large = query(build(predicateInput(5000)))
      expect(large.sql).toBe(small.sql)
      expect(large.params).toHaveLength(small.params.length)
      expect(large.params.length).toBeLessThanOrEqual(8)
    }
    expect(members(5000).sql).toBe(members(2).sql)
    expect(members(5000).params).toHaveLength(1)
  })

  test('each group keeps its own lowest visible sequence', () => {
    const [history] = query(groupHistoryMessageVisibleCondition(predicateInput(4))).params
    const [summary] = query(groupSummaryMessageVisibleCondition(predicateInput(4))).params
    // index 0: earlier history and summary included -> 0 for both; 1: join point 1 for both;
    // 2: history included, summary join point 2; 3: summary included, history join point 3.
    expect(JSON.parse(history as string)).toEqual({
      [key(0)]: 0,
      [key(1)]: 1,
      [key(2)]: 0,
      [key(3)]: 3,
    })
    expect(JSON.parse(summary as string)).toEqual({
      [key(0)]: 0,
      [key(1)]: 1,
      [key(2)]: 2,
      [key(3)]: 0,
    })
  })

  test('channel ids are keyed in canonical lower case and a missing channel is denied, never null', () => {
    const upper = query(
      groupHistoryMessageVisibleCondition({
        channelId: sql.raw('candidate.channel_id'),
        sequence: sql.raw('candidate.sequence'),
        access: new Map([
          [
            'AAAAAAAA-0000-4000-8000-000000000001',
            { joinedSequence: 5, includesEarlierHistory: false, includesEarlierSummary: false },
          ],
        ]),
      })
    )
    expect(upper.params).toEqual([JSON.stringify({ 'aaaaaaaa-0000-4000-8000-000000000001': 5 })])
    expect(upper.sql).toContain('coalesce(')
    expect(upper.sql).toContain(', false)')
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
