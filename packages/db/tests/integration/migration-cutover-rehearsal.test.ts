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
import {
  archiveChannel,
  createGroupChannel,
  createMessage,
  listChannelsForUser,
  listMessagesForUser,
} from '../../src/conversations'
import { createTemporaryUserSession } from '../../src/identity'
import {
  captureMigrationSnapshot,
  type MigrationSnapshotCaptureIdentityInput,
} from '../../src/migration-snapshot-capture'
import { compareMigrationSnapshots } from '../../src/migration-snapshot-comparator'
import { setProjectMember } from '../../src/project-sharing'
import { createProject } from '../../src/projects'
import { listReadStateForUser, markChannelReadState } from '../../src/read-state'
import { taskExecutionAttempts, workspaceMemberships } from '../../src/schema'
import { createTask, listTasksForUser } from '../../src/tasks'
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

  const shared = await createGroupChannel(connection.db, workspaceId, owner, {
    idempotencyKey: `rehearsal-shared-${suffix}`,
    title: 'Shared rehearsal channel',
  })
  for (const body of ['rehearsal-shared-body-1', 'rehearsal-shared-body-2']) {
    await createMessage(connection.db, workspaceId, shared.id, owner, {
      bodyText: body,
      idempotencyKey: `rehearsal-${body}-${suffix}`,
      sender: owner,
    })
  }
  await markChannelReadState(connection.db, workspaceId, shared.id, owner, 'read')

  const closed = await createGroupChannel(connection.db, workspaceId, owner, {
    idempotencyKey: `rehearsal-closed-${suffix}`,
    title: 'Archived participant-only channel',
  })
  await createMessage(connection.db, workspaceId, closed.id, owner, {
    bodyText: 'rehearsal-closed-body',
    idempotencyKey: `rehearsal-closed-message-${suffix}`,
    sender: owner,
  })
  await archiveChannel(connection.db, workspaceId, closed.id, owner, closed.version)

  const task = await createTask(
    connection.db,
    workspaceId,
    owner,
    { objective: 'Rehearsal objective', title: 'Rehearsal task' },
    { idempotencyKey: `rehearsal-task-${suffix}`, requestId: crypto.randomUUID() }
  )
  await connection.db.insert(taskExecutionAttempts).values({
    attempt: 1,
    locationKind: 'agent_hq_cloud',
    runtimeNodeId: null,
    taskId: task.id,
    workspaceId,
  })

  await createWorkspaceInvitation(
    connection.db,
    workspaceId,
    owner,
    { email: `rehearsal-invitee-${suffix}@example.com`, role: 'member' },
    new Date('2026-01-01T00:00:00.000Z')
  )

  const project = await createProject(connection.db, workspaceId, owner, {
    iconKey: 'folder',
    name: 'Rehearsal project',
  })
  await setProjectMember(connection.db, workspaceId, project.id, owner, {
    role: 'editor',
    userId: collaborator.userId,
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
    sharedChannelId: shared.id,
    archivedChannelId: closed.id,
  }
}

const ids = (rows: readonly { id: string }[] | 'denied') =>
  rows === 'denied' ? 'denied' : rows.map((row) => row.id).toSorted()

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
  const before = await captureMigrationSnapshot(connection.db, { identity: identity('before') })
  const baselineReads = await readThroughProduct(connection, fixture)

  // Cutover: the remaining journal entry, applied unchanged.
  await migrate(connection.db, { migrationsFolder: DRIZZLE_DIR })
  const cutover = {
    applied: await journalCount(connection),
    grantsTablePresent: await tablePresent(connection, 'app.artifact_reference_grants'),
    artifactRows: await artifactRowCount(connection, fixture.artifactId),
  }
  const after = await captureMigrationSnapshot(connection.db, { identity: identity('after') })
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

  test('the cutover applies the remaining journal entry and changes no captured record', async () => {
    const { cutover, journalLength, cutoverComparison, baselineReads, afterReads } =
      await runScenario()
    expect(cutover.applied).toBe(journalLength)
    expect(cutover.grantsTablePresent).toBe(true)
    expect(cutover.artifactRows).toBe(1)
    expect(cutoverComparison.findings).toEqual([])
    expect(cutoverComparison.verdict).toBe('identical')
    expect(afterReads).toEqual(baselineReads)
  }, 300_000)

  test('the capture covers the rehearsed families and the fixture is read through the product', async () => {
    const { before, baselineReads } = await runScenario()
    const families = Object.keys(before.document.sections).toSorted()
    expect(families).toEqual(
      [
        'agents',
        'channelParticipants',
        'channels',
        'contentRefs',
        'events',
        'executionAttempts',
        'identityBindings',
        'invitations',
        'memberships',
        'messages',
        'projectMembers',
        'projects',
        'readState',
        'tasks',
        'temporarySessions',
        'workspaces',
      ].toSorted()
    )
    expect(before.document.sections.executionAttempts?.records.length).toBeGreaterThanOrEqual(1)
    expect(before.document.sections.readState?.records.length).toBeGreaterThanOrEqual(1)
    expect(baselineReads.owner.sharedMessages).toHaveLength(2)
    expect(baselineReads.outsider.sharedMessages).toBe('denied')
    expect(baselineReads.collaborator.sharedMessages).toBe('denied')
    expect(baselineReads.collaborator.archivedMessages).toBe('denied')
  }, 300_000)

  test('repeating the migration and capture is idempotent', async () => {
    const { repeat, journalLength, repeatComparison, repeatReads, afterReads, again, after } =
      await runScenario()
    expect(repeat.applied).toBe(journalLength)
    expect(repeat.artifactRows).toBe(1)
    expect(repeatComparison.findings).toEqual([])
    expect(repeatComparison.verdict).toBe('identical')
    expect(again.document.sections).toEqual(after.document.sections)
    expect(repeatReads).toEqual(afterReads)
  }, 300_000)

  test('denied users stay denied through the product read paths after cutover', async () => {
    const { afterReads, baselineReads, fixture } = await runScenario()
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
    expect(afterReads.owner.archivedMessages).toEqual(baselineReads.owner.archivedMessages)
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
