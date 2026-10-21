import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'

import { createAgent, archiveAgent } from '../../src/agents'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { groupAgentCandidateKey, listGroupAgentCandidates } from '../../src/group-agent-candidates'
import { requireAgentEnlistmentSource } from '../../src/group-participation-store'
import { createTemporaryUserSession } from '../../src/identity'
import {
  agents,
  groupAdmissions,
  groupEnlistmentGrants,
  workspaceMemberships,
  workspaces,
} from '../../src/schema'
import { createWorkspaceWithOwner } from '../../src/workspaces'

const connectionUrl = process.env.DATABASE_URL

describe.skipIf(!connectionUrl)('tenant-authorized foreign-Agent candidates', () => {
  let connection: DatabaseConnection

  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })
  afterAll(async () => connection.close())

  async function session(label: string) {
    return createTemporaryUserSession(connection.db, {
      credentialDigest: `group-agent-candidates-${label}-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
  }

  test('lists a foreign Agent only where the requester holds source-workspace authority', async () => {
    const owner = await session('owner')
    const { workspace: tenant } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: 'group-agent-candidates-tenant',
      name: 'Tenant',
      owner: owner.principal,
    })
    const { workspace: source } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: 'group-agent-candidates-source',
      name: 'Source',
      owner: owner.principal,
    })
    const foreign = await createAgent(connection.db, source.id, owner.principal, {
      name: 'Ada',
      profileId: 'software-engineer',
      profileVersion: '1.0.0',
    })
    const own = await createAgent(connection.db, tenant.id, owner.principal, {
      name: 'Tenant Agent',
      profileId: 'software-engineer',
      profileVersion: '1.0.0',
    })

    const candidates = await listGroupAgentCandidates(connection.db, {
      principal: owner.principal,
      sourceWorkspaceIds: [source.id, tenant.id],
      workspaceId: tenant.id,
    })

    expect(candidates).toEqual([
      Object.freeze({ agentId: foreign.id, name: 'Ada', workspaceId: source.id }),
    ])
    // The identity is the workspace-qualified pair, never the display name.
    expect(candidates.map(groupAgentCandidateKey)).toEqual([`${source.id}:${foreign.id}`])
    expect(candidates.map((candidate) => candidate.agentId)).not.toContain(own.id)
  })

  test('a source workspace the requester only belongs to yields no candidate', async () => {
    const tenantOwner = await session('tenant-owner')
    const member = await session('member')
    const { workspace: tenant } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: 'group-agent-candidates-member-tenant',
      name: 'Tenant',
      owner: tenantOwner.principal,
    })
    const { workspace: source } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: 'group-agent-candidates-member-source',
      name: 'Source',
      owner: tenantOwner.principal,
    })
    const foreign = await createAgent(connection.db, source.id, tenantOwner.principal, {
      name: 'Ada',
      profileId: 'software-engineer',
      profileVersion: '1.0.0',
    })
    await connection.db.insert(workspaceMemberships).values({
      role: 'member',
      userId: member.principal.userId,
      workspaceId: tenant.id,
    })
    await connection.db.insert(workspaceMemberships).values({
      role: 'member',
      userId: member.principal.userId,
      workspaceId: source.id,
    })

    // Membership is not authority: a member of the source workspace cannot
    // administer it, so no foreign Agent becomes a candidate.
    expect(
      await listGroupAgentCandidates(connection.db, {
        principal: member.principal,
        sourceWorkspaceIds: [source.id],
        workspaceId: tenant.id,
      })
    ).toEqual([])
    // The issuer path refuses the same principal, so the listing did not
    // become an authorization.
    await expect(
      connection.db.transaction((transaction) =>
        requireAgentEnlistmentSource(transaction, 0, foreign.id, source.id, member.principal)
      )
    ).rejects.toThrow('Agent unavailable')
  })

  test('a same-name Agent in the tenant workspace never makes the foreign one visible', async () => {
    const tenantOwner = await session('same-name-tenant-owner')
    const member = await session('same-name-member')
    const { workspace: tenant } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: 'group-agent-candidates-same-name-tenant',
      name: 'Tenant',
      owner: tenantOwner.principal,
    })
    const { workspace: source } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: 'group-agent-candidates-same-name-source',
      name: 'Source',
      owner: tenantOwner.principal,
    })
    await createAgent(connection.db, tenant.id, tenantOwner.principal, {
      name: 'Ada',
      profileId: 'software-engineer',
      profileVersion: '1.0.0',
    })
    await createAgent(connection.db, source.id, tenantOwner.principal, {
      name: 'Ada',
      profileId: 'software-engineer',
      profileVersion: '1.0.0',
    })
    await connection.db.insert(workspaceMemberships).values({
      role: 'member',
      userId: member.principal.userId,
      workspaceId: tenant.id,
    })
    await connection.db.insert(workspaceMemberships).values({
      role: 'member',
      userId: member.principal.userId,
      workspaceId: source.id,
    })

    expect(
      await listGroupAgentCandidates(connection.db, {
        principal: member.principal,
        sourceWorkspaceIds: [source.id],
        workspaceId: tenant.id,
      })
    ).toEqual([])
  })

  test('archived Agents and an unavailable source workspace are excluded', async () => {
    const owner = await session('active-checks')
    const { workspace: tenant } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: 'group-agent-candidates-active-tenant',
      name: 'Tenant',
      owner: owner.principal,
    })
    const { workspace: source } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: 'group-agent-candidates-active-source',
      name: 'Source',
      owner: owner.principal,
    })
    const active = await createAgent(connection.db, source.id, owner.principal, {
      name: 'Active',
      profileId: 'software-engineer',
      profileVersion: '1.0.0',
    })
    const archived = await createAgent(connection.db, source.id, owner.principal, {
      name: 'Archived',
      profileId: 'software-engineer',
      profileVersion: '1.0.0',
    })
    await archiveAgent(connection.db, source.id, archived.id, owner.principal)

    expect(
      await listGroupAgentCandidates(connection.db, {
        principal: owner.principal,
        sourceWorkspaceIds: [source.id],
        workspaceId: tenant.id,
      })
    ).toEqual([Object.freeze({ agentId: active.id, name: 'Active', workspaceId: source.id })])

    // A workspace pending deletion is not an active source of candidates.
    await connection.db
      .update(workspaces)
      .set({ deletionRequestedAt: new Date() })
      .where(eq(workspaces.id, source.id))
    expect(
      await listGroupAgentCandidates(connection.db, {
        principal: owner.principal,
        sourceWorkspaceIds: [source.id],
        workspaceId: tenant.id,
      })
    ).toEqual([])
  })

  test('a requester outside the tenant scope is refused', async () => {
    const owner = await session('outsider-owner')
    const outsider = await session('outsider')
    const { workspace: tenant } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: 'group-agent-candidates-outsider-tenant',
      name: 'Tenant',
      owner: owner.principal,
    })
    const { workspace: source } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: 'group-agent-candidates-outsider-source',
      name: 'Source',
      owner: owner.principal,
    })
    await createAgent(connection.db, source.id, owner.principal, {
      name: 'Ada',
      profileId: 'software-engineer',
      profileVersion: '1.0.0',
    })

    await expect(
      listGroupAgentCandidates(connection.db, {
        principal: outsider.principal,
        sourceWorkspaceIds: [source.id],
        workspaceId: tenant.id,
      })
    ).rejects.toThrow('Agent unavailable')
  })

  test('listing never grants enlistment and writes no participation row', async () => {
    const owner = await session('read-only')
    const { workspace: tenant } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: 'group-agent-candidates-read-only-tenant',
      name: 'Tenant',
      owner: owner.principal,
    })
    const { workspace: source } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: 'group-agent-candidates-read-only-source',
      name: 'Source',
      owner: owner.principal,
    })
    await createAgent(connection.db, source.id, owner.principal, {
      name: 'Ada',
      profileId: 'software-engineer',
      profileVersion: '1.0.0',
    })

    const grantsBefore = await connection.db.select().from(groupEnlistmentGrants)
    const admissionsBefore = await connection.db.select().from(groupAdmissions)
    const candidates = await listGroupAgentCandidates(connection.db, {
      principal: owner.principal,
      sourceWorkspaceIds: [source.id],
      workspaceId: tenant.id,
    })
    expect(candidates).toHaveLength(1)
    expect(await connection.db.select().from(groupEnlistmentGrants)).toEqual(grantsBefore)
    expect(await connection.db.select().from(groupAdmissions)).toEqual(admissionsBefore)
    // The tenant's own Agents stay with the existing Agent read.
    const tenantAgents = await connection.db
      .select()
      .from(agents)
      .where(and(eq(agents.workspaceId, tenant.id)))
    expect(tenantAgents).toEqual([])
  })
})
