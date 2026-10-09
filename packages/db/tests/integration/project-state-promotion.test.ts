// Integration coverage for explicit project-state promotion (M14.03.2,
// adea#1218): the promotion flips archived to active at the exact observed
// revision with explicit opt-in, preserves visibility, wakes the archived
// project channels, and refuses stale, unconfirmed, repeat and foreign
// attempts without touching the row.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { and, eq } from 'drizzle-orm'

import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createTemporaryUserSession } from '../../src/identity'
import {
  archiveProject,
  createProject,
  getProjectForUser,
  listProjectsForUser,
} from '../../src/projects'
import { setProjectVisibility } from '../../src/project-sharing'
import { ProjectStatePromotionError, promoteProjectState } from '../../src/project-state-policy'
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

      const promoted = await promoteProjectState(
        connection.db,
        workspace.id,
        project.id,
        owner.principal,
        { confirmed: true, expectedUpdatedAt: archived.updatedAt }
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
      const projectChannels = await connection.db
        .select({ lifecycleState: channels.lifecycleState, version: channels.version })
        .from(channels)
        .where(and(eq(channels.workspaceId, workspace.id), eq(channels.projectId, project.id)))
      expect(projectChannels.length).toBeGreaterThan(0)
      expect(projectChannels.every((channel) => channel.lifecycleState === 'active')).toBe(true)
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
          expectedUpdatedAt: archived.updatedAt,
        })
      ).rejects.toThrow('Project unavailable')
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
          expectedUpdatedAt: beforeArchive.updatedAt,
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
          expectedUpdatedAt: archived.updatedAt,
        })
      ).rejects.toMatchObject({ reason: 'promotion_not_confirmed' })
      expect(
        (await archivedSummary(workspace.id, project.id, owner.principal)).lifecycleState
      ).toBe('archived')

      await promoteProjectState(connection.db, workspace.id, project.id, owner.principal, {
        confirmed: true,
        expectedUpdatedAt: archived.updatedAt,
      })
      const active = await archivedSummary(workspace.id, project.id, owner.principal)
      await expect(
        promoteProjectState(connection.db, workspace.id, project.id, owner.principal, {
          confirmed: true,
          expectedUpdatedAt: active.updatedAt,
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

  test('the typed refusal never carries project detail', () => {
    const error = new ProjectStatePromotionError('project_unavailable')
    expect(error.reason).toBe('project_unavailable')
    expect(error.message).toBe('Project unavailable')
  })
})
