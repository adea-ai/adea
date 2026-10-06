import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createTemporaryUserSession } from '../../src/identity'
import {
  archiveAgent,
  assignAgentToProject,
  changeAgentProfile,
  createAgent,
  getAgentForUser,
  listAgentsForUser,
  updateAgentPresentation,
} from '../../src/agents'
import { createProject } from '../../src/projects'
import {
  agents,
  channels,
  projects,
  temporaryUserSessions,
  users,
  workspaceMemberships,
  workspaces,
} from '../../src/schema'
import { createWorkspaceWithOwner } from '../../src/workspaces'

const connectionUrl = process.env.DATABASE_URL

describe.skipIf(!connectionUrl)('persistent Agent identity', () => {
  let connection: DatabaseConnection

  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })
  afterAll(async () => connection.close())

  test('preserves identity while project, presentation, and explicit profile version change', async () => {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: `agent-owner-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const outsider = await createTemporaryUserSession(connection.db, {
      credentialDigest: `agent-outsider-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: 'agents',
      name: 'Adea',
      owner: owner.principal,
    })
    const project = await createProject(connection.db, workspace.id, owner.principal, {
      iconKey: 'engineering',
      name: 'Engineering',
    })
    const created = await createAgent(connection.db, workspace.id, owner.principal, {
      name: 'Ada',
      profileId: 'software-engineer',
      profileVersion: '1.0.0',
      roleSummary: 'Builds reliable systems',
    })

    expect(created.lifecycleState).toBe('active')
    expect(created.profile).toEqual({
      id: 'software-engineer',
      state: 'available',
      version: '1.0.0',
    })
    expect(
      await getAgentForUser(connection.db, workspace.id, created.id, outsider.principal)
    ).toBeNull()

    const assigned = await assignAgentToProject(
      connection.db,
      workspace.id,
      created.id,
      owner.principal,
      project.id
    )
    const customized = await updateAgentPresentation(
      connection.db,
      workspace.id,
      created.id,
      owner.principal,
      {
        avatarRef: 'avatar:ada',
        characterRef: 'character:75',
        name: 'Ada Lovelace',
        presentationMetadata: { accent: 'violet' },
        roleSummary: 'Principal systems engineer',
      }
    )
    const changed = await changeAgentProfile(
      connection.db,
      workspace.id,
      created.id,
      owner.principal,
      {
        profileId: 'software-engineer',
        profileState: 'deprecated',
        profileVersion: '1.1.0',
      }
    )
    expect(assigned.id).toBe(created.id)
    expect(customized.id).toBe(created.id)
    expect(changed).toMatchObject({ id: created.id, projectId: project.id })
    expect(changed.profile).toEqual({
      id: 'software-engineer',
      state: 'deprecated',
      version: '1.1.0',
    })
    expect(await listAgentsForUser(connection.db, workspace.id, owner.principal)).toEqual([changed])

    await archiveAgent(connection.db, workspace.id, created.id, owner.principal)
    expect(await listAgentsForUser(connection.db, workspace.id, owner.principal)).toEqual([])

    await connection.db.delete(agents).where(eq(agents.workspaceId, workspace.id))
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

  test('rejects assigning an Agent to a Project from another workspace', async () => {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: `agent-project-scope-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const a = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: 'agent-a',
      name: 'A',
      owner: owner.principal,
    })
    const b = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: 'agent-b',
      name: 'B',
      owner: owner.principal,
    })
    const agent = await createAgent(connection.db, a.workspace.id, owner.principal, {
      name: 'Scoped',
      profileId: 'general',
      profileVersion: '1',
    })
    const otherProject = await createProject(connection.db, b.workspace.id, owner.principal, {
      iconKey: 'general',
      name: 'Other',
    })

    await expect(
      assignAgentToProject(
        connection.db,
        a.workspace.id,
        agent.id,
        owner.principal,
        otherProject.id
      )
    ).rejects.toThrow('Project unavailable')

    await connection.db.delete(agents).where(eq(agents.workspaceId, a.workspace.id))
    for (const workspaceId of [a.workspace.id, b.workspace.id])
      await connection.db.delete(channels).where(eq(channels.workspaceId, workspaceId))
    await connection.db.delete(projects).where(eq(projects.workspaceId, b.workspace.id))
    for (const workspaceId of [a.workspace.id, b.workspace.id]) {
      await connection.db
        .delete(workspaceMemberships)
        .where(eq(workspaceMemberships.workspaceId, workspaceId))
      await connection.db.delete(workspaces).where(eq(workspaces.id, workspaceId))
    }
    await connection.db
      .delete(temporaryUserSessions)
      .where(eq(temporaryUserSessions.userId, owner.principal.userId))
    await connection.db.delete(users).where(eq(users.id, owner.principal.userId))
  })
})
