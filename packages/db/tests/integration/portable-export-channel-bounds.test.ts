import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomBytes, randomUUID } from 'node:crypto'

import {
  PORTABLE_WORKSPACE_EXPORT_MAX_MESSAGE_TEXT_LENGTH,
  PORTABLE_WORKSPACE_EXPORT_MAX_BYTES,
  PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS,
  portableJsonUtf8ByteLength,
} from '@adea-ai/types/portable-export'
import type { ChannelSummary } from '@adea-ai/types'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import type { AgentHqDatabase } from '../../src/connection'
import { listChannelIdsForUser, listChannelsForUserPage } from '../../src/conversations'
import { createTemporaryUserSession } from '../../src/identity'
import { exportPortableWorkspace } from '../../src/portable-export'
import { PortableExportError } from '../../src/portable-export-content'
import { createProject } from '../../src/projects'
import { setProjectMember, setProjectVisibility } from '../../src/project-sharing'
import {
  agents,
  channelParticipants,
  channels,
  messages,
  tasks,
  temporaryUserSessions,
  users,
  workspaces,
  workspaceMemberships,
} from '../../src/schema'
import { addWorkspaceMembership, createWorkspaceWithOwner } from '../../src/workspaces'
import * as schema from '../../src/schema'

const connectionUrl = process.env.DATABASE_URL
const run = randomBytes(6).toString('hex')
const CHANNEL_PAGE_SIZE = 256
const MIN_EXPECTED_CHANNEL_PAGE_SIZE = 100
const MAX_CHANNEL_QUERY_ROWS = CHANNEL_PAGE_SIZE + 1
const PARTICIPANT_BATCH_ROW_LIMIT = PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS
const MAX_PARTICIPANT_QUERY_ROWS = PARTICIPANT_BATCH_ROW_LIMIT + 1
const MAX_EXPORT_QUERY_COUNT = 512
const HIDDEN_CHANNELS = 64
const HEAVY_PARTICIPANTS = 64
const HEAVY_SCALE_CHANNELS = 157

/**
 * `channels.id` is a global primary key, not a per-workspace one, so a fixture that reuses a fixed
 * id collides with the row an interrupted or concurrent run left behind in the same database. A
 * run of this file that was interrupted before its cleanup, or two runs of this file against one
 * shared lane database, both produce exactly that: `23505 duplicate channels_pkey`.
 *
 * Every channel fixture id below is therefore scoped to this run's marker, and each fixture gets
 * its own index inside that id, so two fixtures of one run cannot share a primary key either. The
 * three id families the file used before are kept here as the regression's subject: this run has to
 * survive finding them still in the database, because that is the condition a leftover row creates.
 *
 * The three families are the ones the file used before the repair: the late-project channel, the
 * participant-boundary channel, and the heavy visible scale range. The scale range wrote one id
 * per row, so a leftover row carries whichever member of the range it was, and the first member is
 * the one planted below.
 */
const LEGACY_LATE_PROJECT_CHANNEL_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const LEGACY_BOUNDARY_CHANNEL_ID = '00000000-0000-4000-8000-000000000000'
const LEGACY_SCALE_CHANNEL_ID = '00000000-0000-4000-8000-000000000001'

/**
 * The identifier shape the file's fixtures have always had, with the run marker in place of the
 * constant part and the fixture's own index in the last group. The shape is not cosmetic: the
 * channel page cursor is the channel id and the participant reads are ordered by channel id, so
 * the *order* of these identifiers decides which channels a reader meets first, where the
 * participant-row bound splits a batch, and which page first exceeds that bound. The low family
 * keeps the leading `00000000` group and the high family the trailing `ffffffff` group for exactly
 * that reason.
 */
const runScopedLowChannelId = (index: number) =>
  `00000000-4${index.toString(16).padStart(3, '0')}-8000-0000-${run}`

const runScopedHighChannelId = () => `ffffffff-ffff-4fff-8fff-${run}`

/**
 * The late-project channel of the mid-export case, scoped to this run. It keeps the highest
 * identifier of the workspace, the position it has always had.
 */
const lateProjectChannelId = () => runScopedHighChannelId()

/**
 * The participant-boundary channel of the 10,000-participant case, scoped to this run. It keeps
 * the lowest identifier of the workspace, the position it has always had: the export has to meet
 * that channel on its first page to refuse on the participant bound before it reads any
 * participant row.
 */
const participantBoundaryChannelId = () => runScopedLowChannelId(0)

/**
 * The heavy visible scale channel of the given index, scoped to this run. The scale rows keep the
 * lowest identifiers of the workspace and their order among themselves, so the participant-row
 * bound still splits a page at the same place.
 */
const heavyVisibleChannelId = (index: number) => runScopedLowChannelId(index + 1)

/**
 * The legacy channel ids are fixed and global, so the regression that plants them is the one place
 * two runs of this file can still meet. Planting with `onConflictDoNothing` and reading the rows
 * back is not safe on its own: a concurrent run B that finds run A's rows asserts on A's rows, and
 * A's teardown then removes them under B. The seed therefore has a lifetime of its own.
 *
 * `withLegacyChannelSeed` holds one session-level PostgreSQL advisory lock for the whole lifetime
 * of the seed: acquire, plant, assert, remove, release. A second run waits for the first to be
 * finished before it plants, so it plants its own rows and asserts on them. The rows it removes
 * are exactly the ones its own insert returned. A row that was already there (a leftover from an
 * interrupted run, which is the condition under test) is left in place, and so is every row that
 * belongs to anyone else. The presence assertions stay in the caller, unweakened.
 *
 * Only runs of this file that go through this helper are serialized. A run of the pre-repair
 * fixture, or any other writer of these ids, is outside what a lock this file takes can protect.
 */
const LEGACY_SEED_LOCK_NAME = 'portable-export-channel-bounds:legacy-channel-seed'
const LEGACY_SEED_LOCK_WAIT_MS = 120_000
const LEGACY_SEED_LOCK_POLL_MS = 50

type ChannelSeed = typeof channels.$inferInsert

async function withLegacyChannelSeed<T>(
  options: {
    client: postgres.Sql
    database: AgentHqDatabase
    lockName?: string
    rows: readonly ChannelSeed[]
    waitMs?: number
  },
  body: (seed: { insertedIds: readonly string[]; preexistingIds: readonly string[] }) => Promise<T>
): Promise<T> {
  const lockName = options.lockName ?? LEGACY_SEED_LOCK_NAME
  const deadline = Date.now() + (options.waitMs ?? LEGACY_SEED_LOCK_WAIT_MS)
  // The lock is session-level, so it is taken and released on one reserved connection.
  const reserved = await options.client.reserve()
  let locked = false
  try {
    while (!locked) {
      const [row] = await reserved<
        { locked: boolean }[]
      >`select pg_try_advisory_lock(hashtextextended(${lockName}::text, 0)) as locked`
      locked = row?.locked === true
      if (locked) break
      if (Date.now() >= deadline)
        throw new Error(`timed out waiting for the legacy channel seed lock ${lockName}`)
      await new Promise((resolve) => setTimeout(resolve, LEGACY_SEED_LOCK_POLL_MS))
    }
    const wanted = options.rows.map(({ id }) => id!)
    const inserted = await options.database
      .insert(channels)
      .values([...options.rows])
      .onConflictDoNothing()
      .returning({ id: channels.id })
    const insertedIds = inserted.map(({ id }) => id)
    try {
      return await body({
        insertedIds,
        preexistingIds: wanted.filter((id) => !insertedIds.includes(id)),
      })
    } finally {
      if (insertedIds.length > 0)
        await options.database.delete(channels).where(inArray(channels.id, insertedIds))
    }
  } finally {
    try {
      if (locked) await reserved`select pg_advisory_unlock(hashtextextended(${lockName}::text, 0))`
    } finally {
      reserved.release()
    }
  }
}

/**
 * Fails when the named advisory lock is held by any session. It takes the lock itself on a
 * connection of its own, so a lock a caller forgot to release is a failure here, not a hang.
 */
async function assertAdvisoryLockFree(client: postgres.Sql, lockName: string) {
  const probe = await client.reserve()
  try {
    const [row] = await probe<
      { locked: boolean }[]
    >`select pg_try_advisory_lock(hashtextextended(${lockName}::text, 0)) as locked`
    if (row?.locked !== true) throw new Error(`advisory lock ${lockName} is still held`)
    await probe`select pg_advisory_unlock(hashtextextended(${lockName}::text, 0))`
  } finally {
    probe.release()
  }
}

/**
 * Runs a scenario that starts callers, and settles every caller it started before the teardown
 * deletes anything, whether the scenario passed, failed, or abandoned a caller by throwing before
 * it awaited it. Each started caller gets a rejection observer the moment it starts, so none can
 * become an unhandled rejection, and the original promise is kept to be settled later.
 *
 * The scenario's own failure is the primary error. A rejection of a started caller that is not
 * that same error, and a failing teardown, are cleanup errors. When both kinds exist they are
 * reported together, primary first, in one AggregateError; a lone primary is rethrown as it was.
 */
async function runWithSettledCallers(
  scenario: (start: <T>(caller: Promise<T>) => Promise<T>) => Promise<void>,
  teardown: () => Promise<void>
): Promise<void> {
  const started: Promise<unknown>[] = []
  const start = <T>(caller: Promise<T>): Promise<T> => {
    caller.catch(() => {})
    started.push(caller)
    return caller
  }
  let primary: unknown
  let failed = false
  try {
    await scenario(start)
  } catch (error) {
    primary = error
    failed = true
  }
  const cleanupErrors: unknown[] = []
  for (const result of await Promise.allSettled(started))
    if (result.status === 'rejected' && !(failed && result.reason === primary))
      cleanupErrors.push(result.reason)
  try {
    await teardown()
  } catch (error) {
    cleanupErrors.push(error)
  }
  if (failed) {
    if (cleanupErrors.length === 0) throw primary
    throw new AggregateError(
      [primary, ...cleanupErrors],
      'the scenario failed and so did its cleanup'
    )
  }
  if (cleanupErrors.length > 0)
    throw new AggregateError(cleanupErrors, 'the scenario cleanup failed')
}

const slowReject = (error: Error) =>
  new Promise<never>((_resolve, reject) => setTimeout(() => reject(error), 50))

type QueryTrace = {
  channelPageReads: number
  channelIdSnapshotReads: number
  channelReadsWithoutLimit: number
  maxChannelPageRows: number
  maxChannelSnapshotRows: number
  participantCountReads: number
  maxParticipantQueryParameters: number
  maxParticipantQueryRows: number
  participantReads: number
  participantReadBatchSizes: number[]
  participantRowsMaterialized: number
  maxParticipantRowsMaterializedPerPage: number
  participantReadChannelIds: string[]
  totalStatements: number
}

const emptyTrace = (): QueryTrace => ({
  channelPageReads: 0,
  channelIdSnapshotReads: 0,
  channelReadsWithoutLimit: 0,
  maxChannelPageRows: 0,
  maxChannelSnapshotRows: 0,
  participantCountReads: 0,
  maxParticipantQueryParameters: 0,
  maxParticipantQueryRows: 0,
  participantReads: 0,
  participantReadBatchSizes: [],
  participantRowsMaterialized: 0,
  maxParticipantRowsMaterializedPerPage: 0,
  participantReadChannelIds: [],
  totalStatements: 0,
})

const CHANNELS_FROM = /\bfrom\s+"app"\."channels"/iu
const CHANNEL_ID_SNAPSHOT = /^\s*select\s+"id"(?:,\s*"kind")?\s+from\s+"app"\."channels"/iu
const PARTICIPANTS_FROM = /\bfrom\s+"app"\."channel_participants"/iu
const UUID_VALUE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const PARTICIPANT_COUNT_QUERY = /\bcount\s*\(\s*\*\s*\)/iu

function queryLimit(query: string, parameters: unknown[]): number | undefined {
  const matches = [...query.matchAll(/\blimit\s+(\$\d+|\d+)/giu)]
  const match = matches.at(-1)
  if (!match) return undefined
  if (!match[1]!.startsWith('$')) return Number(match[1])
  const parameter = parameters[Number(match[1]!.slice(1)) - 1]
  const limit = Number(parameter)
  return Number.isSafeInteger(limit) ? limit : undefined
}

function traceSummary(trace: QueryTrace) {
  return {
    ...trace,
    participantReadChannelIds: `${trace.participantReadChannelIds.length} channel IDs recorded`,
  }
}

describe.skipIf(!connectionUrl)('portable export bounds channel materialization', () => {
  let client: ReturnType<typeof postgres>
  let db: AgentHqDatabase
  let workspaceId: string | undefined
  let ownerUserId: string | undefined
  const testUserIds: string[] = []
  let visibleControlChannelId: string
  let hiddenControlChannelId: string
  let agentIds: string[] = []
  let trace = emptyTrace()
  let traceEnabled = true

  async function insertBoundTask(title: string, objective: string): Promise<string> {
    const [task] = await db
      .insert(tasks)
      .values({ creatorUserId: ownerUserId!, objective, title, workspaceId: workspaceId! })
      .returning({ id: tasks.id })
    return task!.id
  }

  async function insertBoundMessage(bodyText: string, idempotencyKey: string): Promise<string> {
    const [message] = await db
      .insert(messages)
      .values({
        bodyText,
        channelId: visibleControlChannelId,
        createPayloadHash: 'b'.repeat(64),
        idempotencyKey,
        senderKind: 'user',
        senderUserId: ownerUserId!,
        workspaceId: workspaceId!,
      })
      .returning({ id: messages.id })
    return message!.id
  }

  beforeAll(async () => {
    client = postgres(connectionUrl!, {
      debug: (_connection, query, parameters) => {
        if (!traceEnabled) return
        trace.totalStatements += 1
        if (CHANNELS_FROM.test(query)) {
          const limit = queryLimit(query, parameters)
          if (limit === undefined) trace.channelReadsWithoutLimit += 1
          if (CHANNEL_ID_SNAPSHOT.test(query)) {
            trace.channelIdSnapshotReads += 1
            if (limit !== undefined)
              trace.maxChannelSnapshotRows = Math.max(trace.maxChannelSnapshotRows, limit)
          } else {
            trace.channelPageReads += 1
            if (limit !== undefined)
              trace.maxChannelPageRows = Math.max(trace.maxChannelPageRows, limit)
          }
        }
        const firstFrom = query.match(/\bfrom\s+"app"\."([^"]+)"/iu)?.[1]
        if (PARTICIPANTS_FROM.test(query) && firstFrom === 'channel_participants') {
          if (PARTICIPANT_COUNT_QUERY.test(query)) trace.participantCountReads += 1
          else {
            trace.participantReads += 1
            trace.maxParticipantQueryParameters = Math.max(
              trace.maxParticipantQueryParameters,
              parameters.length
            )
            const limit = queryLimit(query, parameters)
            if (limit !== undefined)
              trace.maxParticipantQueryRows = Math.max(trace.maxParticipantQueryRows, limit)
            const channelIds = parameters.filter(
              (parameter): parameter is string =>
                typeof parameter === 'string' &&
                UUID_VALUE.test(parameter) &&
                parameter !== workspaceId
            )
            trace.participantReadBatchSizes.push(channelIds.length)
            for (const channelId of channelIds)
              if (!trace.participantReadChannelIds.includes(channelId))
                trace.participantReadChannelIds.push(channelId)
          }
        }
      },
      max: 10,
      prepare: false,
    })
    db = drizzle(client, { schema })

    const owner = await createTemporaryUserSession(db, {
      credentialDigest: `portable-channel-bounds-${run}`,
      displayName: 'Channel Bounds Owner',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })
    ownerUserId = owner.principal.userId
    const created = await createWorkspaceWithOwner(db, {
      idempotencyKey: `portable-channel-bounds-${run}`,
      name: 'Channel bounds',
      owner: owner.principal,
    })
    workspaceId = created.workspace.id

    const agentsCreated = await db
      .insert(agents)
      .values(
        Array.from({ length: HEAVY_PARTICIPANTS }, (_, index) => ({
          name: `Channel participant ${index}`,
          profileId: 'profile.channel-bounds',
          profileVersion: '1.0.0',
          workspaceId,
        }))
      )
      .returning({ id: agents.id })
    agentIds = agentsCreated.map(({ id }) => id)

    visibleControlChannelId = randomUUID()
    hiddenControlChannelId = randomUUID()
    await db.insert(channels).values([
      {
        id: visibleControlChannelId,
        idempotencyKey: `portable-channel-visible-${run}`,
        agentId: agentIds[0]!,
        kind: 'direct_agent',
        sortOrder: 100,
        title: 'Visible control channel',
        visibility: 'workspace',
        workspaceId,
      },
      {
        id: hiddenControlChannelId,
        idempotencyKey: `portable-channel-hidden-${run}`,
        agentId: agentIds[0]!,
        kind: 'direct_agent',
        sortOrder: 0,
        title: 'Hidden participant-only control channel',
        visibility: 'participants',
        workspaceId,
      },
    ])
    await db.insert(channelParticipants).values(
      [visibleControlChannelId, hiddenControlChannelId].flatMap((channelId) =>
        agentIds.map((agentId) => ({
          agentId,
          channelId,
          principalKind: 'agent' as const,
          workspaceId,
        }))
      )
    )
    trace = emptyTrace()
  })

  afterAll(async () => {
    try {
      if (workspaceId) {
        await db.delete(channels).where(eq(channels.workspaceId, workspaceId))
        await db.delete(agents).where(eq(agents.workspaceId, workspaceId))
        await db
          .delete(workspaceMemberships)
          .where(eq(workspaceMemberships.workspaceId, workspaceId))
        await db.delete(workspaces).where(eq(workspaces.id, workspaceId))
      }
      if (ownerUserId) {
        await db.delete(temporaryUserSessions).where(eq(temporaryUserSessions.userId, ownerUserId))
        await db.delete(users).where(eq(users.id, ownerUserId))
      }
      for (const userId of testUserIds) {
        await db.delete(temporaryUserSessions).where(eq(temporaryUserSessions.userId, userId))
        await db.delete(users).where(eq(users.id, userId))
      }
    } finally {
      await client.end({ timeout: 5 })
    }
  }, 300_000)

  test('positive control filters hidden channels and preserves participant-heavy summaries', async () => {
    trace = emptyTrace()
    const document = await exportPortableWorkspace(db, {
      principal: { kind: 'user', userId: ownerUserId! },
      workspaceId: workspaceId!,
    })

    expect(document.content.channels.map(({ channelId }) => channelId)).toEqual([
      visibleControlChannelId,
    ])
    expect(document.content.channels[0]?.participants).toHaveLength(HEAVY_PARTICIPANTS)
    expect(
      document.content.channels.some(({ channelId }) => channelId === hiddenControlChannelId)
    ).toBe(false)
    expect(trace.totalStatements).toBeLessThan(100)
  })

  test('an agent name beyond the remaining read budget is withheld before transfer', async () => {
    const agentId = agentIds[0]!
    try {
      // Agent names have an index and cannot themselves exceed the database's
      // index tuple limit. Let the role summary consume nearly all of the
      // export budget, then make the name cross the remaining budget.
      await db
        .update(agents)
        .set({
          name: 'n'.repeat(4_096),
          roleSummary: 'r'.repeat(PORTABLE_WORKSPACE_EXPORT_MAX_BYTES - 1_024),
        })
        .where(eq(agents.id, agentId))
      const materialized: { nameJsonBytes: number; roleSummaryJsonBytes: number }[] = []
      const outcome = await exportPortableWorkspace(db, {
        hooks: { afterAgentPage: (page) => materialized.push(page) },
        principal: { kind: 'user', userId: ownerUserId! },
        workspaceId: workspaceId!,
      }).then(
        () => 'exported',
        (error: unknown) => (error instanceof PortableExportError ? error.code : 'other')
      )

      expect(outcome).toBe('too_large')
      expect(materialized).toHaveLength(1)
      expect(materialized[0]!.nameJsonBytes).toBeLessThan(4_096)
      expect(materialized[0]!.roleSummaryJsonBytes).toBeLessThan(4_096)
    } finally {
      await db
        .update(agents)
        .set({ name: 'Channel participant 0', roleSummary: null })
        .where(eq(agents.id, agentId))
    }
  }, 180_000)

  test('an oversized agent role summary is refused before its value is transferred to the Worker', async () => {
    const agentId = agentIds[0]!
    try {
      await db
        .update(agents)
        .set({
          name: 'Channel participant 0',
          roleSummary: 'r'.repeat(PORTABLE_WORKSPACE_EXPORT_MAX_BYTES + 1),
        })
        .where(eq(agents.id, agentId))
      const materialized: { nameJsonBytes: number; roleSummaryJsonBytes: number }[] = []
      const outcome = await exportPortableWorkspace(db, {
        hooks: { afterAgentPage: (page) => materialized.push(page) },
        principal: { kind: 'user', userId: ownerUserId! },
        workspaceId: workspaceId!,
      }).then(
        () => 'exported',
        (error: unknown) => (error instanceof PortableExportError ? error.code : 'other')
      )

      expect(outcome).toBe('too_large')
      expect(materialized).toHaveLength(1)
      expect(materialized[0]!.nameJsonBytes).toBeLessThan(4_096)
      expect(materialized[0]!.roleSummaryJsonBytes).toBeLessThan(4_096)
    } finally {
      await db
        .update(agents)
        .set({ name: 'Channel participant 0', roleSummary: null })
        .where(eq(agents.id, agentId))
    }
  }, 180_000)

  test('task titles and objectives preserve multibyte UTF-8 text without truncation', async () => {
    const title = '漢字🧪🚀'.repeat(50)
    const objective = 'Objective ' + '重要🛠️'.repeat(1_024)
    const taskId = await insertBoundTask(title, objective)
    const pageProjections: {
      objectiveJsonBytes: number
      textByteBudget: number
      titleJsonBytes: number
      withheldRows: number
    }[] = []
    try {
      const document = await exportPortableWorkspace(db, {
        hooks: { afterTaskPage: (page) => pageProjections.push(page) },
        principal: { kind: 'user', userId: ownerUserId! },
        workspaceId: workspaceId!,
      })
      const exportedTask = document.content.tasks.find((task) => task.taskId === taskId)

      expect(exportedTask?.title).toBe(title)
      expect(exportedTask?.objective).toBe(objective)
      expect(pageProjections).toHaveLength(1)
      expect(pageProjections[0]!.titleJsonBytes).toBe(portableJsonUtf8ByteLength(title))
      expect(pageProjections[0]!.objectiveJsonBytes).toBe(portableJsonUtf8ByteLength(objective))
      expect(pageProjections[0]!.withheldRows).toBe(0)
    } finally {
      await db.delete(tasks).where(eq(tasks.id, taskId))
    }
  })

  test('task text at the exact and near byte boundary is complete; one over-budget row is refused', async () => {
    const title = 'Boundary task'
    const longObjective = 'x'.repeat(PORTABLE_WORKSPACE_EXPORT_MAX_MESSAGE_TEXT_LENGTH)
    const inserted = await db
      .insert(tasks)
      .values(
        Array.from({ length: 84 }, () => ({
          creatorUserId: ownerUserId!,
          objective: longObjective,
          title,
          workspaceId: workspaceId!,
        }))
      )
      .returning({ id: tasks.id })
    const taskIds = inserted.map(({ id }) => id)
    try {
      const initialPages: {
        objectiveJsonBytes: number
        textByteBudget: number
        titleJsonBytes: number
        withheldRows: number
      }[] = []
      await exportPortableWorkspace(db, {
        hooks: { afterTaskPage: (page) => initialPages.push(page) },
        principal: { kind: 'user', userId: ownerUserId! },
        workspaceId: workspaceId!,
      }).catch((error: unknown) => {
        if (!(error instanceof PortableExportError) || error.code !== 'too_large') throw error
      })
      const orderedTasks = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(inArray(tasks.id, taskIds))
        .orderBy(asc(tasks.id))
      const lastTaskId = orderedTasks.at(-1)!.id
      const lastPage = initialPages.at(-1)!
      const largeTaskTextBytes = portableJsonUtf8ByteLength({
        objective: longObjective,
        title,
      })
      const lastTaskTextByteBudget = lastPage.textByteBudget - largeTaskTextBytes * 8
      const emptyObjectiveBytes = portableJsonUtf8ByteLength({ objective: '', title })
      expect(lastTaskTextByteBudget).toBeGreaterThan(emptyObjectiveBytes)
      expect(lastTaskTextByteBudget - emptyObjectiveBytes).toBeLessThanOrEqual(
        PORTABLE_WORKSPACE_EXPORT_MAX_MESSAGE_TEXT_LENGTH
      )

      for (const offset of [-1, 0]) {
        const currentObjective = 'x'.repeat(lastTaskTextByteBudget + offset - emptyObjectiveBytes)
        await db.update(tasks).set({ objective: currentObjective }).where(eq(tasks.id, lastTaskId))
        const projections: {
          objectiveJsonBytes: number
          textByteBudget: number
          titleJsonBytes: number
          withheldRows: number
        }[] = []
        const outcome = await exportPortableWorkspace(db, {
          hooks: { afterTaskPage: (page) => projections.push(page) },
          principal: { kind: 'user', userId: ownerUserId! },
          workspaceId: workspaceId!,
        }).then(
          () => 'exported',
          (error: unknown) => (error instanceof PortableExportError ? error.code : 'other')
        )

        expect(outcome).toBe('too_large')
        expect(projections).toHaveLength(4)
        expect(projections[3]!.textByteBudget).toBe(lastPage.textByteBudget)
        expect(projections[3]!.objectiveJsonBytes).toBe(
          8 * portableJsonUtf8ByteLength(longObjective) +
            portableJsonUtf8ByteLength(currentObjective)
        )
        expect(projections[3]!.titleJsonBytes).toBe(9 * portableJsonUtf8ByteLength(title))
        expect(
          8 * largeTaskTextBytes +
            portableJsonUtf8ByteLength({ objective: currentObjective, title })
        ).toBe(lastPage.textByteBudget + offset)
        expect(projections[3]!.withheldRows).toBe(0)
      }

      const oversizedObjective = 'x'.repeat(lastTaskTextByteBudget + 1 - emptyObjectiveBytes)
      await db.update(tasks).set({ objective: oversizedObjective }).where(eq(tasks.id, lastTaskId))
      const projections: {
        objectiveJsonBytes: number
        textByteBudget: number
        titleJsonBytes: number
        withheldRows: number
      }[] = []
      const outcome = await exportPortableWorkspace(db, {
        hooks: { afterTaskPage: (page) => projections.push(page) },
        principal: { kind: 'user', userId: ownerUserId! },
        workspaceId: workspaceId!,
      }).then(
        () => 'exported',
        (error: unknown) => (error instanceof PortableExportError ? error.code : 'other')
      )

      expect(outcome).toBe('too_large')
      expect(projections).toHaveLength(4)
      expect(projections[3]!.withheldRows).toBe(1)
      expect(projections[3]!.titleJsonBytes).toBe(8 * portableJsonUtf8ByteLength(title))
      expect(projections[3]!.objectiveJsonBytes).toBe(8 * portableJsonUtf8ByteLength(longObjective))
    } finally {
      await db.delete(tasks).where(inArray(tasks.id, taskIds))
    }
  }, 180_000)

  test('message bodies at the exact and near byte boundary are complete; one over-budget row is refused', async () => {
    const messageId = await insertBoundMessage('boundary seed', 'portable-body-bound-' + run)
    try {
      const initialPages: { bodyTextByteBudget: number }[] = []
      await exportPortableWorkspace(db, {
        hooks: { afterMessagePage: (page) => initialPages.push(page) },
        principal: { kind: 'user', userId: ownerUserId! },
        workspaceId: workspaceId!,
      })
      const bodyTextByteBudget = initialPages[0]!.bodyTextByteBudget

      for (const offset of [-1, 0]) {
        const bodyText = 'x'.repeat(bodyTextByteBudget + offset - 2)
        await db.update(messages).set({ bodyText }).where(eq(messages.id, messageId))
        const projections: {
          bodyTextByteBudget: number
          bodyTextJsonBytes: number
          withheldBodyTextRows: number
        }[] = []
        const outcome = await exportPortableWorkspace(db, {
          hooks: { afterMessagePage: (page) => projections.push(page) },
          principal: { kind: 'user', userId: ownerUserId! },
          workspaceId: workspaceId!,
        }).then(
          () => 'exported',
          (error: unknown) => (error instanceof PortableExportError ? error.code : 'other')
        )

        expect(outcome).toBe('too_large')
        expect(projections).toHaveLength(1)
        expect(projections[0]!.bodyTextByteBudget).toBe(bodyTextByteBudget)
        expect(projections[0]!.bodyTextJsonBytes).toBe(portableJsonUtf8ByteLength(bodyText))
        expect(projections[0]!.bodyTextJsonBytes).toBe(bodyTextByteBudget + offset)
        expect(projections[0]!.withheldBodyTextRows).toBe(0)
      }

      const oversizedBody = 'x'.repeat(bodyTextByteBudget - 1)
      await db.update(messages).set({ bodyText: oversizedBody }).where(eq(messages.id, messageId))
      const projections: {
        bodyTextByteBudget: number
        bodyTextJsonBytes: number
        withheldBodyTextRows: number
      }[] = []
      const outcome = await exportPortableWorkspace(db, {
        hooks: { afterMessagePage: (page) => projections.push(page) },
        principal: { kind: 'user', userId: ownerUserId! },
        workspaceId: workspaceId!,
      }).then(
        () => 'exported',
        (error: unknown) => (error instanceof PortableExportError ? error.code : 'other')
      )

      expect(outcome).toBe('too_large')
      expect(projections).toHaveLength(1)
      expect(projections[0]!.withheldBodyTextRows).toBe(1)
      expect(projections[0]!.bodyTextJsonBytes).toBe(0)
    } finally {
      await db.delete(messages).where(eq(messages.id, messageId))
    }
  }, 180_000)

  test('message bodies preserve multibyte UTF-8 text without truncation', async () => {
    const bodyText = 'Message body ' + '漢字🧪🚀'.repeat(1_024)
    const messageId = await insertBoundMessage(bodyText, 'portable-body-utf8-' + run)
    const pageProjections: {
      bodyTextByteBudget: number
      bodyTextJsonBytes: number
      withheldBodyTextRows: number
    }[] = []
    try {
      const document = await exportPortableWorkspace(db, {
        hooks: { afterMessagePage: (page) => pageProjections.push(page) },
        principal: { kind: 'user', userId: ownerUserId! },
        workspaceId: workspaceId!,
      })
      const exportedMessage = document.content.messages.find(
        (message) => message.messageId === messageId
      )

      expect(exportedMessage?.body).toEqual({ kind: 'text', text: bodyText })
      expect(pageProjections).toHaveLength(1)
      expect(pageProjections[0]!.bodyTextJsonBytes).toBe(portableJsonUtf8ByteLength(bodyText))
      expect(pageProjections[0]!.withheldBodyTextRows).toBe(0)
    } finally {
      await db.delete(messages).where(eq(messages.id, messageId))
    }
  })

  test("this run's channel fixtures cannot collide with the fixed rows an earlier run left behind", async () => {
    // Reproduce the historical condition exactly: the rows the previous fixed channel ids left in
    // the lane database are still present when this run creates its own fixtures. `channels.id` is
    // a global primary key, so a leftover row with one of those ids is what makes the next run
    // fail with `23505 duplicate channels_pkey` before it asserts anything.
    //
    // All three fixed families are planted, one row each: the late-project channel, the
    // participant-boundary channel, and one member of the heavy visible scale range. The recorded
    // lane failure named the first of them, but the defect was a family, so the regression covers
    // the family and not only the member the receipt happened to carry.
    //
    // The leftover rows are participant-only channels: the collision is on the primary key alone,
    // and a participant-only channel with no participants is invisible to every other assertion in
    // this file, so the leftovers cannot perturb the cases that follow. The insert tolerates a
    // leftover that is already there, because "already there" is the condition under test.
    expect(LEGACY_SCALE_CHANNEL_ID).toMatch(/^00000000-0000-4000-8000-[0-9]{12}$/)
    await withLegacyChannelSeed(
      {
        client,
        database: db,
        rows: [
          {
            id: LEGACY_LATE_PROJECT_CHANNEL_ID,
            idempotencyKey: `portable-channel-legacy-late-project-${run}`,
            agentId: agentIds[0]!,
            kind: 'direct_agent' as const,
            sortOrder: 10_000,
            title: 'Leftover late-project channel',
            visibility: 'participants' as const,
            workspaceId: workspaceId!,
          },
          {
            id: LEGACY_BOUNDARY_CHANNEL_ID,
            idempotencyKey: `portable-channel-legacy-boundary-${run}`,
            agentId: agentIds[0]!,
            kind: 'direct_agent' as const,
            sortOrder: 10_001,
            title: 'Leftover boundary channel',
            visibility: 'participants' as const,
            workspaceId: workspaceId!,
          },
          {
            id: LEGACY_SCALE_CHANNEL_ID,
            idempotencyKey: `portable-channel-legacy-scale-${run}`,
            agentId: agentIds[0]!,
            kind: 'direct_agent' as const,
            sortOrder: 10_002,
            title: 'Leftover scale channel',
            visibility: 'participants' as const,
            workspaceId: workspaceId!,
          },
        ],
      },
      async ({ insertedIds, preexistingIds }) => {
        // The lock is held, so nothing here can be another run's row being removed under this one:
        // every legacy row is either planted by this run or a leftover that was already there.
        expect(insertedIds.length + preexistingIds.length).toBe(3)

        // The planted condition is real, not merely tolerated: all three leftover rows are present.
        const leftovers = await db
          .select({ id: channels.id })
          .from(channels)
          .where(
            inArray(channels.id, [
              LEGACY_LATE_PROJECT_CHANNEL_ID,
              LEGACY_BOUNDARY_CHANNEL_ID,
              LEGACY_SCALE_CHANNEL_ID,
            ])
          )
        expect(leftovers.map(({ id }) => id).toSorted()).toEqual(
          [
            LEGACY_LATE_PROJECT_CHANNEL_ID,
            LEGACY_BOUNDARY_CHANNEL_ID,
            LEGACY_SCALE_CHANNEL_ID,
          ].toSorted()
        )

        // Every fixture id this run creates is scoped to this run, so none of them is a fixed id an
        // earlier or concurrent run could have left behind. The run marker is in the id, which is what
        // makes it this run's own. The scale family is covered at both of its ends, because that is
        // where a collision with a fixed member of the old family would be most likely.
        const legacyIds = [
          LEGACY_LATE_PROJECT_CHANNEL_ID,
          LEGACY_BOUNDARY_CHANNEL_ID,
          LEGACY_SCALE_CHANNEL_ID,
        ]
        const productionIds = [
          lateProjectChannelId(),
          participantBoundaryChannelId(),
          heavyVisibleChannelId(0),
          heavyVisibleChannelId(HEAVY_SCALE_CHANNELS - 1),
        ]
        for (const id of productionIds) expect(id).toContain(run)
        for (const legacyId of legacyIds) expect(productionIds).not.toContain(legacyId)
        expect(new Set(productionIds).size).toBe(productionIds.length)

        // And a run-scoped id inserts cleanly while the leftover rows are present. The probe keeps the
        // low family's shape but takes an index no case below uses, so it never takes an identifier
        // one of them needs.
        const probeId = runScopedLowChannelId(900)
        expect(probeId).toContain(run)
        expect(legacyIds).not.toContain(probeId)
        await db.insert(channels).values({
          id: probeId,
          idempotencyKey: `portable-channel-run-scoped-probe-${run}`,
          agentId: agentIds[0]!,
          kind: 'direct_agent' as const,
          sortOrder: 10_003,
          title: 'Run-scoped probe channel',
          visibility: 'participants' as const,
          workspaceId: workspaceId!,
        })
        const rows = await db
          .select({ id: channels.id })
          .from(channels)
          .where(inArray(channels.id, [probeId, LEGACY_LATE_PROJECT_CHANNEL_ID]))
        expect(rows.map(({ id }) => id).toSorted()).toEqual(
          [probeId, LEGACY_LATE_PROJECT_CHANNEL_ID].toSorted()
        )
      }
    )
  }, 300_000)

  const seedRow = (id: string, title: string): ChannelSeed => ({
    id,
    idempotencyKey: `portable-channel-seed-lifetime-${title}-${run}`,
    agentId: agentIds[0]!,
    kind: 'direct_agent',
    sortOrder: 10_100,
    title,
    visibility: 'participants',
    workspaceId: workspaceId!,
  })

  /**
   * The fixture ids and rows the helper self-tests plant. They are run-scoped synthetic ids, not the
   * legacy ones, so the self-tests cannot touch the real legacy rows or another run's seed.
   */
  function selfTestFixture() {
    const ownedId = runScopedLowChannelId(901)
    const leftoverId = runScopedLowChannelId(902)
    const present = async () =>
      (
        await db
          .select({ id: channels.id })
          .from(channels)
          .where(inArray(channels.id, [ownedId, leftoverId]))
      )
        .map(({ id }) => id)
        .toSorted()
    return {
      leftoverId,
      ownedId,
      present,
      removeFixtures: async () => {
        await db.delete(channels).where(inArray(channels.id, [ownedId, leftoverId]))
      },
      rows: [seedRow(ownedId, 'owned'), seedRow(leftoverId, 'leftover')],
    }
  }

  test('the legacy seed is held for its whole lifetime and only its own rows are removed', async () => {
    // The helper under test is the one the regression above uses, here with a lock name and ids of
    // this run's own so it cannot touch the real legacy rows or another run's lock. "Run B" is a
    // second caller on a second connection that starts while run A still holds the seed. Every
    // caller is started through `runWithSettledCallers`, which settles all of them before the
    // fixture rows are deleted, so a failure of run A cannot leave B running under the teardown.
    const lockName = `${LEGACY_SEED_LOCK_NAME}:self-test:${run}`
    const { present, rows, ownedId, leftoverId, removeFixtures } = selfTestFixture()

    // A leftover that some earlier or other run owns: planted outside the helper, with its own key.
    await db.insert(channels).values(seedRow(leftoverId, 'leftover-original'))
    const events: string[] = []
    await runWithSettledCallers(
      async (start) => {
        const runA = start(
          withLegacyChannelSeed(
            { client, database: db, lockName, rows },
            async ({ insertedIds, preexistingIds }) => {
              events.push('a:enter')
              expect(insertedIds).toEqual([ownedId])
              expect(preexistingIds).toEqual([leftoverId])
              // While A holds the seed, a second connection cannot take the lock.
              await expect(assertAdvisoryLockFree(client, lockName)).rejects.toThrow(/still held/)
              // Run B starts now and has to wait; A keeps working on its rows meanwhile.
              start(
                withLegacyChannelSeed(
                  { client, database: db, lockName, rows, waitMs: 10_000 },
                  async (seed) => {
                    events.push('b:enter')
                    // A removed the row it planted, so B plants its own instead of reusing A's, and
                    // the leftover that was never A's is still the leftover.
                    expect(seed.insertedIds).toEqual([ownedId])
                    expect(seed.preexistingIds).toEqual([leftoverId])
                    expect(await present()).toEqual([ownedId, leftoverId].toSorted())
                    events.push('b:leave')
                  }
                )
              )
              await new Promise((resolve) => setTimeout(resolve, 400))
              expect(events).toEqual(['a:enter'])
              expect(await present()).toEqual([ownedId, leftoverId].toSorted())
              events.push('a:leave')
            }
          )
        )
        await runA
        // B was started inside A and is awaited only by the harness; wait for it here as well so the
        // assertions below see the finished sequence.
        for (let waited = 0; !events.includes('b:leave') && waited < 10_000; waited += 50)
          await new Promise((resolve) => setTimeout(resolve, 50))
        expect(events).toEqual(['a:enter', 'a:leave', 'b:enter', 'b:leave'])
        // Both runs removed what they planted and neither removed the leftover.
        expect(await present()).toEqual([leftoverId])
        const [leftover] = await db.select().from(channels).where(eq(channels.id, leftoverId))
        expect(leftover?.title).toBe('leftover-original')

        // The lock is released on a failing body as well, and the rows planted are still removed.
        // These callers are awaited on the spot, so they cannot be abandoned and need no
        // registration with the harness.
        await expect(
          withLegacyChannelSeed({ client, database: db, lockName, rows }, async () => {
            throw new Error('body failed')
          })
        ).rejects.toThrow('body failed')
        expect(await present()).toEqual([leftoverId])
        await withLegacyChannelSeed(
          { client, database: db, lockName, rows, waitMs: 1_000 },
          async () => undefined
        )

        // A lock that is never released surfaces as a bounded wait, not as a hang.
        const holder = await client.reserve()
        try {
          await holder`select pg_advisory_lock(hashtextextended(${lockName}::text, 0))`
          await expect(
            withLegacyChannelSeed(
              { client, database: db, lockName, rows, waitMs: 300 },
              async () => {}
            )
          ).rejects.toThrow(/timed out waiting/)
          expect(await present()).toEqual([leftoverId])
        } finally {
          await holder`select pg_advisory_unlock_all()`
          holder.release()
        }
      },
      async () => {
        await removeFixtures()
        await assertAdvisoryLockFree(client, lockName)
      }
    )
  }, 300_000)

  test('a failing first caller is settled together with the second one before teardown', async () => {
    // The scenario abandons run B: run A rejects while B is still waiting for the lock, so the
    // scenario throws before it ever awaits B. The teardown must still not run until B has
    // finished, and by then neither the lock nor B's planted row may be left behind.
    const lockName = `${LEGACY_SEED_LOCK_NAME}:self-test-failure:${run}`
    const { present, rows, ownedId, leftoverId, removeFixtures } = selfTestFixture()
    await db.insert(channels).values(seedRow(leftoverId, 'leftover-original'))
    const failure = new Error('run A failed')
    const events: string[] = []
    let atTeardown: { events: string[]; present: string[] } | undefined

    await expect(
      runWithSettledCallers(
        async (start) => {
          const runA = start(
            withLegacyChannelSeed({ client, database: db, lockName, rows }, async () => {
              events.push('a:enter')
              start(
                withLegacyChannelSeed(
                  { client, database: db, lockName, rows, waitMs: 10_000 },
                  async (seed) => {
                    events.push('b:enter')
                    expect(seed.insertedIds).toEqual([ownedId])
                    await new Promise((resolve) => setTimeout(resolve, 200))
                    events.push('b:leave')
                  }
                )
              )
              // B is waiting on the lock now; A fails while holding it.
              await new Promise((resolve) => setTimeout(resolve, 300))
              events.push('a:throw')
              throw failure
            })
          )
          await runA
          // Never reached: the line that used to be skipped, `await runB`, is not here at all.
        },
        async () => {
          atTeardown = { events: [...events], present: await present() }
          await removeFixtures()
          await assertAdvisoryLockFree(client, lockName)
        }
      )
    ).rejects.toBe(failure)

    // B had entered, finished and removed its own row before the teardown ran, and the teardown
    // found the lock free.
    expect(atTeardown?.events).toEqual(['a:enter', 'a:throw', 'b:enter', 'b:leave'])
    expect(atTeardown?.present).toEqual([leftoverId])
    expect(await present()).toEqual([])
  }, 300_000)

  test('the settling harness keeps the primary error and every cleanup error', async () => {
    const primary = new Error('scenario failed')
    const lateCaller = new Error('abandoned caller failed')
    const teardownFailure = new Error('teardown failed')
    // A lone primary error comes back as itself, after the abandoned caller has settled.
    let settled = false
    await expect(
      runWithSettledCallers(
        async (start) => {
          start(
            new Promise<void>((resolve) =>
              setTimeout(() => {
                settled = true
                resolve()
              }, 50)
            )
          )
          throw primary
        },
        async () => {
          expect(settled).toBe(true)
        }
      )
    ).rejects.toBe(primary)

    // The primary error, an abandoned caller's rejection and a failing teardown are all kept.
    const combined = await runWithSettledCallers(
      async (start) => {
        start(slowReject(lateCaller))
        throw primary
      },
      async () => {
        throw teardownFailure
      }
    ).then(
      () => undefined,
      (error: unknown) => error
    )
    expect(combined).toBeInstanceOf(AggregateError)
    expect((combined as AggregateError).errors).toEqual([primary, lateCaller, teardownFailure])

    // A passing scenario with a failing teardown still fails.
    await expect(
      runWithSettledCallers(
        async () => {},
        async () => {
          throw teardownFailure
        }
      )
    ).rejects.toMatchObject({ errors: [teardownFailure] })

    // A caller that fails after the scenario passed is not swallowed either.
    await expect(
      runWithSettledCallers(
        async (start) => {
          start(slowReject(lateCaller))
        },
        async () => {}
      )
    ).rejects.toMatchObject({ errors: [lateCaller] })
  })

  test('mid-export project grants cannot expand channel or participant reads past the snapshot', async () => {
    const reader = await createTemporaryUserSession(db, {
      credentialDigest: `portable-channel-reader-${run}`,
      displayName: 'Channel Bounds Reader',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })
    testUserIds.push(reader.principal.userId)
    await addWorkspaceMembership(db, workspaceId!, reader.principal, 'member')

    const project = await createProject(
      db,
      workspaceId!,
      {
        kind: 'user',
        userId: ownerUserId!,
      },
      {
        iconKey: 'folder',
        name: `Mid-page grant ${run}`,
      }
    )
    await setProjectVisibility(
      db,
      workspaceId!,
      project.id,
      {
        kind: 'user',
        userId: ownerUserId!,
      },
      'members'
    )

    const newlyVisibleChannelId = lateProjectChannelId()
    await db.insert(channels).values({
      id: newlyVisibleChannelId,
      idempotencyKey: `portable-channel-late-project-${run}`,
      isPrimaryProjectChannel: false,
      kind: 'project',
      projectId: project.id,
      sortOrder: 10_000,
      title: 'Late project channel',
      visibility: 'workspace',
      workspaceId: workspaceId!,
    })
    await db.insert(channelParticipants).values(
      agentIds.map((agentId) => ({
        agentId,
        channelId: newlyVisibleChannelId,
        principalKind: 'agent' as const,
        workspaceId: workspaceId!,
      }))
    )

    const baselineRows = Array.from({ length: CHANNEL_PAGE_SIZE + 44 }, (_, index) => ({
      id: randomUUID(),
      idempotencyKey: `portable-channel-page-baseline-${run}-${index}`,
      agentId: agentIds[0]!,
      kind: 'direct_agent' as const,
      sortOrder: 1_000 + index,
      title: `Baseline channel ${index}`,
      visibility: 'workspace' as const,
      workspaceId: workspaceId!,
    }))
    for (let offset = 0; offset < baselineRows.length; offset += 100)
      await db.insert(channels).values(baselineRows.slice(offset, offset + 100))

    traceEnabled = false
    const baselineChannelIds = await listChannelIdsForUser(db, workspaceId!, reader.principal)
    const projectChannelRows = await db
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.projectId, project.id))
    const [baselineParticipantCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(channelParticipants)
      .where(
        and(
          eq(channelParticipants.workspaceId, workspaceId!),
          inArray(channelParticipants.channelId, baselineChannelIds)
        )
      )
    traceEnabled = true
    expect(baselineChannelIds).not.toContain(newlyVisibleChannelId)
    expect(projectChannelRows.length).toBeGreaterThan(0)
    expect(projectChannelRows.every(({ id }) => !baselineChannelIds.includes(id))).toBe(true)

    const observedChannelIds: string[] = []
    let projectGrantApplied = false
    trace = emptyTrace()
    const document = await exportPortableWorkspace(db, {
      principal: reader.principal,
      workspaceId: workspaceId!,
      hooks: {
        beforeChannelPage: async ({ afterChannelId }) => {
          if (afterChannelId && !projectGrantApplied) {
            await setProjectMember(
              db,
              workspaceId!,
              project.id,
              {
                kind: 'user',
                userId: ownerUserId!,
              },
              {
                role: 'viewer',
                userId: reader.principal.userId,
              }
            )
            projectGrantApplied = true
          }
        },
        afterChannelPage: ({ channelIds, participantRowsMaterialized }) => {
          observedChannelIds.push(...channelIds)
          trace.participantRowsMaterialized += participantRowsMaterialized
          trace.maxParticipantRowsMaterializedPerPage = Math.max(
            trace.maxParticipantRowsMaterializedPerPage,
            participantRowsMaterialized
          )
        },
      },
    })

    expect(projectGrantApplied).toBe(true)
    expect(observedChannelIds).not.toContain(newlyVisibleChannelId)
    expect(projectChannelRows.every(({ id }) => !observedChannelIds.includes(id))).toBe(true)
    expect(trace.participantReadChannelIds).not.toContain(newlyVisibleChannelId)
    expect(trace.participantRowsMaterialized).toBe(baselineParticipantCount?.count ?? 0)
    expect(document.content.channels.map(({ channelId }) => channelId)).not.toContain(
      newlyVisibleChannelId
    )
  }, 300_000)

  test('reads complete participant summaries in bounded pages and rejects one over the export cap', async () => {
    const existingVisible = await db
      .select({ id: channels.id })
      .from(channels)
      .where(
        and(
          eq(channels.workspaceId, workspaceId!),
          eq(channels.lifecycleState, 'active'),
          eq(channels.visibility, 'workspace')
        )
      )
    const visibleToAdd = PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS - existingVisible.length
    expect(visibleToAdd).toBeGreaterThan(0)

    const hiddenRows = Array.from({ length: HIDDEN_CHANNELS - 1 }, (_, index) => ({
      id: randomUUID(),
      idempotencyKey: `portable-channel-hidden-scale-${run}-${index}`,
      agentId: agentIds[0]!,
      kind: 'direct_agent' as const,
      sortOrder: index + 1,
      title: `Hidden scale channel ${index}`,
      visibility: 'participants' as const,
      workspaceId: workspaceId!,
    }))
    const hiddenIds: string[] = []
    for (let offset = 0; offset < hiddenRows.length; offset += 500) {
      const page = await db
        .insert(channels)
        .values(hiddenRows.slice(offset, offset + 500))
        .returning({ id: channels.id })
      hiddenIds.push(...page.map(({ id }) => id))
    }

    const heavyVisibleIds = Array.from(
      { length: Math.min(HEAVY_SCALE_CHANNELS, visibleToAdd) },
      (_, index) => heavyVisibleChannelId(index)
    )
    const visibleRows = Array.from({ length: visibleToAdd }, (_, index) => ({
      id: heavyVisibleIds[index] ?? randomUUID(),
      idempotencyKey: `portable-channel-visible-scale-${run}-${index}`,
      agentId: agentIds[0]!,
      kind: 'direct_agent' as const,
      sortOrder: HIDDEN_CHANNELS + index,
      title: `Visible scale channel ${index}`,
      visibility: 'workspace' as const,
      workspaceId: workspaceId!,
    }))
    const visibleIds: string[] = []
    for (let offset = 0; offset < visibleRows.length; offset += 500) {
      const page = await db
        .insert(channels)
        .values(visibleRows.slice(offset, offset + 500))
        .returning({ id: channels.id })
      visibleIds.push(...page.map(({ id }) => id))
    }
    const participantRows = [
      ...hiddenIds.slice(0, HEAVY_SCALE_CHANNELS),
      ...visibleIds.slice(0, HEAVY_SCALE_CHANNELS),
    ].flatMap((channelId) =>
      agentIds.map((agentId) => ({
        agentId,
        channelId,
        principalKind: 'agent' as const,
        workspaceId: workspaceId!,
      }))
    )
    for (let offset = 0; offset < participantRows.length; offset += 1000)
      await db.insert(channelParticipants).values(participantRows.slice(offset, offset + 1000))

    const hiddenInFixture = await db
      .select({ id: channels.id })
      .from(channels)
      .where(
        and(
          eq(channels.workspaceId, workspaceId!),
          eq(channels.lifecycleState, 'active'),
          eq(channels.visibility, 'participants')
        )
      )

    trace = emptyTrace()
    const summaries: ChannelSummary[] = []
    let after: { id: string } | undefined
    for (;;) {
      const page = await listChannelsForUserPage(
        db,
        workspaceId!,
        {
          kind: 'user',
          userId: ownerUserId!,
        },
        { after }
      )
      summaries.push(...page.channels)
      trace.participantRowsMaterialized += page.participantRowsMaterialized
      trace.maxParticipantRowsMaterializedPerPage = Math.max(
        trace.maxParticipantRowsMaterializedPerPage,
        page.participantRowsMaterialized
      )
      if (!page.nextAfter) break
      after = page.nextAfter
    }
    expect(summaries).toHaveLength(PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS)
    expect(summaries.some(({ id }) => id === hiddenControlChannelId)).toBe(false)
    expect(summaries.some(({ id }) => hiddenIds.includes(id))).toBe(false)
    const visibleControlSummary = summaries.find(({ id }) => id === visibleControlChannelId)
    expect(visibleControlSummary?.participants).toHaveLength(HEAVY_PARTICIPANTS)
    expect(summaries.find(({ id }) => id === visibleIds[0])?.participants).toHaveLength(
      HEAVY_PARTICIPANTS
    )

    traceEnabled = false
    const [participantCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(channelParticipants)
      .where(
        and(
          eq(channelParticipants.workspaceId, workspaceId!),
          inArray(
            channelParticipants.channelId,
            summaries.map(({ id }) => id)
          )
        )
      )
    traceEnabled = true
    expect(trace.participantRowsMaterialized).toBe(participantCount?.count ?? 0)
    expect(trace.participantRowsMaterialized).toBeGreaterThan(PARTICIPANT_BATCH_ROW_LIMIT)
    expect(trace.maxParticipantRowsMaterializedPerPage).toBeGreaterThan(9_000)
    expect(trace.maxParticipantRowsMaterializedPerPage).toBeLessThanOrEqual(
      PARTICIPANT_BATCH_ROW_LIMIT
    )
    expect(trace.participantReadBatchSizes).toContain(HEAVY_SCALE_CHANNELS - 1)
    expect(trace.maxParticipantQueryRows).toBeLessThanOrEqual(MAX_PARTICIPANT_QUERY_ROWS)
    expect(trace.participantReadChannelIds).not.toContain(hiddenControlChannelId)
    expect(trace.participantReadChannelIds.some((id) => hiddenIds.includes(id))).toBe(false)

    const candidateChannels = PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS + 1 + hiddenInFixture.length
    const maximumPagesPerPass = Math.ceil(candidateChannels / MIN_EXPECTED_CHANNEL_PAGE_SIZE)
    const pageViolations: string[] = []
    if (trace.channelReadsWithoutLimit !== 0)
      pageViolations.push(`${trace.channelReadsWithoutLimit} channel reads had no LIMIT`)
    if (trace.maxChannelPageRows > MAX_CHANNEL_QUERY_ROWS)
      pageViolations.push(`channel page limit reached ${trace.maxChannelPageRows} rows`)
    if (trace.channelPageReads > maximumPagesPerPass + 1)
      pageViolations.push(`${trace.channelPageReads} page queries exceeded the page budget`)
    if (trace.channelIdSnapshotReads !== 0)
      pageViolations.push('canonical list unexpectedly used a standing snapshot')
    if (trace.participantReads > trace.channelPageReads + 1)
      pageViolations.push(`${trace.participantReads} participant reads exceeded one batch per page`)
    if (trace.participantCountReads > trace.channelPageReads + 1)
      pageViolations.push(
        `${trace.participantCountReads} participant count reads exceeded one per page`
      )
    if (trace.maxParticipantQueryParameters > CHANNEL_PAGE_SIZE + 2)
      pageViolations.push(
        `participant batch used ${trace.maxParticipantQueryParameters} query parameters`
      )
    if (trace.totalStatements > MAX_EXPORT_QUERY_COUNT)
      pageViolations.push(`${trace.totalStatements} statements exceeded the query budget`)
    expect(
      pageViolations,
      `channel list query trace: ${JSON.stringify(traceSummary(trace))}`
    ).toEqual([])

    const overflowId = randomUUID()
    await db.insert(channels).values({
      id: overflowId,
      idempotencyKey: `portable-channel-visible-overflow-${run}`,
      agentId: agentIds[0]!,
      kind: 'direct_agent',
      sortOrder: HIDDEN_CHANNELS + visibleToAdd,
      title: 'Visible overflow channel',
      visibility: 'workspace',
      workspaceId: workspaceId!,
    })

    trace = emptyTrace()
    const outcome = await exportPortableWorkspace(db, {
      principal: { kind: 'user', userId: ownerUserId! },
      workspaceId: workspaceId!,
    }).then(
      () => 'exported',
      (error: unknown) => (error instanceof PortableExportError ? error.code : 'other')
    )
    const violations: string[] = []
    if (outcome !== 'too_large') violations.push(`expected too_large, got ${outcome}`)
    if (trace.channelReadsWithoutLimit !== 0)
      violations.push(`${trace.channelReadsWithoutLimit} channel row reads had no LIMIT`)
    if (trace.channelIdSnapshotReads !== 1)
      violations.push(`${trace.channelIdSnapshotReads} bounded standing snapshots were read`)
    if (trace.maxChannelSnapshotRows > PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS + 1)
      violations.push(`standing snapshot limit reached ${trace.maxChannelSnapshotRows} rows`)
    if (trace.channelPageReads !== 0)
      violations.push(`${trace.channelPageReads} summaries were loaded after the overflow snapshot`)
    if (trace.participantReads !== 0)
      violations.push(`${trace.participantReads} participant reads ran after the overflow snapshot`)
    if (trace.totalStatements > 32)
      violations.push(`${trace.totalStatements} statements exceeded the overflow refusal budget`)
    await db.delete(channels).where(eq(channels.id, overflowId))

    expect(
      violations,
      `channel export query trace: ${JSON.stringify(traceSummary(trace))}`
    ).toEqual([])
  }, 300_000)

  test('materializes exactly 10,000 participants and refuses 10,001 before detail transfer', async () => {
    const [channelToReplace] = await db
      .select({ id: channels.id })
      .from(channels)
      .where(
        and(
          eq(channels.workspaceId, workspaceId!),
          eq(channels.lifecycleState, 'active'),
          eq(channels.visibility, 'workspace')
        )
      )
      .orderBy(channels.id)
      .limit(1)
    expect(channelToReplace).toBeDefined()
    await db.delete(channels).where(eq(channels.id, channelToReplace!.id))

    const boundaryChannelId = participantBoundaryChannelId()
    await db.insert(channels).values({
      id: boundaryChannelId,
      idempotencyKey: `portable-channel-participant-bound-${run}`,
      agentId: agentIds[0]!,
      kind: 'direct_agent',
      sortOrder: 0,
      title: 'Participant boundary channel',
      visibility: 'workspace',
      workspaceId: workspaceId!,
    })

    const extraAgents: string[] = []
    for (let offset = 0; offset < 9_936; offset += 500) {
      const page = await db
        .insert(agents)
        .values(
          Array.from({ length: Math.min(500, 9_936 - offset) }, (_, index) => ({
            name: `Boundary participant ${offset + index}`,
            profileId: 'profile.channel-bounds-boundary',
            profileVersion: '1.0.0',
            workspaceId: workspaceId!,
          }))
        )
        .returning({ id: agents.id })
      extraAgents.push(...page.map(({ id }) => id))
    }
    const boundaryAgentIds = [...agentIds, ...extraAgents]
    expect(boundaryAgentIds).toHaveLength(10_000)

    for (let offset = 0; offset < boundaryAgentIds.length; offset += 500)
      await db.insert(channelParticipants).values(
        boundaryAgentIds.slice(offset, offset + 500).map((agentId) => ({
          agentId,
          channelId: boundaryChannelId,
          principalKind: 'agent' as const,
          workspaceId: workspaceId!,
        }))
      )

    trace = emptyTrace()
    const page = await listChannelsForUserPage(
      db,
      workspaceId!,
      { kind: 'user', userId: ownerUserId! },
      { channelIds: [boundaryChannelId], limit: 1 }
    )
    expect(page.channels).toHaveLength(1)
    expect(page.channels[0]?.participants).toHaveLength(10_000)
    expect(page.participantRowsMaterialized).toBe(10_000)

    const overflowAgent = await db
      .insert(agents)
      .values({
        name: 'Boundary overflow participant',
        profileId: 'profile.channel-bounds-boundary',
        profileVersion: '1.0.0',
        workspaceId: workspaceId!,
      })
      .returning({ id: agents.id })
    await db.insert(channelParticipants).values({
      agentId: overflowAgent[0]!.id,
      channelId: boundaryChannelId,
      principalKind: 'agent',
      workspaceId: workspaceId!,
    })

    trace = emptyTrace()
    const outcome = await exportPortableWorkspace(db, {
      principal: { kind: 'user', userId: ownerUserId! },
      workspaceId: workspaceId!,
    }).then(
      () => 'exported',
      (error: unknown) => (error instanceof PortableExportError ? error.code : 'other')
    )
    expect(outcome).toBe('too_large')
    expect(trace.participantCountReads).toBeGreaterThan(0)
    expect(trace.participantReads).toBe(0)
  }, 300_000)
})
