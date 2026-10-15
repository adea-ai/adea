// Persona changes keep an Agent's audience and grants (M14.03.2, adea#1218).
//
// `agent-persona-policy` proves the decision on plain objects. This suite runs
// the real transactions against Postgres and checks the consequence the issue
// cares about: re-pinning a profile or editing presentation touches only the
// Agent's own persona columns, never its audience, enlistment, sharing,
// admission or artifact-reference grants, never its placement or lead
// designation, and a refused, stale or revoked change writes nothing at all.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { and, eq, inArray } from 'drizzle-orm'

import {
  AgentPersonaPolicyError,
  AgentProfileConflictError,
  archiveAgent,
  assignAgentToProject,
  changeAgentProfile,
  createAgent,
  ensureWorkspaceLead,
  updateAgentPresentation,
} from '../../src/index'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createTemporaryUserSession } from '../../src/identity'
import { createProject } from '../../src/projects'
import * as schema from '../../src/schema'
import { createWorkspaceWithOwner } from '../../src/workspaces'

const connectionUrl = process.env.DATABASE_URL

const ISSUED = '2026-10-01T00:00:00.000Z'

describe.skipIf(!connectionUrl)('persona changes preserve audience and grants', () => {
  let connection: DatabaseConnection
  const cleanup: Array<() => Promise<unknown>> = []

  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })
  afterAll(async () => {
    for (const run of cleanup.toReversed()) await run().catch(() => undefined)
    await connection.close()
  })

  async function world() {
    const db = connection.db
    const session = () =>
      createTemporaryUserSession(db, {
        credentialDigest: `persona-grants-${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 60_000),
      })
    const owner = await session()
    const outsider = await session()
    const { workspace } = await createWorkspaceWithOwner(db, {
      idempotencyKey: `persona-grants-${crypto.randomUUID()}`,
      name: 'Persona grants',
      owner: owner.principal,
    })
    const { workspace: audience } = await createWorkspaceWithOwner(db, {
      idempotencyKey: `persona-grants-audience-${crypto.randomUUID()}`,
      name: 'Persona grants audience',
      owner: outsider.principal,
    })
    const project = await createProject(db, workspace.id, owner.principal, {
      iconKey: 'engineering',
      name: 'Engineering',
    })
    const other = await createProject(db, workspace.id, owner.principal, {
      iconKey: 'engineering',
      name: 'Elsewhere',
    })
    const created = await createAgent(db, workspace.id, owner.principal, {
      name: 'Ada',
      profileId: 'software-engineer',
      profileVersion: '1.0.0',
      roleSummary: 'Builds reliable systems',
    })
    const agent = await assignAgentToProject(db, workspace.id, created.id, owner.principal, {
      expectedRevision: created.revision ?? 0,
      projectId: project.id,
    })
    const lead = await ensureWorkspaceLead(db, workspace.id, owner.principal)

    const [channel] = await db
      .insert(schema.channels)
      .values({
        workspaceId: workspace.id,
        kind: 'group',
        title: 'Persona group',
        idempotencyKey: `persona-group-${crypto.randomUUID()}`,
      })
      .returning()
    // One grant of every kind that names this Agent or its audience, one of
    // them already revoked: a persona change must not revive it either.
    await db.insert(schema.groupAudienceGrants).values({
      workspaceId: workspace.id,
      channelId: channel!.id,
      grantId: 'audience-1',
      revision: 1,
      userId: owner.principal.userId,
      issuedAt: ISSUED,
    })
    await db.insert(schema.groupEnlistmentGrants).values({
      workspaceId: workspace.id,
      channelId: channel!.id,
      grantId: 'enlist-1',
      revision: 2,
      agentId: agent.id,
      issuedAt: ISSUED,
      expiresAt: '2027-10-01T00:00:00.000Z',
    })
    await db.insert(schema.groupSharingGrants).values({
      workspaceId: workspace.id,
      channelId: channel!.id,
      grantId: 'share-revoked',
      revision: 1,
      principalKind: 'agent',
      agentId: agent.id,
      scope: 'earlier_history',
      issuedAt: ISSUED,
      revokedAt: '2026-10-02T00:00:00.000Z',
    })
    await db.insert(schema.groupAdmissions).values({
      workspaceId: workspace.id,
      channelId: channel!.id,
      principalKind: 'agent',
      agentId: agent.id,
      joinedSequence: 4,
      joinedAt: ISSUED,
      authGroupId: 'group-1',
      authGrantId: 'enlist-1',
      authRevision: 2,
    })
    await db.insert(schema.artifactReferenceGrants).values({
      grantId: `artifact-grant-${crypto.randomUUID()}`,
      sourceWorkspaceId: workspace.id,
      audienceWorkspaceId: audience.id,
      artifactId: crypto.randomUUID(),
      version: 1,
      checksumSha256: 'a'.repeat(64),
      revision: 1,
    })

    cleanup.push(async () => {
      await db
        .delete(schema.artifactReferenceGrants)
        .where(eq(schema.artifactReferenceGrants.sourceWorkspaceId, workspace.id))
      await db.delete(schema.agents).where(eq(schema.agents.workspaceId, workspace.id))
      await db.delete(schema.channels).where(eq(schema.channels.workspaceId, workspace.id))
      await db.delete(schema.projects).where(eq(schema.projects.workspaceId, workspace.id))
      for (const id of [workspace.id, audience.id]) {
        await db
          .delete(schema.workspaceMemberships)
          .where(eq(schema.workspaceMemberships.workspaceId, id))
        await db.delete(schema.workspaces).where(eq(schema.workspaces.id, id))
      }
      for (const principal of [owner.principal, outsider.principal]) {
        await db
          .delete(schema.temporaryUserSessions)
          .where(eq(schema.temporaryUserSessions.userId, principal.userId))
        await db.delete(schema.users).where(eq(schema.users.id, principal.userId))
      }
    })

    /** Every row that carries an audience or grant for this world, as stored. */
    async function grants() {
      return {
        audience: await db
          .select()
          .from(schema.groupAudienceGrants)
          .where(eq(schema.groupAudienceGrants.workspaceId, workspace.id)),
        enlistment: await db
          .select()
          .from(schema.groupEnlistmentGrants)
          .where(eq(schema.groupEnlistmentGrants.workspaceId, workspace.id)),
        sharing: await db
          .select()
          .from(schema.groupSharingGrants)
          .where(eq(schema.groupSharingGrants.workspaceId, workspace.id)),
        admissions: await db
          .select()
          .from(schema.groupAdmissions)
          .where(eq(schema.groupAdmissions.workspaceId, workspace.id)),
        artifacts: await db
          .select()
          .from(schema.artifactReferenceGrants)
          .where(eq(schema.artifactReferenceGrants.sourceWorkspaceId, workspace.id)),
      }
    }
    /** The Agent's structural authority, exactly as stored. */
    async function authority(agentId: string) {
      const [row] = await db
        .select({
          id: schema.agents.id,
          workspaceId: schema.agents.workspaceId,
          projectId: schema.agents.projectId,
          isWorkspaceLead: schema.agents.isWorkspaceLead,
          lifecycleState: schema.agents.lifecycleState,
          revision: schema.agents.revision,
        })
        .from(schema.agents)
        .where(eq(schema.agents.id, agentId))
      return row
    }
    async function agentRow(agentId: string) {
      const [row] = await db.select().from(schema.agents).where(eq(schema.agents.id, agentId))
      return row
    }
    async function eventTypes() {
      const rows = await db
        .select({ eventType: schema.workspaceEvents.eventType })
        .from(schema.workspaceEvents)
        .where(eq(schema.workspaceEvents.workspaceId, workspace.id))
        .orderBy(schema.workspaceEvents.workspaceSequence)
      return rows.map((row) => row.eventType)
    }
    return {
      db,
      owner,
      outsider,
      workspace,
      project,
      other,
      agent,
      lead,
      grants,
      authority,
      agentRow,
      eventTypes,
    }
  }

  test('a profile re-pin and a presentation edit leave every grant, the placement and the lead designation as stored', async () => {
    const w = await world()
    const grantsBefore = await w.grants()
    expect(grantsBefore.enlistment).toHaveLength(1)
    expect(grantsBefore.sharing[0]?.revokedAt).not.toBeNull()
    const agentBefore = await w.authority(w.agent.id)
    const leadBefore = await w.authority(w.lead.id)
    const eventsBefore = await w.eventTypes()

    const customized = await updateAgentPresentation(
      w.db,
      w.workspace.id,
      w.agent.id,
      w.owner.principal,
      {
        expectedRevision: w.agent.revision ?? 0,
        name: 'Ada Lovelace',
        presentationMetadata: { accent: 'violet' },
        roleSummary: 'Principal systems engineer',
      }
    )
    const repinned = await changeAgentProfile(w.db, w.workspace.id, w.agent.id, w.owner.principal, {
      expectedRevision: 0,
      profileId: 'staff-engineer',
      profileState: 'deprecated',
      profileVersion: '2.0.0',
    })
    const leadRepinned = await changeAgentProfile(
      w.db,
      w.workspace.id,
      w.lead.id,
      w.owner.principal,
      {
        expectedRevision: w.lead.profile.revision ?? 0,
        profileId: 'chief-of-staff',
        profileVersion: '3.0.0',
      }
    )

    // The persona moved...
    expect(customized.name).toBe('Ada Lovelace')
    expect(repinned.profile).toMatchObject({ id: 'staff-engineer', version: '2.0.0', revision: 1 })
    expect(leadRepinned.profile).toMatchObject({ id: 'chief-of-staff', version: '3.0.0' })
    // ...and nothing that confers authority did.
    expect(await w.grants()).toEqual(grantsBefore)
    const agentAfter = await w.authority(w.agent.id)
    expect(agentAfter).toEqual({ ...agentBefore, revision: agentBefore!.revision + 1 })
    expect(await w.authority(w.lead.id)).toEqual(leadBefore)
    expect(agentAfter).toMatchObject({ projectId: w.project.id, isWorkspaceLead: false })
    expect((await w.authority(w.lead.id))!.isWorkspaceLead).toBe(true)
    // Only persona events were appended: no grant, placement or lead event.
    expect((await w.eventTypes()).slice(eventsBefore.length)).toEqual([
      'agent.presentation_updated',
      'agent.profile_changed',
      'agent.profile_changed',
    ])
  })

  test('a change that names an authority field is refused and writes nothing', async () => {
    const w = await world()
    const grantsBefore = await w.grants()
    const rowBefore = await w.agentRow(w.agent.id)
    const eventsBefore = await w.eventTypes()
    const attempts: ReadonlyArray<Record<string, unknown>> = [
      { projectId: w.other.id },
      { projectId: null },
      { isWorkspaceLead: true },
      { lifecycleState: 'archived' },
      { workspaceId: crypto.randomUUID() },
      { id: crypto.randomUUID() },
      { profileRevision: 99 },
    ]
    for (const attempt of attempts) {
      const error = await changeAgentProfile(w.db, w.workspace.id, w.agent.id, w.owner.principal, {
        expectedRevision: 0,
        profileId: 'staff-engineer',
        profileVersion: '2.0.0',
        ...attempt,
      } as never).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(AgentPersonaPolicyError)
      expect((error as AgentPersonaPolicyError).reason).toBe('persona_change_would_broaden_grants')
    }
    expect(await w.agentRow(w.agent.id)).toEqual(rowBefore)
    expect(await w.grants()).toEqual(grantsBefore)
    expect(await w.eventTypes()).toEqual(eventsBefore)
  })

  test('a stale revision, a missing manager and an archived Agent each write nothing', async () => {
    const w = await world()
    const grantsBefore = await w.grants()
    const rowBefore = await w.agentRow(w.agent.id)
    const eventsBefore = await w.eventTypes()
    const request = { profileId: 'staff-engineer', profileVersion: '2.0.0' }

    await expect(
      changeAgentProfile(w.db, w.workspace.id, w.agent.id, w.owner.principal, {
        ...request,
        expectedRevision: 5,
      })
    ).rejects.toBeInstanceOf(AgentProfileConflictError)
    // A principal with no membership holds no persona authority.
    await expect(
      changeAgentProfile(w.db, w.workspace.id, w.agent.id, w.outsider.principal, {
        ...request,
        expectedRevision: 0,
      })
    ).rejects.toThrow('Agent unavailable')
    expect(await w.agentRow(w.agent.id)).toEqual(rowBefore)
    expect(await w.grants()).toEqual(grantsBefore)
    expect(await w.eventTypes()).toEqual(eventsBefore)

    await archiveAgent(w.db, w.workspace.id, w.agent.id, w.owner.principal)
    const archivedRow = await w.agentRow(w.agent.id)
    const archivedEvents = await w.eventTypes()
    await expect(
      changeAgentProfile(w.db, w.workspace.id, w.agent.id, w.owner.principal, {
        ...request,
        expectedRevision: 0,
      })
    ).rejects.toThrow('Agent unavailable')
    await expect(
      updateAgentPresentation(w.db, w.workspace.id, w.agent.id, w.owner.principal, {
        expectedRevision: w.agent.revision ?? 0,
        name: 'Revived',
      })
    ).rejects.toThrow('Agent unavailable')
    // An archived Agent stays archived with its persona and grants as they were.
    expect(await w.agentRow(w.agent.id)).toEqual(archivedRow)
    expect((await w.agentRow(w.agent.id))!.lifecycleState).toBe('archived')
    expect(await w.eventTypes()).toEqual(archivedEvents)
    expect(await w.grants()).toEqual(grantsBefore)
  })

  test('a persona change racing an archive ends archived, never revived, with grants intact', async () => {
    const w = await world()
    const grantsBefore = await w.grants()
    const outcomes = await Promise.allSettled([
      changeAgentProfile(w.db, w.workspace.id, w.agent.id, w.owner.principal, {
        expectedRevision: 0,
        profileId: 'staff-engineer',
        profileVersion: '2.0.0',
      }),
      archiveAgent(w.db, w.workspace.id, w.agent.id, w.owner.principal),
    ])
    expect(outcomes[1]?.status).toBe('fulfilled')
    const row = await w.agentRow(w.agent.id)
    expect(row!.lifecycleState).toBe('archived')
    expect(row!.projectId).toBe(w.project.id)
    expect(await w.grants()).toEqual(grantsBefore)
    // Whatever the interleaving, the profile pin is either the old or the new
    // one in full, never a mix.
    expect([
      ['software-engineer', '1.0.0', 0],
      ['staff-engineer', '2.0.0', 1],
    ]).toContainEqual([row!.profileId, row!.profileVersion, row!.profileRevision])
    expect(
      await w.db
        .select({ id: schema.agents.id })
        .from(schema.agents)
        .where(
          and(
            eq(schema.agents.workspaceId, w.workspace.id),
            inArray(schema.agents.lifecycleState, ['active'])
          )
        )
    ).toEqual([{ id: w.lead.id }])
  })
})
