import { describe, expect, test } from 'bun:test'
import { getTableColumns } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pg-proxy'
import {
  archivedGroupReadAllowedForUser,
  retainedArchivedGroupParticipants,
} from '../../src/group-participation-store'
import { groupAdmissions, groupAudienceGrants } from '../../src/schema'

const WORKSPACE = '00000000-0000-4000-8000-000000000001'
const CHANNEL = '00000000-0000-4000-8000-000000000002'
const USER = '00000000-0000-4000-8000-000000000003'
const AGENT = '00000000-0000-4000-8000-000000000004'
const NOW = '2026-10-08T12:00:00.000Z'

type Statement = { sql: string; params: unknown[] }

const wire = (
  table: typeof groupAdmissions | typeof groupAudienceGrants,
  values: Record<string, unknown>
) => Object.values(getTableColumns(table)).map((column) => values[column.name] ?? null)

// Exercise the real Drizzle PostgreSQL compiler and row decoder. The proxy only supplies wire
// rows: it does not pretend to evaluate SQL. Assertions below pin the authorization predicates
// sent to PostgreSQL; matching real-database cases live in the canonical product-read suite.
function driver(
  options: {
    canonical?: boolean
    revoked?: boolean
    retained?: boolean
    users?: (string | null)[]
    agents?: (string | null)[]
  } = {}
) {
  const statements: Statement[] = []
  const db = drizzle(async (text, params) => {
    const sql = text.replace(/\s+/g, ' ').trim()
    statements.push({ sql, params })
    const table = / from "app"\."([^"]+)"/.exec(sql)?.[1]
    if (table === 'group_admissions')
      return {
        rows: options.canonical
          ? [
              wire(groupAdmissions, {
                id: 'admission',
                workspace_id: WORKSPACE,
                channel_id: CHANNEL,
                principal_kind: 'user',
                user_id: USER,
                joined_sequence: '1',
                joined_at: '2026-10-01T00:00:00.000Z',
                auth_group_id: CHANNEL,
                auth_grant_id: 'grant',
                auth_revision: 1,
                created_at: NOW,
                updated_at: NOW,
              }),
            ]
          : [],
      }
    if (table === 'group_audience_grants')
      return {
        rows: options.canonical
          ? [
              wire(groupAudienceGrants, {
                id: 'audience',
                workspace_id: WORKSPACE,
                channel_id: CHANNEL,
                grant_id: 'grant',
                revision: 1,
                user_id: USER,
                issued_at: '2026-10-01T00:00:00.000Z',
                revoked_at: options.revoked ? NOW : null,
                created_at: NOW,
                updated_at: NOW,
              }),
            ]
          : [],
      }
    if (table === 'group_enlistment_grants') return { rows: [] }
    if (table === 'channel_participants') {
      const projection = sql.slice(0, sql.indexOf(' from '))
      if (projection.endsWith('."id"')) return { rows: options.retained ? [['retained']] : [] }
      if (projection.endsWith('."user_id"'))
        return { rows: (options.users ?? []).map((id) => [id]) }
      if (projection.endsWith('."agent_id"'))
        return { rows: (options.agents ?? []).map((id) => [id]) }
    }
    throw new Error(`Unexpected query: ${sql}`)
  })
  return { db, statements }
}

function expectProvenance(statement: Statement) {
  const { sql } = statement
  for (const table of [
    'group_admissions',
    'group_audience_grants',
    'group_enlistment_grants',
    'group_sharing_grants',
  ]) {
    expect(sql).toContain(`not exists ( select 1 from "app"."${table}"`)
    expect(sql).toContain(`"${table}"."workspace_id" = "app"."channel_participants"."workspace_id"`)
    expect(sql).toContain(`"${table}"."channel_id" = "app"."channel_participants"."channel_id"`)
  }
  for (const count of [
    'withdrawn_admissions',
    'withdrawn_audience_grants',
    'withdrawn_enlistment_grants',
  ])
    expect(sql).toContain(`coalesce("app"."legacy_audience_quarantine"."${count}", 1) <> 0`)
  expect(sql).toContain(
    '"legacy_audience_quarantine"."source_participant_id" = "app"."channel_participants"."id"'
  )
  expect(sql).toContain(
    '"legacy_audience_quarantine"."workspace_id" = "app"."channel_participants"."workspace_id"'
  )
  expect(sql).toContain(
    '"legacy_audience_quarantine"."channel_id" = "app"."channel_participants"."channel_id"'
  )
  expect(sql).toContain('"legacy_audience_quarantine"."reason" = \'group_channel_not_active\'')
  expect(sql).toContain(
    '"legacy_audience_quarantine"."source_row_digest" = app.legacy_participant_digest("channel_participants")'
  )
}

function expectMembership(sql: string) {
  expect(sql).toContain('inner join "app"."workspace_memberships"')
  expect(sql).toContain(
    '"workspace_memberships"."created_at" <= "app"."channel_participants"."created_at"'
  )
}

describe('archived group query contracts and result decoding', () => {
  test('a live canonical grant authorizes without consulting legacy roster fallback', async () => {
    const { db, statements } = driver({ canonical: true })
    expect(await archivedGroupReadAllowedForUser(db, WORKSPACE, CHANNEL, USER, NOW)).toBe(true)
    expect(statements).toHaveLength(3)
    expect(
      statements.every((query) => !query.sql.includes('from "app"."channel_participants"'))
    ).toBe(true)
    for (const query of statements) expect(query.params).toEqual([WORKSPACE, CHANNEL])
  })

  for (const canonical of [false, true]) {
    test(`absent legacy standing denies when canonical=${canonical} (revoked if present)`, async () => {
      const { db, statements } = driver({ canonical, revoked: canonical })
      expect(await archivedGroupReadAllowedForUser(db, WORKSPACE, CHANNEL, USER, NOW)).toBe(false)
      const query = statements.at(-1)!
      expectProvenance(query)
      expectMembership(query.sql)
      expect(query.params).toEqual([WORKSPACE, USER, WORKSPACE, CHANNEL, 'user', USER, 1])
    })
  }

  test('a proven retained row authorizes only the requested user and channel with continuous membership', async () => {
    const { db, statements } = driver({ retained: true })
    expect(await archivedGroupReadAllowedForUser(db, WORKSPACE, CHANNEL, USER, NOW)).toBe(true)
    const query = statements.at(-1)!
    expectProvenance(query)
    expectMembership(query.sql)
    expect(query.sql).toContain('"workspace_memberships"."user_id" = $2')
    expect(query.sql).toContain('"channel_participants"."user_id" = $6')
    expect(query.params).toEqual([WORKSPACE, USER, WORKSPACE, CHANNEL, 'user', USER, 1])
  })

  test('retained listing decodes both principal kinds, drops null projections and binds their independent liveness checks', async () => {
    const { db, statements } = driver({ users: [USER, null], agents: [null, AGENT] })
    expect(await retainedArchivedGroupParticipants(db, WORKSPACE, CHANNEL)).toEqual([
      { kind: 'user', userId: USER },
      { kind: 'agent', agentId: AGENT },
    ])
    expect(statements).toHaveLength(2)
    for (const query of statements) expectProvenance(query)
    expectMembership(statements[0]!.sql)
    expect(statements[0]!.params).toEqual([WORKSPACE, WORKSPACE, CHANNEL, 'user'])
    expect(statements[1]!.sql).toContain('inner join "app"."agents"')
    expect(statements[1]!.sql).toContain('"agents"."id" = "app"."channel_participants"."agent_id"')
    expect(statements[1]!.params).toEqual([WORKSPACE, 'active', WORKSPACE, CHANNEL, 'agent'])
  })

  test('an empty proven audience remains empty rather than synthesizing participants', async () => {
    const { db } = driver()
    expect(await retainedArchivedGroupParticipants(db, WORKSPACE, CHANNEL)).toEqual([])
  })
})
