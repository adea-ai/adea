import { afterAll, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { listMessagesForUser } from '../../src/conversations'
import { createTemporaryUserSession } from '../../src/identity'
import {
  captureMigrationSnapshot,
  type MigrationSnapshotCaptureIdentityInput,
  resolveMigrationSnapshotCaptureDomains,
} from '../../src/migration-snapshot-capture'
import { compareMigrationSnapshots } from '../../src/migration-snapshot-comparator'
import { channelParticipants, workspaceMemberships } from '../../src/schema'
import { createWorkspaceWithOwner } from '../../src/workspaces'
import {
  CANONICAL_BASE_TAG,
  canonicalChainFolders,
  CANONICAL_DIR,
  timestampOrderViolations,
  verifiedCanonicalChain,
} from '../fixtures/canonical-chain'
import {
  DRIZZLE_DIR,
  type RehearsalResources,
  settleAndDispose,
  view,
} from '../fixtures/cutover-rehearsal'
import { insertLegacyGroup, insertLegacyMessage } from '../fixtures/legacy-audience-seed'

// Rehearsal of the incoming canonical migration chain for the #1241 proof: main through 0046,
// then #1229 -> #1230 -> #1232 in that order. The chain is vendored from exact source commits
// (tests/fixtures/canonical-chain/pins.json). The rehearsal applies it the way a deployed database
// receives it: stage one (#1229 and #1230) first, then the group legacy seed, then #1232's
// 0049/0050 backfill on top. Each recorded migration is checked against the journal, so an entry
// drizzle skips is a failure here, not a silent success.
//
// What it does NOT prove: the group join-point gate and its read paths (the product read functions
// here are main's), and any quarantine of ambiguous group records. The chain has no quarantine
// surface, so the test records that absence instead of passing as coverage.

const provisioningUrl = process.env.MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL
const inCi = process.env.CI === 'true' || process.env.CI === '1'
const SCRATCH_PREFIX = 'rehearsal_1232_'
// Capture-completeness gap, stated rather than hidden. The migration snapshot inventories 16
// families and none is a group table. The backfill writes these tables, so the capture cannot
// see the admissions and grants it creates. Any group table not listed here fails the suite.
const DECLARED_UNCAPTURED_GROUP_TABLES = [
  'group_admissions',
  'group_audience_grants',
  'group_enlistment_grants',
  'group_sharing_grants',
] as const

const identity = (snapshotId: string): MigrationSnapshotCaptureIdentityInput => ({
  capturedAt: new Date('2026-01-05T00:00:00.000Z'),
  rehearsalId: 'rehearsal-canonical-chain',
  snapshotId,
  source: 'integration',
})

function requireProvisioningUrl(): string {
  if (!provisioningUrl) {
    throw new Error(
      'MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL is not set. In CI this means the Docker capture provisioning did not run, and the canonical chain rehearsal refuses to skip silently.'
    )
  }
  return provisioningUrl
}

function urlForDatabase(database: string): string {
  const url = new URL(requireProvisioningUrl())
  url.pathname = `/${database}`
  return url.toString()
}

async function adminExecute(statement: string): Promise<void> {
  const admin = postgres(urlForDatabase('postgres'), { max: 1, onnotice: () => {} })
  try {
    await admin.unsafe(statement)
  } finally {
    await admin.end()
  }
}

/** The 0050 backfill, statement by statement, exactly as drizzle would split it. */
function backfillStatements(): string[] {
  const text = readFileSync(`${CANONICAL_DIR}/0050_group_legacy_backfill.sql`, 'utf8')
  return text
    .split('--> statement-breakpoint')
    .map((part) => part.replace(/^(\s*--[^\n]*\n)*/g, '').trim())
    .filter((part) => part.length > 0)
}

type Scenario = Awaited<ReturnType<typeof executeScenario>>
const resources: RehearsalResources = {}
let scenario: Promise<Scenario> | undefined

async function executeScenario() {
  requireProvisioningUrl()
  const chain = canonicalChainFolders()
  resources.preFolder = chain.root
  const scratch = `${SCRATCH_PREFIX}${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`
  resources.scratch = scratch
  await adminExecute(`create database "${scratch}"`)
  const connection: DatabaseConnection = createDatabase(urlForDatabase(scratch))
  resources.connection = connection

  // Stage one: main through 0046, then #1229 and #1230. This is the state before #1232 lands.
  await migrate(connection.db, { migrationsFolder: chain.stageOne })
  const stageOneRecorded = await recordedMigrationTimes(connection)
  const suffix = crypto.randomUUID()
  const expiresAt = new Date(Date.now() + 600_000)
  const session = async (name: string) =>
    (
      await createTemporaryUserSession(connection.db, {
        credentialDigest: `candidate-${name}-${suffix}`,
        expiresAt,
      })
    ).principal
  const owner = await session('owner')
  const member = await session('member')
  const outsider = await session('outsider')
  const { workspace } = await createWorkspaceWithOwner(connection.db, {
    idempotencyKey: `candidate-${suffix}`,
    name: 'Candidate HQ',
    owner,
  })
  const workspaceId = workspace.id
  await connection.db.insert(workspaceMemberships).values({
    role: 'member',
    userId: member.userId,
    workspaceId,
  })

  // Legacy group rows at stage one, written as the pre-#1232 product wrote them: the group policy
  // tables do not exist yet, so the product's group writers cannot run here.
  // Active group with two users, and an archived group with one user.
  const activeId = await insertLegacyGroup(
    connection.db,
    workspaceId,
    owner,
    'Candidate active group'
  )
  await connection.db.insert(channelParticipants).values({
    channelId: activeId,
    principalKind: 'user',
    userId: member.userId,
    workspaceId,
  })
  await insertLegacyMessage(connection.db, {
    bodyText: 'candidate-active-body',
    channelId: activeId,
    sender: owner,
    workspaceId,
  })
  const archivedId = await insertLegacyGroup(
    connection.db,
    workspaceId,
    owner,
    'Candidate archived group',
    { archived: true }
  )

  const before = await captureMigrationSnapshot(connection.db, { identity: identity('before') })
  const participantsBefore = await participantRows(connection, workspaceId)

  // Then the rest of the canonical chain: #1232's 0049 and 0050 backfill, applied on a database
  // that already holds 0048. The recorded migrations are checked against the journal below.
  await migrate(connection.db, { migrationsFolder: chain.full })
  const applied = appliedAgainstJournal(
    chain.fullEntries,
    stageOneRecorded,
    await recordedMigrationTimes(connection)
  )
  if (applied.missing.length > 0 || applied.duplicates.length > 0) {
    throw new Error(
      `canonical chain not applied as journaled: skipped ${JSON.stringify(applied.missing)}, repeated ${applied.duplicates.length}. Drizzle applies an entry only when its when is later than the newest recorded migration. Ordering: ${applied.orderViolations.join('; ') || 'none'}`
    )
  }
  const afterBackfill = {
    admissions: await admissionRows(connection, workspaceId),
    grants: await implicitGrantCount(connection, workspaceId),
    quarantineSurfaces: await quarantineSurfaces(connection),
  }

  // Idempotence: run the 0050 statements again. Row counts must not change.
  for (const statement of backfillStatements()) {
    await connection.db.execute(sql.raw(statement))
  }
  const afterRepeat = {
    admissions: await admissionRows(connection, workspaceId),
    grants: await implicitGrantCount(connection, workspaceId),
  }

  const after = await captureMigrationSnapshot(connection.db, { identity: identity('after') })
  const comparison = compareMigrationSnapshots({ after: after.document, before: before.document })

  const reads = {
    ownerActive: await view(async () =>
      (await listMessagesForUser(connection.db, workspaceId, activeId, owner)).messages.map(
        (message) => message.id
      )
    ),
    memberActive: await view(async () =>
      (await listMessagesForUser(connection.db, workspaceId, activeId, member)).messages.map(
        (message) => message.id
      )
    ),
    outsiderActive: await view(async () =>
      (await listMessagesForUser(connection.db, workspaceId, activeId, outsider)).messages.map(
        (message) => message.id
      )
    ),
  }

  return {
    chainApplied: applied,
    groupTables: await groupTableNames(connection),
    activeChannelId: activeId,
    archivedChannelId: archivedId,
    participantsBefore,
    afterBackfill,
    afterRepeat,
    comparison,
    reads,
  }
}

type Row = Record<string, unknown>

async function participantRows(connection: DatabaseConnection, workspaceId: string) {
  return (await connection.db.execute<Row>(
    sql`select cp.channel_id, cp.user_id from app.channel_participants cp
        join app.channels c on c.id = cp.channel_id
        where cp.workspace_id = ${workspaceId} and c.kind = 'group' and c.lifecycle_state = 'active' and cp.principal_kind = 'user'
        order by cp.channel_id, cp.user_id`
  )) as unknown as Row[]
}

async function admissionRows(connection: DatabaseConnection, workspaceId: string) {
  return (await connection.db.execute<Row>(
    sql`select channel_id, user_id, joined_sequence, auth_grant_id from app.group_admissions
        where workspace_id = ${workspaceId} order by channel_id, user_id`
  )) as unknown as Row[]
}

async function implicitGrantCount(connection: DatabaseConnection, workspaceId: string) {
  const rows = await connection.db.execute<{ count: number }>(
    sql`select count(*)::int as count from app.group_audience_grants
        where workspace_id = ${workspaceId} and grant_id like 'implicit:member:%'`
  )
  return rows[0]?.count ?? -1
}

async function quarantineSurfaces(connection: DatabaseConnection): Promise<string[]> {
  const rows = await connection.db.execute<{ table_name: string }>(
    sql`select table_name from information_schema.tables
        where table_schema = 'app' and table_name ilike '%quarantin%'`
  )
  return rows.map((row) => row.table_name)
}

/** Every group table in the app schema: the set the capture-completeness declaration must cover. */
async function groupTableNames(connection: DatabaseConnection): Promise<string[]> {
  const rows = await connection.db.execute<{ table_name: string }>(
    sql`select table_name from information_schema.tables
        where table_schema = 'app' and left(table_name, 6) = 'group_'
        order by table_name`
  )
  return rows.map((row) => row.table_name)
}

/** The `when` of every migration the database has recorded, in order of recording. */
async function recordedMigrationTimes(connection: DatabaseConnection): Promise<number[]> {
  const rows = await connection.db.execute<{ created_at: string }>(
    sql`select created_at from drizzle.__drizzle_migrations order by id`
  )
  return rows.map((row) => Number(row.created_at))
}

/**
 * Compares what the database recorded with the journal. Drizzle records a migration by its `when`,
 * so a `when` missing from the recorded set is an entry the migrator skipped, and a repeated one
 * is an entry applied twice.
 */
function appliedAgainstJournal(
  expected: { tag: string; when: number }[],
  recordedBeforeFull: number[],
  recorded: number[]
) {
  const recordedSet = new Set(recorded)
  return {
    orderViolations: timestampOrderViolations(expected),
    missing: expected.filter((entry) => !recordedSet.has(entry.when)).map((entry) => entry.tag),
    duplicates: recorded.filter((when, index) => recorded.indexOf(when) !== index),
    expectedCount: expected.length,
    recordedBeforeFull,
    recordedCount: recorded.length,
    recorded,
  }
}

function runScenario(): Promise<Scenario> {
  scenario ??= executeScenario()
  return scenario
}

describe('incoming canonical chain (no database)', () => {
  test('a capture request for a group table is unknown, never an empty capture', () => {
    expect(
      resolveMigrationSnapshotCaptureDomains(['groupAdmissions', 'groupAudienceGrants'])
    ).toEqual([
      { domain: 'groupAdmissions', status: 'unknown', unknownReason: 'unrecognized_domain' },
      { domain: 'groupAudienceGrants', status: 'unknown', unknownReason: 'unrecognized_domain' },
    ])
  })

  test('the canonical chain matches its pinned sources byte for byte, with the excluded migration absent', () => {
    const { pins, entries } = verifiedCanonicalChain()
    expect(pins.base.lastTag).toBe(CANONICAL_BASE_TAG)
    expect(entries.map((entry) => entry.tag)).toEqual([
      '0047_requested_role_model_selections',
      '0048_graceful_prima',
      '0049_group_participation_grants',
      '0050_group_legacy_backfill',
    ])
    expect(pins.excluded.map((entry) => entry.tag)).toEqual(['0047_huge_hitman'])
  })

  test('the assembled chain holds each migration once, on top of main through 0046', () => {
    const chain = canonicalChainFolders()
    try {
      const files = readdirSync(chain.full)
        .filter((name) => name.endsWith('.sql'))
        .map((name) => name.replace(/\.sql$/, ''))
        .toSorted()
      const tags = chain.fullEntries.map((entry) => entry.tag)
      expect(new Set(tags).size).toBe(tags.length)
      expect(files).toEqual([...tags].toSorted())
      expect(files).not.toContain('0047_huge_hitman')
      // Main's live journal supplies idx 0-46 (through the base tag), then the approved order.
      expect(tags.indexOf(CANONICAL_BASE_TAG)).toBe(46)
      expect(tags.slice(47)).toEqual([
        '0047_requested_role_model_selections',
        '0048_graceful_prima',
        '0049_group_participation_grants',
        '0050_group_legacy_backfill',
      ])
    } finally {
      rmSync(chain.root, { recursive: true, force: true })
    }
  })

  test('the canonical timestamps ascend, so drizzle applies every entry to a database already at 0048', () => {
    const chain = canonicalChainFolders()
    try {
      expect(timestampOrderViolations(chain.fullEntries)).toEqual([])
    } finally {
      rmSync(chain.root, { recursive: true, force: true })
    }
  })
})

describe.skipIf(!provisioningUrl && !inCi)(
  'incoming canonical chain group backfill rehearsal',
  () => {
    afterAll(async () => {
      const pending = scenario
      scenario = undefined
      await settleAndDispose(resources, pending, async (database) => {
        if (!database.startsWith(SCRATCH_PREFIX)) throw new Error(`refusing to drop ${database}`)
        await adminExecute(`drop database if exists "${database}" with (force)`)
      })
    }, 300_000)

    test('incremental application records every canonical migration exactly once', async () => {
      const { chainApplied } = await runScenario()
      expect(chainApplied.orderViolations).toEqual([])
      expect(chainApplied.missing).toEqual([])
      expect(chainApplied.duplicates).toEqual([])
      expect(chainApplied.recordedCount).toBe(chainApplied.expectedCount)
    })

    test('every group table on the canonical chain is a declared capture gap, none silently missing', async () => {
      const { groupTables } = await runScenario()
      expect(groupTables).toEqual([...DECLARED_UNCAPTURED_GROUP_TABLES].toSorted())
    })

    test('fresh and upgrade-from-main application each record every canonical migration exactly once', async () => {
      const chain = canonicalChainFolders()
      try {
        for (const mode of ['fresh', 'upgrade-from-main'] as const) {
          const scratch = `${SCRATCH_PREFIX}${mode.replaceAll('-', '_')}_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
          await adminExecute(`create database "${scratch}"`)
          const connection = createDatabase(urlForDatabase(scratch))
          try {
            if (mode === 'upgrade-from-main')
              await migrate(connection.db, { migrationsFolder: DRIZZLE_DIR })
            await migrate(connection.db, { migrationsFolder: chain.full })
            const result = appliedAgainstJournal(
              chain.fullEntries,
              [],
              await recordedMigrationTimes(connection)
            )
            expect({ mode, missing: result.missing, duplicates: result.duplicates }).toEqual({
              mode,
              missing: [],
              duplicates: [],
            })
            expect(result.recordedCount).toBe(result.expectedCount)
          } finally {
            await connection.close()
            await adminExecute(`drop database if exists "${scratch}" with (force)`)
          }
        }
      } finally {
        rmSync(chain.root, { recursive: true, force: true })
      }
    })

    test('the backfill admits exactly the active group participants, once each', async () => {
      const { participantsBefore, afterBackfill, activeChannelId, archivedChannelId } =
        await runScenario()
      expect(afterBackfill.admissions).toHaveLength(participantsBefore.length)
      expect(afterBackfill.admissions.map((row) => row.channel_id)).not.toContain(archivedChannelId)
      const activeRows = afterBackfill.admissions.filter(
        (row) => row.channel_id === activeChannelId
      )
      expect(activeRows).toHaveLength(2)
      for (const row of activeRows) {
        expect(row.joined_sequence).toBe('0')
        expect(String(row.auth_grant_id)).toMatch(/^implicit:member:/)
      }
      expect(afterBackfill.grants).toBe(participantsBefore.length)
    })

    test('the 0050 backfill is idempotent: re-running its statements changes no row', async () => {
      const { afterBackfill, afterRepeat } = await runScenario()
      expect(afterRepeat.admissions).toEqual(afterBackfill.admissions)
      expect(afterRepeat.grants).toBe(afterBackfill.grants)
    })

    test('the main capture families are unchanged across the canonical chain', async () => {
      const { comparison } = await runScenario()
      expect(comparison.findings).toEqual([])
      expect(comparison.verdict).toBe('identical')
    })

    test('the existing read paths on main are unchanged for members and deny the outsider', async () => {
      const { reads, activeChannelId } = await runScenario()
      expect(reads.ownerActive).not.toBe('denied')
      expect(reads.memberActive).not.toBe('denied')
      expect(reads.outsiderActive).toBe('denied')
      expect(activeChannelId).toBeTruthy()
    })

    test('no quarantine surface exists for ambiguous group records: the acceptance is unproven', async () => {
      // Archived group participants are silently left out of the backfill (no admission row),
      // and nothing records them as quarantined. Recorded here so the gap stays visible.
      const { afterBackfill, archivedChannelId } = await runScenario()
      expect(afterBackfill.quarantineSurfaces).toEqual([])
      expect(afterBackfill.admissions.map((row) => row.channel_id)).not.toContain(archivedChannelId)
    })
  }
)
