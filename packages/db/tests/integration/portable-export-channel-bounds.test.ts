import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomBytes, randomUUID } from 'node:crypto'

import {
  PORTABLE_WORKSPACE_EXPORT_MAX_BYTES,
  PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS,
} from '@adea-ai/types/portable-export'
import type { ChannelSummary } from '@adea-ai/types'
import { and, eq, inArray, sql } from 'drizzle-orm'
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
  projects,
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
const CHANNEL_ID_SNAPSHOT = /^\s*select\s+"id"\s+from\s+"app"\."channels"/iu
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
  let fixtureProjectId: string
  let agentIds: string[] = []
  let trace = emptyTrace()
  let traceEnabled = true

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
    // These bounds fixtures model ordinary project/participant readers. Canonical groups
    // now require admissions; separate isolation proofs exercise real group grants.
    const [project] = await db
      .insert(projects)
      .values({ workspaceId, name: 'Bounds fixture', iconKey: 'planning' })
      .returning({ id: projects.id })
    fixtureProjectId = project!.id

    const agentsCreated = await db
      .insert(agents)
      .values(
        Array.from({ length: HEAVY_PARTICIPANTS }, (_, index) => ({
          name: `Channel participant ${index}`,
          profileId: 'profile.channel-bounds',
          profileVersion: '1.0.0',
          workspaceId: workspaceId!,
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
        kind: 'project',
        projectId: fixtureProjectId,
        sortOrder: 100,
        title: 'Visible control channel',
        visibility: 'workspace',
        workspaceId,
      },
      {
        id: hiddenControlChannelId,
        idempotencyKey: `portable-channel-hidden-${run}`,
        kind: 'project',
        projectId: fixtureProjectId,
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
          workspaceId: workspaceId!,
        }))
      )
    )
    trace = emptyTrace()
  })

  afterAll(async () => {
    try {
      if (workspaceId) {
        await db.delete(channels).where(eq(channels.workspaceId, workspaceId))
        await db.delete(projects).where(eq(projects.workspaceId, workspaceId))
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
        hooks: {
          afterAgentPage: (page) => {
            materialized.push(page)
          },
        },
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
        hooks: {
          afterAgentPage: (page) => {
            materialized.push(page)
          },
        },
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

    const newlyVisibleChannelId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
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
      kind: 'project' as const,
      projectId: fixtureProjectId,
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
      kind: 'project' as const,
      projectId: fixtureProjectId,
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
      (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
    )
    const visibleRows = Array.from({ length: visibleToAdd }, (_, index) => ({
      id: heavyVisibleIds[index] ?? randomUUID(),
      idempotencyKey: `portable-channel-visible-scale-${run}-${index}`,
      kind: 'project' as const,
      projectId: fixtureProjectId,
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
      kind: 'project',
      projectId: fixtureProjectId,
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

    const boundaryChannelId = '00000000-0000-4000-8000-000000000000'
    await db.insert(channels).values({
      id: boundaryChannelId,
      idempotencyKey: `portable-channel-participant-bound-${run}`,
      kind: 'project',
      projectId: fixtureProjectId,
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
