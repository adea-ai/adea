/**
 * #1222: the client surfaces a cutover must not change.
 *
 * The populated historical rehearsal proves the *data* is unchanged across the cutover and
 * that the quarantined principals lose the access the approved policy withdraws. It never
 * proves the *client* surfaces a legitimate reader already depends on: search, the inbox,
 * read state, the workspace unread summary and event visibility.
 *
 * A pre-0046 product read is impossible — the rehearsal's own baseline capture records the
 * product code as `unavailable` before 0046 — so both points of this qualification are taken
 * on the current schema: the first is the canonical state the cutover produced, the second is
 * that state after the legacy audience quarantine and a canonical backfill replay. The
 * legitimate member's surfaces must be identical across that interval, the outsider and the
 * collaborator must keep exactly the same denial, and the departed legacy participant must
 * keep the denial the workspace gate and the withdrawn admission give them. The compared
 * snapshot families must not move either.
 *
 * Test-only: no production code, no UI, no Pi runtime, no #1472 file, and no live data.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { and, asc, eq, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

import { accountConversationInbox } from '../../src/account-inbox'
import { accountWorkspaceSummaries } from '../../src/account-summary'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { classifyWorkspaceEventsForUser } from '../../src/event-visibility'
import type { WorkspaceEventView } from '../../src/event-log'
import { createTemporaryUserSession } from '../../src/identity'
import {
  captureMigrationSnapshot,
  type MigrationSnapshotCaptureIdentityInput,
} from '../../src/migration-snapshot-capture'
import { compareMigrationSnapshots } from '../../src/migration-snapshot-comparator'
import {
  captureLegacyMigrationSnapshot,
  LEGACY_MIGRATION_SNAPSHOT_VERSIONS,
} from '../../src/migration-snapshot-legacy'
import { listReadStateForUser } from '../../src/read-state'
import { searchWorkspaceForUser } from '../../src/search'
import {
  channelParticipants,
  messages as schemaMessages,
  workspaceMemberships,
} from '../../src/schema'
import { createWorkspaceWithOwner } from '../../src/workspaces'
import { migrationSnapshotFamilies } from '@adea-ai/types'
import {
  CUTOVER_TAG,
  DRIZZLE_DIR,
  disposeRehearsal,
  isProductDenial,
  migrationsFolderBefore,
  type RehearsalResources,
} from '../fixtures/cutover-rehearsal'
import {
  assertScratchDatabaseName,
  assertServerIdentity,
  canonicalTargetUrl,
  parseLocalDisposableTarget,
  type LocalDisposableTarget,
} from '../fixtures/migration-cutover-target'
import { assertAuthorizedMemberSearch } from '../fixtures/migration-cutover-surface-evidence'
import {
  legacyBackfillProfile,
  quarantineLegacyAudience,
  replayCanonicalBackfill,
} from '../fixtures/legacy-audience-quarantine'
import {
  insertLegacyGroup,
  insertLegacyMessageSequence,
  insertLegacyReadState,
} from '../fixtures/legacy-audience-seed'

// The families the legacy pre-0046 readers and the canonical capture both prove.
const COMPARED_FAMILIES = LEGACY_MIGRATION_SNAPSHOT_VERSIONS['pre-0046']!.capturedFamilies
// The families the compared scope does not cover: unknown on both sides, never empty.
const UNPROVEN_FAMILIES = migrationSnapshotFamilies.filter(
  (family) => !COMPARED_FAMILIES.includes(family)
)
const OBSERVED_AT = '2026-01-05T00:00:00.000Z'
const SCRATCH_PREFIX = 'rehearsal_1222_surface_'
const provisioningUrl = process.env.MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL
const inCi = process.env.CI === 'true' || process.env.CI === '1'

/**
 * The disposable target, validated before anything connects to it.
 *
 * The capture URL is inherited from the environment, so it is checked rather
 * than trusted: a loopback host, no startup or identity option, and no
 * duplicate or encoded parameter. An inherited URL that points anywhere else
 * is refused instead of used.
 */
function requireLocalDisposableTarget(): LocalDisposableTarget {
  if (!provisioningUrl) {
    throw new Error(
      'MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL is not set. In CI this means the Docker capture provisioning did not run, and this qualification refuses to skip silently.'
    )
  }
  return parseLocalDisposableTarget(provisioningUrl)
}

let disposableTarget: LocalDisposableTarget | undefined

function target(): LocalDisposableTarget {
  disposableTarget ??= requireLocalDisposableTarget()
  return disposableTarget
}

function urlForDatabase(database: string): string {
  return canonicalTargetUrl(target(), database)
}

function assertScratch(database: string): void {
  assertScratchDatabaseName(database, SCRATCH_PREFIX)
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
type PrincipalName = 'member' | 'outsider' | 'collaborator' | 'removed'

type Fixture = {
  workspaceId: string
  sharedChannelId: string
  /** The exact messages the fixture seeded, so the search control can name them. */
  messageIds: string[]
  member: Principal
  outsider: Principal
  collaborator: Principal
  removed: Principal
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

async function seedLegacySurfaceFixture(connection: DatabaseConnection): Promise<Fixture> {
  const suffix = crypto.randomUUID()
  const expiresAt = new Date(Date.now() + 600_000)
  const session = async (name: string) =>
    (
      await createTemporaryUserSession(connection.db, {
        credentialDigest: `surface-${name}-${suffix}`,
        expiresAt,
      })
    ).principal
  const member = await session('member')
  const collaborator = await session('collaborator')
  const outsider = await session('outsider')
  const removed = await session('removed')
  const owner = await session('owner')

  const { workspace } = await createWorkspaceWithOwner(connection.db, {
    idempotencyKey: `surface-${suffix}`,
    name: 'Surface rehearsal HQ',
    owner,
  })
  const workspaceId = workspace.id
  await connection.db.insert(workspaceMemberships).values([
    { role: 'member', userId: member.userId, workspaceId },
    { role: 'member', userId: collaborator.userId, workspaceId },
    { role: 'member', userId: removed.userId, workspaceId },
  ])
  const sharedId = await insertLegacyGroup(
    connection.db,
    workspaceId,
    owner,
    'Shared rehearsal channel'
  )
  let latest = 0
  for (const body of ['rehearsal-shared-body-1', 'rehearsal-shared-body-2']) {
    latest = await insertLegacyMessageSequence(connection.db, {
      bodyText: body,
      channelId: sharedId,
      sender: owner,
      workspaceId,
    })
  }
  // The exact seeded messages, so the search positive control can name them
  // instead of counting results.
  const seeded = await connection.db
    .select({ id: schemaMessages.id })
    .from(schemaMessages)
    .where(eq(schemaMessages.workspaceId, workspaceId))
    .orderBy(asc(schemaMessages.sequence))
  // The member is one message behind, so the unread summary has a value to prove.
  await insertLegacyReadState(connection.db, {
    channelId: sharedId,
    lastReadSequence: Math.max(1, latest - 1),
    userId: member.userId,
    workspaceId,
  })
  await insertLegacyReadState(connection.db, {
    channelId: sharedId,
    lastReadSequence: Math.max(1, latest - 1),
    userId: removed.userId,
    workspaceId,
  })
  // The legacy audience: the clean member and the participant who has since left
  // the workspace. The collaborator and the outsider are never participants.
  await connection.db.insert(channelParticipants).values([
    { channelId: sharedId, principalKind: 'user', userId: member.userId, workspaceId },
    { channelId: sharedId, principalKind: 'user', userId: removed.userId, workspaceId },
  ])
  // The departed participant leaves the workspace: only the canonical admission
  // can stand between them and the group afterwards.
  await connection.db
    .delete(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.userId, removed.userId),
        eq(workspaceMemberships.workspaceId, workspaceId)
      )
    )
  return {
    workspaceId,
    sharedChannelId: sharedId,
    messageIds: seeded.map((row) => row.id),
    member,
    outsider,
    collaborator,
    removed,
  }
}

/**
 * The canonical read progress of one channel, as the public read-state contract
 * returns it: the read cursor, the latest top-level sequence, the unread
 * counts and the per-thread cursors. Projecting only the channel id would let
 * a drifted cursor pass as equality.
 */
type ReadStateProjection = {
  channelId: string
  lastReadSequence: number
  latestTopLevelSequence: number
  topLevelUnreadCount: number
  threadUnreadCount: number
  manuallyUnread: boolean
  unread: boolean
  threads: readonly {
    threadRootMessageId: string
    lastReadSequence: number
    latestSequence: number
    unreadCount: number
    manuallyUnread: boolean
  }[]
}

type SurfaceRead = {
  searchChannels: string[] | 'denied'
  searchMessages: string[] | 'denied'
  inbox: string[] | 'denied'
  readState: ReadStateProjection[] | 'denied'
  unreadChannels: number | 'denied'
  events: string | 'denied'
}

/**
 * One client read. A product denial becomes the value `denied`; any other
 * failure propagates, so a broken read is never mistaken for a denial.
 */
async function readSurface<T>(read: () => Promise<T>): Promise<T | 'denied'> {
  try {
    return await read()
  } catch (error) {
    if (
      isProductDenial(error) ||
      (error instanceof Error && error.message === 'Search unavailable')
    )
      return 'denied'
    throw error
  }
}

/** The five client surfaces a legitimate reader depends on, for one principal. */
async function captureSurfaces(
  connection: DatabaseConnection,
  fixture: Fixture,
  principal: Principal
): Promise<SurfaceRead> {
  const { db } = connection
  const { workspaceId, sharedChannelId } = fixture
  const search = await readSurface(() =>
    searchWorkspaceForUser(db, workspaceId, principal, 'rehearsal-shared-body')
  )
  const inbox = await readSurface(() => accountConversationInbox(db, principal))
  const readState = await readSurface(() => listReadStateForUser(db, workspaceId, principal))
  const summaries = await readSurface(() => accountWorkspaceSummaries(db, principal))
  const events = await readSurface(() =>
    classifyWorkspaceEventsForUser(db, workspaceId, principal.userId, [
      channelUpdatedEvent(sharedChannelId),
    ])
  )
  // Each surface keeps its own outcome: a denied read is never reported as an
  // empty result, and an empty result is never reported as a denial.
  return {
    searchChannels:
      search === 'denied'
        ? 'denied'
        : search.results
            .filter((hit) => hit.kind === 'channel')
            .map((hit) => hit.id)
            .toSorted(),
    searchMessages:
      search === 'denied'
        ? 'denied'
        : search.results
            .flatMap((hit) => (hit.kind === 'message' && hit.messageId ? [hit.messageId] : []))
            .toSorted(),
    inbox: inbox === 'denied' ? 'denied' : inbox.conversations.map((entry) => entry.id).toSorted(),
    readState:
      readState === 'denied'
        ? 'denied'
        : readState
            .map((entry) => ({
              channelId: entry.channelId,
              lastReadSequence: entry.lastReadSequence,
              latestTopLevelSequence: entry.latestTopLevelSequence,
              topLevelUnreadCount: entry.topLevelUnreadCount,
              threadUnreadCount: entry.threadUnreadCount,
              manuallyUnread: entry.manuallyUnread,
              unread: entry.unread,
              threads: entry.threads
                .map((thread) => ({
                  threadRootMessageId: thread.threadRootMessageId,
                  lastReadSequence: thread.lastReadSequence,
                  latestSequence: thread.latestSequence,
                  unreadCount: thread.unreadCount,
                  manuallyUnread: thread.manuallyUnread,
                }))
                .toSorted((left, right) =>
                  left.threadRootMessageId < right.threadRootMessageId
                    ? -1
                    : left.threadRootMessageId > right.threadRootMessageId
                      ? 1
                      : 0
                ),
            }))
            .toSorted((left, right) =>
              left.channelId < right.channelId ? -1 : left.channelId > right.channelId ? 1 : 0
            ),
    unreadChannels:
      summaries === 'denied'
        ? 'denied'
        : (summaries.find((row) => row.workspaceId === workspaceId)?.unreadChannels ?? 0),
    events: events === 'denied' ? 'denied' : (events?.[0]?.kind ?? 'none'),
  }
}

type Surfaces = Record<PrincipalName, SurfaceRead>

async function captureAllSurfaces(
  connection: DatabaseConnection,
  fixture: Fixture
): Promise<Surfaces> {
  return {
    member: await captureSurfaces(connection, fixture, fixture.member),
    outsider: await captureSurfaces(connection, fixture, fixture.outsider),
    collaborator: await captureSurfaces(connection, fixture, fixture.collaborator),
    removed: await captureSurfaces(connection, fixture, fixture.removed),
  }
}

const identity = (snapshotId: string): MigrationSnapshotCaptureIdentityInput => ({
  capturedAt: new Date(OBSERVED_AT),
  rehearsalId: 'rehearsal-surface-1222',
  snapshotId,
  source: 'integration',
})

type Scenario = {
  before: Awaited<ReturnType<typeof captureAllSurfaces>>
  after: Awaited<ReturnType<typeof captureAllSurfaces>>
  cutoverComparison: ReturnType<typeof compareMigrationSnapshots>
  phaseComparison: ReturnType<typeof compareMigrationSnapshots>
  fixture: Fixture
}

const resources: RehearsalResources = {}
let captureConnection: DatabaseConnection | undefined
let scenario: Promise<Scenario> | undefined

async function executeScenario(): Promise<Scenario> {
  const disposable = requireLocalDisposableTarget()
  const scratch = `${SCRATCH_PREFIX}${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`
  assertScratch(scratch)
  resources.scratch = scratch
  await adminExecute(`create database "${scratch}"`)
  const connection = createDatabase(urlForDatabase(scratch))
  resources.connection = connection
  captureConnection = connection
  resources.preFolder = migrationsFolderBefore(CUTOVER_TAG)
  // The server's own identity is confirmed before anything is migrated: an
  // instance that answers on another database or user is refused instead of
  // written to. A failure here leaves the scratch database to the cleanup.
  await assertServerIdentity(connection.db, {
    database: scratch,
    user: disposable.user,
  })

  // The populated pre-0046 database: the legacy state a cutover starts from.
  await migrate(connection.db, { migrationsFolder: resources.preFolder })
  const fixture = await seedLegacySurfaceFixture(connection)
  const legacy = await captureLegacyMigrationSnapshot(connection.db, {
    identity: identity('before'),
    versionId: 'pre-0046',
  })

  // The cutover: the remaining journal entries, applied unchanged.
  await migrate(connection.db, { migrationsFolder: DRIZZLE_DIR })
  const after = await captureMigrationSnapshot(connection.db, {
    identity: identity('after'),
    requestedDomains: COMPARED_FAMILIES,
  })
  const cutoverComparison = compareMigrationSnapshots({
    after: after.document,
    before: legacy.document,
  })

  // The first client observation: the canonical state the cutover produced.
  const before = await captureAllSurfaces(connection, fixture)

  // The cutover's ambiguity resolution: the legacy audience quarantine, repeated
  // to prove it is idempotent, and a canonical backfill replay to prove the
  // replay does not restore anything.
  await quarantineLegacyAudience(connection.db, {
    observedAt: OBSERVED_AT,
    profile: legacyBackfillProfile(),
  })
  await quarantineLegacyAudience(connection.db, {
    observedAt: OBSERVED_AT,
    profile: legacyBackfillProfile(),
  })
  await replayCanonicalBackfill(connection.db)
  const final = await captureMigrationSnapshot(connection.db, {
    identity: identity('after-quarantine'),
    requestedDomains: COMPARED_FAMILIES,
  })
  const phaseComparison = compareMigrationSnapshots({
    after: final.document,
    before: after.document,
  })
  const afterSurfaces = await captureAllSurfaces(connection, fixture)
  return { before, after: afterSurfaces, cutoverComparison, phaseComparison, fixture }
}

function runScenario(): Promise<Scenario> {
  scenario ??= executeScenario()
  return scenario
}

describe.skipIf(!provisioningUrl && !inCi)(
  'migration cutover: the client surfaces a legitimate reader depends on',
  () => {
    beforeAll(async () => {
      await runScenario()
    }, 300_000)

    afterAll(async () => {
      await settleScenario()
    }, 60_000)

    test('the authorized member sees the same surfaces before and after the ambiguity resolution', async () => {
      const { before, after, fixture } = await runScenario()
      // A positive control first: an empty or denied capture would make the
      // equality below vacuous. The control names the exact seeded messages and
      // rejects the denial sentinel, which is a string and would otherwise
      // count as six results.
      assertAuthorizedMemberSearch(before.member, fixture.messageIds)
      expect(before.member.inbox).toContain(fixture.sharedChannelId)
      expect(before.member.events).toBe('deliver')
      // The read progress is narrowed here: a denied read is not an empty one.
      const memberReadState = before.member.readState
      if (memberReadState === 'denied') {
        throw new Error('the member read state was denied; the positive control cannot hold')
      }
      expect(memberReadState.map((entry) => entry.channelId)).toContain(fixture.sharedChannelId)
      // The fixture leaves the member exactly one message behind, so the unread
      // count is a real one. An always-zero projection would pass an equality
      // check that proves nothing, so the expected count is pinned here.
      expect(before.member.unreadChannels).toBe(1)
      // The read cursor is part of the projection: the member is behind the
      // channel's latest top-level sequence.
      expect(memberReadState[0]?.lastReadSequence).toBeGreaterThan(0)
      expect(memberReadState[0]?.latestTopLevelSequence).toBe(
        (memberReadState[0]?.lastReadSequence ?? 0) + 1
      )
      expect(memberReadState[0]?.topLevelUnreadCount).toBe(1)
      expect(after.member).toEqual(before.member)
    }, 300_000)

    test('the outsider and the collaborator keep exactly the same denial', async () => {
      const { before, after } = await runScenario()
      // The outsider has no workspace access: the search and the read state
      // refuse them, and the inbox has nothing for them.
      expect(before.outsider.searchMessages).toEqual('denied')
      expect(before.outsider.inbox).toEqual([])
      expect(before.outsider.readState).toEqual('denied')
      expect(before.outsider.events).toBe('none')
      // The collaborator is a member but never a participant: the group stays
      // unreadable to them, and the event is withheld rather than delivered.
      expect(before.collaborator.searchMessages).toEqual([])
      expect(before.collaborator.inbox).toEqual([])
      expect(before.collaborator.readState).toEqual([])
      expect(before.collaborator.events).toBe('withheld')
      expect(after.outsider).toEqual(before.outsider)
      expect(after.collaborator).toEqual(before.collaborator)
    }, 300_000)

    test('the departed legacy participant keeps the denial the workspace gate gives them', async () => {
      const { before, after } = await runScenario()
      // The participant left the workspace before the cutover, so the client
      // already refused them; the cutover must not change what they see.
      expect(before.removed.searchMessages).toEqual('denied')
      expect(before.removed.inbox).toEqual([])
      expect(before.removed.readState).toEqual('denied')
      expect(before.removed.events).toBe('none')
      expect(after.removed).toEqual(before.removed)
    }, 300_000)

    test('a drifted read cursor is detected instead of passing as equality', async () => {
      const { fixture } = await runScenario()
      const connection = captureConnection
      if (!connection) throw new Error('the disposable capture database is not open')
      const before = await captureSurfaces(connection, fixture, fixture.member)
      if (before.readState === 'denied') throw new Error('the member read state was denied')
      const cursor = before.readState[0]?.lastReadSequence ?? 0
      // Advance the member's read cursor by one message. The canonical read
      // progress drifts, so the projection must show the drift instead of the
      // equality check passing on an unchanged cursor.
      const advanced = await connection.db.execute(sql`
        UPDATE app.channel_read_states
        SET last_read_sequence = last_read_sequence + 1
        WHERE workspace_id = ${fixture.workspaceId}::uuid
          AND user_id = ${fixture.member.userId}::uuid
          AND channel_id = ${fixture.sharedChannelId}::uuid
        RETURNING last_read_sequence
      `)
      expect(advanced.length).toBe(1)
      const after = await captureSurfaces(connection, fixture, fixture.member)
      if (after.readState === 'denied') throw new Error('the member read state was denied')
      expect(after.readState).not.toEqual(before.readState)
      expect(after.readState[0]?.lastReadSequence).toBe(cursor + 1)
      // Restore the fixture's read progress so the disposable database is left
      // exactly as the scenario found it.
      await connection.db.execute(sql`
        UPDATE app.channel_read_states
        SET last_read_sequence = ${cursor}
        WHERE workspace_id = ${fixture.workspaceId}::uuid
          AND user_id = ${fixture.member.userId}::uuid
          AND channel_id = ${fixture.sharedChannelId}::uuid
      `)
      const restored = await captureSurfaces(connection, fixture, fixture.member)
      if (restored.readState === 'denied') throw new Error('the member read state was denied')
      expect(restored.readState).toEqual(before.readState)
    }, 300_000)

    test('the compared snapshot families do not move across the cutover or the ambiguity resolution', async () => {
      const { cutoverComparison, phaseComparison } = await runScenario()
      // The families outside the compared scope are unknown on both sides, so the
      // verdict is inconclusive; no family both sides prove may diverge.
      for (const comparison of [cutoverComparison, phaseComparison]) {
        expect(
          comparison.findings.filter((finding) => finding.findingClass !== 'unknown_domain')
        ).toEqual([])
        expect(comparison.findings.map((finding) => finding.family).toSorted()).toEqual(
          UNPROVEN_FAMILIES.toSorted()
        )
        expect(comparison.verdict).toBe('inconclusive')
      }
    }, 300_000)
  }
)

async function settleScenario(): Promise<void> {
  const pending = scenario
  if (!pending) return
  try {
    await pending
  } catch {
    // A scenario failure is reported by the tests that read it.
  }
  await disposeRehearsal(resources, async (database) => {
    assertScratch(database)
    await adminExecute(`drop database if exists "${database}"`)
  })
}
