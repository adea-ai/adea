import { afterAll, describe, expect, test } from 'bun:test'
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { and, eq, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { migrationSnapshotFamilies } from '@adea-ai/types'
import { listMessagesForUser } from '../../src/conversations'
import { createTemporaryUserSession } from '../../src/identity'
import {
  captureMigrationSnapshot,
  type MigrationSnapshotCaptureIdentityInput,
  resolveMigrationSnapshotCaptureDomains,
} from '../../src/migration-snapshot-capture'
import { compareMigrationSnapshots } from '../../src/migration-snapshot-comparator'
import { channelParticipants, messages, workspaceMemberships } from '../../src/schema'
import { createWorkspaceWithOwner } from '../../src/workspaces'
import {
  CANONICAL_BASE_TAG,
  canonicalChainFolders,
  CANONICAL_DIR,
  assertCanonicalOverlayMatchesLive,
  timestampOrderViolations,
  verifiedCanonicalChain,
} from '../fixtures/canonical-chain'
import {
  type RehearsalResources,
  disposeRehearsal,
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
// This rehearsal checks legacy-message visibility after the canonical chain is applied; it does
// not replace the focused group join-point authorization tests. The chain has no quarantine surface,
// so the test records that absence instead of passing as coverage.

const provisioningUrl = process.env.MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL
const inCi = process.env.CI === 'true' || process.env.CI === '1'
const SCRATCH_PREFIX = 'rehearsal_1232_'
// Capture-completeness, stated rather than hidden. Three group tables are snapshot families
// (admissions, audience grants, enlistment grants), so the capture sees what the backfill creates.
// `group_sharing_grants` is not a family and remains a declared gap. Any group table in neither
// list fails the suite.
const CAPTURED_GROUP_TABLES = [
  'group_admissions',
  'group_audience_grants',
  'group_enlistment_grants',
] as const
const GROUP_FAMILIES = ['groupAdmissions', 'groupAudienceGrants', 'groupEnlistmentGrants'] as const
const DECLARED_UNCAPTURED_GROUP_TABLES = ['group_sharing_grants'] as const

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
  const seededMessageId = await insertLegacyMessage(connection.db, {
    bodyText: 'candidate-active-body',
    channelId: activeId,
    sender: owner,
    workspaceId,
  })
  // The candidate product read path uses 0049 group-grant tables, so it cannot be called on this
  // deliberate pre-0049 schema. Capture the legacy participant/message relation as the baseline;
  // after migration, the real product read path below must preserve that visibility.
  const legacyVisibleMessageIds = async (principal: UserPrincipalRef) =>
    (
      await connection.db
        .select({ id: messages.id })
        .from(messages)
        .innerJoin(
          channelParticipants,
          and(
            eq(channelParticipants.workspaceId, messages.workspaceId),
            eq(channelParticipants.channelId, messages.channelId),
            eq(channelParticipants.principalKind, 'user'),
            eq(channelParticipants.userId, principal.userId)
          )
        )
        .where(and(eq(messages.workspaceId, workspaceId), eq(messages.channelId, activeId)))
        .orderBy(messages.sequence)
    ).map((row) => row.id)
  const ownerLegacyMessages = await legacyVisibleMessageIds(owner)
  const memberLegacyMessages = await legacyVisibleMessageIds(member)
  const outsiderLegacyMessages = await legacyVisibleMessageIds(outsider)
  const readsBefore = {
    ownerActive: ownerLegacyMessages,
    memberActive: memberLegacyMessages,
    outsiderActive: outsiderLegacyMessages.length === 0 ? 'denied' : outsiderLegacyMessages,
  }
  const archivedId = await insertLegacyGroup(
    connection.db,
    workspaceId,
    owner,
    'Candidate archived group',
    { archived: true }
  )

  // The main families the canonical capture proves on both sides of the chain. nativeSessions needs an
  // inventory source this rehearsal does not supply, so it is excluded rather than compared as unknown.
  // The group families are created by 0049, so they cannot be read at this 0048 state; they are captured
  // after the backfill instead.
  const mainFamilies = migrationSnapshotFamilies.filter(
    (family) =>
      family !== 'nativeSessions' && !(GROUP_FAMILIES as readonly string[]).includes(family)
  )
  const before = await captureMigrationSnapshot(connection.db, {
    identity: identity('before'),
    requestedDomains: mainFamilies,
  })
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
    audienceGrants: await audienceGrantRows(connection, workspaceId),
    enlistmentGrants: await enlistmentGrantRows(connection, workspaceId),
    quarantineSurfaces: await quarantineSurfaces(connection),
  }

  // Idempotence: run the 0050 statements again. Row counts must not change.
  for (const statement of backfillStatements()) {
    await connection.db.execute(sql.raw(statement))
  }
  const afterRepeat = {
    admissions: await admissionRows(connection, workspaceId),
    audienceGrants: await audienceGrantRows(connection, workspaceId),
    enlistmentGrants: await enlistmentGrantRows(connection, workspaceId),
  }

  const groupAfterBackfill = await captureMigrationSnapshot(connection.db, {
    identity: identity('group-after-backfill'),
    requestedDomains: GROUP_FAMILIES,
  })
  const after = await captureMigrationSnapshot(connection.db, {
    identity: identity('after'),
    requestedDomains: mainFamilies,
  })
  const groupAfterRepeat = await captureMigrationSnapshot(connection.db, {
    identity: identity('group-after-repeat'),
    requestedDomains: GROUP_FAMILIES,
  })
  const groupComparison = compareMigrationSnapshots({
    after: groupAfterRepeat.document,
    before: groupAfterBackfill.document,
  })
  const comparison = compareMigrationSnapshots({ after: after.document, before: before.document })

  const readsAfter = {
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
    groupAfterBackfill,
    groupAfterRepeat,
    groupComparison,
    groupTables: await groupTableNames(connection),
    activeChannelId: activeId,
    archivedChannelId: archivedId,
    participantsBefore,
    seededMessageId,
    afterBackfill,
    afterRepeat,
    comparison,
    readsBefore,
    readsAfter,
  }
}

type Row = Record<string, unknown>

function principalTuple(row: Row): string {
  return `${row.channel_id}:${row.principal_kind}:${row.user_id ?? row.agent_id}`
}

async function participantRows(connection: DatabaseConnection, workspaceId: string) {
  return (await connection.db.execute<Row>(
    sql`select cp.channel_id, cp.principal_kind, cp.user_id, cp.agent_id from app.channel_participants cp
        join app.channels c on c.id = cp.channel_id
        where cp.workspace_id = ${workspaceId} and c.kind = 'group' and c.lifecycle_state = 'active'
        order by cp.channel_id, cp.principal_kind, cp.user_id, cp.agent_id`
  )) as unknown as Row[]
}

async function admissionRows(connection: DatabaseConnection, workspaceId: string) {
  return (await connection.db.execute<Row>(
    sql`select * from app.group_admissions where workspace_id = ${workspaceId} order by id`
  )) as unknown as Row[]
}

async function audienceGrantRows(connection: DatabaseConnection, workspaceId: string) {
  return (await connection.db.execute<Row>(
    sql`select * from app.group_audience_grants where workspace_id = ${workspaceId} order by id`
  )) as unknown as Row[]
}

async function enlistmentGrantRows(connection: DatabaseConnection, workspaceId: string) {
  return (await connection.db.execute<Row>(
    sql`select * from app.group_enlistment_grants where workspace_id = ${workspaceId} order by id`
  )) as unknown as Row[]
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
  test('the three group families are captured and the sharing-grant table is unknown, never an empty capture', () => {
    expect(
      resolveMigrationSnapshotCaptureDomains([
        'groupAdmissions',
        'groupAudienceGrants',
        'groupEnlistmentGrants',
        'groupSharingGrants',
      ])
    ).toEqual([
      { domain: 'groupAdmissions', status: 'captured', unknownReason: null },
      { domain: 'groupAudienceGrants', status: 'captured', unknownReason: null },
      { domain: 'groupEnlistmentGrants', status: 'captured', unknownReason: null },
      { domain: 'groupSharingGrants', status: 'unknown', unknownReason: 'unrecognized_domain' },
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

  test('a same-tag live migration must match its pinned journal entry and SQL bytes', () => {
    const { entries } = verifiedCanonicalChain()
    const entry = entries[0]!
    const live = mkdtempSync(join(tmpdir(), 'canonical-live-overlay-'))
    try {
      copyFileSync(`${CANONICAL_DIR}/${entry.tag}.sql`, join(live, `${entry.tag}.sql`))
      expect(() =>
        assertCanonicalOverlayMatchesLive([entry], entries, live, CANONICAL_DIR)
      ).not.toThrow()
      expect(() =>
        assertCanonicalOverlayMatchesLive(
          [{ ...entry, when: entry.when + 1 }],
          entries,
          live,
          CANONICAL_DIR
        )
      ).toThrow(`live journal entry ${entry.tag} differs`)
      writeFileSync(join(live, `${entry.tag}.sql`), '-- same-tag drift\n')
      expect(() =>
        assertCanonicalOverlayMatchesLive([entry], entries, live, CANONICAL_DIR)
      ).toThrow(`live migration ${entry.tag}.sql differs`)
    } finally {
      rmSync(live, { recursive: true, force: true })
    }
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

    test('every group table on the canonical chain is a captured family or a declared gap, none silently missing', async () => {
      const { groupTables } = await runScenario()
      expect(groupTables).toEqual(
        [...CAPTURED_GROUP_TABLES, ...DECLARED_UNCAPTURED_GROUP_TABLES].toSorted()
      )
    })

    test('the capture sees exactly the admissions and grants the backfill wrote, and a repeat changes nothing (#1222)', async () => {
      const { afterBackfill, groupAfterBackfill, groupAfterRepeat, groupComparison } =
        await runScenario()
      const sections = groupAfterBackfill.document.sections
      // Nonempty and equal to the table rows: the capture is not a vacuous empty section.
      expect(afterBackfill.admissions.length).toBeGreaterThan(0)
      expect(sections.groupAdmissions?.records).toHaveLength(afterBackfill.admissions.length)
      expect(sections.groupAudienceGrants?.records).toHaveLength(
        afterBackfill.audienceGrants.length
      )
      expect(sections.groupEnlistmentGrants?.records).toHaveLength(
        afterBackfill.enlistmentGrants.length
      )
      for (const family of GROUP_FAMILIES) {
        expect(groupAfterRepeat.document.sections[family]).toEqual(sections[family])
      }
      // Only the three group families were requested, so every other family is unknown by scope and the
      // three compared families produce no finding at all: identical record for record.
      const groupFindings = groupComparison.findings.filter((finding) =>
        (GROUP_FAMILIES as readonly string[]).includes(finding.family)
      )
      expect(groupFindings).toEqual([])
      expect(
        groupComparison.findings.every((finding) => finding.findingClass === 'unknown_domain')
      ).toBe(true)
      expect(groupComparison.verdict).toBe('inconclusive')
    })

    test('fresh and upgrade-from-main application each record every canonical migration exactly once', async () => {
      const chain = canonicalChainFolders()
      try {
        for (const mode of ['fresh', 'upgrade-from-main'] as const) {
          const scratch = `${SCRATCH_PREFIX}${mode.replaceAll('-', '_')}_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
          await adminExecute(`create database "${scratch}"`)
          const scratchResources: RehearsalResources = { scratch }
          try {
            // Record the database before constructing the connection so a constructor failure
            // still reaches the scratch database cleanup below.
            const connection = createDatabase(urlForDatabase(scratch))
            scratchResources.connection = connection
            if (mode === 'upgrade-from-main')
              await migrate(connection.db, { migrationsFolder: chain.base })
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
            await disposeRehearsal(scratchResources, async (database) => {
              if (!database.startsWith(SCRATCH_PREFIX))
                throw new Error(`refusing to drop ${database}`)
              await adminExecute(`drop database if exists "${database}" with (force)`)
            })
          }
        }
      } finally {
        rmSync(chain.root, { recursive: true, force: true })
      }
    })

    test('the backfill admits exactly the active group participants, once each', async () => {
      const { participantsBefore, afterBackfill, archivedChannelId } = await runScenario()
      expect(afterBackfill.admissions.map((row) => row.channel_id)).not.toContain(archivedChannelId)
      expect(afterBackfill.admissions.map(principalTuple).toSorted()).toEqual(
        participantsBefore.map(principalTuple).toSorted()
      )
      const expectedAudienceGrants = participantsBefore.filter(
        (row) => row.principal_kind === 'user'
      )
      const expectedEnlistmentGrants = participantsBefore.filter(
        (row) => row.principal_kind === 'agent'
      )
      expect(
        afterBackfill.audienceGrants.map((row) => `${row.channel_id}:${row.user_id}`).toSorted()
      ).toEqual(expectedAudienceGrants.map((row) => `${row.channel_id}:${row.user_id}`).toSorted())
      expect(
        afterBackfill.enlistmentGrants.map((row) => `${row.channel_id}:${row.agent_id}`).toSorted()
      ).toEqual(
        expectedEnlistmentGrants.map((row) => `${row.channel_id}:${row.agent_id}`).toSorted()
      )
      for (const row of afterBackfill.admissions) {
        expect(row.joined_sequence).toBe('0')
        const principalId = String(row.user_id ?? row.agent_id)
        expect(row.auth_grant_id).toBe(`implicit:member:${principalId}`)
        const grants =
          row.principal_kind === 'user'
            ? afterBackfill.audienceGrants.filter(
                (grant) => grant.channel_id === row.channel_id && grant.user_id === row.user_id
              )
            : afterBackfill.enlistmentGrants.filter(
                (grant) => grant.channel_id === row.channel_id && grant.agent_id === row.agent_id
              )
        expect(grants).toHaveLength(1)
        expect(grants[0]?.workspace_id).toBe(row.workspace_id)
        expect(grants[0]?.grant_id).toBe(`implicit:member:${principalId}`)
      }
    })

    test('the 0050 backfill is idempotent: re-running its statements changes no row', async () => {
      const { afterBackfill, afterRepeat } = await runScenario()
      expect(afterRepeat.admissions).toEqual(afterBackfill.admissions)
      expect(afterRepeat.audienceGrants).toEqual(afterBackfill.audienceGrants)
      expect(afterRepeat.enlistmentGrants).toEqual(afterBackfill.enlistmentGrants)
    })

    test('the main capture families are unchanged across the canonical chain', async () => {
      const { comparison } = await runScenario()
      // No determinate change on any main family. nativeSessions and the 0049 group families are outside
      // this capture's scope (the group tables do not exist at 0048; the test above proves them after the
      // backfill), so the comparator reports them unknown on both sides and the verdict is inconclusive.
      expect(comparison.findings.map((finding) => finding.family).toSorted()).toEqual([
        'groupAdmissions',
        'groupAudienceGrants',
        'groupEnlistmentGrants',
        'nativeSessions',
      ])
      expect(
        comparison.findings.every((finding) => finding.findingClass === 'unknown_domain')
      ).toBe(true)
      expect(comparison.verdict).toBe('inconclusive')
    })

    test('the seeded message remains visible to both members through the existing read paths', async () => {
      const { readsBefore, readsAfter, seededMessageId } = await runScenario()
      expect(readsBefore.ownerActive).toContain(seededMessageId)
      expect(readsBefore.memberActive).toContain(seededMessageId)
      expect(readsAfter.ownerActive).toContain(seededMessageId)
      expect(readsAfter.memberActive).toContain(seededMessageId)
      expect(readsAfter.ownerActive).toEqual(readsBefore.ownerActive)
      expect(readsAfter.memberActive).toEqual(readsBefore.memberActive)
      expect(readsBefore.outsiderActive).toBe('denied')
      expect(readsAfter.outsiderActive).toBe(readsBefore.outsiderActive)
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
