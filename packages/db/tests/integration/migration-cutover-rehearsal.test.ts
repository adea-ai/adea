import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { and, eq, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

import { createAgent } from '../../src/agents'
import { createArtifact } from '../../src/artifacts'
import {
  ArtifactReferenceGrantError,
  readCurrentArtifactReferenceGrant,
  registerArtifactReferenceGrant,
  revokeArtifactReferenceGrant,
} from '../../src/artifact-reference-grants'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createContentRef } from '../../src/content-refs'
import { upsertContentReplica } from '../../src/content-replicas'
import { accountConversationInbox } from '../../src/account-inbox'
import { accountWorkspaceSummaries } from '../../src/account-summary'
import {
  archiveChannel,
  createMessage,
  getChannelForUser,
  getMessageForUser,
  listChannelsForUser,
  listMessagesForUser,
  setChannelParticipants,
  updateChannel,
} from '../../src/conversations'
import { classifyWorkspaceEventsForUser } from '../../src/event-visibility'
import type { WorkspaceEventView } from '../../src/event-log'
import { postGroupChannelMessage } from '../../src/group-channels'
import { loadGroupAdmission } from '../../src/group-participation-store'
import { searchWorkspaceForUser } from '../../src/search'
import { createTemporaryUserSession } from '../../src/identity'
import {
  captureMigrationSnapshot,
  type MigrationSnapshotCaptureIdentityInput,
} from '../../src/migration-snapshot-capture'
import { compareMigrationSnapshots } from '../../src/migration-snapshot-comparator'
import { migrationSnapshotFamilies, type MigrationSnapshotDocument } from '@adea-ai/types'
import {
  captureLegacyMigrationSnapshot,
  LEGACY_MIGRATION_SNAPSHOT_VERSIONS,
} from '../../src/migration-snapshot-legacy'
import { listReadStateForUser } from '../../src/read-state'
import {
  channelParticipants,
  groupAdmissions,
  taskExecutionAttempts,
  workspaceMemberships,
} from '../../src/schema'
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
  captureGroupAudienceParticipants,
  installLegacyAudienceQuarantine,
  legacyBackfillProfile,
  quarantineLegacyAudience,
  reconcileLegacyAudience,
  replayCanonicalBackfill,
} from '../fixtures/legacy-audience-quarantine'
import {
  insertLegacyGroup,
  insertLegacyMessage,
  insertLegacyMessageSequence,
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
  contentRefId: string
  replicaId: string
  contentDigest: string
  taskId: string
  owner: Principal
  audienceOwner: Principal
  collaborator: Principal
  outsider: Principal
  /** A clean legacy participant: admissible, the positive control for every denial below. */
  member: Principal
  /** A legacy participant who has since left the workspace (an ambiguous audience record). */
  removed: Principal
  /** An Agent from another workspace on a legacy roster (an ambiguous audience record). */
  foreignAgentId: string
  sharedChannelId: string
  archivedChannelId: string
  /** Stable ids of the seeded records the exact-evidence assertions pin. */
  memberMessageId: string
  /** The highest sequence the owner, member and removed user had read on the shared channel. */
  ownerReadSequence: number
  removedReadSequence: number
  messageContentRefId: string
  secondTaskId: string
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
  const member = await session('member')
  const removed = await session('removed')

  const { workspace } = await createWorkspaceWithOwner(connection.db, {
    idempotencyKey: `rehearsal-${suffix}`,
    name: 'Rehearsal HQ',
    owner,
  })
  const workspaceId = workspace.id
  await connection.db.insert(workspaceMemberships).values([
    { role: 'member', userId: collaborator.userId, workspaceId },
    { role: 'member', userId: member.userId, workspaceId },
    { role: 'member', userId: removed.userId, workspaceId },
  ])
  const { workspace: audience } = await createWorkspaceWithOwner(connection.db, {
    idempotencyKey: `rehearsal-audience-${suffix}`,
    name: 'Rehearsal audience',
    owner: audienceOwner,
  })
  // An Agent that lives in the audience workspace, later placed on the host workspace's legacy roster.
  const foreignAgent = await createAgent(connection.db, audience.id, audienceOwner, {
    name: 'Rehearsal foreign agent',
    profileId: 'software-engineer',
    profileVersion: '1.0.0',
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
    latestShared = await insertLegacyMessageSequence(connection.db, {
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
  // Ambiguous legacy audience on the shared group: a clean member, a user who is about to leave the
  // workspace, and an Agent from another workspace. Their roster rows are the only record of them.
  await connection.db.insert(channelParticipants).values([
    { channelId: sharedId, principalKind: 'user', userId: member.userId, workspaceId },
    { channelId: sharedId, principalKind: 'user', userId: removed.userId, workspaceId },
    { channelId: sharedId, principalKind: 'agent', agentId: foreignAgent.id, workspaceId },
  ])
  // A third message from the clean member, with a stable id the exact-evidence assertions pin.
  const memberMessageId = await insertLegacyMessage(connection.db, {
    bodyText: 'rehearsal-shared-body-3',
    channelId: sharedId,
    sender: member,
    workspaceId,
  })
  // Each participant has read part of the channel; the owner has read all of it.
  await insertLegacyReadState(connection.db, {
    channelId: sharedId,
    lastReadSequence: latestShared,
    userId: member.userId,
    workspaceId,
  })
  await insertLegacyReadState(connection.db, {
    channelId: sharedId,
    lastReadSequence: Math.max(1, latestShared - 1),
    userId: removed.userId,
    workspaceId,
  })

  const closedId = await insertLegacyGroup(
    connection.db,
    workspaceId,
    owner,
    'Archived participant-only channel',
    { archived: true }
  )
  await insertLegacyMessageSequence(connection.db, {
    bodyText: 'rehearsal-closed-body',
    channelId: closedId,
    sender: owner,
    workspaceId,
  })
  // The clean member also sits on the archived group, so the owner and member rows there are the
  // 'group channel not active' shape once the canonical backfill declines to admit them.
  await connection.db.insert(channelParticipants).values({
    channelId: closedId,
    principalKind: 'user',
    userId: member.userId,
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
  // The same task retried: attempt 2 is the active (highest) attempt, a sticky retry on the cloud.
  await connection.db.insert(taskExecutionAttempts).values({
    attempt: 2,
    change: 'sticky_retry',
    locationKind: 'agent_hq_cloud',
    runtimeNodeId: null,
    taskId,
    workspaceId,
  })
  // A second task with a single initial attempt, so active-attempt ownership is per task.
  const secondTaskId = await insertLegacyTask(connection.db, {
    creatorUserId: member.userId,
    objective: 'Rehearsal second objective',
    title: 'Rehearsal second task',
    workspaceId,
  })
  await connection.db.insert(taskExecutionAttempts).values({
    attempt: 1,
    locationKind: 'agent_hq_cloud',
    runtimeNodeId: null,
    taskId: secondTaskId,
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

  const contentDigest = 'd'.repeat(64)
  const contentRef = await createContentRef(connection.db, workspaceId, owner, {
    availability: 'available',
    contentType: 'task_input',
    digestSha256: contentDigest,
    id: crypto.randomUUID(),
    keyVersion: 1,
    schemaVersion: 1,
    sensitivity: 'restricted',
    storagePolicy: 'local_authority',
    synchronizationPolicy: 'agent_hq_e2ee_sync',
    taskId,
  })
  const replica = await upsertContentReplica(connection.db, workspaceId, contentRef.id, owner, {
    availability: 'available',
    ciphertext: Buffer.from('rehearsal encrypted replica payload').toString('base64url'),
    digestSha256: contentDigest,
    keyEpochId: crypto.randomUUID(),
    nonce: 'R'.repeat(16),
    replicaKind: 'agent_hq_e2ee_sync',
    revision: 1,
    schemaVersion: 1,
  })

  // A message-linked ref: the link from the member's message to its encrypted body.
  const messageContentRef = await createContentRef(connection.db, workspaceId, member, {
    availability: 'available',
    contentType: 'message_body',
    digestSha256: 'e'.repeat(64),
    id: crypto.randomUUID(),
    keyVersion: 1,
    messageId: memberMessageId,
    schemaVersion: 1,
    sensitivity: 'restricted',
    storagePolicy: 'local_authority',
    synchronizationPolicy: 'agent_hq_e2ee_sync',
  })

  // The user leaves the workspace; the legacy roster rows remain, as they did for real departures.
  await connection.db
    .delete(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, removed.userId)
      )
    )

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
    contentRefId: contentRef.id,
    replicaId: replica.contentReplica.id,
    contentDigest,
    taskId,
    owner,
    audienceOwner,
    collaborator,
    outsider,
    member,
    removed,
    foreignAgentId: foreignAgent.id,
    sharedChannelId: sharedId,
    archivedChannelId: closedId,
    memberMessageId,
    ownerReadSequence: latestShared,
    removedReadSequence: Math.max(1, latestShared - 1),
    messageContentRefId: messageContentRef.id,
    secondTaskId,
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

/**
 * Exact, bounded evidence for the seeded historical records of the fixture workspace, pinned by stable id:
 * the same assertion runs on the pre-cutover capture, the post-cutover capture and the repeat capture, so a
 * dropped, duplicated or re-keyed record fails by name rather than by an aggregate count.
 */
function assertHistoricalEvidence(document: MigrationSnapshotDocument, fixture: Fixture): void {
  const inWorkspace = <T extends { workspaceId?: string }>(rows: readonly T[] | undefined) =>
    (rows ?? []).filter((row) => row.workspaceId === fixture.workspaceId)
  const sections = document.sections

  // Content: the task-linked ref and the message-linked ref, and the one replica.
  const refs = inWorkspace(sections.contentRefs?.records).toSorted((left, right) =>
    left.contentRefId.localeCompare(right.contentRefId)
  )
  expect(refs).toEqual(
    [
      {
        availability: 'available',
        contentRefId: fixture.contentRefId,
        digestSha256: fixture.contentDigest,
        family: 'contentRefs',
        keyVersion: 1,
        messageId: null,
        revision: 1,
        taskId: fixture.taskId,
        workspaceId: fixture.workspaceId,
      },
      {
        availability: 'available',
        contentRefId: fixture.messageContentRefId,
        digestSha256: 'e'.repeat(64),
        family: 'contentRefs',
        keyVersion: 1,
        messageId: fixture.memberMessageId,
        revision: 1,
        taskId: null,
        workspaceId: fixture.workspaceId,
      },
    ].toSorted((left, right) => left.contentRefId.localeCompare(right.contentRefId))
  )
  expect(inWorkspace(sections.contentReplicas?.records)).toEqual([
    {
      availability: 'available',
      contentRefId: fixture.contentRefId,
      deleted: false,
      digestSha256: fixture.contentDigest,
      family: 'contentReplicas',
      replicaId: fixture.replicaId,
      replicaKind: 'agent_hq_e2ee_sync',
      revision: 1,
      schemaVersion: 1,
      workspaceId: fixture.workspaceId,
    },
  ])

  // Channels and their rosters: both legacy groups, with every legacy participant row still on record.
  expect(
    inWorkspace(sections.channels?.records)
      .map((row) => `${row.channelId}:${row.visibility}`)
      .toSorted()
  ).toEqual(
    [
      `${fixture.sharedChannelId}:participants`,
      `${fixture.archivedChannelId}:participants`,
    ].toSorted()
  )
  expect(
    inWorkspace(sections.channelParticipants?.records)
      .map((row) => `${row.channelId}:${row.principalKind}:${row.principalId}`)
      .toSorted()
  ).toEqual(
    [
      `${fixture.sharedChannelId}:user:${fixture.owner.userId}`,
      `${fixture.sharedChannelId}:user:${fixture.member.userId}`,
      `${fixture.sharedChannelId}:user:${fixture.removed.userId}`,
      `${fixture.sharedChannelId}:agent:${fixture.foreignAgentId}`,
      `${fixture.archivedChannelId}:user:${fixture.owner.userId}`,
      `${fixture.archivedChannelId}:user:${fixture.member.userId}`,
    ].toSorted()
  )

  // Messages: three on the shared channel (one pinned by id) and one on the archived channel, none deleted.
  const messages = inWorkspace(sections.messages?.records)
  expect(messages.filter((row) => row.channelId === fixture.sharedChannelId)).toHaveLength(3)
  expect(messages.filter((row) => row.channelId === fixture.archivedChannelId)).toHaveLength(1)
  expect(messages.some((row) => row.messageId === fixture.memberMessageId)).toBe(true)
  expect(messages.every((row) => row.deleted === false && row.threadRootMessageId === null)).toBe(
    true
  )

  // Read state: each reader's exact position, including the member who is behind and the removed user.
  expect(
    inWorkspace(sections.readState?.records)
      .map(
        (row) =>
          `${row.userId}:${row.channelId}:${row.lastReadSequence}:${row.manuallyUnread}:${row.threadRootMessageId}`
      )
      .toSorted()
  ).toEqual(
    [
      `${fixture.owner.userId}:${fixture.sharedChannelId}:${fixture.ownerReadSequence}:false:null`,
      `${fixture.member.userId}:${fixture.sharedChannelId}:${fixture.ownerReadSequence}:false:null`,
      `${fixture.removed.userId}:${fixture.sharedChannelId}:${fixture.removedReadSequence}:false:null`,
    ].toSorted()
  )

  // Active attempts: attempt 2 is the highest on the retried task; the second task has only attempt 1.
  expect(
    inWorkspace(sections.executionAttempts?.records)
      .map((row) => `${row.taskId}:${row.attempt}:${row.locationKind}:${row.runtimeNodeId}`)
      .toSorted()
  ).toEqual(
    [
      `${fixture.taskId}:1:agent_hq_cloud:null`,
      `${fixture.taskId}:2:agent_hq_cloud:null`,
      `${fixture.secondTaskId}:1:agent_hq_cloud:null`,
    ].toSorted()
  )
  expect(
    inWorkspace(sections.tasks?.records)
      .map((row) => row.taskId)
      .toSorted()
  ).toEqual([fixture.taskId, fixture.secondTaskId].toSorted())
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

async function count(connection: DatabaseConnection, statement: ReturnType<typeof sql>) {
  const [row] = (await connection.db.execute<{ count: number }>(statement)) as unknown as {
    count: number
  }[]
  return Number(row?.count ?? 0)
}

/** Everything a refused write must leave untouched: messages, roster rows, admissions, version. */
async function writeFootprint(connection: DatabaseConnection, fixture: Fixture) {
  const channelId = fixture.sharedChannelId
  const workspaceId = fixture.workspaceId
  return {
    admissions: await count(
      connection,
      sql`select count(*)::int as count from ${groupAdmissions} where channel_id = ${channelId}::uuid and workspace_id = ${workspaceId}::uuid`
    ),
    messages: await count(
      connection,
      sql`select count(*)::int as count from app.messages where channel_id = ${channelId}::uuid`
    ),
    rosterRows: await count(
      connection,
      sql`select count(*)::int as count from ${channelParticipants} where channel_id = ${channelId}::uuid and workspace_id = ${workspaceId}::uuid`
    ),
    version: await count(
      connection,
      sql`select version::int as count from app.channels where id = ${channelId}::uuid`
    ),
  }
}

function channelUpdatedEvent(channelId: string): WorkspaceEventView {
  return {
    actor: null,
    aggregateId: channelId,
    aggregateType: 'channel',
    correlationId: null,
    eventId: crypto.randomUUID(),
    eventType: 'channel.updated',
    occurredAt: new Date('2026-01-05T00:00:00.000Z'),
    payload: { channelId },
    schemaVersion: 1,
    workspaceSequence: 1,
  }
}

const OBSERVED_AT = '2026-01-05T00:00:00.000Z'

/**
 * Every product handler a stale legacy audience member can reach on the shared group, run as that
 * member with workspace membership restored, so the only thing left to refuse them is the group's
 * canonical admission. Refusals are values; every refused write is checked for zero footprint.
 */
async function probeStaleAudience(
  connection: DatabaseConnection,
  fixture: Fixture,
  stale: Principal
) {
  const { db } = connection
  const { workspaceId, sharedChannelId: channelId } = fixture
  const read = {
    channel: await settle(() => getChannelForUser(db, workspaceId, channelId, stale)),
    channels: ids(await view(() => listChannelsForUser(db, workspaceId, stale))),
    messages: await settle(() => listMessagesForUser(db, workspaceId, channelId, stale)),
    message: await settle(() => getMessageForUser(db, workspaceId, fixture.memberMessageId, stale)),
    inbox: (await accountConversationInbox(db, stale)).conversations.map((entry) => entry.id),
    readState: (await listReadStateForUser(db, workspaceId, stale)).map((entry) => entry.channelId),
    unreadChannels: (await accountWorkspaceSummaries(db, stale)).find(
      (row) => row.workspaceId === workspaceId
    )?.unreadChannels,
    searchChannels: (
      await searchWorkspaceForUser(db, workspaceId, stale, 'Shared rehearsal channel')
    ).results.filter((hit) => hit.kind === 'channel'),
    searchMessages: (
      await searchWorkspaceForUser(db, workspaceId, stale, 'rehearsal-shared-body')
    ).results.filter((hit) => hit.kind === 'message'),
    events: (
      await classifyWorkspaceEventsForUser(db, workspaceId, stale.userId, [
        channelUpdatedEvent(channelId),
      ])
    )?.[0]?.kind,
  }
  const footprintBefore = await writeFootprint(connection, fixture)
  const version = footprintBefore.version
  const append = {
    create: await settle(() =>
      createMessage(db, workspaceId, channelId, stale, {
        bodyText: 'stale append through the legacy writer',
        idempotencyKey: `stale-create-${crypto.randomUUID()}`,
        sender: { kind: 'user', userId: stale.userId },
      })
    ),
    post: await settle(() =>
      postGroupChannelMessage(db, workspaceId, channelId, stale, stale, {
        message: {
          bodyText: 'stale canonical post',
          idempotencyKey: `stale-post-${crypto.randomUUID()}`,
        },
        mode: 'direct',
      })
    ),
    rename: await settle(() =>
      updateChannel(
        db,
        workspaceId,
        channelId,
        stale,
        { title: 'renamed by stale audience' },
        version
      )
    ),
    archive: await settle(() => archiveChannel(db, workspaceId, channelId, stale, version)),
  }
  const current = await getChannelForUser(db, workspaceId, channelId, fixture.owner)
  const rejoin = await setChannelParticipants(
    db,
    workspaceId,
    channelId,
    fixture.owner,
    [
      { kind: 'user', userId: fixture.owner.userId },
      { kind: 'user', userId: fixture.member.userId },
      { kind: 'user', userId: stale.userId },
    ],
    current.version
  ).then(
    () => 'written',
    (error: unknown) => messageChain(error)
  )
  return {
    read,
    append,
    rejoin,
    footprintBefore,
    footprintAfter: await writeFootprint(connection, fixture),
    admission: await loadGroupAdmission(db, workspaceId, channelId, {
      kind: 'user',
      userId: stale.userId,
    }),
  }
}

/** The clean member's reads on the same channel: the positive control for every refusal above. */
async function probeCleanMember(connection: DatabaseConnection, fixture: Fixture) {
  const { db } = connection
  const { workspaceId, sharedChannelId: channelId, member } = fixture
  return {
    channel: await settle(() => getChannelForUser(db, workspaceId, channelId, member)),
    channels: ids(await view(() => listChannelsForUser(db, workspaceId, member))),
    messages: await settle(() => listMessagesForUser(db, workspaceId, channelId, member)),
    message: await settle(() =>
      getMessageForUser(db, workspaceId, fixture.memberMessageId, member)
    ),
    inbox: (await accountConversationInbox(db, member)).conversations.map((entry) => entry.id),
    searchMessages: (
      await searchWorkspaceForUser(db, workspaceId, member, 'rehearsal-shared-body')
    ).results.filter((hit) => hit.kind === 'message'),
    events: (
      await classifyWorkspaceEventsForUser(db, workspaceId, member.userId, [
        channelUpdatedEvent(channelId),
      ])
    )?.[0]?.kind,
    admission: await loadGroupAdmission(db, workspaceId, channelId, {
      kind: 'user',
      userId: member.userId,
    }),
  }
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

  // Audience phase: the canonical admissions and grants the cutover created from the populated legacy
  // roster, the real 0050 backfill replayed on that populated data, the quarantine of the ambiguous
  // audience, and the product's answer to the principals it excludes.
  const groupDb = connection.db
  await installLegacyAudienceQuarantine(groupDb)
  const audienceState = async () => ({
    reconciliation: await reconcileLegacyAudience(groupDb),
    participants: await captureGroupAudienceParticipants(groupDb, fixture.workspaceId),
  })
  const audienceAtCutover = await audienceState()
  await replayCanonicalBackfill(groupDb)
  const audienceAfterReplay = await audienceState()
  const afterReplayCapture = await captureMigrationSnapshot(groupDb, {
    identity: identity('after-backfill-replay'),
    requestedDomains: COMPARED_FAMILIES,
  })
  const replayComparison = compareMigrationSnapshots({
    after: afterReplayCapture.document,
    before: after.document,
  })
  const quarantine = await quarantineLegacyAudience(groupDb, {
    observedAt: OBSERVED_AT,
    profile: legacyBackfillProfile(),
  })
  const audienceQuarantined = await audienceState()
  const quarantineRepeat = await quarantineLegacyAudience(groupDb, {
    observedAt: OBSERVED_AT,
    profile: legacyBackfillProfile(),
  })
  await replayCanonicalBackfill(groupDb)
  const audienceFinal = await audienceState()
  const finalCapture = await captureMigrationSnapshot(groupDb, {
    identity: identity('after-quarantine'),
    requestedDomains: COMPARED_FAMILIES,
  })
  const quarantineComparison = compareMigrationSnapshots({
    after: finalCapture.document,
    before: after.document,
  })
  // The departed user is re-invited, so only the canonical admission stands between them and the group.
  await groupDb
    .insert(workspaceMemberships)
    .values({ role: 'member', userId: fixture.removed.userId, workspaceId: fixture.workspaceId })
  const denial = await probeStaleAudience(connection, fixture, fixture.removed)
  const control = await probeCleanMember(connection, fixture)
  const audience = {
    atCutover: audienceAtCutover,
    afterReplay: audienceAfterReplay,
    replayComparison,
    quarantine,
    quarantined: audienceQuarantined,
    quarantineRepeat,
    final: audienceFinal,
    quarantineComparison,
    denial,
    control,
  }

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
    audience,
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
    const { before, typedBefore, fixture } = await runScenario()
    assertHistoricalEvidence(before.document, fixture)
    assertHistoricalEvidence(typedBefore.document, fixture)
    expect(before.document.sections).toEqual(typedBefore.document.sections)
    expect(Object.keys(before.document.sections).toSorted()).toEqual(
      [...COMPARED_FAMILIES].toSorted()
    )
  })

  test('the cutover applies the remaining journal entry and changes no captured record', async () => {
    const {
      cutover,
      journalLength,
      cutoverComparison,
      baselineReads,
      afterReads,
      before,
      after,
      again,
      fixture,
    } = await runScenario()
    assertHistoricalEvidence(before.document, fixture)
    assertHistoricalEvidence(after.document, fixture)
    assertHistoricalEvidence(again.document, fixture)
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
    expect(afterReads.owner.sharedMessages).toHaveLength(3)
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
    const {
      repeat,
      journalLength,
      repeatComparison,
      repeatReads,
      afterReads,
      again,
      after,
      before,
      fixture,
    } = await runScenario()
    assertHistoricalEvidence(before.document, fixture)
    assertHistoricalEvidence(after.document, fixture)
    assertHistoricalEvidence(again.document, fixture)
    expect(after.document.sections.contentRefs).toEqual(before.document.sections.contentRefs)
    expect(again.document.sections.contentRefs).toEqual(after.document.sections.contentRefs)
    expect(after.document.sections.contentReplicas).toEqual(
      before.document.sections.contentReplicas
    )
    expect(again.document.sections.contentReplicas).toEqual(after.document.sections.contentReplicas)
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
    // UNRESOLVED acceptance item (not proven): the canonical backfill (0050) admits active groups
    // only, so this archived legacy group has no canonical admission and no owner standing. The
    // current expectation records that outcome; whether archived groups stay visible to their former
    // participants is a separate decision and is deliberately not settled here.
    expect(afterReads.owner.channels).not.toContain(fixture.archivedChannelId)
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

  test('the cutover admits the populated legacy roster exactly, and replaying the real 0050 backfill changes nothing', async () => {
    const { audience, fixture } = await runScenario()
    const channel = fixture.sharedChannelId
    const admitted = [
      `${channel}:agent:${fixture.foreignAgentId}`,
      `${channel}:user:${fixture.owner.userId}`,
      `${channel}:user:${fixture.member.userId}`,
      `${channel}:user:${fixture.removed.userId}`,
    ].toSorted()
    const grantKey = (userId: string) => `${channel}:user:${userId}:implicit:member:${userId}:1:`
    // Exact participants and grants. The canonical backfill is the only writer: it admits every active
    // legacy participant, including the two ambiguous ones, which is why the quarantine step exists.
    expect(audience.atCutover.participants).toEqual({
      admissions: admitted,
      audienceGrants: [
        grantKey(fixture.owner.userId),
        grantKey(fixture.member.userId),
        grantKey(fixture.removed.userId),
      ].toSorted(),
      enlistmentGrants: [
        `${channel}:agent:${fixture.foreignAgentId}:implicit:member:${fixture.foreignAgentId}:1:`,
      ],
    })
    // Six legacy roster rows, two admissible; the other four are not yet recorded as ambiguous.
    expect(audience.atCutover.reconciliation).toMatchObject({
      sourceRows: 6,
      admissibleRows: 2,
      quarantined: 0,
      admissions: 4,
      audienceGrants: 3,
      enlistmentGrants: 1,
      unrecordedClassifications: 4,
    })
    // Replaying the real 0050 statements on the populated data is a no-op: same rows, same digests.
    expect(audience.afterReplay).toEqual(audience.atCutover)
    // Families both sides prove stay equal to the cutover capture; the rest stay unknown.
    expect(audience.replayComparison.findings.map((finding) => finding.findingClass)).toEqual(
      UNPROVEN_FAMILIES.map(() => 'unknown_domain')
    )
    expect(audience.replayComparison.verdict).toBe('inconclusive')
  }, 300_000)

  test('the quarantine records exactly the ambiguous audiences, withdraws only their grants, and is idempotent', async () => {
    const { audience, fixture } = await runScenario()
    const channel = fixture.sharedChannelId
    expect(audience.quarantine).toEqual({
      recordedNow: 4,
      withdrawnNow: { admissions: 2, audienceGrants: 1, enlistmentGrants: 1 },
    })
    expect(audience.quarantined.reconciliation).toMatchObject({
      sourceRows: 6,
      admissibleRows: 2,
      quarantined: 4,
      quarantinedByReason: {
        group_channel_not_active: 2,
        user_not_workspace_member: 1,
        agent_workspace_mismatch: 1,
      },
      admissions: 2,
      audienceGrants: 2,
      enlistmentGrants: 0,
      unrecordedClassifications: 0,
      invariants: {
        admissionsEqualAdmissible: true,
        admissionsPlusQuarantinedEqualSource: true,
        quarantineCoversClassification: true,
      },
    })
    // Only the clean owner and member keep an admission; the removed user and foreign Agent are gone.
    expect(audience.quarantined.participants.admissions).toEqual(
      [
        `${channel}:user:${fixture.owner.userId}`,
        `${channel}:user:${fixture.member.userId}`,
      ].toSorted()
    )
    expect(audience.quarantined.participants.admissions).not.toContain(
      `${channel}:user:${fixture.removed.userId}`
    )
    expect(audience.quarantined.participants.enlistmentGrants).toEqual([])
    // The original legacy record is never edited: the source digest is identical at every stage.
    const digests = new Set(
      [audience.atCutover, audience.afterReplay, audience.quarantined, audience.final].map(
        (stage) => stage.reconciliation.sourceDigest
      )
    )
    expect(digests.size).toBe(1)
    // Repeating the quarantine records and withdraws nothing, and re-running the real backfill after it
    // does not resurrect a withdrawn admission or grant.
    expect(audience.quarantineRepeat).toEqual({
      recordedNow: 0,
      withdrawnNow: { admissions: 0, audienceGrants: 0, enlistmentGrants: 0 },
    })
    expect(audience.final).toEqual(audience.quarantined)
    expect(audience.quarantineComparison.findings.map((finding) => finding.findingClass)).toEqual(
      UNPROVEN_FAMILIES.map(() => 'unknown_domain')
    )
    expect(audience.quarantineComparison.verdict).toBe('inconclusive')
  }, 300_000)

  test('a quarantined principal gets no product access even after being re-added to the workspace', async () => {
    const { audience, fixture } = await runScenario()
    const { denial, control } = audience
    // Every read path refuses the removed user, or returns nothing and withholds events.
    expect(denial.read.channel).toEqual({ denied: 'Channel unavailable' })
    expect(denial.read.messages).toEqual({ denied: 'Channel unavailable' })
    expect(denial.read.message).toEqual({ denied: 'Channel unavailable' })
    expect(denial.read.channels).toEqual([])
    expect(denial.read.inbox).toEqual([])
    expect(denial.read.readState).toEqual([])
    expect(denial.read.unreadChannels).toBe(0)
    expect(denial.read.searchChannels).toEqual([])
    expect(denial.read.searchMessages).toEqual([])
    expect(denial.read.events).toBe('withheld')
    // Every write path refuses them too.
    for (const outcome of Object.values(denial.append)) {
      expect(outcome).toEqual({ denied: 'Channel unavailable' })
    }
    // The owner re-adding them to the roster cannot recreate the admission: the quarantine trigger refuses it by reason.
    expect(denial.rejoin).toContain('legacy audience is quarantined (user_not_workspace_member)')
    expect(denial.admission).toBeNull()
    // A refused write leaves messages, roster rows, admissions and the channel version untouched.
    expect(denial.footprintAfter).toEqual(denial.footprintBefore)
    // Positive control: the clean member, through the same paths, is served in full.
    expect(control.channels).toEqual([fixture.sharedChannelId])
    expect(control.inbox).toEqual([fixture.sharedChannelId])
    expect(control.events).toBe('deliver')
    expect(control.admission?.participant).toEqual({ kind: 'user', userId: fixture.member.userId })
    expect(control.admission?.grant.revokedAt).toBeNull()
  }, 300_000)

  test('inventory the audience comparison cannot prove is named and stays unknown', async () => {
    const { audience } = await runScenario()
    const replayComparison = audience.replayComparison
    // The group admission, grant and quarantine tables are not registered snapshot families, so the
    // cutover comparison cannot see them. Their exact participants and digests are asserted by the
    // dedicated reconciliation above; here the gap is pinned so a new family registration is noticed.
    const unregisteredAudienceTables = [
      'app.group_admissions',
      'app.group_audience_grants',
      'app.group_enlistment_grants',
      'app.legacy_audience_quarantine',
    ]
    for (const table of unregisteredAudienceTables) {
      const bare = table.split('.')[1]!.replaceAll(/_(\w)/g, (_, c: string) => c.toUpperCase())
      expect((migrationSnapshotFamilies as readonly string[]).includes(bare)).toBe(false)
    }
    expect(UNPROVEN_FAMILIES).toEqual(['artifactReferenceGrants', 'nativeSessions'])
    expect(
      replayComparison.findings.every((finding) => finding.findingClass === 'unknown_domain')
    ).toBe(true)
    expect(audience.atCutover.reconciliation.unrecordedClassifications).toBe(4)
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
