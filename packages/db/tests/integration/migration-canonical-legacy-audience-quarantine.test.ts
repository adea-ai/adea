import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { rmSync } from 'node:fs'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

import { createDatabase, type AgentHqDatabase, type DatabaseConnection } from '../../src/connection'
import {
  createMessage,
  createRuntimeResultMessage,
  listMessagesForUser,
} from '../../src/conversations'
import { canonicalChainFolders } from '../fixtures/canonical-chain'
import {
  installLegacyAudienceQuarantine,
  legacyBackfillProfile,
  quarantineLegacyAudience,
  reconcileLegacyAudience,
  replayCanonicalBackfill,
  type LegacyAudienceReconciliation,
} from '../fixtures/legacy-audience-quarantine'
import {
  seedLegacyAudience,
  type LegacyAudienceSeed as Seeded,
} from '../fixtures/legacy-audience-seed'

// #1222 additive-migration quarantine, proved on a disposable rehearsal database. The chain is the
// pinned canonical #1229 -> #1230 -> #1232 sequence. Legacy records that the product could not have
// produced through its own functions are seeded directly, as the legacy data would be:
//   - a user who has since left the workspace, still a participant of an active group;
//   - an agent from another workspace, still a participant of an active group;
//   - the participants of an archived group.
// The canonical 0050 backfill admits all of them. The quarantine then withholds exactly the
// unresolvable ones. Original channel_participants rows are preserved and never changed.
//
// NOT proved here: a product integration that makes the join-point gate refuse quarantined principals
// (the #1232 candidate's gate is not on main), and quarantine of other ambiguous shapes beyond the
// three stated reasons. Those are reported as gaps, not claimed.

const provisioningUrl = process.env.MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL
const inCi = process.env.CI === 'true' || process.env.CI === '1'
const SCRATCH_PREFIX = 'rehearsal_1222q_'
const OBSERVED_AT = '2026-01-05T00:00:00.000Z'

function adminUrl(database: string): string {
  if (!provisioningUrl) throw new Error('MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL is not set')
  const url = new URL(provisioningUrl)
  url.pathname = `/${database}`
  return url.toString()
}

async function adminExecute(statement: string): Promise<void> {
  const admin = postgres(adminUrl('postgres'), { max: 1, onnotice: () => {} })
  try {
    await admin.unsafe(statement)
  } finally {
    await admin.end()
  }
}

type Row = Record<string, unknown>

async function rowsOf(db: AgentHqDatabase, statement: ReturnType<typeof sql>): Promise<Row[]> {
  return (await db.execute<Row>(statement)) as unknown as Row[]
}

type Scenario = {
  seeded: Seeded
  beforeQuarantine: LegacyAudienceReconciliation
  sourceParticipantsBefore: number
  afterQuarantine: LegacyAudienceReconciliation
  quarantineRows: Row[]
  quarantineResult: Awaited<ReturnType<typeof quarantineLegacyAudience>>
  quarantineRepeat: Awaited<ReturnType<typeof quarantineLegacyAudience>>
  sourceParticipantsAfter: number
}

const provisioned = !!provisioningUrl || inCi

describe.skipIf(!provisioned)('canonical legacy-audience quarantine (#1222)', () => {
  let connection: DatabaseConnection
  let scratch = ''
  let chainRoot: string | undefined
  let scenario: Scenario

  beforeAll(async () => {
    scratch = `${SCRATCH_PREFIX}${crypto.randomUUID().replaceAll('-', '').slice(0, 14)}`
    await adminExecute(`create database "${scratch}"`)
    connection = createDatabase(adminUrl(scratch))
    const chain = canonicalChainFolders()
    chainRoot = chain.root

    // Stage one: main through 0046, then #1229 and #1230. Legacy data is written before 0049/0050.
    await migrate(connection.db, { migrationsFolder: chain.stageOne })
    const seeded = await seedLegacyAudience({ migration: connection.db, runtime: connection.db })

    // The canonical chain: #1232's 0049 and 0050 backfill admit the legacy participants.
    await migrate(connection.db, { migrationsFolder: chain.full })
    // The tooling is additive and inert until a principal is quarantined, so installing it here
    // leaves the pre-quarantine state unchanged.
    await installLegacyAudienceQuarantine(connection.db)
    const sourceParticipantsBefore = await countSourceParticipants(connection.db)
    const beforeQuarantine = await reconcileLegacyAudience(connection.db)

    const profile = legacyBackfillProfile()
    const quarantineResult = await quarantineLegacyAudience(connection.db, {
      observedAt: OBSERVED_AT,
      profile,
    })
    const afterQuarantine = await reconcileLegacyAudience(connection.db)
    const quarantineRows = await rowsOf(
      connection.db,
      sql`select * from app.legacy_audience_quarantine order by reason, principal_id`
    )
    const quarantineRepeat = await quarantineLegacyAudience(connection.db, {
      observedAt: OBSERVED_AT,
      profile,
    })
    scenario = {
      afterQuarantine,
      beforeQuarantine,
      quarantineRepeat,
      quarantineResult,
      quarantineRows,
      seeded,
      sourceParticipantsAfter: await countSourceParticipants(connection.db),
      sourceParticipantsBefore,
    }
  }, 300_000)

  afterAll(async () => {
    if (connection) await connection.close()
    if (scratch) await adminExecute(`drop database if exists "${scratch}" with (force)`)
    if (chainRoot) rmSync(chainRoot, { recursive: true, force: true })
  })

  test('before quarantine the canonical backfill admits every active-group participant, unresolvable ones included', () => {
    const { beforeQuarantine } = scenario
    expect(beforeQuarantine.sourceRows).toBe(6)
    expect(beforeQuarantine.admissions).toBe(4)
    expect(beforeQuarantine.quarantined).toBe(0)
    expect(beforeQuarantine.audienceGrants).toBe(3)
    expect(beforeQuarantine.enlistmentGrants).toBe(1)
  })

  test('each unresolvable legacy principal is quarantined with one stable reason and no other record', () => {
    const { afterQuarantine, quarantineRows } = scenario
    expect(afterQuarantine.quarantined).toBe(4)
    expect(afterQuarantine.quarantinedByReason).toEqual({
      agent_workspace_mismatch: 1,
      group_channel_not_active: 2,
      user_not_workspace_member: 1,
    })
    expect(afterQuarantine.unrecordedClassifications).toBe(0)
    expect(quarantineRows.map((row) => row.reason).toSorted()).toEqual([
      'agent_workspace_mismatch',
      'group_channel_not_active',
      'group_channel_not_active',
      'user_not_workspace_member',
    ])
  })

  test('every quarantine record carries source, profile and time provenance', () => {
    const { quarantineRows, seeded } = scenario
    const profile = legacyBackfillProfile()
    for (const row of quarantineRows) {
      expect(String(row.source_row_digest)).toMatch(/^[0-9a-f]{64}$/)
      expect(String(row.source_participant_id)).toMatch(/^[0-9a-f-]{36}$/)
      expect(row.profile).toBe(profile)
      expect(String(row.profile)).toMatch(
        /^legacy-group-audience\/0050-group-legacy-backfill@[0-9a-f]{16}$/
      )
      expect(row.observed_at).toBe(OBSERVED_AT)
      expect(String(row.source_channel_created_at)).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
      )
      expect(String(row.source_joined_at)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      expect(row.workspace_id).toBe(seeded.workspaceId)
    }
  })

  test('withdrawal removes only the derived rows of quarantined principals and records their digests', () => {
    const { afterQuarantine, beforeQuarantine, quarantineRows } = scenario
    expect(afterQuarantine.admissions).toBe(2)
    expect(afterQuarantine.audienceGrants).toBe(2)
    expect(afterQuarantine.enlistmentGrants).toBe(0)
    expect(afterQuarantine.admissions).toBe(beforeQuarantine.admissions - 2)
    const withdrawn = quarantineRows.filter((row) => row.withdrawn_digest !== null)
    expect(withdrawn).toHaveLength(4)
    for (const row of withdrawn) expect(String(row.withdrawn_digest)).toMatch(/^[0-9a-f]{64}$/)
    const admissionTotal = quarantineRows.reduce(
      (sum, row) => sum + Number(row.withdrawn_admissions),
      0
    )
    expect(admissionTotal).toBe(2)
  })

  test('the original legacy participant rows are preserved: none removed or changed by quarantine', () => {
    const { sourceParticipantsAfter, sourceParticipantsBefore, beforeQuarantine, afterQuarantine } =
      scenario
    expect(sourceParticipantsBefore).toBe(6)
    expect(sourceParticipantsAfter).toBe(sourceParticipantsBefore)
    expect(afterQuarantine.sourceDigest).toBe(beforeQuarantine.sourceDigest)
  })

  test('reconciliation balances after quarantine: admissions equal the admissible rows, and admissions plus quarantined equal the source', () => {
    const { afterQuarantine } = scenario
    expect(afterQuarantine.admissibleRows).toBe(2)
    expect(afterQuarantine.invariants).toEqual({
      admissionsEqualAdmissible: true,
      admissionsPlusQuarantinedEqualSource: true,
      quarantineCoversClassification: true,
    })
  })

  test('denied-user access: a quarantined user cannot read the group, and an archived group is unavailable', async () => {
    const { seeded } = scenario
    // A user who has left the workspace fails the product's membership gate: the same unavailable
    // message the product gives for a channel the reader cannot see.
    await expect(
      listMessagesForUser(connection.db, seeded.workspaceId, seeded.activeGroupId, seeded.removed)
    ).rejects.toThrow('Channel unavailable')
    await expect(
      listMessagesForUser(connection.db, seeded.workspaceId, seeded.archivedGroupId, seeded.owner)
    ).rejects.toThrow('Channel unavailable')
    // Positive control: an admissible member still reads the active group.
    const allowed = await listMessagesForUser(
      connection.db,
      seeded.workspaceId,
      seeded.activeGroupId,
      seeded.member
    )
    expect(allowed.messages).toBeDefined()
  })

  test('publication into a group by a quarantined principal is refused by the product write path', async () => {
    const { seeded } = scenario
    await expect(
      createMessage(connection.db, seeded.workspaceId, seeded.activeGroupId, seeded.removed, {
        bodyText: 'quarantined publication',
        idempotencyKey: `quarantine-publish-${crypto.randomUUID()}`,
        sender: seeded.removed,
      })
    ).rejects.toThrow('Channel unavailable')
  })

  test('no new admission for a quarantined principal: a direct insert is refused, and a backfill replay admits nothing for it', async () => {
    const { seeded, afterQuarantine } = scenario
    const direct = (async () =>
      await connection.db.execute(sql`
      insert into app.group_admissions (workspace_id, channel_id, principal_kind, user_id, agent_id,
        joined_sequence, joined_at, auth_group_id, auth_grant_id, auth_revision)
      values (${seeded.workspaceId}, ${seeded.activeGroupId}, 'user', ${seeded.removedUserId}, null,
        0, '2026-01-05T00:00:00.000Z', ${seeded.activeGroupId}, 'implicit:member:' || ${seeded.removedUserId}::text, 1)
    `))()
    const refusal = await direct.then(
      () => 'accepted',
      (error: unknown) => postgresMessage(error)
    )
    expect(refusal).toMatch(/legacy audience is quarantined/)

    await replayCanonicalBackfill(connection.db)
    const afterReplay = await reconcileLegacyAudience(connection.db)
    expect(afterReplay.admissions).toBe(afterQuarantine.admissions)
    expect(afterReplay.audienceGrants).toBe(afterQuarantine.audienceGrants)
    expect(afterReplay.enlistmentGrants).toBe(afterQuarantine.enlistmentGrants)
    expect(afterReplay.quarantined).toBe(afterQuarantine.quarantined)
    expect(afterReplay.admissionsDigest).toBe(afterQuarantine.admissionsDigest)
    expect(afterReplay.quarantineDigest).toBe(afterQuarantine.quarantineDigest)
  })

  test('the other two shapes cannot be newly admitted: a direct insert for each is refused by the withholding trigger', async () => {
    const { quarantineRows, seeded } = scenario
    const mismatch = quarantineRows.find((row) => row.reason === 'agent_workspace_mismatch')!
    const archived = quarantineRows.find(
      (row) => row.reason === 'group_channel_not_active' && row.principal_kind === 'user'
    )!
    expect(mismatch).toBeDefined()
    expect(archived).toBeDefined()
    const agentRefusal = await connection.db
      .execute(sql`
      insert into app.group_admissions (workspace_id, channel_id, principal_kind, user_id, agent_id,
        joined_sequence, joined_at, auth_group_id, auth_grant_id, auth_revision)
      values (${mismatch.workspace_id}::uuid, ${mismatch.channel_id}::uuid, 'agent', null,
        ${mismatch.principal_id}::uuid, 0, '2026-01-05T00:00:00.000Z', ${mismatch.channel_id}::uuid,
        'implicit:agent:' || ${mismatch.principal_id}::text, 1)
    `)
      .then(
        () => 'accepted',
        (error: unknown) => postgresMessage(error)
      )
    expect(agentRefusal).toMatch(/legacy audience is quarantined \(agent_workspace_mismatch\)/)
    const userRefusal = await connection.db
      .execute(sql`
      insert into app.group_admissions (workspace_id, channel_id, principal_kind, user_id, agent_id,
        joined_sequence, joined_at, auth_group_id, auth_grant_id, auth_revision)
      values (${archived.workspace_id}::uuid, ${archived.channel_id}::uuid, 'user',
        ${archived.principal_id}::uuid, null, 0, '2026-01-05T00:00:00.000Z', ${archived.channel_id}::uuid,
        'implicit:member:' || ${archived.principal_id}::text, 1)
    `)
      .then(
        () => 'accepted',
        (error: unknown) => postgresMessage(error)
      )
    expect(userRefusal).toMatch(/legacy audience is quarantined \(group_channel_not_active\)/)
    expect(seeded.workspaceId).toBe(archived.workspace_id as string)
  })

  test('publication by the other two shapes is refused by the product write path', async () => {
    const { quarantineRows, seeded } = scenario
    const archived = quarantineRows.find(
      (row) => row.reason === 'group_channel_not_active' && row.principal_kind === 'user'
    )!
    await expect(
      createMessage(
        connection.db,
        seeded.workspaceId,
        archived.channel_id as string,
        seeded.member,
        {
          bodyText: 'archived publication',
          idempotencyKey: `archived-publish-${crypto.randomUUID()}`,
          sender: { kind: 'user', userId: archived.principal_id as string },
        }
      )
    ).rejects.toThrow('Channel unavailable')
    // The group agent path (#1232) checks the agent's admission and refuses as an unavailable
    // channel, not as a host-workspace agent mismatch.
    await expect(
      createRuntimeResultMessage(
        connection.db,
        seeded.workspaceId,
        seeded.activeGroupId,
        seeded.member,
        {
          bodyText: 'mismatched agent publication',
          executionRef: `exec-${crypto.randomUUID()}`,
          externalSessionRef: `session-${crypto.randomUUID()}`,
          idempotencyKey: `mismatch-publish-${crypto.randomUUID()}`,
          sender: { kind: 'agent', agentId: seeded.otherWorkspaceAgentId },
        }
      )
    ).rejects.toThrow('Channel unavailable')
  })

  test('quarantine is idempotent: a repeat records and withdraws nothing, and the digests do not move', async () => {
    const { quarantineRepeat, afterQuarantine, quarantineResult } = scenario
    expect(quarantineResult.recordedNow).toBe(4)
    expect(quarantineResult.withdrawnNow).toEqual({
      admissions: 2,
      audienceGrants: 1,
      enlistmentGrants: 1,
    })
    expect(quarantineRepeat.recordedNow).toBe(0)
    expect(quarantineRepeat.withdrawnNow).toEqual({
      admissions: 0,
      audienceGrants: 0,
      enlistmentGrants: 0,
    })
    const again = await reconcileLegacyAudience(connection.db)
    expect(again.quarantineDigest).toBe(afterQuarantine.quarantineDigest)
    expect(again.admissionsDigest).toBe(afterQuarantine.admissionsDigest)
    expect(again.quarantined).toBe(4)
  })

  test('no broader audience is assigned: a quarantined (channel, principal) pair holds no admission or grant', async () => {
    const { quarantineRows } = scenario
    for (const row of quarantineRows) {
      const channelId = String(row.channel_id)
      const principalId = String(row.principal_id)
      const admissions = await rowsOf(
        connection.db,
        sql`select id from app.group_admissions
            where channel_id = ${channelId}::uuid and coalesce(user_id, agent_id) = ${principalId}::uuid`
      )
      expect(admissions).toEqual([])
      if (row.principal_kind === 'user') {
        const audience = await rowsOf(
          connection.db,
          sql`select id from app.group_audience_grants
              where channel_id = ${channelId}::uuid and user_id = ${principalId}::uuid`
        )
        expect(audience).toEqual([])
      } else {
        const enlistment = await rowsOf(
          connection.db,
          sql`select id from app.group_enlistment_grants
              where channel_id = ${channelId}::uuid and agent_id = ${principalId}::uuid`
        )
        expect(enlistment).toEqual([])
      }
    }
  })

  test('the quarantine digests are reproducible from the same rows: the reconciliation is deterministic', async () => {
    const first = await reconcileLegacyAudience(connection.db)
    const second = await reconcileLegacyAudience(connection.db)
    expect(second).toEqual(first)
    expect(createHash('sha256').update(first.quarantineDigest).digest('hex')).toMatch(
      /^[0-9a-f]{64}$/
    )
  })

  test('known gap, recorded: the quarantined originals stay in channel_participants, so the rows still exist as legacy records', async () => {
    const rows = await countQuarantinedOriginals(connection.db)
    expect(rows).toBe(4)
  })
})

/** The database's own message, walking past drizzle's query wrapper to the underlying error. */
function postgresMessage(error: unknown): string {
  const messages: string[] = []
  let current: unknown = error
  while (current instanceof Error) {
    messages.push(current.message)
    current = current.cause
  }
  return messages.join(' <- ')
}

async function countSourceParticipants(db: AgentHqDatabase): Promise<number> {
  const rows = await db.execute<{ count: number }>(sql`
    select count(*)::int as count from app.channel_participants cp
    join app.channels ch on ch.id = cp.channel_id and ch.workspace_id = cp.workspace_id
    where ch.kind = 'group'
  `)
  return rows[0]?.count ?? -1
}

async function countQuarantinedOriginals(db: AgentHqDatabase): Promise<number> {
  const rows = await db.execute<{ count: number }>(sql`
    select count(*)::int as count from app.channel_participants cp
    join app.legacy_audience_quarantine q on q.source_participant_id = cp.id
  `)
  return rows[0]?.count ?? -1
}
