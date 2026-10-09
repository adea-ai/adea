import { afterAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

import { createDatabase, type DatabaseConnection } from '../../src/connection'
import {
  archiveChannel,
  createGroupChannel,
  createMessage,
  listMessagesForUser,
  setChannelParticipants,
} from '../../src/conversations'
import { createTemporaryUserSession } from '../../src/identity'
import {
  captureMigrationSnapshot,
  type MigrationSnapshotCaptureIdentityInput,
} from '../../src/migration-snapshot-capture'
import { compareMigrationSnapshots } from '../../src/migration-snapshot-comparator'
import { workspaceMemberships } from '../../src/schema'
import { createWorkspaceWithOwner } from '../../src/workspaces'
import {
  DRIZZLE_DIR,
  disposeRehearsal,
  type RehearsalResources,
  readJournal,
  view,
} from '../fixtures/cutover-rehearsal'

// Candidate rehearsal for the #1178 group backfill, pinned to the draft PR #1232 head
// ac73eee1. This is NOT main: candidate migrations 0047-0050 are unmerged and are
// vendored under tests/fixtures/candidate-1232 with sha256 pins. The rehearsal runs the
// real migration chain (main 0000-0046, then the candidate's 0047-0050) on a disposable
// database, then re-runs the 0050 backfill to test idempotence.
//
// What it does NOT prove: the candidate's join-point gate and its read paths (the product
// read functions here are main's), and any quarantine of ambiguous group records. The
// candidate has no quarantine surface, so the test records that absence instead of
// passing as coverage.

const provisioningUrl = process.env.MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL
const inCi = process.env.CI === 'true' || process.env.CI === '1'
const SCRATCH_PREFIX = 'rehearsal_1232_'
const CANDIDATE_DIR = `${import.meta.dir}/../fixtures/candidate-1232`
const CANDIDATE_TAGS = [
  '0047_huge_hitman',
  '0048_graceful_prima',
  '0049_group_participation_grants',
  '0050_group_legacy_backfill',
] as const

type Pins = { candidate: { headSha: string; pullRequest: number }; files: Record<string, string> }

/** The vendored candidate files must match their pins; a drifted copy fails before it runs. */
function verifiedCandidate(): { headSha: string; entries: { tag: string; when: number }[] } {
  const pins = JSON.parse(readFileSync(`${CANDIDATE_DIR}/pins.json`, 'utf8')) as Pins
  for (const [name, expected] of Object.entries(pins.files)) {
    const actual = createHash('sha256')
      .update(readFileSync(`${CANDIDATE_DIR}/${name}`))
      .digest('hex')
    if (actual !== expected) throw new Error(`candidate fixture ${name} does not match its pin`)
  }
  const journal = JSON.parse(readFileSync(`${CANDIDATE_DIR}/_journal.json`, 'utf8')) as {
    entries: { tag: string; when: number }[]
  }
  return { headSha: pins.candidate.headSha, entries: journal.entries }
}

/** Main's full journal followed by the candidate's entries, as one migrations folder. */
function combinedMigrationsFolder(): string {
  const main = readJournal()
  const candidate = verifiedCandidate()
  if (candidate.entries.map((entry) => entry.tag).join() !== CANDIDATE_TAGS.join()) {
    throw new Error('candidate journal does not match the pinned 0047-0050 chain')
  }
  const folder = mkdtempSync(join(tmpdir(), 'rehearsal-1232-chain-'))
  mkdirSync(join(folder, 'meta'))
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({ ...main, entries: [...main.entries, ...candidate.entries] })
  )
  for (const entry of main.entries) {
    copyFileSync(`${DRIZZLE_DIR}/${entry.tag}.sql`, join(folder, `${entry.tag}.sql`))
  }
  for (const tag of CANDIDATE_TAGS) {
    copyFileSync(`${CANDIDATE_DIR}/${tag}.sql`, join(folder, `${tag}.sql`))
  }
  return folder
}

const identity = (snapshotId: string): MigrationSnapshotCaptureIdentityInput => ({
  capturedAt: new Date('2026-01-05T00:00:00.000Z'),
  rehearsalId: 'rehearsal-candidate-1232',
  snapshotId,
  source: 'integration',
})

function requireProvisioningUrl(): string {
  if (!provisioningUrl) {
    throw new Error(
      'MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL is not set. In CI this means the Docker capture provisioning did not run, and the candidate rehearsal refuses to skip silently.'
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
  const text = readFileSync(`${CANDIDATE_DIR}/0050_group_legacy_backfill.sql`, 'utf8')
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
  const candidate = verifiedCandidate()
  const scratch = `${SCRATCH_PREFIX}${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`
  resources.scratch = scratch
  await adminExecute(`create database "${scratch}"`)
  const connection: DatabaseConnection = createDatabase(urlForDatabase(scratch))
  resources.connection = connection

  // Main schema through 0046 only, then the fixture on that schema.
  await migrate(connection.db, { migrationsFolder: DRIZZLE_DIR })
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

  // Active group with two users, and an archived group with one user.
  const active = await createGroupChannel(connection.db, workspaceId, owner, {
    idempotencyKey: `candidate-active-${suffix}`,
    title: 'Candidate active group',
  })
  const activeWithMember = await setChannelParticipants(
    connection.db,
    workspaceId,
    active.id,
    owner,
    [
      { kind: 'user', userId: owner.userId },
      { kind: 'user', userId: member.userId },
    ],
    active.version
  )
  await createMessage(connection.db, workspaceId, active.id, owner, {
    bodyText: 'candidate-active-body',
    idempotencyKey: `candidate-active-message-${suffix}`,
    sender: owner,
  })
  const archived = await createGroupChannel(connection.db, workspaceId, owner, {
    idempotencyKey: `candidate-archived-${suffix}`,
    title: 'Candidate archived group',
  })
  await archiveChannel(connection.db, workspaceId, archived.id, owner, archived.version)

  const before = await captureMigrationSnapshot(connection.db, { identity: identity('before') })
  const participantsBefore = await participantRows(connection, workspaceId)

  // Apply the candidate chain: 0047-0050, including the 0050 backfill, through drizzle.
  const chain = combinedMigrationsFolder()
  resources.preFolder = chain
  await migrate(connection.db, { migrationsFolder: chain })
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
      (await listMessagesForUser(connection.db, workspaceId, active.id, owner)).messages.map(
        (message) => message.id
      )
    ),
    memberActive: await view(async () =>
      (await listMessagesForUser(connection.db, workspaceId, active.id, member)).messages.map(
        (message) => message.id
      )
    ),
    outsiderActive: await view(async () =>
      (await listMessagesForUser(connection.db, workspaceId, active.id, outsider)).messages.map(
        (message) => message.id
      )
    ),
  }

  return {
    candidateHead: candidate.headSha,
    activeChannelId: active.id,
    archivedChannelId: archived.id,
    activeWithMember,
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

function runScenario(): Promise<Scenario> {
  scenario ??= executeScenario()
  return scenario
}

describe.skipIf(!provisioningUrl && !inCi)('candidate #1232 group backfill rehearsal', () => {
  afterAll(async () => {
    const pending = scenario
    scenario = undefined
    const owned = { ...resources }
    for (const key of Object.keys(resources) as (keyof RehearsalResources)[]) delete resources[key]
    if (pending) await pending.catch(() => undefined)
    await disposeRehearsal(owned, async (database) => {
      if (!database.startsWith(SCRATCH_PREFIX)) throw new Error(`refusing to drop ${database}`)
      await adminExecute(`drop database if exists "${database}" with (force)`)
    })
  }, 300_000)

  test('the vendored candidate chain matches its sha256 pins and the pinned head', () => {
    const candidate = verifiedCandidate()
    expect(candidate.headSha).toBe('ac73eee1dcd8da3eec60fcb851265e0eaca583d8')
    expect(candidate.entries.map((entry) => entry.tag)).toEqual([...CANDIDATE_TAGS])
  })

  test('the backfill admits exactly the active group participants, once each', async () => {
    const { participantsBefore, afterBackfill, activeChannelId, archivedChannelId } =
      await runScenario()
    expect(afterBackfill.admissions).toHaveLength(participantsBefore.length)
    expect(afterBackfill.admissions.map((row) => row.channel_id)).not.toContain(archivedChannelId)
    const activeRows = afterBackfill.admissions.filter((row) => row.channel_id === activeChannelId)
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

  test('the main capture families are unchanged across the candidate chain', async () => {
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
})
