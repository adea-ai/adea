import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

import type { UserPrincipalRef } from '@adea-ai/types'

import { accountConversationInbox } from '../../src/account-inbox'
import { accountWorkspaceSummaries } from '../../src/account-summary'
import { createDatabase, type AgentHqDatabase, type DatabaseConnection } from '../../src/connection'
import { createAgent } from '../../src/agents'
import * as schema from '../../src/schema'
import { classifyWorkspaceEventsForUser } from '../../src/event-visibility'
import type { WorkspaceEventView } from '../../src/event-log'
import {
  captureMigrationSnapshot,
  type MigrationSnapshotCaptureIdentityInput,
} from '../../src/migration-snapshot-capture'
import { compareMigrationSnapshots } from '../../src/migration-snapshot-comparator'
import {
  archiveChannel,
  createMessage,
  createRuntimeResultMessage,
  deleteMessage,
  editMessage,
  getChannelForUser,
  getMessageForUser,
  listChannelsForUser,
  listMessagesForUser,
  setChannelParticipants,
  updateChannel,
} from '../../src/conversations'
import { postGroupChannelMessage } from '../../src/group-channels'
import { loadGroupAdmission } from '../../src/group-participation-store'
import { listReadStateForUser, markChannelReadState } from '../../src/read-state'
import { searchWorkspaceForUser } from '../../src/search'
import { channelParticipants, groupAdmissions, workspaceMemberships } from '../../src/schema'
import { canonicalChainFolders } from '../fixtures/canonical-chain'
import {
  canonicalUrl,
  createCanonicalDatabase,
  MIGRATION_ROLE,
  RUNTIME_ROLE,
} from '../fixtures/canonical-boundary'
import {
  canonicalBackfillStatements,
  legacyBackfillProfile,
} from '../fixtures/legacy-audience-quarantine'
import { seedLegacyAudience, type LegacyAudienceSeed } from '../fixtures/legacy-audience-seed'
import { DRIZZLE_DIR, migrationsFolderBefore } from '../fixtures/cutover-rehearsal'

// #1222 quarantine, proved at the product boundaries a stale legacy roster row can reach.
//
// The legacy `channel_participants` rows of a quarantined audience remain. Its canonical admission
// is withheld. Each product read, append and join below is run as the quarantined user, with
// workspace membership restored (the user was re-invited), so the only thing left to refuse them is
// the group's canonical admission. Clean members run the same calls as controls.
//
// One upgrade database on a disposable instance with the canonical role boundary: main through
// 0046, the stage-one #1229/#1230 chain, the legacy seed, the canonical 0049/0050 backfill, then the
// quarantine. Migrations run as the migration role. Product calls run as the runtime role.

const provisioningUrl = process.env.MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL
const inCi = process.env.CI === 'true' || process.env.CI === '1'
const provisioned = !!provisioningUrl || inCi
const SCRATCH_PREFIX = 'rehearsal_1222g_'
const OBSERVED_AT = '2026-01-05T00:00:00.000Z'
const QUARANTINE_SNAPSHOT_FAMILIES = [
  'groupAdmissions',
  'groupAudienceGrants',
  'groupEnlistmentGrants',
  'groupSharingGrants',
  'legacyAudienceQuarantine',
] as const

type AgentLifecycleCases = Readonly<{
  active: string
  archived: string
  configurationError: string
}>

/** Seed active, archived and configuration-error same-workspace Agents on historical rosters. */
async function addAgentLifecycleCases(
  fixture: Fixture,
  seed: LegacyAudienceSeed
): Promise<AgentLifecycleCases> {
  const create = (name: string) =>
    createAgent(fixture.runtime.db, seed.workspaceId, seed.owner, {
      name,
      profileId: 'software-engineer',
      profileVersion: '1.0.0',
    })
  const [active, archived, configurationError] = await Promise.all([
    create(`Quarantine active ${crypto.randomUUID()}`),
    create(`Quarantine archived ${crypto.randomUUID()}`),
    create(`Quarantine config-error ${crypto.randomUUID()}`),
  ])
  await fixture.migration.db.execute(sql`
    update app.agents set lifecycle_state = 'archived' where id = ${archived.id}::uuid
  `)
  await fixture.migration.db.execute(sql`
    update app.agents set lifecycle_state = 'configuration_error' where id = ${configurationError.id}::uuid
  `)
  await fixture.migration.db.insert(channelParticipants).values([
    {
      agentId: active.id,
      channelId: seed.activeGroupId,
      principalKind: 'agent',
      workspaceId: seed.workspaceId,
    },
    {
      agentId: archived.id,
      channelId: seed.activeGroupId,
      principalKind: 'agent',
      workspaceId: seed.workspaceId,
    },
    {
      agentId: configurationError.id,
      channelId: seed.activeGroupId,
      principalKind: 'agent',
      workspaceId: seed.workspaceId,
    },
    {
      agentId: active.id,
      channelId: seed.archivedGroupId,
      principalKind: 'agent',
      workspaceId: seed.workspaceId,
    },
  ])
  return { active: active.id, archived: archived.id, configurationError: configurationError.id }
}

const quarantineSnapshotIdentity = (snapshotId: string): MigrationSnapshotCaptureIdentityInput => ({
  capturedAt: new Date(OBSERVED_AT),
  rehearsalId: 'migration-canonical-legacy-product-gate',
  snapshotId,
  source: 'disposable-canonical-migration',
})

function adminUrl(database: string): string {
  if (!provisioningUrl) throw new Error('MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL is not set')
  const url = new URL(provisioningUrl)
  url.pathname = `/${database}`
  return url.toString()
}

type Fixture = {
  database: string
  migration: DatabaseConnection
  runtime: DatabaseConnection
}

function open(database: string): Fixture {
  return {
    database,
    migration: createDatabase(canonicalUrl(adminUrl(database), database, MIGRATION_ROLE)),
    runtime: createDatabase(canonicalUrl(adminUrl(database), database, RUNTIME_ROLE)),
  }
}

async function switchMigrationTimeZone(fixture: Fixture, timeZone: string): Promise<void> {
  await fixture.migration.close()
  const client = postgres(
    canonicalUrl(adminUrl(fixture.database), fixture.database, MIGRATION_ROLE),
    {
      max: 1,
      connect_timeout: 10,
      idle_timeout: 20,
      prepare: false,
      connection: { TimeZone: timeZone },
      onnotice: () => {},
    }
  )
  fixture.migration = {
    client,
    db: drizzle(client, { schema }),
    close: () => client.end({ timeout: 5 }),
  }
}

type Settled<T> = { value: T } | { denied: string }

/** The product's own answer, including its refusal message, without throwing into the test. */
async function settle<T>(run: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { value: await run() }
  } catch (error) {
    return { denied: error instanceof Error ? error.message : String(error) }
  }
}

/** Every message in an error's cause chain: a driver failure names its database refusal only as the cause. */
function messageChain(error: unknown): string {
  const parts: string[] = []
  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    parts.push(current instanceof Error ? current.message : String(current))
    current = current instanceof Error ? current.cause : undefined
  }
  return parts.join(' | ')
}

async function countRows(db: AgentHqDatabase, statement: ReturnType<typeof sql>) {
  const [row] = (await db.execute<{ count: number }>(statement)) as unknown as {
    count: number
  }[]
  return Number(row?.count ?? 0)
}

/** Everything a refused write must leave untouched: messages, roster rows, admissions, version. */
async function writeFootprint(db: AgentHqDatabase, workspaceId: string, channelId: string) {
  return {
    admissions: await countRows(
      db,
      sql`select count(*)::int as count from ${groupAdmissions} where channel_id = ${channelId}::uuid and workspace_id = ${workspaceId}::uuid`
    ),
    messages: await countRows(
      db,
      sql`select count(*)::int as count from app.messages where channel_id = ${channelId}::uuid`
    ),
    quarantinedOriginals: await countRows(
      db,
      sql`select count(*)::int as count
          from app.legacy_audience_quarantine q
          join app.channel_participants cp on cp.id = q.source_participant_id
          where q.channel_id = ${channelId}::uuid
            and q.source_row_digest = app.legacy_participant_digest(cp)`
    ),
    rosterRows: await countRows(
      db,
      sql`select count(*)::int as count from ${channelParticipants} where channel_id = ${channelId}::uuid and workspace_id = ${workspaceId}::uuid`
    ),
    version: await countRows(
      db,
      sql`select version::int as count from app.channels where id = ${channelId}::uuid`
    ),
  }
}

/** The unread channel count the account summary reports for one workspace. */
async function unreadChannelsFor(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef
) {
  const summaries = await accountWorkspaceSummaries(database, principal)
  return summaries.find((row) => row.workspaceId === workspaceId)?.unreadChannels
}

/** The stale audience re-enters the workspace; its original roster row is still on record. */
function reinviteUser(db: AgentHqDatabase, seedValue: LegacyAudienceSeed) {
  return db.insert(workspaceMemberships).values({
    role: 'member',
    userId: seedValue.removedUserId,
    workspaceId: seedValue.workspaceId,
  })
}

function channelUpdatedEvent(channelId: string): WorkspaceEventView {
  return {
    actor: null,
    aggregateId: channelId,
    aggregateType: 'channel',
    correlationId: null,
    eventId: crypto.randomUUID(),
    eventType: 'channel.updated',
    occurredAt: new Date(OBSERVED_AT),
    payload: { channelId },
    schemaVersion: 1,
    workspaceSequence: 1,
  }
}

describe.skipIf(!provisioned)(
  'canonical quarantine at the stale-participant product boundary (#1222)',
  () => {
    let admin: postgres.Sql
    let upgrade: Fixture
    let seed: LegacyAudienceSeed
    let agentLifecycleCases: AgentLifecycleCases
    let ownerMessageId: string
    let migrationQuarantineComparison: ReturnType<typeof compareMigrationSnapshots> | undefined
    let migrationQuarantineCapture: Awaited<ReturnType<typeof captureMigrationSnapshot>> | undefined
    let preQuarantineQuarantineDomain: unknown
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 14)
    const upgradeName = `${SCRATCH_PREFIX}upgrade_${suffix}`

    beforeAll(async () => {
      admin = postgres(adminUrl('postgres'), { max: 1, onnotice: () => {} })
      await createCanonicalDatabase(admin, adminUrl, upgradeName)
      upgrade = open(upgradeName)
      const chain = canonicalChainFolders()

      await migrate(upgrade.migration.db, { migrationsFolder: chain.stageOne })
      seed = await seedLegacyAudience({
        migration: upgrade.migration.db,
        runtime: upgrade.runtime.db,
      })
      agentLifecycleCases = await addAgentLifecycleCases(upgrade, seed)
      await migrate(upgrade.migration.db, { migrationsFolder: chain.full })
      const beforeQuarantineTail = migrationsFolderBefore('0058_legacy_audience_quarantine')
      try {
        await migrate(upgrade.migration.db, { migrationsFolder: beforeQuarantineTail })
        const beforeQuarantine = await captureMigrationSnapshot(upgrade.migration.db, {
          identity: quarantineSnapshotIdentity('before-0058'),
          requestedDomains: QUARANTINE_SNAPSHOT_FAMILIES,
        })
        preQuarantineQuarantineDomain = beforeQuarantine.domains.find(
          (domain) => domain.domain === 'legacyAudienceQuarantine'
        )
        // Exercise the production migration from a non-UTC operator session. The migration's
        // withdrawn-row JSON digest must not depend on this connection-level setting.
        await switchMigrationTimeZone(upgrade, 'Pacific/Auckland')
        const [migrationTimeZone] = await rowsOf(
          upgrade.migration.db,
          sql`select current_setting('TimeZone') as time_zone`
        )
        expect(migrationTimeZone?.time_zone).toBe('Pacific/Auckland')
        await migrate(upgrade.migration.db, { migrationsFolder: DRIZZLE_DIR })
        const [restoredTimeZone] = await rowsOf(
          upgrade.migration.db,
          sql`select current_setting('TimeZone') as time_zone`
        )
        expect(restoredTimeZone?.time_zone).toBe('Pacific/Auckland')
        const afterQuarantine = await captureMigrationSnapshot(upgrade.migration.db, {
          identity: quarantineSnapshotIdentity('after-0058'),
          requestedDomains: QUARANTINE_SNAPSHOT_FAMILIES,
        })
        migrationQuarantineCapture = afterQuarantine
        migrationQuarantineComparison = compareMigrationSnapshots({
          after: afterQuarantine.document,
          before: beforeQuarantine.document,
        })
      } finally {
        rmSync(beforeQuarantineTail, { recursive: true, force: true })
      }
      const legacy = await postGroupChannelMessage(
        upgrade.runtime.db,
        seed.workspaceId,
        seed.activeGroupId,
        seed.owner,
        seed.owner,
        { message: { bodyText: 'legacy hello', idempotencyKey: 'legacy-hello' }, mode: 'direct' }
      )
      ownerMessageId = legacy.id
      await postGroupChannelMessage(
        upgrade.runtime.db,
        seed.workspaceId,
        seed.activeGroupId,
        seed.member,
        seed.member,
        { message: { bodyText: 'clean member note', idempotencyKey: 'clean-note' }, mode: 'direct' }
      )
      await reinviteUser(upgrade.migration.db, seed)
      await restoreQuarantinedAdmissionsForAuthorityProbe(upgrade, seed)
    }, 300_000)

    afterAll(async () => {
      await upgrade?.runtime.close()
      await upgrade?.migration.close()
      if (admin) {
        await admin.unsafe(`drop database if exists "${upgradeName}" with (force)`)
        await admin.end()
      }
    })

    const db = () => upgrade.runtime.db
    const ws = () => seed.workspaceId
    const active = () => seed.activeGroupId
    const stale = (): UserPrincipalRef => seed.removed

    test('0058 withdraws the exact ambiguous group records and preserves the registered snapshot proof', () => {
      if (!migrationQuarantineComparison)
        throw new Error('production quarantine comparison was not captured')
      expect(preQuarantineQuarantineDomain).toEqual({
        domain: 'legacyAudienceQuarantine',
        status: 'unknown',
        unknownReason: 'schema_absent',
      })
      expect(migrationQuarantineComparison.findings).toContainEqual(
        expect.objectContaining({
          family: 'legacyAudienceQuarantine',
          findingClass: 'unknown_domain',
        })
      )
      const findings = migrationQuarantineComparison.findings.filter(
        (finding) => finding.findingClass !== 'unknown_domain'
      )
      expect(
        findings.map((finding) => `${finding.findingClass}:${finding.family}`).toSorted()
      ).toEqual(
        [
          'missing_record:groupAdmissions',
          'missing_record:groupAdmissions',
          'missing_record:groupAdmissions',
          'missing_record:groupAdmissions',
          'missing_record:groupAudienceGrants',
          'missing_record:groupEnlistmentGrants',
          'missing_record:groupEnlistmentGrants',
          'missing_record:groupEnlistmentGrants',
        ].toSorted()
      )
      expect(migrationQuarantineComparison.verdict).toBe('divergent')
    })

    test('archived and configuration-error same-workspace Agents are quarantined, while active Agents remain admitted', async () => {
      if (!migrationQuarantineCapture)
        throw new Error('production quarantine snapshot was not captured')
      const records = migrationQuarantineCapture.document.sections.legacyAudienceQuarantine?.records
      expect(records).toHaveLength(7)
      expect(
        records
          ?.filter((record) => record.reason === 'agent_not_active')
          .map((record) => record.principalId)
          .toSorted()
      ).toEqual([agentLifecycleCases.archived, agentLifecycleCases.configurationError].toSorted())
      expect(
        records
          ?.filter(
            (record) =>
              record.principalKind === 'agent' && record.channelId === seed.archivedGroupId
          )
          .map((record) => record.reason)
      ).toContain('group_channel_not_active')
      expect(
        migrationQuarantineCapture.document.sections.groupEnlistmentGrants?.records
      ).toContainEqual(expect.objectContaining({ agentId: agentLifecycleCases.active }))
      expect(
        migrationQuarantineCapture.document.sections.groupEnlistmentGrants?.records
      ).not.toContainEqual(expect.objectContaining({ agentId: agentLifecycleCases.archived }))
      const directRestore = await upgrade.migration.db.execute(sql`
        insert into app.group_admissions (workspace_id, channel_id, principal_kind, user_id, agent_id,
          joined_sequence, joined_at, auth_group_id, auth_grant_id, auth_revision)
        values (${seed.workspaceId}::uuid, ${seed.activeGroupId}::uuid, 'agent', null,
          ${agentLifecycleCases.archived}::uuid, 0, ${OBSERVED_AT}, ${seed.activeGroupId}::uuid,
          'qualification-archived-restore', 1)
        returning id
      `)
      expect(directRestore).toHaveLength(0)
      expect(
        await countRows(
          upgrade.migration.db,
          sql`select count(*)::int as count from app.group_admissions
              where auth_grant_id = 'qualification-archived-restore'`
        )
      ).toBe(0)
    })

    test('the migration preserves and records the stale audience source row', async () => {
      const membership = await countRows(
        upgrade.migration.db,
        sql`select count(*)::int as count from app.workspace_memberships where workspace_id = ${ws()}::uuid and user_id = ${stale().userId}::uuid`
      )
      expect(membership).toBe(1)
      expect(
        await loadGroupAdmission(db(), ws(), active(), { kind: 'user', userId: stale().userId })
      ).toBeNull()
      const quarantine = await rowsOf(
        upgrade.migration.db,
        sql`select reason, source_row_digest, withdrawn_digest, profile
            from app.legacy_audience_quarantine
            where workspace_id = ${ws()}::uuid and channel_id = ${active()}::uuid
              and principal_kind = 'user' and principal_id = ${stale().userId}::uuid`
      )
      expect(quarantine).toHaveLength(1)
      expect(quarantine[0]?.reason).toBe('user_not_workspace_member')
      expect(quarantine[0]?.profile).toBe(legacyBackfillProfile())
      expect(String(quarantine[0]?.source_row_digest)).toMatch(/^[0-9a-f]{64}$/)
      expect(String(quarantine[0]?.withdrawn_digest)).toMatch(/^[0-9a-f]{64}$/)
      const [microsecondDigests] = await rowsOf(
        upgrade.migration.db,
        sql`select
              app.legacy_participant_digest(jsonb_populate_record(
                cp, jsonb_build_object(
                  'created_at', date_trunc('milliseconds', cp.created_at) + interval '1 microsecond'
                )
              )) as first_digest,
              app.legacy_participant_digest(jsonb_populate_record(
                cp, jsonb_build_object(
                  'created_at', date_trunc('milliseconds', cp.created_at) + interval '2 microseconds'
                )
              )) as second_digest
            from app.channel_participants cp
            join app.legacy_audience_quarantine q on q.source_participant_id = cp.id
            where q.workspace_id = ${ws()}::uuid and q.channel_id = ${active()}::uuid
              and q.principal_kind = 'user' and q.principal_id = ${stale().userId}::uuid`
      )
      expect(String(microsecondDigests?.first_digest)).not.toBe(
        String(microsecondDigests?.second_digest)
      )
      const roster = await countRows(
        upgrade.migration.db,
        sql`select count(*)::int as count from ${channelParticipants} where channel_id = ${active()}::uuid and principal_kind = 'user' and user_id = ${stale().userId}::uuid`
      )
      expect(roster).toBe(1)
    })

    test('re-running the migrator and historical backfill does not restore quarantined grants', async () => {
      const before = await rowsOf(
        upgrade.migration.db,
        sql`select source_row_digest, withdrawn_digest
            from app.legacy_audience_quarantine
            where workspace_id = ${ws()}::uuid and channel_id = ${active()}::uuid
            order by principal_kind, principal_id`
      )
      await migrate(upgrade.migration.db, { migrationsFolder: DRIZZLE_DIR })
      await upgrade.migration.db.transaction(async (tx) => {
        for (const statement of canonicalBackfillStatements()) await tx.execute(sql.raw(statement))
      })
      const after = await rowsOf(
        upgrade.migration.db,
        sql`select source_row_digest, withdrawn_digest
            from app.legacy_audience_quarantine
            where workspace_id = ${ws()}::uuid and channel_id = ${active()}::uuid
            order by principal_kind, principal_id`
      )
      expect(after).toEqual(before)
      expect(
        await countRows(
          upgrade.migration.db,
          sql`select count(*)::int as count from app.group_audience_grants
              where workspace_id = ${ws()}::uuid and channel_id = ${active()}::uuid
                and user_id = ${stale().userId}::uuid`
        )
      ).toBe(1)
    })

    test('quarantine remains authoritative even if legacy derived rows are restored', async () => {
      const admission = await countRows(
        upgrade.migration.db,
        sql`select count(*)::int as count from app.group_admissions
            where workspace_id = ${ws()}::uuid and channel_id = ${active()}::uuid
              and principal_kind = 'user' and user_id = ${stale().userId}::uuid`
      )
      expect(admission).toBe(1)
      expect(
        await loadGroupAdmission(db(), ws(), active(), { kind: 'user', userId: stale().userId })
      ).toBeNull()
      expect(await settle(() => getChannelForUser(db(), ws(), active(), stale()))).toEqual({
        denied: 'Channel unavailable',
      })
      expect(
        await loadGroupAdmission(db(), ws(), active(), {
          kind: 'agent',
          agentId: seed.otherWorkspaceAgentId,
        })
      ).toBeNull()
      expect(
        await settle(() =>
          createRuntimeResultMessage(db(), ws(), active(), seed.owner, {
            bodyText: 'wrong-workspace agent bypass',
            executionRef: `exec-${crypto.randomUUID()}`,
            externalSessionRef: `session-${crypto.randomUUID()}`,
            idempotencyKey: `agent-bypass-${crypto.randomUUID()}`,
            sender: { kind: 'agent', agentId: seed.otherWorkspaceAgentId },
          })
        )
      ).toEqual({ denied: 'Channel unavailable' })
    })

    test('runtime DML cannot change quarantined grants, admissions, source rows or the quarantine record', async () => {
      const attempts = [
        upgrade.runtime.db.execute(sql`
          update app.group_admissions set joined_sequence = 1
          where workspace_id = ${ws()}::uuid and channel_id = ${active()}::uuid
            and principal_kind = 'user' and user_id = ${stale().userId}::uuid
        `),
        upgrade.runtime.db.execute(sql`
          update app.group_audience_grants set revision = revision + 1
          where workspace_id = ${ws()}::uuid and channel_id = ${active()}::uuid
            and user_id = ${stale().userId}::uuid
        `),
        upgrade.runtime.db.execute(sql`
          update app.group_enlistment_grants set revision = revision + 1
          where workspace_id = ${ws()}::uuid and channel_id = ${active()}::uuid
            and agent_id = ${seed.otherWorkspaceAgentId}::uuid
        `),
        upgrade.runtime.db.execute(sql`
          update app.group_admissions set joined_sequence = 1
          where workspace_id = ${ws()}::uuid and channel_id = ${active()}::uuid
            and principal_kind = 'agent' and agent_id = ${seed.otherWorkspaceAgentId}::uuid
        `),
        upgrade.runtime.db.execute(sql`
          update app.channel_participants set updated_at = now()
          where workspace_id = ${ws()}::uuid and channel_id = ${active()}::uuid
            and principal_kind = 'user' and user_id = ${stale().userId}::uuid
        `),
        upgrade.runtime.db.execute(sql`
          delete from app.channel_participants
          where workspace_id = ${ws()}::uuid and channel_id = ${active()}::uuid
            and principal_kind = 'user' and user_id = ${stale().userId}::uuid
        `),
        upgrade.runtime.db.execute(sql`
          delete from app.legacy_audience_quarantine
          where workspace_id = ${ws()}::uuid and channel_id = ${active()}::uuid
            and principal_kind = 'user' and principal_id = ${stale().userId}::uuid
        `),
        upgrade.runtime.db.execute(sql`
          update app.legacy_audience_quarantine set observed_at = 'tampered'
          where workspace_id = ${ws()}::uuid and channel_id = ${active()}::uuid
            and principal_kind = 'user' and principal_id = ${stale().userId}::uuid
        `),
        // The canonical migration role owns the table, but ownership does not bypass the immutable
        // quarantine trigger after cutover. A future migration must make any repair explicit.
        upgrade.migration.db.execute(sql`
          update app.legacy_audience_quarantine set observed_at = 'owner-bypass'
          where workspace_id = ${ws()}::uuid and channel_id = ${active()}::uuid
            and principal_kind = 'user' and principal_id = ${stale().userId}::uuid
        `),
      ]
      for (const attempt of attempts) {
        const result = await attempt.then(
          () => 'accepted',
          (error: unknown) => messageChain(error)
        )
        expect(result).toMatch(/legacy audience is quarantined|quarantine is migration-managed/)
      }
    })

    test('new grant and admission inserts cannot recreate quarantined authority', async () => {
      await upgrade.runtime.db.execute(sql`
        insert into app.group_audience_grants
          (workspace_id, channel_id, grant_id, revision, user_id, issued_at, expires_at, revoked_at)
        values (${ws()}::uuid, ${active()}::uuid, 'runtime_attempted_quarantined_insert', 1,
          ${stale().userId}::uuid, ${OBSERVED_AT}, null, null)
      `)
      await upgrade.runtime.db.execute(sql`
        insert into app.group_admissions
          (workspace_id, channel_id, principal_kind, user_id, agent_id, joined_sequence, joined_at,
           auth_group_id, auth_grant_id, auth_revision)
        values (${ws()}::uuid, ${active()}::uuid, 'user', ${stale().userId}::uuid, null,
          0, ${OBSERVED_AT}, ${active()}, 'runtime_attempted_quarantined_insert', 1)
      `)
      expect(
        await countRows(
          upgrade.migration.db,
          sql`select count(*)::int as count from app.group_audience_grants
              where grant_id = 'runtime_attempted_quarantined_insert'`
        )
      ).toBe(0)
      expect(
        await countRows(
          upgrade.migration.db,
          sql`select count(*)::int as count from app.group_admissions
              where workspace_id = ${ws()}::uuid and channel_id = ${active()}::uuid
                and principal_kind = 'user' and user_id = ${stale().userId}::uuid`
        )
      ).toBe(1)
      expect(
        await loadGroupAdmission(db(), ws(), active(), { kind: 'user', userId: stale().userId })
      ).toBeNull()
    })

    describe('read', () => {
      test('getChannelForUser refuses the stale group by its admission, not its roster row', async () => {
        expect(await settle(() => getChannelForUser(db(), ws(), active(), stale()))).toEqual({
          denied: 'Channel unavailable',
        })
        expect(
          'value' in (await settle(() => getChannelForUser(db(), ws(), active(), seed.owner)))
        ).toBe(true)
      })

      test('listChannelsForUser omits the stale group; clean members still list it', async () => {
        const staleIds = (await listChannelsForUser(db(), ws(), stale())).map(
          (channel) => channel.id
        )
        expect(staleIds).not.toContain(active())
        const ownerIds = (await listChannelsForUser(db(), ws(), seed.owner)).map((c) => c.id)
        expect(ownerIds).toContain(active())
      })

      test('listMessagesForUser and getMessageForUser refuse the stale group history', async () => {
        expect(await settle(() => listMessagesForUser(db(), ws(), active(), stale()))).toEqual({
          denied: 'Channel unavailable',
        })
        expect(await settle(() => getMessageForUser(db(), ws(), ownerMessageId, stale()))).toEqual({
          denied: 'Channel unavailable',
        })
        const ownerPage = await listMessagesForUser(db(), ws(), active(), seed.owner)
        expect(ownerPage.messages.map((message) => message.bodyText)).toContain('legacy hello')
      })

      test('the account inbox and the read state omit the stale group', async () => {
        const inbox = await accountConversationInbox(db(), stale())
        expect(inbox.conversations.map((entry) => entry.id)).not.toContain(active())
        const readState = await listReadStateForUser(db(), ws(), stale())
        expect(readState.map((entry) => entry.channelId)).not.toContain(active())
        const ownerInbox = await accountConversationInbox(db(), seed.owner)
        expect(ownerInbox.conversations.map((entry) => entry.id)).toContain(active())
        expect(
          await settle(() => markChannelReadState(db(), ws(), active(), stale(), 'read', 1))
        ).toEqual({ denied: 'Read state unavailable' })
      })

      test('the account summary counts no unread from the stale group', async () => {
        // The group has messages nobody has read. The owner counts it; the stale user must not.
        expect(await unreadChannelsFor(db(), ws(), seed.owner)).toBeGreaterThan(0)
        expect(await unreadChannelsFor(db(), ws(), stale())).toBe(0)
      })

      test('search returns neither the stale group as a channel nor its messages', async () => {
        const { title } = await getChannelForUser(db(), ws(), active(), seed.owner)
        const staleHits = await searchWorkspaceForUser(db(), ws(), stale(), title)
        expect(staleHits.results.filter((hit) => hit.kind === 'channel')).not.toContainEqual(
          expect.objectContaining({ id: active() })
        )
        const staleMessages = await searchWorkspaceForUser(db(), ws(), stale(), 'legacy hello')
        expect(staleMessages.results.filter((hit) => hit.kind === 'message')).toEqual([])
        const ownerHits = await searchWorkspaceForUser(db(), ws(), seed.owner, 'legacy hello')
        expect(ownerHits.results.some((hit) => hit.kind === 'message')).toBe(true)
      })

      test('workspace events about the stale group are not delivered to it', async () => {
        const staleDelivery = await classifyWorkspaceEventsForUser(db(), ws(), stale().userId, [
          channelUpdatedEvent(active()),
        ])
        expect(staleDelivery?.[0]?.kind).not.toBe('deliver')
        const ownerDelivery = await classifyWorkspaceEventsForUser(db(), ws(), seed.owner.userId, [
          channelUpdatedEvent(active()),
        ])
        expect(ownerDelivery?.[0]?.kind).toBe('deliver')
      })
    })

    describe('append', () => {
      test('createMessage refuses a post from the stale audience, and writes nothing', async () => {
        const before = await writeFootprint(db(), ws(), active())
        const attempt = await settle(() =>
          createMessage(db(), ws(), active(), stale(), {
            bodyText: 'stale append through the legacy writer',
            idempotencyKey: `stale-create-${crypto.randomUUID()}`,
            sender: { kind: 'user', userId: stale().userId },
          })
        )
        expect(attempt).toEqual({ denied: 'Channel unavailable' })
        expect(await writeFootprint(db(), ws(), active())).toEqual(before)
      })

      test('direct message-id edit and delete refuse the stale audience, and write nothing', async () => {
        const before = await writeFootprint(db(), ws(), active())
        const message = await rowsOf(
          upgrade.migration.db,
          sql`select id, version from app.messages where channel_id = ${active()}::uuid
              order by sequence limit 1`
        )
        const id = String(message[0]?.id)
        const version = Number(message[0]?.version)
        expect(
          await settle(() => editMessage(db(), ws(), id, stale(), { bodyText: 'changed' }, version))
        ).toEqual({ denied: 'Channel unavailable' })
        expect(await settle(() => deleteMessage(db(), ws(), id, stale(), version))).toEqual({
          denied: 'Channel unavailable',
        })
        expect(await writeFootprint(db(), ws(), active())).toEqual(before)
      })

      test('generic append and channel status/payload writes refuse the stale audience', async () => {
        const before = await writeFootprint(db(), ws(), active())
        const channel = await getChannelForUser(db(), ws(), active(), seed.owner)
        expect(
          await settle(() =>
            createMessage(db(), ws(), active(), stale(), {
              bodyText: 'generic append bypass',
              idempotencyKey: 'quarantined-generic-append',
              sender: stale(),
            })
          )
        ).toEqual({ denied: 'Channel unavailable' })
        expect(
          await settle(() =>
            updateChannel(
              db(),
              ws(),
              active(),
              stale(),
              { title: 'bypassed title' },
              channel.version
            )
          )
        ).toEqual({ denied: 'Channel unavailable' })
        expect(
          await settle(() => archiveChannel(db(), ws(), active(), stale(), channel.version))
        ).toEqual({ denied: 'Channel unavailable' })
        expect(await writeFootprint(db(), ws(), active())).toEqual(before)
      })

      test('the canonical group post refuses the stale audience, and writes nothing', async () => {
        const before = await writeFootprint(db(), ws(), active())
        const attempt = await settle(() =>
          postGroupChannelMessage(db(), ws(), active(), stale(), stale(), {
            message: {
              bodyText: 'stale canonical post',
              idempotencyKey: `stale-post-${crypto.randomUUID()}`,
            },
            mode: 'direct',
          })
        )
        expect(attempt).toEqual({ denied: 'Channel unavailable' })
        expect(await writeFootprint(db(), ws(), active())).toEqual(before)
      })

      test('renaming or archiving the stale group is refused, and the group is unchanged', async () => {
        const before = await writeFootprint(db(), ws(), active())
        const rename = await settle(() =>
          updateChannel(
            db(),
            ws(),
            active(),
            stale(),
            { title: 'renamed by stale audience' },
            before.version
          )
        )
        expect(rename).toEqual({ denied: 'Channel unavailable' })
        const archive = await settle(() =>
          archiveChannel(db(), ws(), active(), stale(), before.version)
        )
        expect(archive).toEqual({ denied: 'Channel unavailable' })
        expect(await writeFootprint(db(), ws(), active())).toEqual(before)
      })

      test('a clean member still appends to the same group', async () => {
        const posted = await postGroupChannelMessage(
          db(),
          ws(),
          active(),
          seed.member,
          seed.member,
          {
            message: {
              bodyText: 'member after the quarantine',
              idempotencyKey: `member-${crypto.randomUUID()}`,
            },
            mode: 'direct',
          }
        )
        expect(posted.bodyText).toBe('member after the quarantine')
      })
    })

    describe('join', () => {
      test('roster replacement requires caller standing and preserves quarantined source rows', async () => {
        const before = await writeFootprint(db(), ws(), active())
        const cleanParticipants = [
          { kind: 'user' as const, userId: seed.owner.userId },
          { kind: 'user' as const, userId: seed.member.userId },
        ]
        expect(
          await settle(() =>
            setChannelParticipants(db(), ws(), active(), stale(), cleanParticipants, before.version)
          )
        ).toEqual({ denied: 'Channel unavailable' })
        expect(
          await settle(() =>
            setChannelParticipants(
              db(),
              ws(),
              active(),
              stale(),
              cleanParticipants,
              before.version + 1
            )
          )
        ).toEqual({ denied: 'Channel unavailable' })
        expect(await writeFootprint(db(), ws(), active())).toEqual(before)

        const ownerChannel = await getChannelForUser(db(), ws(), active(), seed.owner)
        await setChannelParticipants(
          db(),
          ws(),
          active(),
          seed.owner,
          cleanParticipants,
          ownerChannel.version
        )
        const afterCleanReplacement = await writeFootprint(db(), ws(), active())
        expect(afterCleanReplacement.quarantinedOriginals).toBe(before.quarantinedOriginals)
        expect(
          await countRows(
            upgrade.migration.db,
            sql`select count(*)::int as count from app.channel_participants cp
                join app.legacy_audience_quarantine q on q.source_participant_id = cp.id
                where q.workspace_id = ${ws()}::uuid and q.channel_id = ${active()}::uuid
                  and cp.user_id = ${stale().userId}::uuid`
          )
        ).toBe(1)

        const current = await getChannelForUser(db(), ws(), active(), seed.owner)
        expect(
          await settle(() =>
            setChannelParticipants(
              db(),
              ws(),
              active(),
              seed.owner,
              [...cleanParticipants, { kind: 'user' as const, userId: stale().userId }],
              current.version
            )
          )
        ).toEqual({ denied: 'Conversation participant unavailable' })
        expect(await writeFootprint(db(), ws(), active())).toEqual(afterCleanReplacement)
        expect(
          await loadGroupAdmission(db(), ws(), active(), { kind: 'user', userId: stale().userId })
        ).toBeNull()
      })
    })
  }
)

async function rowsOf(db: AgentHqDatabase, statement: ReturnType<typeof sql>) {
  return (await db.execute<Record<string, unknown>>(statement)) as unknown as Record<
    string,
    unknown
  >[]
}

/** Simulates a stale pre-migration admission being restored by an out-of-band repair. */
async function restoreQuarantinedAdmissionsForAuthorityProbe(
  fixture: Fixture,
  seed: LegacyAudienceSeed
): Promise<void> {
  const tx = fixture.migration.db
  await tx.execute(
    sql`alter table app.group_audience_grants disable trigger legacy_audience_withhold`
  )
  await tx.execute(
    sql`alter table app.group_enlistment_grants disable trigger legacy_audience_withhold`
  )
  await tx.execute(sql`alter table app.group_admissions disable trigger legacy_audience_withhold`)
  try {
    await tx.execute(sql`
      insert into app.group_audience_grants
        (workspace_id, channel_id, grant_id, revision, user_id, issued_at, expires_at, revoked_at)
      values (${seed.workspaceId}::uuid, ${seed.activeGroupId}::uuid, 'out_of_band_stale_user', 1,
        ${seed.removed.userId}::uuid, ${OBSERVED_AT}, null, null)
    `)
    await tx.execute(sql`
      insert into app.group_admissions
        (workspace_id, channel_id, principal_kind, user_id, agent_id, joined_sequence, joined_at,
         auth_group_id, auth_grant_id, auth_revision)
      values (${seed.workspaceId}::uuid, ${seed.activeGroupId}::uuid, 'user',
        ${seed.removed.userId}::uuid, null, 0, ${OBSERVED_AT}, ${seed.activeGroupId},
        'out_of_band_stale_user', 1)
    `)
    await tx.execute(sql`
      insert into app.group_enlistment_grants
        (workspace_id, channel_id, grant_id, revision, agent_id, issued_at, expires_at, revoked_at)
      values (${seed.workspaceId}::uuid, ${seed.activeGroupId}::uuid, 'out_of_band_stale_agent', 1,
        ${seed.otherWorkspaceAgentId}::uuid, ${OBSERVED_AT}, null, null)
    `)
    await tx.execute(sql`
      insert into app.group_admissions
        (workspace_id, channel_id, principal_kind, user_id, agent_id, joined_sequence, joined_at,
         auth_group_id, auth_grant_id, auth_revision)
      values (${seed.workspaceId}::uuid, ${seed.activeGroupId}::uuid, 'agent', null,
        ${seed.otherWorkspaceAgentId}::uuid, 0, ${OBSERVED_AT}, ${seed.activeGroupId},
        'out_of_band_stale_agent', 1)
    `)
  } finally {
    await tx.execute(
      sql`alter table app.group_audience_grants enable trigger legacy_audience_withhold`
    )
    await tx.execute(
      sql`alter table app.group_enlistment_grants enable trigger legacy_audience_withhold`
    )
    await tx.execute(sql`alter table app.group_admissions enable trigger legacy_audience_withhold`)
  }
}
