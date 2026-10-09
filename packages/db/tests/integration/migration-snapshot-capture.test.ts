import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

import { createGroupChannel, createMessage } from '../../src/conversations'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createContentRef } from '../../src/content-refs'
import type { JsonObject } from '../../src/schema/conventions'
import { createUserWithAuthIdentity, createTemporaryUserSession } from '../../src/identity'
import {
  captureMigrationSnapshot,
  captureMigrationSnapshotInTransaction,
  type MigrationSnapshotCaptureIdentityInput,
  MIGRATION_SNAPSHOT_CAPTURE_TRANSACTION_CONFIG,
  PAYLOAD_CANONICAL_MAX_DEPTH,
} from '../../src/migration-snapshot-capture'
import { compareMigrationSnapshots } from '../../src/migration-snapshot-comparator'
import { setProjectMember } from '../../src/project-sharing'
import { createProject } from '../../src/projects'
import { markChannelReadState } from '../../src/read-state'
import {
  channelParticipants,
  channels,
  contentRefs,
  messages,
  taskExecutionAttempts,
  tasks,
  temporaryUserSessions,
  users,
  workspaceEvents,
  workspaceMemberships,
  workspaces,
} from '../../src/schema'
import { createTask } from '../../src/tasks'
import { createWorkspaceInvitation } from '../../src/workspace-invitations'
import { createWorkspaceWithOwner } from '../../src/workspaces'
import { migrationSnapshotFamilies } from '@adea-ai/types'

// Capture proofs against the disposable PostgreSQL lane (DATABASE_URL, skipped
// cleanly when absent). Every proof drives real rows through the domain
// helpers, captures, and — where a diff is expected — runs the comparator on
// the two frozen documents. Capture is read-only: the only writes in this
// file are the fixtures themselves and their cleanup.
//
// A capture inventories the WHOLE app schema — that is its job — and the
// comparator deliberately refuses input pairs whose sections could outgrow
// its documented output bound. The shared disposable instance outlives this
// file and may hold unrelated rows, so each run captures inside a scratch
// database of its own: created in the same PostgreSQL instance DATABASE_URL
// points at, migrated with the repository's drizzle migrations, and dropped
// afterwards. The proofs therefore see exactly the state the fixture wrote.

const connectionUrl = process.env.DATABASE_URL

let scratchDatabase: string | null = null

/** Fixed capture clock: the fixture invitation below is pending at this instant. */
const CAPTURED_AT = new Date('2026-01-05T00:00:00.000Z')

const captureIdentity = (snapshotId: string): MigrationSnapshotCaptureIdentityInput => ({
  capturedAt: CAPTURED_AT,
  rehearsalId: 'rehearsal-capture-integration',
  snapshotId,
  source: 'integration',
})

/**
 * A payload whose content sits entirely below the canonical depth cap: a
 * skeleton of single-key objects with the leaf buried `PAYLOAD_CANONICAL_MAX_DEPTH + 8`
 * levels down, so two such payloads are byte-identical above the cap and
 * differ only where the digest's fold must still see them.
 */
const payloadNestedBelow = (leaf: string): JsonObject => {
  let value: JsonObject = { leaf }
  for (let depth = 0; depth < PAYLOAD_CANONICAL_MAX_DEPTH + 8; depth += 1) {
    value = { layer: value }
  }
  return value
}

function capture(connection: DatabaseConnection, snapshotId: string, limitPerFamily?: number) {
  return captureMigrationSnapshot(connection.db, {
    ...(limitPerFamily === undefined ? {} : { limitPerFamily }),
    identity: captureIdentity(snapshotId),
  })
}

async function buildFixture(connection: DatabaseConnection) {
  const suffix = crypto.randomUUID()
  const boundSubject = `subject-${suffix}`
  const invitationEmail = `capture-invitee-${suffix}@example.com`
  const expiresAt = new Date(Date.now() + 600_000)

  const owner = await createTemporaryUserSession(connection.db, {
    credentialDigest: `capture-owner-${suffix}`,
    expiresAt,
  })
  const collaborator = await createTemporaryUserSession(connection.db, {
    credentialDigest: `capture-collaborator-${suffix}`,
    expiresAt,
  })
  const bound = await createUserWithAuthIdentity(connection.db, {
    identity: { provider: 'capture-test', subject: boundSubject },
  })

  const { workspace } = await createWorkspaceWithOwner(connection.db, {
    idempotencyKey: `capture-${suffix}`,
    name: 'Capture HQ',
    owner: owner.principal,
  })
  const { workspace: secondWorkspace } = await createWorkspaceWithOwner(connection.db, {
    idempotencyKey: `capture-second-${suffix}`,
    name: 'Capture Second HQ',
    owner: owner.principal,
  })

  // A second workspace member: the audience rows and grants need a grantee.
  await connection.db.insert(workspaceMemberships).values({
    role: 'member',
    userId: collaborator.principal.userId,
    workspaceId: workspace.id,
  })

  const channel = await createGroupChannel(connection.db, workspace.id, owner.principal, {
    idempotencyKey: `capture-channel-${suffix}`,
    title: 'Capture channel',
  })
  const message = await createMessage(connection.db, workspace.id, channel.id, owner.principal, {
    bodyText: 'capture-private-message-body',
    idempotencyKey: `capture-message-${suffix}`,
    sender: owner.principal,
  })

  const project = await createProject(connection.db, workspace.id, owner.principal, {
    iconKey: 'folder',
    name: 'Capture project',
  })
  await setProjectMember(connection.db, workspace.id, project.id, owner.principal, {
    role: 'editor',
    userId: collaborator.principal.userId,
  })

  const task = await createTask(
    connection.db,
    workspace.id,
    owner.principal,
    { objective: 'Capture objective', title: 'Capture task' },
    { idempotencyKey: `capture-task-${suffix}`, requestId: crypto.randomUUID() }
  )
  await connection.db.insert(taskExecutionAttempts).values({
    attempt: 1,
    locationKind: 'agent_hq_cloud',
    runtimeNodeId: null,
    taskId: task.id,
    workspaceId: workspace.id,
  })

  const { invitation } = await createWorkspaceInvitation(
    connection.db,
    workspace.id,
    owner.principal,
    { email: invitationEmail, role: 'member' },
    new Date('2026-01-01T00:00:00.000Z')
  )

  const contentRefId = crypto.randomUUID()
  await createContentRef(connection.db, workspace.id, owner.principal, {
    availability: 'available',
    contentType: 'task_input',
    digestSha256: 'a'.repeat(64),
    id: contentRefId,
    keyVersion: 1,
    schemaVersion: 1,
    sensitivity: 'restricted',
    storagePolicy: 'local_authority',
    synchronizationPolicy: 'local_only',
  })

  await markChannelReadState(connection.db, workspace.id, channel.id, owner.principal, 'read')

  return {
    async cleanup() {
      await connection.db.delete(messages).where(eq(messages.id, message.id))
      await connection.db.delete(channels).where(eq(channels.id, channel.id))
      await connection.db.delete(tasks).where(eq(tasks.id, task.id))
      await connection.db.delete(contentRefs).where(eq(contentRefs.id, contentRefId))
      await connection.db
        .delete(workspaceMemberships)
        .where(eq(workspaceMemberships.workspaceId, workspace.id))
      await connection.db
        .delete(workspaceMemberships)
        .where(eq(workspaceMemberships.workspaceId, secondWorkspace.id))
      await connection.db.delete(workspaces).where(eq(workspaces.id, workspace.id))
      await connection.db.delete(workspaces).where(eq(workspaces.id, secondWorkspace.id))
      await connection.db
        .delete(temporaryUserSessions)
        .where(eq(temporaryUserSessions.userId, owner.principal.userId))
      await connection.db
        .delete(temporaryUserSessions)
        .where(eq(temporaryUserSessions.userId, collaborator.principal.userId))
      await connection.db.delete(users).where(eq(users.id, owner.principal.userId))
      await connection.db.delete(users).where(eq(users.id, collaborator.principal.userId))
      await connection.db.delete(users).where(eq(users.id, bound.userId))
    },
    bound,
    boundSubject,
    channel,
    collaborator,
    contentRefId,
    invitation,
    invitationEmail,
    message,
    owner,
    project,
    secondWorkspace,
    task,
    workspace,
  }
}

/** The same connection settings as `connectionUrl`, against another database. */
function urlForDatabase(database: string): string {
  const url = new URL(connectionUrl!)
  url.pathname = `/${database}`
  return url.toString()
}

async function dropScratchDatabase(): Promise<void> {
  if (!scratchDatabase) return
  const admin = postgres(urlForDatabase('postgres'), { max: 1, onnotice: () => {} })
  try {
    await admin.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  } finally {
    await admin.end()
  }
}

describe.skipIf(!connectionUrl)('migration snapshot capture', () => {
  let connection: DatabaseConnection

  beforeAll(async () => {
    scratchDatabase = `capture_test_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`
    const admin = postgres(urlForDatabase('postgres'), { max: 1, onnotice: () => {} })
    try {
      await admin.unsafe(`create database "${scratchDatabase}"`)
    } finally {
      await admin.end()
    }
    connection = createDatabase(urlForDatabase(scratchDatabase))
    await migrate(connection.db, {
      migrationsFolder: `${import.meta.dir}/../../drizzle`,
    })
    // Applying the full repository migration set to the scratch database
    // comfortably exceeds bun's default five-second hook timeout.
  }, 120_000)
  afterAll(async () => {
    // The scratch database must be dropped even when setup failed midway and
    // no connection was ever opened.
    try {
      await connection.close()
    } catch {
      // Setup never opened a connection; the scratch drop below still runs.
    }
    await dropScratchDatabase()
  })

  test('captures every supported family at one consistent snapshot, byte-identically', async () => {
    const fixture = await buildFixture(connection)
    try {
      const first = await capture(connection, 'snapshot-a')
      const second = await capture(connection, 'snapshot-a')

      // Determinism: the same state and the same identity inputs serialize to
      // the exact same bytes.
      expect(JSON.stringify(first.document)).toBe(JSON.stringify(second.document))

      // Completeness: every supported family is a present, untruncated
      // section — a proven inventory, not an absence.
      for (const family of migrationSnapshotFamilies) {
        const section = first.document.sections[family]
        expect(section).toBeDefined()
        expect(section?.truncated).toBe(false)
      }

      const document = first.document
      const own = document.sections.workspaces?.records.find(
        (row) => row.workspaceId === fixture.workspace.id
      )
      expect(own).toMatchObject({ archived: false, ownerUserId: fixture.owner.principal.userId })
      expect(own?.controlPlaneWorkspaceId.startsWith('wsp_')).toBe(true)

      expect(document.sections.memberships?.records).toContainEqual({
        family: 'memberships',
        role: 'owner',
        userId: fixture.owner.principal.userId,
        workspaceId: fixture.workspace.id,
      })

      expect(document.sections.channels?.records).toContainEqual({
        channelId: fixture.channel.id,
        family: 'channels',
        projectId: null,
        visibility: 'participants',
        workspaceId: fixture.workspace.id,
      })

      expect(document.sections.channelParticipants?.records).toContainEqual({
        channelId: fixture.channel.id,
        family: 'channelParticipants',
        principalId: fixture.owner.principal.userId,
        principalKind: 'user',
        workspaceId: fixture.workspace.id,
      })

      expect(document.sections.messages?.records).toContainEqual({
        channelId: fixture.channel.id,
        deleted: false,
        family: 'messages',
        messageId: fixture.message.id,
        threadRootMessageId: null,
        workspaceId: fixture.workspace.id,
      })

      expect(document.sections.projects?.records).toContainEqual({
        family: 'projects',
        projectId: fixture.project.id,
        visibility: 'workspace',
        workspaceId: fixture.workspace.id,
      })
      expect(document.sections.projectMembers?.records).toContainEqual({
        family: 'projectMembers',
        projectId: fixture.project.id,
        role: 'editor',
        userId: fixture.collaborator.principal.userId,
        workspaceId: fixture.workspace.id,
      })

      expect(document.sections.tasks?.records).toContainEqual({
        channelId: null,
        creatorUserId: fixture.owner.principal.userId,
        family: 'tasks',
        lifecycleState: 'created',
        messageId: null,
        projectId: null,
        taskId: fixture.task.id,
        threadRootMessageId: null,
        version: 1,
        workspaceId: fixture.workspace.id,
      })
      expect(document.sections.executionAttempts?.records).toContainEqual({
        attempt: 1,
        family: 'executionAttempts',
        locationKind: 'agent_hq_cloud',
        runtimeNodeId: null,
        taskId: fixture.task.id,
        workspaceId: fixture.workspace.id,
      })

      const invitation = document.sections.invitations?.records.find(
        (row) => row.invitationId === fixture.invitation.id
      )
      // Created 2026-01-01 with a seven-day lifetime: pending at the fixed
      // capture clock, derived from injected time, not the wall clock.
      expect(invitation).toMatchObject({ role: 'member', state: 'pending' })

      expect(document.sections.identityBindings?.records).toContainEqual({
        family: 'identityBindings',
        provider: 'capture-test',
        subject: fixture.boundSubject,
        userId: fixture.bound.userId,
      })

      expect(document.sections.contentRefs?.records).toContainEqual({
        availability: 'available',
        contentRefId: fixture.contentRefId,
        digestSha256: 'a'.repeat(64),
        family: 'contentRefs',
        keyVersion: 1,
        messageId: null,
        revision: 1,
        taskId: null,
        workspaceId: fixture.workspace.id,
      })

      const events = document.sections.events?.records ?? []
      expect(events.length).toBeGreaterThan(0)
      for (const event of events) {
        expect(event.payloadDigest).toMatch(/^[0-9a-f]{64}$/)
        expect(Number.isSafeInteger(event.workspaceSequence)).toBe(true)
      }

      // The channel-level frontier exists for the owner; the sequence is
      // globally allocated on this database, so assert its provenance, not a
      // fixed number.
      const frontier = document.sections.readState?.records.find(
        (row) =>
          row.channelId === fixture.channel.id &&
          row.threadRootMessageId === null &&
          row.userId === fixture.owner.principal.userId
      )
      expect(frontier).toMatchObject({
        channelId: fixture.channel.id,
        family: 'readState',
        manuallyUnread: false,
        threadRootMessageId: null,
        userId: fixture.owner.principal.userId,
        workspaceId: fixture.workspace.id,
      })
      expect(frontier?.lastReadSequence).toBeGreaterThan(0)

      expect(document.sections.temporarySessions?.records).toContainEqual({
        claimed: false,
        family: 'temporarySessions',
        sessionId: fixture.owner.sessionId,
        userId: fixture.owner.principal.userId,
      })

      // Redaction: none of the private values the fixture wrote may travel.
      const serialized = JSON.stringify(first.document)
      expect(serialized).not.toContain(fixture.invitationEmail)
      expect(serialized).not.toContain('capture-private-message-body')
      expect(serialized).not.toContain('capture-owner-')
      expect(serialized).not.toContain('postgres://')

      // The comparator confirms the two documents agree.
      const comparison = compareMigrationSnapshots({
        after: second.document,
        before: first.document,
      })
      expect(comparison.verdict).toBe('identical')
      expect(comparison.findings).toEqual([])
    } finally {
      await fixture.cleanup()
    }
  })

  test('runs as one repeatable-read, read-only transaction', async () => {
    const fixture = await buildFixture(connection)
    try {
      // The capture-shaped transaction really is REPEATABLE READ / READ ONLY,
      // and the database rejects a write inside it (the driver wraps the
      // Postgres error, so inspect its cause for the server's verdict).
      const rejected = await connection.db
        .transaction(async (transaction) => {
          const rows = (await transaction.execute(
            sql`select current_setting('transaction_isolation') as iso, current_setting('transaction_read_only') as ro`
          )) as unknown as ReadonlyArray<{ iso: string; ro: string }>
          expect(rows[0]?.iso).toBe('repeatable read')
          expect(rows[0]?.ro).toBe('on')
          await transaction.execute(sql`update ${workspaces} set name = name`)
        }, MIGRATION_SNAPSHOT_CAPTURE_TRANSACTION_CONFIG)
        .then(
          () => null,
          (error: unknown) => error
        )
      expect(rejected).toBeInstanceOf(Error)
      const cause = (rejected as { cause?: { message?: string } }).cause
      const reason = cause?.message ?? (rejected as Error).message
      expect(reason).toMatch(/read-only transaction/)

      // A capture inside a caller-owned consistent transaction matches a
      // capture that opens its own — same bytes for the same state.
      await connection.db.transaction(async (transaction) => {
        const inside = await captureMigrationSnapshotInTransaction(transaction, {
          identity: captureIdentity('snapshot-inside'),
        })
        const outside = await captureMigrationSnapshot(connection.db, {
          identity: captureIdentity('snapshot-inside'),
        })
        expect(JSON.stringify(inside.document)).toBe(JSON.stringify(outside.document))
      }, MIGRATION_SNAPSHOT_CAPTURE_TRANSACTION_CONFIG)
    } finally {
      await fixture.cleanup()
    }
  })

  test('a deleted row is a typed missing_record, not an unknown', async () => {
    const fixture = await buildFixture(connection)
    try {
      const before = await capture(connection, 'snapshot-before')
      await connection.db.delete(messages).where(eq(messages.id, fixture.message.id))
      const after = await capture(connection, 'snapshot-after')

      const comparison = compareMigrationSnapshots({
        after: after.document,
        before: before.document,
      })
      expect(comparison.verdict).toBe('divergent')
      expect(comparison.findings).toContainEqual(
        expect.objectContaining({
          family: 'messages',
          findingClass: 'missing_record',
          side: 'after',
          stableId: fixture.message.id,
        })
      )
      // The comparison was determinate: nothing was unknown.
      expect(comparison.counts.byClass?.unknown_domain ?? 0).toBe(0)
    } finally {
      await fixture.cleanup()
    }
  })

  test('a workspace-binding change is a typed remapped_record', async () => {
    const fixture = await buildFixture(connection)
    try {
      const before = await capture(connection, 'snapshot-before')
      // Move the channel-audience row to the other workspace: same stable id
      // (channel, kind, principal), changed workspace binding.
      await connection.db
        .update(channelParticipants)
        .set({ workspaceId: fixture.secondWorkspace.id })
        .where(eq(channelParticipants.channelId, fixture.channel.id))
      const after = await capture(connection, 'snapshot-after')

      const comparison = compareMigrationSnapshots({
        after: after.document,
        before: before.document,
      })
      expect(comparison.verdict).toBe('divergent')
      expect(comparison.findings).toContainEqual(
        expect.objectContaining({
          detail: expect.objectContaining({ field: 'workspaceId' }),
          family: 'channelParticipants',
          findingClass: 'remapped_record',
        })
      )
    } finally {
      await fixture.cleanup()
    }
  })

  test('payloads differing only below the digest depth cap are typed digest drift', async () => {
    const fixture = await buildFixture(connection)
    const eventId = crypto.randomUUID()
    // Identical above the canonical depth cap, different below it. The
    // payload itself never travels; only its digest does, so the two captures
    // differ in the document ONLY if the digest folds the deep content in.
    try {
      // The fixture's domain helpers may already have written events for this
      // workspace; append after them to respect the per-workspace sequence.
      const [{ nextSequence }] = await connection.db
        .select({
          nextSequence: sql<number>`coalesce(max(${workspaceEvents.workspaceSequence}), 0) + 1`,
        })
        .from(workspaceEvents)
        .where(eq(workspaceEvents.workspaceId, fixture.workspace.id))
      await connection.db.insert(workspaceEvents).values({
        aggregateType: 'workspace',
        eventType: 'capture.depth-probe',
        id: eventId,
        payload: payloadNestedBelow('before'),
        schemaVersion: 1,
        workspaceId: fixture.workspace.id,
        workspaceSequence: nextSequence,
      })
      const before = await capture(connection, 'snapshot-before')
      await connection.db
        .update(workspaceEvents)
        .set({ payload: payloadNestedBelow('after') })
        .where(eq(workspaceEvents.id, eventId))
      const after = await capture(connection, 'snapshot-after')

      const comparison = compareMigrationSnapshots({
        after: after.document,
        before: before.document,
      })
      // Past the depth fold, identical skeletons with different deep leaves
      // digest differently; under the old constant '"~depth"' marker this
      // comparison came back identical.
      expect(comparison.verdict).toBe('divergent')
      expect(comparison.findings).toContainEqual(
        expect.objectContaining({
          detail: expect.objectContaining({ field: 'payloadDigest' }),
          family: 'events',
          findingClass: 'digest_drift',
          stableId: eventId,
        })
      )
    } finally {
      await connection.db.delete(workspaceEvents).where(eq(workspaceEvents.id, eventId))
      await fixture.cleanup()
    }
  })

  test('grown audience and visibility are typed widened_access', async () => {
    const fixture = await buildFixture(connection)
    try {
      const before = await capture(connection, 'snapshot-before')

      await connection.db
        .update(channels)
        .set({ visibility: 'workspace' })
        .where(eq(channels.id, fixture.channel.id))
      await connection.db.insert(channelParticipants).values({
        channelId: fixture.channel.id,
        principalKind: 'user',
        userId: fixture.collaborator.principal.userId,
        workspaceId: fixture.workspace.id,
      })

      const after = await capture(connection, 'snapshot-after')
      const comparison = compareMigrationSnapshots({
        after: after.document,
        before: before.document,
      })
      expect(comparison.verdict).toBe('divergent')

      expect(comparison.findings).toContainEqual(
        expect.objectContaining({
          detail: expect.objectContaining({ after: 'workspace', before: 'participants' }),
          family: 'channels',
          findingClass: 'widened_access',
        })
      )
      // A new audience row is a grant family: widened access, never a neutral
      // unexpected record.
      expect(comparison.findings).toContainEqual(
        expect.objectContaining({
          detail: expect.objectContaining({ field: 'grant' }),
          family: 'channelParticipants',
          findingClass: 'widened_access',
          side: 'after',
        })
      )
    } finally {
      await fixture.cleanup()
    }
  })

  test('a family over the per-family bound is flagged truncated and reads as incomplete', async () => {
    const fixture = await buildFixture(connection)
    try {
      const full = await capture(connection, 'snapshot-full')
      const bounded = await capture(connection, 'snapshot-bounded', 3)

      // The durable event log outgrew the bound: the bounded section carries
      // the truncation evidence and the applied limit, never a silent claim
      // of completeness.
      const fullEvents = full.document.sections.events
      const boundedEvents = bounded.document.sections.events
      expect(fullEvents?.truncated).toBe(false)
      expect(fullEvents?.records.length).toBeGreaterThan(3)
      expect(boundedEvents?.truncated).toBe(true)
      expect(boundedEvents?.limit).toBe(3)
      expect(boundedEvents?.records).toHaveLength(3)

      // Comparator side: each bounded section yields its own truncated_input
      // finding — equality was not proven.
      const boundedTwice = compareMigrationSnapshots({
        after: bounded.document,
        before: bounded.document,
      })
      expect(boundedTwice.verdict).toBe('inconclusive')
      expect(boundedTwice.findings).toContainEqual(
        expect.objectContaining({
          family: 'events',
          findingClass: 'truncated_input',
          side: 'before',
        })
      )
      expect(boundedTwice.findings).toContainEqual(
        expect.objectContaining({
          family: 'events',
          findingClass: 'truncated_input',
          side: 'after',
        })
      )

      const boundedAgainstFull = compareMigrationSnapshots({
        after: full.document,
        before: bounded.document,
      })
      expect(boundedAgainstFull.verdict).toBe('divergent')
      expect(boundedAgainstFull.findings).toContainEqual(
        expect.objectContaining({
          family: 'events',
          findingClass: 'truncated_input',
          side: 'before',
        })
      )
      expect(boundedAgainstFull.findings).toContainEqual(
        expect.objectContaining({
          family: 'events',
          findingClass: 'unexpected_record',
          side: 'after',
        })
      )
    } finally {
      await fixture.cleanup()
    }
  })

  test('an unsupported requested domain stays unknown with a typed reason', async () => {
    const result = await captureMigrationSnapshot(connection.db, {
      identity: captureIdentity('snapshot-partial'),
      requestedDomains: ['workspaces', 'runtimeNodes'],
    })

    expect(result.domains).toEqual([
      { domain: 'runtimeNodes', status: 'unknown', unknownReason: 'unrecognized_domain' },
      { domain: 'workspaces', status: 'captured', unknownReason: null },
    ])
    // Only the supported, requested family has a section; the unsupported one
    // is absent entirely — the comparator's unknown, never an empty success.
    expect(Object.keys(result.document.sections)).toEqual(['workspaces'])
    expect(result.document.sections.workspaces?.truncated).toBe(false)

    const comparison = compareMigrationSnapshots({
      after: result.document,
      before: result.document,
    })
    expect(comparison.verdict).toBe('inconclusive')
    expect(comparison.counts.byClass?.unknown_domain).toBe(migrationSnapshotFamilies.length - 1)
  })

  test('documents from this capture validate against the comparator contract', async () => {
    const fixture = await buildFixture(connection)
    try {
      const result = await capture(connection, 'snapshot-shaped')
      // No section may trip the comparator's structure checks: bounds, limit
      // and truncation evidence all agree by construction.
      expect(result.document.identity.formatVersion).toBe(1)
      const comparison = compareMigrationSnapshots({
        after: result.document,
        before: result.document,
      })
      expect(comparison.verdict).toBe('identical')
    } finally {
      await fixture.cleanup()
    }
  })
})
