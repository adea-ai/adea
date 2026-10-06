import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { and, eq } from 'drizzle-orm'

import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createTemporaryUserSession } from '../../src/identity'
import {
  archiveProject,
  createProject,
  getProjectForUser,
  listProjectsForUser,
  reorderProjects,
  softDeleteProject,
  updateProject,
} from '../../src/projects'
import {
  channels,
  projects,
  workspaceEvents,
  temporaryUserSessions,
  users,
  workspaceMemberships,
  workspaces,
} from '../../src/schema'
import { createWorkspaceWithOwner } from '../../src/workspaces'

const connectionUrl = process.env.DATABASE_URL

describe.skipIf(!connectionUrl)('project persistence and isolation', () => {
  let connection: DatabaseConnection

  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })

  afterAll(async () => {
    await connection.close()
  })

  test('persists, reorders, updates, archives, and isolates projects', async () => {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: `project-owner-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const outsider = await createTemporaryUserSession(connection.db, {
      credentialDigest: `project-outsider-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: 'projects',
      name: 'Project HQ',
      owner: owner.principal,
      scene: 'work',
    })

    const engineering = await createProject(connection.db, workspace.id, owner.principal, {
      iconKey: 'engineering',
      name: 'Engineering',
      sourceKind: 'repository',
    })
    expect(engineering.sourceKind).toBe('repository')
    expect(Object.keys(engineering).toSorted()).toEqual([
      'createdAt',
      'iconKey',
      'id',
      'lifecycleState',
      'name',
      'sortOrder',
      'sourceKind',
      'updatedAt',
      'visibility',
      'workspaceId',
    ])
    const operations = await createProject(connection.db, workspace.id, owner.principal, {
      iconKey: 'operations',
      name: 'Operations',
    })

    expect(await listProjectsForUser(connection.db, workspace.id, owner.principal)).toEqual([
      engineering,
      operations,
    ])
    expect(
      await getProjectForUser(connection.db, workspace.id, engineering.id, outsider.principal)
    ).toBeNull()
    await expect(
      updateProject(connection.db, workspace.id, engineering.id, outsider.principal, {
        name: 'Leaked',
      })
    ).rejects.toThrow('Project unavailable')

    const reordered = await reorderProjects(connection.db, workspace.id, owner.principal, [
      operations.id,
      engineering.id,
    ])
    expect(reordered.map(({ id, sortOrder }) => [id, sortOrder])).toEqual([
      [operations.id, 0],
      [engineering.id, 1],
    ])

    const updated = await updateProject(
      connection.db,
      workspace.id,
      engineering.id,
      owner.principal,
      {
        iconKey: 'build',
        name: 'Product Engineering',
        sourceKind: 'none',
      }
    )
    expect(updated).toMatchObject({
      iconKey: 'build',
      name: 'Product Engineering',
      sourceKind: 'none',
    })

    await archiveProject(connection.db, workspace.id, operations.id, owner.principal)
    expect(await listProjectsForUser(connection.db, workspace.id, owner.principal)).toEqual([
      expect.objectContaining({ id: engineering.id, lifecycleState: 'active' }),
    ])

    await connection.db.delete(channels).where(eq(channels.workspaceId, workspace.id))
    await connection.db.delete(projects).where(eq(projects.workspaceId, workspace.id))
    await connection.db
      .delete(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, workspace.id))
    await connection.db.delete(workspaces).where(eq(workspaces.id, workspace.id))
    for (const principal of [owner.principal, outsider.principal]) {
      await connection.db
        .delete(temporaryUserSessions)
        .where(eq(temporaryUserSessions.userId, principal.userId))
      await connection.db.delete(users).where(eq(users.id, principal.userId))
    }
  })

  test('rejects incomplete, duplicate, and cross-workspace reorder requests', async () => {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: `project-order-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const firstWorkspace = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: 'project-order-a',
      name: 'First HQ',
      owner: owner.principal,
    })
    const secondWorkspace = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: 'project-order-b',
      name: 'Second HQ',
      owner: owner.principal,
    })
    const first = await createProject(connection.db, firstWorkspace.workspace.id, owner.principal, {
      iconKey: 'general',
      name: 'First',
    })
    const second = await createProject(
      connection.db,
      firstWorkspace.workspace.id,
      owner.principal,
      {
        iconKey: 'general',
        name: 'Second',
      }
    )
    const other = await createProject(
      connection.db,
      secondWorkspace.workspace.id,
      owner.principal,
      {
        iconKey: 'general',
        name: 'Other',
      }
    )

    await expect(
      reorderProjects(connection.db, firstWorkspace.workspace.id, owner.principal, [first.id])
    ).rejects.toThrow('Project order conflict')
    await expect(
      reorderProjects(connection.db, firstWorkspace.workspace.id, owner.principal, [
        first.id,
        first.id,
      ])
    ).rejects.toThrow('Project order conflict')
    await expect(
      reorderProjects(connection.db, firstWorkspace.workspace.id, owner.principal, [
        first.id,
        other.id,
      ])
    ).rejects.toThrow('Project order conflict')

    for (const workspaceId of [firstWorkspace.workspace.id, secondWorkspace.workspace.id]) {
      await connection.db.delete(channels).where(eq(channels.workspaceId, workspaceId))
      await connection.db.delete(projects).where(eq(projects.workspaceId, workspaceId))
      await connection.db
        .delete(workspaceMemberships)
        .where(eq(workspaceMemberships.workspaceId, workspaceId))
      await connection.db.delete(workspaces).where(eq(workspaces.id, workspaceId))
    }
    await connection.db
      .delete(temporaryUserSessions)
      .where(eq(temporaryUserSessions.userId, owner.principal.userId))
    await connection.db.delete(users).where(eq(users.id, owner.principal.userId))
    expect(second.id).not.toBe(first.id)
  })
  test('honours client-supplied ids idempotently and never across workspaces', async () => {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: `project-id-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const outsider = await createTemporaryUserSession(connection.db, {
      credentialDigest: `project-id-outsider-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: 'project-ids',
      name: 'Id HQ',
      owner: owner.principal,
    })
    const foreign = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: 'project-ids-foreign',
      name: 'Foreign HQ',
      owner: outsider.principal,
    })
    const id = crypto.randomUUID()
    const input = { iconKey: 'study', id, name: 'Thesis' } as const

    const created = await createProject(connection.db, workspace.id, owner.principal, input)
    const replayed = await createProject(connection.db, workspace.id, owner.principal, input)
    expect(created.id).toBe(id)
    expect(replayed).toEqual(created)
    const primaryChannels = await connection.db
      .select({ idempotencyKey: channels.idempotencyKey, kind: channels.kind })
      .from(channels)
      .where(and(eq(channels.workspaceId, workspace.id), eq(channels.projectId, id)))
    expect(primaryChannels).toEqual([{ idempotencyKey: `primary-project:${id}`, kind: 'project' }])
    const createdEvents = await connection.db
      .select({ aggregateType: workspaceEvents.aggregateType })
      .from(workspaceEvents)
      .where(
        and(
          eq(workspaceEvents.workspaceId, workspace.id),
          eq(workspaceEvents.eventType, 'project.created')
        )
      )
    expect(createdEvents).toEqual([{ aggregateType: 'project' }])

    await expect(
      createProject(connection.db, workspace.id, owner.principal, { ...input, name: 'Other' })
    ).rejects.toThrow('Project id conflict')
    await expect(
      createProject(connection.db, foreign.workspace.id, outsider.principal, input)
    ).rejects.toThrow('Project unavailable')
    await expect(
      createProject(connection.db, workspace.id, owner.principal, { ...input, id: 'not-a-uuid' })
    ).rejects.toThrow('Project id invalid')
    expect(
      await getProjectForUser(connection.db, workspace.id, 'not-a-uuid', owner.principal)
    ).toBe(null)

    for (const workspaceId of [workspace.id, foreign.workspace.id]) {
      await connection.db.delete(channels).where(eq(channels.workspaceId, workspaceId))
      await connection.db.delete(projects).where(eq(projects.workspaceId, workspaceId))
      await connection.db
        .delete(workspaceMemberships)
        .where(eq(workspaceMemberships.workspaceId, workspaceId))
      await connection.db.delete(workspaces).where(eq(workspaces.id, workspaceId))
    }
    for (const principal of [owner.principal, outsider.principal]) {
      await connection.db
        .delete(temporaryUserSessions)
        .where(eq(temporaryUserSessions.userId, principal.userId))
      await connection.db.delete(users).where(eq(users.id, principal.userId))
    }
  })

  test('soft-deletes projects and denies every write to non-members', async () => {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: `project-delete-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const outsider = await createTemporaryUserSession(connection.db, {
      credentialDigest: `project-delete-outsider-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: 'project-delete',
      name: 'Delete HQ',
      owner: owner.principal,
    })
    const kept = await createProject(connection.db, workspace.id, owner.principal, {
      iconKey: 'garden',
      name: 'Kept',
    })
    const doomed = await createProject(connection.db, workspace.id, owner.principal, {
      iconKey: 'gym',
      name: 'Doomed',
    })

    await expect(
      createProject(connection.db, workspace.id, outsider.principal, { iconKey: 'x', name: 'X' })
    ).rejects.toThrow('Project unavailable')
    await expect(
      archiveProject(connection.db, workspace.id, kept.id, outsider.principal)
    ).rejects.toThrow('Project unavailable')
    await expect(
      softDeleteProject(connection.db, workspace.id, kept.id, outsider.principal)
    ).rejects.toThrow('Project unavailable')
    await expect(
      reorderProjects(connection.db, workspace.id, outsider.principal, [doomed.id, kept.id])
    ).rejects.toThrow('Project unavailable')
    await expect(
      listProjectsForUser(connection.db, workspace.id, outsider.principal)
    ).rejects.toThrow('Project unavailable')

    await softDeleteProject(connection.db, workspace.id, doomed.id, owner.principal)
    expect(
      await listProjectsForUser(connection.db, workspace.id, owner.principal, {
        includeArchived: true,
      })
    ).toEqual([expect.objectContaining({ id: kept.id })])
    expect(
      await getProjectForUser(connection.db, workspace.id, doomed.id, owner.principal, {
        includeArchived: true,
      })
    ).toBeNull()
    await expect(
      updateProject(connection.db, workspace.id, doomed.id, owner.principal, { name: 'Back' })
    ).rejects.toThrow('Project unavailable')
    await expect(
      softDeleteProject(connection.db, workspace.id, doomed.id, owner.principal)
    ).rejects.toThrow('Project unavailable')
    await expect(
      createProject(connection.db, workspace.id, owner.principal, {
        iconKey: 'gym',
        id: doomed.id,
        name: 'Doomed',
      })
    ).rejects.toThrow('Project unavailable')
    const [row] = await connection.db.select().from(projects).where(eq(projects.id, doomed.id))
    expect(row?.deletedAt).toBeInstanceOf(Date)
    expect(row?.lifecycleState).toBe('archived')
    const doomedChannels = await connection.db
      .select({ lifecycleState: channels.lifecycleState })
      .from(channels)
      .where(eq(channels.projectId, doomed.id))
    expect(doomedChannels.every(({ lifecycleState }) => lifecycleState === 'archived')).toBe(true)
    // Reorder now covers only the remaining active project.
    expect(
      (await reorderProjects(connection.db, workspace.id, owner.principal, [kept.id])).map(
        ({ id }) => id
      )
    ).toEqual([kept.id])

    await connection.db.delete(channels).where(eq(channels.workspaceId, workspace.id))
    await connection.db.delete(projects).where(eq(projects.workspaceId, workspace.id))
    await connection.db
      .delete(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, workspace.id))
    await connection.db.delete(workspaces).where(eq(workspaces.id, workspace.id))
    for (const principal of [owner.principal, outsider.principal]) {
      await connection.db
        .delete(temporaryUserSessions)
        .where(eq(temporaryUserSessions.userId, principal.userId))
      await connection.db.delete(users).where(eq(users.id, principal.userId))
    }
  })
})
