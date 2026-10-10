// Integration coverage for explicit project-state promotion (M14.03.2,
// adea#1218): the promotion flips archived to active at the exact observed
// revision with explicit opt-in, preserves visibility, wakes the archived
// project channels, and refuses stale, unconfirmed, repeat and foreign
// attempts without touching the row.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { and, eq, sql } from 'drizzle-orm'

import { archiveChannel, createProjectChannel } from '../../src/conversations'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createTemporaryUserSession } from '../../src/identity'
import {
  archiveProject,
  createProject,
  getProjectForUser,
  listProjectsForUser,
} from '../../src/projects'
import { setProjectVisibility } from '../../src/project-sharing'
import {
  ProjectStatePromotionError,
  promoteProjectState,
  restoreProjectChannels,
} from '../../src/project-state-policy'
import {
  channels,
  projects,
  temporaryUserSessions,
  users,
  workspaceEvents,
  workspaceMemberships,
  workspaces,
} from '../../src/schema'
import { createWorkspaceWithOwner } from '../../src/workspaces'

const connectionUrl = process.env.DATABASE_URL

describe.skipIf(!connectionUrl)('explicit project-state promotion', () => {
  let connection: DatabaseConnection

  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })

  afterAll(async () => {
    await connection.close()
  })

  async function fixture() {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: `promotion-owner-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const outsider = await createTemporaryUserSession(connection.db, {
      credentialDigest: `promotion-outsider-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `promotion-${crypto.randomUUID()}`,
      name: 'Promotion HQ',
      owner: owner.principal,
      scene: 'work',
    })
    const project = await createProject(connection.db, workspace.id, owner.principal, {
      iconKey: 'promotion',
      name: 'Promotion project',
    })
    return { owner, outsider, project, workspace }
  }

  async function cleanup(input: {
    owner: Awaited<ReturnType<typeof createTemporaryUserSession>>
    outsider: Awaited<ReturnType<typeof createTemporaryUserSession>>
    workspace: Awaited<ReturnType<typeof createWorkspaceWithOwner>>['workspace']
  }) {
    await connection.db.delete(channels).where(eq(channels.workspaceId, input.workspace.id))
    await connection.db.delete(projects).where(eq(projects.workspaceId, input.workspace.id))
    await connection.db
      .delete(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, input.workspace.id))
    await connection.db.delete(workspaces).where(eq(workspaces.id, input.workspace.id))
    for (const principal of [input.owner.principal, input.outsider.principal]) {
      await connection.db
        .delete(temporaryUserSessions)
        .where(eq(temporaryUserSessions.userId, principal.userId))
      await connection.db.delete(users).where(eq(users.id, principal.userId))
    }
  }

  async function archivedSummary(
    workspaceId: string,
    projectId: string,
    principal: Parameters<typeof getProjectForUser>[3]
  ) {
    const summary = await getProjectForUser(connection.db, workspaceId, projectId, principal, {
      includeArchived: true,
    })
    if (!summary) throw new Error('fixture project missing')
    return summary
  }

  async function channelRows(workspaceId: string, projectId: string) {
    return connection.db
      .select({
        archiveSource: channels.archiveSource,
        id: channels.id,
        lifecycleState: channels.lifecycleState,
        version: channels.version,
      })
      .from(channels)
      .where(and(eq(channels.workspaceId, workspaceId), eq(channels.projectId, projectId)))
  }

  async function eventCount(workspaceId: string, eventType: string) {
    const rows = await connection.db
      .select({ eventType: workspaceEvents.eventType })
      .from(workspaceEvents)
      .where(
        and(eq(workspaceEvents.workspaceId, workspaceId), eq(workspaceEvents.eventType, eventType))
      )
    return rows.length
  }

  test('promotes an archived project at the observed revision and preserves its audience', async () => {
    const { owner, outsider, project, workspace } = await fixture()
    try {
      await setProjectVisibility(
        connection.db,
        workspace.id,
        project.id,
        owner.principal,
        'members'
      )
      await archiveProject(connection.db, workspace.id, project.id, owner.principal)
      const archived = await archivedSummary(workspace.id, project.id, owner.principal)
      expect(archived.lifecycleState).toBe('archived')
      expect(archived.visibility).toBe('members')
      // The project cascade marks every channel it sleeps with its provenance.
      const cascade = await channelRows(workspace.id, project.id)
      expect(cascade.length).toBeGreaterThan(0)
      expect(
        cascade.every(
          (channel) =>
            channel.lifecycleState === 'archived' && channel.archiveSource === 'project_cascade'
        )
      ).toBe(true)

      const promoted = await promoteProjectState(
        connection.db,
        workspace.id,
        project.id,
        owner.principal,
        { confirmed: true, expectedVersion: archived.version }
      )
      expect(promoted).toMatchObject({
        id: project.id,
        lifecycleState: 'active',
        visibility: 'members',
      })
      expect(await listProjectsForUser(connection.db, workspace.id, owner.principal)).toEqual([
        expect.objectContaining({ id: project.id, lifecycleState: 'active' }),
      ])

      // The archive cascade slept the project channel; promotion wakes it at +1 version.
      const projectChannels = await channelRows(workspace.id, project.id)
      expect(projectChannels.length).toBeGreaterThan(0)
      expect(projectChannels.every((channel) => channel.lifecycleState === 'active')).toBe(true)
      expect(projectChannels.every((channel) => channel.archiveSource === 'individual')).toBe(true)
      // version 1 on create, +1 on archive, +1 on restore.
      expect(projectChannels.every((channel) => channel.version === 3)).toBe(true)

      const restoredEvents = await connection.db
        .select({ eventType: workspaceEvents.eventType })
        .from(workspaceEvents)
        .where(
          and(
            eq(workspaceEvents.workspaceId, workspace.id),
            eq(workspaceEvents.eventType, 'project.restored')
          )
        )
      expect(restoredEvents).toHaveLength(1)
      const channelEvents = await connection.db
        .select({ eventType: workspaceEvents.eventType })
        .from(workspaceEvents)
        .where(
          and(
            eq(workspaceEvents.workspaceId, workspace.id),
            eq(workspaceEvents.eventType, 'channel.restored')
          )
        )
      expect(channelEvents).toHaveLength(projectChannels.length)

      // The outsider never observes or promotes the project.
      await expect(
        promoteProjectState(connection.db, workspace.id, project.id, outsider.principal, {
          confirmed: true,
          expectedVersion: archived.version,
        })
      ).rejects.toThrow('Project unavailable')
    } finally {
      await cleanup({ outsider, owner, workspace })
    }
  })

  test('promotion wakes only the channels the project archive slept', async () => {
    const { owner, outsider, project, workspace } = await fixture()
    try {
      // A topic archived on its own keeps its provenance and is never revived
      // by promoting the project.
      const topic = await createProjectChannel(
        connection.db,
        workspace.id,
        project.id,
        owner.principal,
        { idempotencyKey: `promotion-topic-${crypto.randomUUID()}`, title: 'Independent topic' }
      )
      await archiveChannel(connection.db, workspace.id, topic.id, owner.principal, topic.version)
      await archiveProject(connection.db, workspace.id, project.id, owner.principal)
      const archived = await archivedSummary(workspace.id, project.id, owner.principal)
      const before = await channelRows(workspace.id, project.id)
      const independent = before.find((channel) => channel.id === topic.id)
      expect(independent).toMatchObject({ archiveSource: 'individual', lifecycleState: 'archived' })
      expect(before.filter((channel) => channel.id !== topic.id).length).toBeGreaterThan(0)

      await promoteProjectState(connection.db, workspace.id, project.id, owner.principal, {
        confirmed: true,
        expectedVersion: archived.version,
      })
      const after = await channelRows(workspace.id, project.id)
      // Exactly the cascade channel woke; the independent archive stayed archived.
      expect(after.find((channel) => channel.id === topic.id)).toEqual(independent)
      const cascade = after.filter((channel) => channel.id !== topic.id)
      expect(cascade.every((channel) => channel.lifecycleState === 'active')).toBe(true)
      expect(cascade.every((channel) => channel.version === 3)).toBe(true)
      // One channel.restored event per cascade channel, none for the topic.
      expect(await eventCount(workspace.id, 'channel.restored')).toBe(cascade.length)
    } finally {
      await cleanup({ outsider, owner, workspace })
    }
  })

  test('concurrent promotions promote exactly once and bump each channel once', async () => {
    const { owner, outsider, project, workspace } = await fixture()
    try {
      await archiveProject(connection.db, workspace.id, project.id, owner.principal)
      const archived = await archivedSummary(workspace.id, project.id, owner.principal)
      const results = await Promise.allSettled([
        promoteProjectState(connection.db, workspace.id, project.id, owner.principal, {
          confirmed: true,
          expectedVersion: archived.version,
        }),
        promoteProjectState(connection.db, workspace.id, project.id, owner.principal, {
          confirmed: true,
          expectedVersion: archived.version,
        }),
      ])
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      const rejected = results.filter((result) => result.status === 'rejected')
      expect(rejected).toHaveLength(1)
      const reason = (rejected[0] as PromiseRejectedResult).reason as { reason?: string }
      expect(['promotion_state_invalid', 'promotion_stale']).toContain(reason.reason)
      expect(await eventCount(workspace.id, 'project.restored')).toBe(1)
      const rows = await channelRows(workspace.id, project.id)
      expect(rows.every((channel) => channel.lifecycleState === 'active')).toBe(true)
      expect(rows.every((channel) => channel.version === 3)).toBe(true)
      expect(await eventCount(workspace.id, 'channel.restored')).toBe(rows.length)
    } finally {
      await cleanup({ outsider, owner, workspace })
    }
  })

  test('a concurrent channel restore CASes the version and never double-wakes', async () => {
    const { owner, outsider, project, workspace } = await fixture()
    try {
      await archiveProject(connection.db, workspace.id, project.id, owner.principal)
      const [first, second] = await Promise.all([
        connection.db.transaction((transaction) =>
          restoreProjectChannels(transaction, workspace.id, project.id, owner.principal)
        ),
        connection.db.transaction((transaction) =>
          restoreProjectChannels(transaction, workspace.id, project.id, owner.principal)
        ),
      ])
      // One transaction wins the row locks and wakes the cascade; the other
      // re-reads the committed state and wakes nothing.
      expect([first, second].toSorted()).toEqual([0, 1])
      const rows = await channelRows(workspace.id, project.id)
      expect(rows.every((channel) => channel.lifecycleState === 'active')).toBe(true)
      expect(rows.every((channel) => channel.version === 3)).toBe(true)
      expect(await eventCount(workspace.id, 'channel.restored')).toBe(rows.length)
    } finally {
      await cleanup({ outsider, owner, workspace })
    }
  })

  test('refuses a stale observed revision and leaves the project archived', async () => {
    const { owner, outsider, project, workspace } = await fixture()
    try {
      const beforeArchive = await archivedSummary(workspace.id, project.id, owner.principal)
      await archiveProject(connection.db, workspace.id, project.id, owner.principal)
      await expect(
        promoteProjectState(connection.db, workspace.id, project.id, owner.principal, {
          confirmed: true,
          expectedVersion: beforeArchive.version,
        })
      ).rejects.toMatchObject({
        name: 'ProjectStatePromotionError',
        reason: 'promotion_stale',
      })
      const stillArchived = await archivedSummary(workspace.id, project.id, owner.principal)
      expect(stillArchived.lifecycleState).toBe('archived')
    } finally {
      await cleanup({ outsider, owner, workspace })
    }
  })

  test('promotion is explicit opt-in and runs exactly once', async () => {
    const { owner, outsider, project, workspace } = await fixture()
    try {
      await archiveProject(connection.db, workspace.id, project.id, owner.principal)
      const archived = await archivedSummary(workspace.id, project.id, owner.principal)
      await expect(
        promoteProjectState(connection.db, workspace.id, project.id, owner.principal, {
          confirmed: false,
          expectedVersion: archived.version,
        })
      ).rejects.toMatchObject({ reason: 'promotion_not_confirmed' })
      expect(
        (await archivedSummary(workspace.id, project.id, owner.principal)).lifecycleState
      ).toBe('archived')

      await promoteProjectState(connection.db, workspace.id, project.id, owner.principal, {
        confirmed: true,
        expectedVersion: archived.version,
      })
      const active = await archivedSummary(workspace.id, project.id, owner.principal)
      await expect(
        promoteProjectState(connection.db, workspace.id, project.id, owner.principal, {
          confirmed: true,
          expectedVersion: active.version,
        })
      ).rejects.toMatchObject({ reason: 'promotion_state_invalid' })
      const restoredEvents = await connection.db
        .select({ eventType: workspaceEvents.eventType })
        .from(workspaceEvents)
        .where(
          and(
            eq(workspaceEvents.workspaceId, workspace.id),
            eq(workspaceEvents.eventType, 'project.restored')
          )
        )
      expect(restoredEvents).toHaveLength(1)
    } finally {
      await cleanup({ outsider, owner, workspace })
    }
  })

  test('a microsecond timestamp no longer blocks an exact revision', async () => {
    const { owner, outsider, project, workspace } = await fixture()
    try {
      await archiveProject(connection.db, workspace.id, project.id, owner.principal)
      // Postgres stores microseconds; the JS surface only milliseconds. The
      // integer revision is authoritative, so the exact observed version
      // still promotes even though the display timestamp is truncated.
      await connection.db.execute(
        sql`update app.projects set updated_at = '2026-10-09 12:00:00.123456+00' where id = ${project.id}`
      )
      const archived = await archivedSummary(workspace.id, project.id, owner.principal)
      expect(archived.updatedAt).toBe('2026-10-09T12:00:00.123Z')
      const promoted = await promoteProjectState(
        connection.db,
        workspace.id,
        project.id,
        owner.principal,
        { confirmed: true, expectedVersion: archived.version }
      )
      expect(promoted).toMatchObject({ id: project.id, lifecycleState: 'active' })
      expect(promoted.version).toBe(archived.version + 1)
    } finally {
      await cleanup({ outsider, owner, workspace })
    }
  })

  test('a same-millisecond edit still moves the revision token', async () => {
    const { owner, outsider, project, workspace } = await fixture()
    try {
      await archiveProject(connection.db, workspace.id, project.id, owner.principal)
      const observed = await archivedSummary(workspace.id, project.id, owner.principal)
      // Canonical project-row mutation while archived (visibility), then pin
      // the display timestamp to the observed millisecond: the timestamp is
      // identical, the revision is not.
      await setProjectVisibility(
        connection.db,
        workspace.id,
        project.id,
        owner.principal,
        'members'
      )
      await connection.db.execute(
        sql`update app.projects set updated_at = ${observed.updatedAt}::timestamptz where id = ${project.id}`
      )
      const edited = await archivedSummary(workspace.id, project.id, owner.principal)
      expect(edited.updatedAt).toBe(observed.updatedAt)
      expect(edited.version).toBe(observed.version + 1)
      await expect(
        promoteProjectState(connection.db, workspace.id, project.id, owner.principal, {
          confirmed: true,
          expectedVersion: observed.version,
        })
      ).rejects.toMatchObject({ reason: 'promotion_stale' })
      const promoted = await promoteProjectState(
        connection.db,
        workspace.id,
        project.id,
        owner.principal,
        { confirmed: true, expectedVersion: edited.version }
      )
      expect(promoted).toMatchObject({
        lifecycleState: 'active',
        version: edited.version + 1,
        visibility: 'members',
      })
    } finally {
      await cleanup({ outsider, owner, workspace })
    }
  })

  test('the typed refusal never carries project detail', () => {
    const error = new ProjectStatePromotionError('project_unavailable')
    expect(error.reason).toBe('project_unavailable')
    expect(error.message).toBe('Project unavailable')
  })
})
