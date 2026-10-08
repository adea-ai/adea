import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createTemporaryUserSession } from '../../src/identity'
import {
  archiveAgent,
  createAgent,
  ensureWorkspaceLead,
  getWorkspaceLeadForUser,
  updateAgentPresentation,
} from '../../src/agents'
import { agents, workspaceEvents, workspaceMemberships } from '../../src/schema'
import { createWorkspaceWithOwner } from '../../src/workspaces'

const connectionUrl = process.env.DATABASE_URL

describe.skipIf(!connectionUrl)('structural workspace lead', () => {
  let connection: DatabaseConnection
  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })
  afterAll(async () => connection.close())

  test('provisions exactly one lead under concurrent retries without replacing existing Agents', async () => {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: `lead-owner-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'Lead fixture',
      owner: owner.principal,
    })
    const custom = await createAgent(connection.db, workspace.id, owner.principal, {
      name: 'Custom',
      profileId: 'custom-profile',
      profileVersion: '1',
    })
    const archived = await createAgent(connection.db, workspace.id, owner.principal, {
      name: 'Archived',
      profileId: 'historical-profile',
      profileVersion: '1',
    })
    await archiveAgent(connection.db, workspace.id, archived.id, owner.principal)
    expect(await getWorkspaceLeadForUser(connection.db, workspace.id, owner.principal)).toBeNull()
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        ensureWorkspaceLead(connection.db, workspace.id, owner.principal)
      )
    )
    expect(new Set(results.map((lead) => lead.id)).size).toBe(1)
    const lead = results[0]!
    expect(lead).toMatchObject({
      isWorkspaceLead: true,
      workspaceId: workspace.id,
      lifecycleState: 'active',
      profile: { state: 'missing', revision: 0 },
    })
    expect(lead.projectId).toBeUndefined()
    const renamed = await updateAgentPresentation(
      connection.db,
      workspace.id,
      lead.id,
      owner.principal,
      { name: 'My lead', roleSummary: 'Customized lead' }
    )
    expect(await ensureWorkspaceLead(connection.db, workspace.id, owner.principal)).toEqual(renamed)
    const rows = await connection.db
      .select()
      .from(agents)
      .where(eq(agents.workspaceId, workspace.id))
    expect(rows).toHaveLength(3)
    expect(rows.find((row) => row.id === custom.id)).toMatchObject({
      profileId: 'custom-profile',
      isWorkspaceLead: false,
    })
    expect(rows.find((row) => row.id === archived.id)).toMatchObject({
      lifecycleState: 'archived',
      isWorkspaceLead: false,
    })
    const events = await connection.db
      .select()
      .from(workspaceEvents)
      .where(eq(workspaceEvents.workspaceId, workspace.id))
    expect(events.filter((event) => event.eventType === 'agent.created')).toHaveLength(3)
    await expect(
      archiveAgent(connection.db, workspace.id, lead.id, owner.principal)
    ).rejects.toThrow('Agent unavailable')
    await expect(
      connection.db
        .insert(agents)
        .values({
          workspaceId: workspace.id,
          name: 'Duplicate',
          profileId: 'p',
          profileVersion: '1',
          isWorkspaceLead: true,
        })
        .execute()
    ).rejects.toThrow()
  })

  test('denies outsiders, member provisioning, and cross-workspace discovery without side effects', async () => {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: `lead-scope-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const outsider = await createTemporaryUserSession(connection.db, {
      credentialDigest: `lead-denied-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'Private',
      owner: owner.principal,
    })
    await expect(
      ensureWorkspaceLead(connection.db, workspace.id, outsider.principal)
    ).rejects.toThrow('Agent unavailable')
    expect(
      await getWorkspaceLeadForUser(connection.db, workspace.id, outsider.principal)
    ).toBeNull()
    expect(
      await connection.db.select().from(agents).where(eq(agents.workspaceId, workspace.id))
    ).toHaveLength(0)
    await connection.db
      .insert(workspaceMemberships)
      .values({ workspaceId: workspace.id, userId: outsider.principal.userId, role: 'member' })
    await expect(
      ensureWorkspaceLead(connection.db, workspace.id, outsider.principal)
    ).rejects.toThrow('Agent unavailable')
    await ensureWorkspaceLead(connection.db, workspace.id, owner.principal)
    expect(
      await getWorkspaceLeadForUser(connection.db, crypto.randomUUID(), owner.principal)
    ).toBeNull()
  })
})
