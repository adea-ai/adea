import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { UserPrincipalRef } from '@adea-ai/types'
import { and, eq, sql } from 'drizzle-orm'

import { createDatabase, type DatabaseConnection } from '../../src/connection'
import {
  authorizeGroupChannelTurn,
  loadGroupRoster,
  revokeGroupGrant,
} from '../../src/group-channels'
import { createTemporaryUserSession } from '../../src/identity'
import * as schema from '../../src/schema'
import { createWorkspaceWithOwner } from '../../src/workspaces'

const connectionUrl = process.env.DATABASE_URL

const NOW = '2026-10-08T12:00:00.000Z'

const wallNow = () => new Date().toISOString()

/** The shipped backfill statements, executed verbatim (idempotency is the assertion). */
function backfillStatements(): readonly string[] {
  const source = readFileSync(
    new URL('../../drizzle/0050_group_legacy_backfill.sql', import.meta.url),
    'utf8'
  )
  return source
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
}

describe.skipIf(!connectionUrl)('group migration proof on upgraded schemas', () => {
  let connection: DatabaseConnection
  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })
  afterAll(async () => connection.close())

  async function user(label: string): Promise<UserPrincipalRef> {
    return (
      await createTemporaryUserSession(connection.db, {
        credentialDigest: `group-migration-proof-${label}-${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 60_000),
      })
    ).principal
  }

  async function tableCounts() {
    const [admissions, audience, enlistment, sharing] = await Promise.all([
      connection.db.select({ n: sql<number>`count(*)` }).from(schema.groupAdmissions),
      connection.db.select({ n: sql<number>`count(*)` }).from(schema.groupAudienceGrants),
      connection.db.select({ n: sql<number>`count(*)` }).from(schema.groupEnlistmentGrants),
      connection.db.select({ n: sql<number>`count(*)` }).from(schema.groupSharingGrants),
    ])
    return {
      admissions: Number(admissions[0]?.n ?? 0),
      audience: Number(audience[0]?.n ?? 0),
      enlistment: Number(enlistment[0]?.n ?? 0),
      sharing: Number(sharing[0]?.n ?? 0),
    }
  }

  test('applied migrations never record twice: the journal has no duplicate hashes', async () => {
    const duplicates = await connection.db.execute(
      sql`select hash, count(*) as n from app.__drizzle_migrations group by hash having count(*) > 1`
    )
    expect(duplicates.length).toBe(0)
  })

  test('the shipped backfill executes idempotently: second run changes zero rows', async () => {
    const owner = await user('owner')
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'Backfill proof',
      owner,
    })
    // A genuinely legacy shape: channel plus participant rows, with no grant
    // or admission rows at all — exactly what predates the grant tables.
    const channelId = crypto.randomUUID()
    await connection.db.insert(schema.channels).values({
      id: channelId,
      idempotencyKey: crypto.randomUUID(),
      kind: 'group',
      sortOrder: 0,
      title: 'Legacy group',
      visibility: 'participants',
      workspaceId: workspace.id,
    })
    await connection.db.insert(schema.channelParticipants).values({
      channelId,
      principalKind: 'user',
      userId: owner.userId,
      workspaceId: workspace.id,
    })
    const runBackfill = async () => {
      for (const statement of backfillStatements()) await connection.client.unsafe(statement)
    }
    await runBackfill()
    const grants = await connection.db
      .select()
      .from(schema.groupAudienceGrants)
      .where(
        and(
          eq(schema.groupAudienceGrants.workspaceId, workspace.id),
          eq(schema.groupAudienceGrants.channelId, channelId)
        )
      )
    expect(grants).toHaveLength(1)
    expect(grants[0]).toMatchObject({ revision: 1, revokedAt: null })
    expect(typeof grants[0]?.issuedAt).toBe('string')
    const admissions = await connection.db
      .select()
      .from(schema.groupAdmissions)
      .where(
        and(
          eq(schema.groupAdmissions.workspaceId, workspace.id),
          eq(schema.groupAdmissions.channelId, channelId)
        )
      )
    expect(admissions).toHaveLength(1)
    expect(admissions[0]).toMatchObject({
      authRevision: 1,
      joinedSequence: 0,
    })
    expect(admissions[0]?.authGrantId).toBe(grants[0]?.grantId)
    const counts = await tableCounts()
    await runBackfill()
    // Exactly-once effect: rerunning the shipped file changes zero rows.
    expect(await tableCounts()).toEqual(counts)
  })

  test('revocation bites on backfilled rows exactly like created ones', async () => {
    const owner = await user('revoker')
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'Backfill revocation',
      owner,
    })
    const channelId = crypto.randomUUID()
    await connection.db.insert(schema.channels).values({
      id: channelId,
      idempotencyKey: crypto.randomUUID(),
      kind: 'group',
      sortOrder: 0,
      title: 'Legacy group',
      visibility: 'participants',
      workspaceId: workspace.id,
    })
    await connection.db.insert(schema.channelParticipants).values({
      channelId,
      principalKind: 'user',
      userId: owner.userId,
      workspaceId: workspace.id,
    })
    for (const statement of backfillStatements()) await connection.client.unsafe(statement)
    const [grant] = await connection.db
      .select()
      .from(schema.groupAudienceGrants)
      .where(
        and(
          eq(schema.groupAudienceGrants.workspaceId, workspace.id),
          eq(schema.groupAudienceGrants.channelId, channelId)
        )
      )
      .limit(1)
    expect(grant).toBeDefined()
    const gate = {
      channel: {
        createdAt: NOW,
        id: channelId,
        isPrimaryProjectChannel: false,
        kind: 'group' as const,
        lifecycleState: 'active' as const,
        participants: [owner],
        sortOrder: 0,
        title: 'Legacy group',
        updatedAt: NOW,
        version: 1,
        visibility: 'participants' as const,
        workspaceId: workspace.id,
      },
      workspaceId: workspace.id,
    }
    const before = await loadGroupRoster(connection.db, workspace.id, channelId)
    expect(
      authorizeGroupChannelTurn(gate, {
        admission:
          before.find(
            (entry) =>
              entry.participant.kind === 'user' && entry.participant.userId === owner.userId
          ) ?? null,
        now: wallNow(),
      })
    ).toMatchObject({ action: 'allow' })
    await revokeGroupGrant(connection.db, workspace.id, channelId, owner, {
      grantId: grant!.grantId,
      kind: 'audience',
      revokedAt: wallNow(),
    })
    const after = await loadGroupRoster(connection.db, workspace.id, channelId)
    expect(
      authorizeGroupChannelTurn(gate, {
        admission:
          after.find(
            (entry) =>
              entry.participant.kind === 'user' && entry.participant.userId === owner.userId
          ) ?? null,
        now: wallNow(),
      })
    ).toMatchObject({ action: 'deny', reason: 'turn_participation_revoked' })
  })
})
