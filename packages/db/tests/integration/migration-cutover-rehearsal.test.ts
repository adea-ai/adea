import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

import { createArtifact } from '../../src/artifacts'
import {
  ArtifactReferenceGrantError,
  readCurrentArtifactReferenceGrant,
  registerArtifactReferenceGrant,
  revokeArtifactReferenceGrant,
} from '../../src/artifact-reference-grants'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createContentRef } from '../../src/content-refs'
import { listChannelsForUser, listMessagesForUser } from '../../src/conversations'
import { createTemporaryUserSession } from '../../src/identity'
import {
  captureMigrationSnapshot,
  type MigrationSnapshotCaptureIdentityInput,
} from '../../src/migration-snapshot-capture'
import { compareMigrationSnapshots } from '../../src/migration-snapshot-comparator'
import { migrationSnapshotFamilies } from '@adea-ai/types'
import {
  captureLegacyMigrationSnapshot,
  LEGACY_MIGRATION_SNAPSHOT_VERSIONS,
} from '../../src/migration-snapshot-legacy'
import { listReadStateForUser } from '../../src/read-state'
import { taskExecutionAttempts, workspaceMemberships } from '../../src/schema'
import { listTasksForUser } from '../../src/tasks'
import {
  createWorkspaceInvitation,
  listWorkspaceMembersForUser,
} from '../../src/workspace-invitations'
import { createWorkspaceWithOwner } from '../../src/workspaces'
import {
  CUTOVER_TAG,
  DRIZZLE_DIR,
  disposeRehearsal,
  isProductDenial,
  migrationsFolderBefore,
  readJournal,
  type RehearsalResources,
  settleAndDispose,
  view,
} from '../fixtures/cutover-rehearsal'
import {
  insertLegacyGroup,
  insertLegacyMessage,
  insertLegacyProject,
  insertLegacyProjectMember,
  insertLegacyReadState,
  insertLegacyTask,
} from '../fixtures/legacy-audience-seed'

// Cutover rehearsal for #1222 on a disposable database that this file creates and
// drops. The pre-cutover state is the repository's drizzle journal cut immediately
// before `0046_artifact_reference_grants`, applied with the same `migrate` the capture
// proofs use. The cutover is the remaining journal entry, applied unchanged. Nothing
// here adds a migration, a backfill, or a second migration framework.
//
// Determinism: one scenario runs once, in fixed order, however the tests are selected
// or reordered. Every test asserts on that scenario's recorded results and never on
// state a previous test left behind.
//
// Provisioning: the admin URL comes from MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL, which
// scripts/test-integration.mjs exports when Docker provisioning succeeds. In CI a
// missing URL fails the suite instead of skipping it. Outside CI the suite is skipped
// without the URL, and it never falls back to the shared DATABASE_URL.

const provisioningUrl = process.env.MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL
const inCi = process.env.CI === 'true' || process.env.CI === '1'
const SCRATCH_PREFIX = 'rehearsal_1222_'
const CHECKSUM = 'b'.repeat(64)

const identity = (snapshotId: string): MigrationSnapshotCaptureIdentityInput => ({
  capturedAt: new Date('2026-01-05T00:00:00.000Z'),
  rehearsalId: 'rehearsal-cutover-1222',
  snapshotId,
  source: 'integration',
})

function requireProvisioningUrl(): string {
  if (!provisioningUrl) {
    throw new Error(
      'MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL is not set. In CI this means the Docker capture provisioning did not run, and the rehearsal refuses to skip silently.'
    )
  }
  return provisioningUrl
}

function urlForDatabase(database: string): string {
  const url = new URL(requireProvisioningUrl())
  url.pathname = `/${database}`
  return url.toString()
}

function assertScratch(database: string): void {
  if (!database.startsWith(SCRATCH_PREFIX)) {
    throw new Error(
      `Refusing to create or drop "${database}": scratch names need ${SCRATCH_PREFIX}`
    )
  }
}

async function adminExecute(statement: string): Promise<void> {
  const admin = postgres(urlForDatabase('postgres'), { max: 1, onnotice: () => {} })
  try {
    await admin.unsafe(statement)
  } finally {
    await admin.end()
  }
}

async function adminRows<T extends Record<string, unknown>>(statement: string): Promise<T[]> {
  const admin = postgres(urlForDatabase('postgres'), { max: 1, onnotice: () => {} })
  try {
    return (await admin.unsafe(statement)) as unknown as T[]
  } finally {
    await admin.end()
  }
}

type Principal = Awaited<ReturnType<typeof createTemporaryUserSession>>['principal']

type Fixture = {
  workspaceId: string
  audienceWorkspaceId: string
  artifactId: string
  owner: Principal
  audienceOwner: Principal
  collaborator: Principal
  outsider: Principal
  sharedChannelId: string
  archivedChannelId: string
}

async function seedLegacyFixture(connection: DatabaseConnection): Promise<Fixture> {
  const suffix = crypto.randomUUID()
  const expiresAt = new Date(Date.now() + 600_000)
  const session = async (name: string) =>
    (
      await createTemporaryUserSession(connection.db, {
        credentialDigest: `rehearsal-${name}-${suffix}`,
        expiresAt,
      })
    ).principal
  const owner = await session('owner')
  const collaborator = await session('collaborator')
  const outsider = await session('outsider')
  const audienceOwner = await session('audience-owner')

  const { workspace } = await createWorkspaceWithOwner(connection.db, {
    idempotencyKey: `rehearsal-${suffix}`,
    name: 'Rehearsal HQ',
    owner,
  })
  const workspaceId = workspace.id
  await connection.db.insert(workspaceMemberships).values({
    role: 'member',
    userId: collaborator.userId,
    workspaceId,
  })
  const { workspace: audience } = await createWorkspaceWithOwner(connection.db, {
    idempotencyKey: `rehearsal-audience-${suffix}`,
    name: 'Rehearsal audience',
    owner: audienceOwner,
  })

  // Legacy group rows, written as the pre-#1232 product wrote them: the group policy tables do not
  // exist before the canonical chain, so the product's group writers cannot run at this state.
  const sharedId = await insertLegacyGroup(
    connection.db,
    workspaceId,
    owner,
    'Shared rehearsal channel'
  )
  let latestShared = 0
  for (const body of ['rehearsal-shared-body-1', 'rehearsal-shared-body-2']) {
    latestShared = await insertLegacyMessage(connection.db, {
      bodyText: body,
      channelId: sharedId,
      sender: owner,
      workspaceId,
    })
  }
  await insertLegacyReadState(connection.db, {
    channelId: sharedId,
    lastReadSequence: latestShared,
    userId: owner.userId,
    workspaceId,
  })

  const closedId = await insertLegacyGroup(
    connection.db,
    workspaceId,
    owner,
    'Archived participant-only channel',
    { archived: true }
  )
  await insertLegacyMessage(connection.db, {
    bodyText: 'rehearsal-closed-body',
    channelId: closedId,
    sender: owner,
    workspaceId,
  })

  const taskId = await insertLegacyTask(connection.db, {
    creatorUserId: owner.userId,
    objective: 'Rehearsal objective',
    title: 'Rehearsal task',
    workspaceId,
  })
  await connection.db.insert(taskExecutionAttempts).values({
    attempt: 1,
    locationKind: 'agent_hq_cloud',
    runtimeNodeId: null,
    taskId,
    workspaceId,
  })

  await createWorkspaceInvitation(
    connection.db,
    workspaceId,
    owner,
    { email: `rehearsal-invitee-${suffix}@example.com`, role: 'member' },
    new Date('2026-01-01T00:00:00.000Z')
  )

  const projectId = await insertLegacyProject(connection.db, workspaceId, 'Rehearsal project')
  await insertLegacyProjectMember(connection.db, {
    projectId,
    role: 'editor',
    userId: collaborator.userId,
    workspaceId,
  })

  await createContentRef(connection.db, workspaceId, owner, {
    availability: 'available',
    contentType: 'task_input',
    digestSha256: 'c'.repeat(64),
    id: crypto.randomUUID(),
    keyVersion: 1,
    schemaVersion: 1,
    sensitivity: 'restricted',
    storagePolicy: 'local_authority',
    synchronizationPolicy: 'local_only',
  })

  // Created before cutover: the artifact must survive the expansion unchanged.
  const artifact = await createArtifact(connection.db, workspaceId, owner, {
    availability: 'available',
    checksumSha256: CHECKSUM,
    filename: 'rehearsal.txt',
    location: { reference: `outputs/${crypto.randomUUID()}`, type: 'object_store' },
    mediaType: 'text/plain',
    sizeBytes: 32,
    sourceArtifactRef: `runtime-output:${crypto.randomUUID()}`,
    sourcePrincipal: { kind: 'system', systemId: 'job-runner' },
  })

  return {
    workspaceId,
    audienceWorkspaceId: audience.id,
    artifactId: artifact.id,
    owner,
    audienceOwner,
    collaborator,
    outsider,
    sharedChannelId: sharedId,
    archivedChannelId: closedId,
  }
}

const ids = (rows: readonly { id: string }[] | 'denied') =>
  rows === 'denied' ? 'denied' : rows.map((row) => row.id).toSorted()

/**
 * The families both sides of the cutover capture, from the registered pre-0046 version. Every other
 * family is recorded as absent by schema or not read by the legacy path, never as empty.
 */
const COMPARED_FAMILIES = LEGACY_MIGRATION_SNAPSHOT_VERSIONS['pre-0046']!.capturedFamilies
/** Contract families outside the compared scope: the comparator reports each as unknown, never as zero. */
const UNPROVEN_FAMILIES = migrationSnapshotFamilies
  .filter((family) => !COMPARED_FAMILIES.includes(family))
  .toSorted()

/**
 * The product baseline at the pre-0046 state. The merged product readers name columns and relations
 * that the historical schema lacks, so the baseline is unavailable evidence, never an empty answer.
 * Only a missing column or relation is accepted as that evidence; any other error still throws.
 */
async function baselineProductReads(
  connection: DatabaseConnection,
  fixture: Fixture
): Promise<{ unavailable: string } | { value: Awaited<ReturnType<typeof readThroughProduct>> }> {
  try {
    return { value: await readThroughProduct(connection, fixture) }
  } catch (error) {
    // drizzle wraps the driver error; the missing object is named on the wrapped cause.
    for (const candidate of [error, (error as { cause?: unknown } | null)?.cause]) {
      const text = candidate instanceof Error ? candidate.message : String(candidate)
      const missing = /(column|relation) "([^"]+)" does not exist/.exec(text)
      if (missing)
        return { unavailable: `${missing[1]} "${missing[2]}" does not exist before 0046` }
    }
    throw error
  }
}

/** Product reads per principal, keyed by stable id. Denials are values; other errors throw. */
async function readThroughProduct(connection: DatabaseConnection, fixture: Fixture) {
  const { db } = connection
  const { workspaceId, sharedChannelId, archivedChannelId } = fixture
  const principals = {
    owner: fixture.owner,
    collaborator: fixture.collaborator,
    outsider: fixture.outsider,
  }
  const out: Record<string, Record<string, string[] | 'denied'>> = {}
  for (const [name, principal] of Object.entries(principals)) {
    out[name] = {
      channels: ids(
        await view(() => listChannelsForUser(db, workspaceId, principal, { includeArchived: true }))
      ),
      sharedMessages: ids(
        await view(
          async () =>
            (await listMessagesForUser(db, workspaceId, sharedChannelId, principal)).messages
        )
      ),
      archivedMessages: ids(
        await view(
          async () =>
            (await listMessagesForUser(db, workspaceId, archivedChannelId, principal)).messages
        )
      ),
      tasks: ids(await view(() => listTasksForUser(db, workspaceId, principal))),
      readState: ids(
        await view(async () =>
          (await listReadStateForUser(db, workspaceId, principal)).map(({ channelId }) => ({
            id: channelId,
          }))
        )
      ),
      members: ids(await view(() => listWorkspaceMembersForUser(db, workspaceId, principal))),
    }
  }
  return out
}

async function journalCount(connection: DatabaseConnection): Promise<number> {
  const rows = await connection.db.execute<{ count: number }>(
    sql`select count(*)::int as count from drizzle.__drizzle_migrations`
  )
  return rows[0]?.count ?? -1
}

async function tablePresent(connection: DatabaseConnection, name: string): Promise<boolean> {
  const rows = await connection.db.execute<{ present: boolean }>(
    sql`select to_regclass(${name}) is not null as present`
  )
  return rows[0]?.present === true
}

async function grantRowCount(connection: DatabaseConnection, grantId: string): Promise<number> {
  const rows = await connection.db.execute<{ count: number }>(
    sql`select count(*)::int as count from app.artifact_reference_grants where grant_id = ${grantId}`
  )
  return rows[0]?.count ?? -1
}

async function artifactRowCount(connection: DatabaseConnection, artifactId: string) {
  const rows = await connection.db.execute<{ count: number }>(
    sql`select count(*)::int as count from app.artifacts where id = ${artifactId}`
  )
  return rows[0]?.count ?? -1
}

type Scenario = Awaited<ReturnType<typeof executeScenario>>

const resources: RehearsalResources = {}
let scenario: Promise<Scenario> | undefined

async function executeScenario() {
  requireProvisioningUrl()
  const scratch = `${SCRATCH_PREFIX}${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`
  assertScratch(scratch)
  resources.scratch = scratch
  await adminExecute(`create database "${scratch}"`)
  const connection = createDatabase(urlForDatabase(scratch))
  resources.connection = connection
  resources.preFolder = migrationsFolderBefore(CUTOVER_TAG)

  // Pre-cutover: the journal before the cutover tag only.
  await migrate(connection.db, { migrationsFolder: resources.preFolder })
  const journalLength = readJournal().entries.length
  const cutIndex = readJournal().entries.findIndex((entry) => entry.tag === CUTOVER_TAG)
  const pre = {
    applied: await journalCount(connection),
    expectedApplied: cutIndex,
    grantsTablePresent: await tablePresent(connection, 'app.artifact_reference_grants'),
  }
  const fixture = await seedLegacyFixture(connection)
  const before = await captureLegacyMigrationSnapshot(connection.db, {
    identity: identity('before'),
    versionId: 'pre-0046',
  })
  const baselineReads = await baselineProductReads(connection, fixture)
  // The canonical typed capture, on the same populated pre-0046 state, restricted to the compared
  // families. Where it is valid it must agree with the legacy readers record for record.
  const typedBefore = await captureMigrationSnapshot(connection.db, {
    identity: identity('before-typed'),
    requestedDomains: COMPARED_FAMILIES,
  })

  // Cutover: the remaining journal entry, applied unchanged.
  await migrate(connection.db, { migrationsFolder: DRIZZLE_DIR })
  const cutover = {
    applied: await journalCount(connection),
    grantsTablePresent: await tablePresent(connection, 'app.artifact_reference_grants'),
    artifactRows: await artifactRowCount(connection, fixture.artifactId),
  }
  const after = await captureMigrationSnapshot(connection.db, {
    identity: identity('after'),
    requestedDomains: COMPARED_FAMILIES,
  })
  const cutoverComparison = compareMigrationSnapshots({
    after: after.document,
    before: before.document,
  })
  const afterReads = await readThroughProduct(connection, fixture)

  // Artifact-reference grants through the real API, after cutover.
  const grantId = `rehearsal-grant-${crypto.randomUUID()}`
  const grantInput = {
    artifactId: fixture.artifactId,
    audienceWorkspaceId: fixture.audienceWorkspaceId,
    checksumSha256: CHECKSUM,
    expiresAt: null,
    grantId,
    version: 1,
  }
  const registration = await registerArtifactReferenceGrant(
    connection.db,
    fixture.workspaceId,
    fixture.owner,
    grantInput
  )
  const outsiderRegistration = await registerArtifactReferenceGrant(
    connection.db,
    fixture.workspaceId,
    fixture.outsider,
    { ...grantInput, grantId: `rehearsal-denied-${crypto.randomUUID()}` }
  ).then(
    () => null,
    (error: unknown) => error
  )
  const grantBeforeRepeat = await readCurrentArtifactReferenceGrant(connection.db, {
    grantId,
    revision: registration.state.revision,
  })
  const grantRowsBefore = await grantRowCount(connection, grantId)

  // Repeat: re-running the migration and the capture must change nothing.
  await migrate(connection.db, { migrationsFolder: DRIZZLE_DIR })
  const repeat = {
    applied: await journalCount(connection),
    artifactRows: await artifactRowCount(connection, fixture.artifactId),
  }
  const again = await captureMigrationSnapshot(connection.db, {
    requestedDomains: COMPARED_FAMILIES,
    identity: identity('after-repeat'),
  })
  const repeatComparison = compareMigrationSnapshots({
    after: again.document,
    before: after.document,
  })
  const repeatReads = await readThroughProduct(connection, fixture)
  const grantAfterRepeat = await readCurrentArtifactReferenceGrant(connection.db, {
    grantId,
    revision: registration.state.revision,
  })
  const grantRowsAfterRepeat = await grantRowCount(connection, grantId)

  // Revocation through the API, then a stale presentation is refused.
  const revoked = await revokeArtifactReferenceGrant(
    connection.db,
    fixture.workspaceId,
    fixture.owner,
    grantId
  )
  const revokedCurrent = revoked
    ? await readCurrentArtifactReferenceGrant(connection.db, {
        grantId,
        revision: revoked.revision,
      })
    : null
  const staleAfterRevoke = await readCurrentArtifactReferenceGrant(connection.db, {
    grantId,
    revision: registration.state.revision,
  })

  // Sensitivity: the comparator must still see a removed record after cutover.
  const mutated = structuredClone(after.document) as typeof after.document
  const messages = mutated.sections.messages
  if (!messages) throw new Error('messages section missing from the after capture')
  mutated.sections.messages = { ...messages, records: messages.records.slice(1) }
  const sensitivity = compareMigrationSnapshots({ after: mutated, before: after.document })

  return {
    fixture,
    journalLength,
    pre,
    cutover,
    repeat,
    before,
    after,
    again,
    baselineReads,
    afterReads,
    typedBefore,
    repeatReads,
    cutoverComparison,
    repeatComparison,
    sensitivity,
    grants: {
      registration,
      outsiderRegistration,
      grantBeforeRepeat,
      grantAfterRepeat,
      grantRowsBefore,
      grantRowsAfterRepeat,
      revoked,
      revokedCurrent,
      staleAfterRevoke,
      grantId,
    },
  }
}

/** Run once per file, however many tests are selected or in what order. */
function runScenario(): Promise<Scenario> {
  scenario ??= executeScenario()
  return scenario
}

describe.skipIf(!provisioningUrl && !inCi)('migration cutover rehearsal (#1222)', () => {
  afterAll(async () => {
    const pending = scenario
    scenario = undefined
    await settleAndDispose(resources, pending, async (database) => {
      assertScratch(database)
      await adminExecute(`drop database if exists "${database}" with (force)`)
    })
  }, 300_000)

  test('the pre-cutover database has exactly the journal entries before the cutover tag', async () => {
    const { pre, journalLength } = await runScenario()
    expect(pre.applied).toBe(pre.expectedApplied)
    expect(pre.applied).toBeLessThan(journalLength)
    expect(pre.grantsTablePresent).toBe(false)
  }, 300_000)

  test('on the same populated pre-0046 database, the legacy capture equals the canonical typed capture', async () => {
    const { before, typedBefore } = await runScenario()
    expect(before.document.sections).toEqual(typedBefore.document.sections)
    expect(Object.keys(before.document.sections).toSorted()).toEqual(
      [...COMPARED_FAMILIES].toSorted()
    )
  })

  test('the cutover applies the remaining journal entry and changes no captured record', async () => {
    const { cutover, journalLength, cutoverComparison, baselineReads, afterReads } =
      await runScenario()
    expect(cutover.applied).toBe(journalLength)
    expect(cutover.grantsTablePresent).toBe(true)
    expect(cutover.artifactRows).toBe(1)
    // No determinate divergence on any family both sides prove. The two families outside the compared
    // scope stay unknown by contract (absent by schema before 0046, not read by the legacy path), so the
    // verdict is inconclusive, never a success.
    expect(cutoverComparison.findings.map((finding) => finding.findingClass)).toEqual(
      UNPROVEN_FAMILIES.map(() => 'unknown_domain')
    )
    expect(cutoverComparison.findings.map((finding) => finding.family).toSorted()).toEqual(
      UNPROVEN_FAMILIES
    )
    expect(cutoverComparison.verdict).toBe('inconclusive')
    // The pre-0046 product baseline is unavailable evidence (see the capture test); after cutover the
    // product answers, and the document comparison carries the audience and identity facts.
    expect('unavailable' in baselineReads).toBe(true)
    expect(afterReads.owner.sharedMessages).toHaveLength(2)
  }, 300_000)

  test('the capture covers the legacy families, records absent and unread families explicitly, and keeps audience facts', async () => {
    const { before, baselineReads, fixture } = await runScenario()
    const families = Object.keys(before.document.sections).toSorted()
    expect(families).toEqual([...COMPARED_FAMILIES].toSorted())
    expect(before.provenance.versionId).toBe('pre-0046')
    expect(before.provenance.migrations.count).toBe(46)
    expect(before.provenance.absentBySchema).toEqual({
      artifactReferenceGrants: { reason: expect.any(String), table: 'artifact_reference_grants' },
    })
    expect(Object.keys(before.provenance.notInLegacyRegistry)).toEqual(['nativeSessions'])
    expect(before.document.sections.executionAttempts?.records.length).toBeGreaterThanOrEqual(1)
    expect(before.document.sections.readState?.records.length).toBeGreaterThanOrEqual(1)
    const audience = before.document.sections.channelParticipants?.records ?? []
    expect(
      audience.some(
        (row) =>
          row.channelId === fixture.sharedChannelId && row.principalId === fixture.owner.userId
      )
    ).toBe(true)
    expect(audience.some((row) => row.principalId === fixture.outsider.userId)).toBe(false)
    // The product baseline cannot run on the pre-0046 schema: recorded as unavailable, never as empty.
    expect(baselineReads).toEqual({ unavailable: expect.stringContaining('does not exist') })
  }, 300_000)

  test('repeating the migration and capture is idempotent', async () => {
    const { repeat, journalLength, repeatComparison, repeatReads, afterReads, again, after } =
      await runScenario()
    expect(repeat.applied).toBe(journalLength)
    expect(repeat.artifactRows).toBe(1)
    expect(repeatComparison.findings.map((finding) => finding.family).toSorted()).toEqual(
      UNPROVEN_FAMILIES
    )
    expect(repeatComparison.verdict).toBe('inconclusive')
    expect(again.document.sections).toEqual(after.document.sections)
    expect(repeatReads).toEqual(afterReads)
  }, 300_000)

  test('denied users stay denied through the product read paths after cutover', async () => {
    const { afterReads, fixture } = await runScenario()
    expect(afterReads.outsider).toEqual({
      channels: 'denied',
      sharedMessages: 'denied',
      archivedMessages: 'denied',
      tasks: 'denied',
      readState: 'denied',
      members: 'denied',
    })
    // A workspace member who is not a participant sees neither channel's content.
    expect(afterReads.collaborator.sharedMessages).toBe('denied')
    expect(afterReads.collaborator.archivedMessages).toBe('denied')
    // Message reads exclude archived channels for everyone, participants included.
    expect(afterReads.owner.archivedMessages).toBe('denied')
    // Only the participant sees the archived channel in the includeArchived listing.
    expect(afterReads.owner.channels).toContain(fixture.archivedChannelId)
    expect(afterReads.collaborator.channels).not.toContain(fixture.archivedChannelId)
    // Positive controls: the same resources are readable by an authorized principal, so each
    // denial above is a real authorization outcome and not a missing fixture.
    expect(afterReads.owner.sharedMessages).not.toBe('denied')
    expect(afterReads.owner.members).not.toBe('denied')
    expect(afterReads.collaborator.members).not.toBe('denied')
    expect(afterReads.collaborator.tasks).not.toBe('denied')
  }, 300_000)

  test('artifact-reference grants register, survive repeat migration, and revoke through the API', async () => {
    const { grants } = await runScenario()
    // Registered through the real API by the source owner.
    expect(grants.registration.outcome).toBe('registered')
    expect(grants.registration.state.revision).toBe(1)
    expect(grants.registration.state.revoked).toBe(false)
    // Authority is enforced: a non-member of the source workspace is refused.
    expect(grants.outsiderRegistration).toBeInstanceOf(ArtifactReferenceGrantError)
    expect((grants.outsiderRegistration as Error).message).toBe(
      'Artifact reference grant issuer unauthorized'
    )
    // The grant reads back identically before and after the repeat migration.
    expect(grants.grantBeforeRepeat).not.toBeNull()
    expect(grants.grantAfterRepeat).toEqual(grants.grantBeforeRepeat)
    expect(grants.grantRowsBefore).toBe(1)
    expect(grants.grantRowsAfterRepeat).toBe(1)
    // Revocation through the API. The stored grant reads back revoked for the presentation that
    // matches it, so a holder cannot treat the grant as live after revocation.
    expect(grants.revoked?.revoked).toBe(true)
    expect(grants.revokedCurrent?.revoked).toBe(true)
    expect(grants.staleAfterRevoke?.revoked).toBe(true)
  }, 300_000)

  test('the comparator still reports a removed record after cutover', async () => {
    const { sensitivity } = await runScenario()
    expect(sensitivity.verdict).not.toBe('identical')
    expect(sensitivity.findings.some((finding) => finding.findingClass === 'missing_record')).toBe(
      true
    )
  }, 300_000)
})

// Teardown that starts while the scenario is still allocating. The allocation below mirrors
// executeScenario's order (record the scratch name, create the database, open the client,
// make the folder) on real resources. Teardown must wait for it to settle, then release all
// of it: the database is gone, the client is closed, and the folder is removed.
describe.skipIf(!provisioningUrl && !inCi)('cleanup race on disposable resources (#1222)', () => {
  test('teardown that starts mid-allocation waits for the scenario and releases every resource', async () => {
    const late: RehearsalResources = {}
    const scratch = `${SCRATCH_PREFIX}race_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let connection: DatabaseConnection | undefined
    let folder: string | undefined
    const allocation = (async () => {
      await gate
      late.scratch = scratch
      await adminExecute(`create database "${scratch}"`)
      connection = createDatabase(urlForDatabase(scratch))
      late.connection = connection
      folder = mkdtempSync(join(tmpdir(), 'rehearsal-1222-race-'))
      late.preFolder = folder
      await connection.db.execute(sql`select 1`)
    })()

    let released = false
    const teardown = settleAndDispose(late, allocation, async (database) => {
      assertScratch(database)
      await adminExecute(`drop database if exists "${database}" with (force)`)
    }).then(() => {
      released = true
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(released).toBe(false)

    release()
    await teardown
    await allocation

    const databases = await adminRows<{ datname: string }>(
      `select datname from pg_database where datname = '${scratch}'`
    )
    expect(databases).toEqual([])
    expect(existsSync(folder!)).toBe(false)
    const clientState = await connection!.client`select 1`.then(
      () => 'open',
      () => 'closed'
    )
    expect(clientState).toBe('closed')
    expect(late).toEqual({})
  }, 300_000)
})

describe('product denial classification (no database)', () => {
  test('an unrelated failure from a read path is not treated as a denial', async () => {
    const connectionLoss = new Error('connection terminated unexpectedly')
    await expect(view(() => Promise.reject(connectionLoss))).rejects.toBe(connectionLoss)
    const missingRelation = new Error('relation "app.artifact_reference_grants" does not exist')
    await expect(view(() => Promise.reject(missingRelation))).rejects.toBe(missingRelation)
    const notAnError = 'Channel unavailable'
    await expect(view(() => Promise.reject(notAnError))).rejects.toBe(notAnError)
  })

  test('the product denial messages are denials, exactly', async () => {
    for (const message of [
      'Channel unavailable',
      'Conversation participant unavailable',
      'Message unavailable',
      'Project unavailable',
      'Read state unavailable',
      'Task unavailable',
    ]) {
      expect(await view(() => Promise.reject(new Error(message)))).toBe('denied')
    }
    expect(isProductDenial(new Error('Channel unavailable!'))).toBe(false)
    expect(isProductDenial(new Error('channel unavailable'))).toBe(false)
  })
})

describe('cleanup disposal (no database)', () => {
  test('a scenario still running at teardown has its late resources released', async () => {
    const late: RehearsalResources = {}
    const dropped: string[] = []
    let closed = false
    const pending = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      late.scratch = 'rehearsal_1222_late'
      late.connection = {
        close: async () => {
          closed = true
        },
      }
      return 'settled'
    })()
    await settleAndDispose(late, pending, async (database) => {
      dropped.push(database)
    })
    expect(dropped).toEqual(['rehearsal_1222_late'])
    expect(closed).toBe(true)
    expect(late).toEqual({})
  })

  test('every step is attempted, failures surface together, and the folder is removed', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'rehearsal-1222-dispose-'))
    writeFileSync(join(folder, 'marker.sql'), '-- marker')
    const attempted: string[] = []
    const closeError = new Error('close failed')
    const dropError = new Error('drop failed')
    const failure = await disposeRehearsal(
      {
        connection: {
          close: async () => {
            attempted.push('close')
            throw closeError
          },
        },
        scratch: 'rehearsal_1222_x',
        preFolder: folder,
      },
      async () => {
        attempted.push('drop')
        throw dropError
      }
    ).catch((error: unknown) => error)
    expect(attempted).toEqual(['close', 'drop'])
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([closeError, dropError])
    expect(existsSync(folder)).toBe(false)
  })

  test('a clean disposal drops the scratch database and removes the folder', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'rehearsal-1222-clean-'))
    const dropped: string[] = []
    await disposeRehearsal(
      {
        connection: { close: async () => undefined },
        scratch: 'rehearsal_1222_y',
        preFolder: folder,
      },
      async (database) => {
        dropped.push(database)
      }
    )
    expect(dropped).toEqual(['rehearsal_1222_y'])
    expect(existsSync(folder)).toBe(false)
  })
})
