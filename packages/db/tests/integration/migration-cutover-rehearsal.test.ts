import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

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
import { markChannelReadState, listReadStateForUser } from '../../src/read-state'
import { setProjectMember } from '../../src/project-sharing'
import { createProject } from '../../src/projects'
import { taskExecutionAttempts, workspaceMemberships } from '../../src/schema'
import { createTask, listTasksForUser } from '../../src/tasks'
import {
  createWorkspaceInvitation,
  listWorkspaceMembersForUser,
} from '../../src/workspace-invitations'
import { createWorkspaceWithOwner } from '../../src/workspaces'

// Cutover rehearsal for #1222, on a disposable database that this file creates
// and drops. The pre-cutover state is the repository's own drizzle journal cut
// immediately before `0046_artifact_reference_grants`, applied through the same
// `migrate` the capture proofs use. The cutover is the remaining journal entry,
// applied unchanged. Nothing here writes a migration, a backfill, or a second
// migration framework. Capture and comparison are the #1219 tooling.
//
// Provisioning follows migration-snapshot-capture.test.ts: the admin URL comes
// from MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL, and scratch names carry the
// `rehearsal_1222_` prefix. The proofs skip cleanly without the provisioning
// URL and never fall back to the shared DATABASE_URL.

const provisioningUrl = process.env.MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL
const SCRATCH_PREFIX = 'rehearsal_1222_'
const DRIZZLE_DIR = `${import.meta.dir}/../../drizzle`
const CUTOVER_TAG = '0046_artifact_reference_grants'

const CAPTURED_AT = new Date('2026-01-05T00:00:00.000Z')
const identity = (snapshotId: string): MigrationSnapshotCaptureIdentityInput => ({
  capturedAt: CAPTURED_AT,
  rehearsalId: 'rehearsal-cutover-1222',
  snapshotId,
  source: 'integration',
})

function urlForDatabase(database: string): string {
  if (!provisioningUrl) throw new Error('MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL is required')
  const url = new URL(provisioningUrl)
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

type Journal = { entries: { idx: number; tag: string }[]; dialect: string; version: string }

/** The journal entries before `tag`, copied verbatim with their SQL, as a migrations folder. */
function migrationsFolderBefore(tag: string): string {
  const journal = JSON.parse(readFileSync(`${DRIZZLE_DIR}/meta/_journal.json`, 'utf8')) as Journal
  const cut = journal.entries.findIndex((entry) => entry.tag === tag)
  if (cut < 0) throw new Error(`cutover tag ${tag} is not in the journal`)
  const folder = mkdtempSync(join(tmpdir(), 'rehearsal-1222-pre-'))
  mkdirSync(join(folder, 'meta'))
  const kept = journal.entries.slice(0, cut)
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({ ...journal, entries: kept })
  )
  for (const entry of kept)
    copyFileSync(`${DRIZZLE_DIR}/${entry.tag}.sql`, join(folder, `${entry.tag}.sql`))
  return folder
}

/** Principal-scoped reads through the product's own functions. Denial is a value, not a throw. */
async function view<T>(read: () => Promise<T>): Promise<T | 'denied'> {
  try {
    return await read()
  } catch {
    return 'denied'
  }
}

const ids = (rows: readonly { id: string }[] | 'denied'): string[] | 'denied' =>
  rows === 'denied' ? 'denied' : rows.map((row) => row.id).toSorted()

type Fixture = {
  workspaceId: string
  owner: Awaited<ReturnType<typeof createTemporaryUserSession>>['principal']
  collaborator: Awaited<ReturnType<typeof createTemporaryUserSession>>['principal']
  outsider: Awaited<ReturnType<typeof createTemporaryUserSession>>['principal']
  sharedChannelId: string
  archivedChannelId: string
}

async function seedLegacyFixture(connection: DatabaseConnection): Promise<Fixture> {
  const suffix = crypto.randomUUID()
  const expiresAt = new Date(Date.now() + 600_000)
  const owner = (
    await createTemporaryUserSession(connection.db, {
      credentialDigest: `rehearsal-owner-${suffix}`,
      expiresAt,
    })
  ).principal
  const collaborator = (
    await createTemporaryUserSession(connection.db, {
      credentialDigest: `rehearsal-collaborator-${suffix}`,
      expiresAt,
    })
  ).principal
  const outsider = (
    await createTemporaryUserSession(connection.db, {
      credentialDigest: `rehearsal-outsider-${suffix}`,
      expiresAt,
    })
  ).principal

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

  const shared = await createGroupChannel(connection.db, workspaceId, owner, {
    idempotencyKey: `rehearsal-shared-${suffix}`,
    title: 'Shared rehearsal channel',
  })
  await createMessage(connection.db, workspaceId, shared.id, owner, {
    bodyText: 'rehearsal-shared-body-1',
    idempotencyKey: `rehearsal-message-1-${suffix}`,
    sender: owner,
  })
  await createMessage(connection.db, workspaceId, shared.id, owner, {
    bodyText: 'rehearsal-shared-body-2',
    idempotencyKey: `rehearsal-message-2-${suffix}`,
    sender: owner,
  })
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
    digestSha256: 'b'.repeat(64),
    id: crypto.randomUUID(),
    keyVersion: 1,
    schemaVersion: 1,
    sensitivity: 'restricted',
    storagePolicy: 'local_authority',
    synchronizationPolicy: 'local_only',
  })

  return {
    workspaceId,
    owner,
    collaborator,
    outsider,
    sharedChannelId: shared.id,
    archivedChannelId: closed.id,
  }
}

/** What each principal can read through the product's own functions, by stable id. */
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

describe.skipIf(!provisioningUrl)('migration cutover rehearsal (#1222)', () => {
  let connection: DatabaseConnection
  let scratch: string
  let preFolder: string
  let fixture: Fixture
  let baselineReads: Awaited<ReturnType<typeof readThroughProduct>>
  let before: Awaited<ReturnType<typeof captureMigrationSnapshot>>
  let after: Awaited<ReturnType<typeof captureMigrationSnapshot>>

  beforeAll(async () => {
    scratch = `${SCRATCH_PREFIX}${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`
    assertScratch(scratch)
    const admin = postgres(urlForDatabase('postgres'), { max: 1, onnotice: () => {} })
    try {
      await admin.unsafe(`create database "${scratch}"`)
    } finally {
      await admin.end()
    }
    connection = createDatabase(urlForDatabase(scratch))
    preFolder = migrationsFolderBefore(CUTOVER_TAG)
    await migrate(connection.db, { migrationsFolder: preFolder })
    fixture = await seedLegacyFixture(connection)
    before = await captureMigrationSnapshot(connection.db, { identity: identity('before') })
    baselineReads = await readThroughProduct(connection, fixture)
  }, 300_000)

  afterAll(async () => {
    try {
      await connection?.close()
    } catch {
      // Setup may fail before a connection opens; the drop below still runs.
    }
    if (scratch) {
      assertScratch(scratch)
      const admin = postgres(urlForDatabase('postgres'), { max: 1, onnotice: () => {} })
      try {
        await admin.unsafe(`drop database if exists "${scratch}" with (force)`)
      } finally {
        await admin.end()
      }
    }
    if (preFolder) rmSync(preFolder, { recursive: true, force: true })
  }, 120_000)

  test('the pre-cutover database has exactly the journal entries before the cutover tag', async () => {
    const rows = await connection.db.execute<{ count: number }>(
      sql`select count(*)::int as count from drizzle.__drizzle_migrations`
    )
    const journal = JSON.parse(readFileSync(`${DRIZZLE_DIR}/meta/_journal.json`, 'utf8')) as Journal
    const cut = journal.entries.findIndex((entry) => entry.tag === CUTOVER_TAG)
    expect(rows[0]?.count).toBe(cut)
    const [table] = await connection.db.execute<{ present: boolean }>(
      sql`select to_regclass('app.artifact_reference_grants') is not null as present`
    )
    expect(table?.present).toBe(false)
  })

  test('the cutover applies the remaining journal entry and changes no captured record', async () => {
    await migrate(connection.db, { migrationsFolder: DRIZZLE_DIR })
    const [table] = await connection.db.execute<{ present: boolean }>(
      sql`select to_regclass('app.artifact_reference_grants') is not null as present`
    )
    expect(table?.present).toBe(true)

    after = await captureMigrationSnapshot(connection.db, { identity: identity('after') })
    const comparison = compareMigrationSnapshots({ after: after.document, before: before.document })
    expect(comparison.findings).toEqual([])
    expect(comparison.verdict).toBe('identical')
    expect(await readThroughProduct(connection, fixture)).toEqual(baselineReads)
  })

  test('the capture covers the rehearsed families and the fixture survives the cutover', async () => {
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
  })

  test('repeating the migration and capture is idempotent', async () => {
    await migrate(connection.db, { migrationsFolder: DRIZZLE_DIR })
    const rows = await connection.db.execute<{ count: number }>(
      sql`select count(*)::int as count from drizzle.__drizzle_migrations`
    )
    const journal = JSON.parse(readFileSync(`${DRIZZLE_DIR}/meta/_journal.json`, 'utf8')) as Journal
    expect(rows[0]?.count).toBe(journal.entries.length)

    const again = await captureMigrationSnapshot(connection.db, {
      identity: identity('after-repeat'),
    })
    expect(
      compareMigrationSnapshots({ after: again.document, before: after.document }).findings
    ).toEqual([])
    expect(await readThroughProduct(connection, fixture)).toEqual(baselineReads)
  })

  test('denied users stay denied through the product read paths after cutover', async () => {
    const reads = await readThroughProduct(connection, fixture)
    expect(reads.outsider).toEqual({
      channels: 'denied',
      sharedMessages: 'denied',
      archivedMessages: 'denied',
      tasks: 'denied',
      readState: 'denied',
      members: 'denied',
    })
    // A workspace member who is not a participant sees neither channel's content.
    expect(reads.collaborator.sharedMessages).toBe('denied')
    expect(reads.collaborator.archivedMessages).toBe('denied')
    // Message reads exclude archived channels for everyone, participants included, so the
    // archived participant-only channel is denied to all principals before and after cutover.
    expect(reads.owner.archivedMessages).toBe('denied')
    expect(reads.owner.archivedMessages).toEqual(baselineReads.owner.archivedMessages)
    // Only the participant sees the archived channel in the includeArchived listing.
    expect(reads.owner.channels).toContain(fixture.archivedChannelId)
    expect(reads.collaborator.channels).not.toContain(fixture.archivedChannelId)
  })

  test('the comparator still reports a removed record after cutover', () => {
    const mutated = structuredClone(after.document) as typeof after.document
    const messages = mutated.sections.messages
    if (!messages) throw new Error('messages section missing')
    mutated.sections.messages = { ...messages, records: messages.records.slice(1) }
    const comparison = compareMigrationSnapshots({ after: mutated, before: after.document })
    expect(comparison.verdict).not.toBe('identical')
    expect(comparison.findings.some((finding) => finding.findingClass === 'missing_record')).toBe(
      true
    )
  })
})
