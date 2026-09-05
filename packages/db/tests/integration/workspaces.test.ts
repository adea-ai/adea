import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { and, eq } from 'drizzle-orm'

import { createDatabase, type DatabaseConnection } from '../../src/connection'
import {
  archiveWorkspace,
  addWorkspaceMembership,
  createWorkspaceWithOwner,
  ensureBootstrapWorkspaces,
  findWorkspaceMembership,
  getWorkspaceForUser,
  listWorkspacesForUser,
  recordWorkspaceAuthorizationDecision,
  removeWorkspaceMembership,
  reopenWorkspace,
} from '../../src/workspaces'
import {
  claimTemporaryUserSession,
  claimTemporaryUserSessionForUser,
  createTemporaryUserSession,
  createUserWithAuthIdentity,
  findUserPrincipalsByAuthIdentity,
  resolveTemporaryUserSession,
} from '../../src/identity'
import {
  authorizationAuditRecords,
  temporaryUserSessions,
  users,
  workspaceEvents,
  workspaceMemberships,
  workspaces,
} from '../../src/schema'

const connectionUrl = process.env.DATABASE_URL

describe.skipIf(!connectionUrl)('workspace tenancy integration', () => {
  let connection: DatabaseConnection

  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })

  afterAll(async () => {
    await connection.close()
  })

  test('creates a temporary user and owner workspace exactly once under retry', async () => {
    const credentialDigest = `digest-${crypto.randomUUID()}`
    const temporary = await createTemporaryUserSession(connection.db, {
      credentialDigest,
      expiresAt: new Date(Date.now() + 60_000),
    })

    expect(await resolveTemporaryUserSession(connection.db, credentialDigest)).toEqual(
      temporary.principal
    )

    const first = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: 'default',
      name: 'My Agent HQ',
      owner: temporary.principal,
    })
    const retry = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: 'default',
      name: 'Ignored retry name',
      owner: temporary.principal,
    })

    expect(retry.workspace).toEqual(first.workspace)
    expect(first.created).toBe(true)
    expect(retry.created).toBe(false)
    expect(
      await findWorkspaceMembership(connection.db, first.workspace.id, temporary.principal)
    ).toEqual({
      role: 'owner',
      userId: temporary.principal.userId,
      workspaceId: first.workspace.id,
    })
    expect(await listWorkspacesForUser(connection.db, temporary.principal)).toEqual([
      first.workspace,
    ])

    await archiveWorkspace(connection.db, first.workspace.id, temporary.principal)
    expect(
      await getWorkspaceForUser(connection.db, first.workspace.id, temporary.principal)
    ).toBeNull()
    const reopened = await reopenWorkspace(connection.db, first.workspace.id, temporary.principal)
    const reopenRetry = await reopenWorkspace(
      connection.db,
      first.workspace.id,
      temporary.principal
    )
    expect(reopenRetry).toEqual(reopened)
    expect(
      await getWorkspaceForUser(connection.db, first.workspace.id, temporary.principal)
    ).toEqual(reopened)
    const reopenEvents = await connection.db
      .select({ id: workspaceEvents.id })
      .from(workspaceEvents)
      .where(
        and(
          eq(workspaceEvents.workspaceId, first.workspace.id),
          eq(workspaceEvents.eventType, 'workspace.reopened')
        )
      )
    expect(reopenEvents).toHaveLength(1)
    await connection.db
      .delete(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, first.workspace.id))
    await connection.db.delete(workspaces).where(eq(workspaces.id, first.workspace.id))
    await connection.db
      .delete(temporaryUserSessions)
      .where(eq(temporaryUserSessions.userId, temporary.principal.userId))
    await connection.db.delete(users).where(eq(users.id, temporary.principal.userId))
  })

  test('upgrades the legacy default workspace into Home and adds Work', async () => {
    const temporary = await createTemporaryUserSession(connection.db, {
      credentialDigest: `bootstrap-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const legacy = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: 'default',
      name: 'My Agent HQ',
      owner: temporary.principal,
    })

    const bootstrapped = await ensureBootstrapWorkspaces(connection.db, temporary.principal)

    expect(bootstrapped.map(({ name }) => name).sort()).toEqual(['Home', 'Work'])
    expect(
      await getWorkspaceForUser(connection.db, legacy.workspace.id, temporary.principal)
    ).toMatchObject({
      id: legacy.workspace.id,
      name: 'Home',
      scene: 'home',
    })
    expect(bootstrapped.find(({ name }) => name === 'Work')).toMatchObject({ scene: 'work' })

    for (const workspace of bootstrapped) {
      await connection.db
        .delete(workspaceMemberships)
        .where(eq(workspaceMemberships.workspaceId, workspace.id))
      await connection.db.delete(workspaces).where(eq(workspaces.id, workspace.id))
    }
    await connection.db
      .delete(temporaryUserSessions)
      .where(eq(temporaryUserSessions.userId, temporary.principal.userId))
    await connection.db.delete(users).where(eq(users.id, temporary.principal.userId))
  })

  test('serializes concurrent creation retries without orphaning memberships', async () => {
    const temporary = await createTemporaryUserSession(connection.db, {
      credentialDigest: `concurrent-create-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })

    const attempts = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        createWorkspaceWithOwner(connection.db, {
          idempotencyKey: 'concurrent-create',
          name: `Concurrent HQ ${index}`,
          owner: temporary.principal,
        })
      )
    )
    expect(new Set(attempts.map(({ workspace }) => workspace.id)).size).toBe(1)
    expect(attempts.filter(({ created }) => created)).toHaveLength(1)
    const workspaceId = attempts[0]!.workspace.id
    const memberships = await connection.db
      .select({ id: workspaceMemberships.id })
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, workspaceId))
    expect(memberships).toHaveLength(1)

    await connection.db
      .delete(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, workspaceId))
    await connection.db.delete(workspaces).where(eq(workspaces.id, workspaceId))
    await connection.db
      .delete(temporaryUserSessions)
      .where(eq(temporaryUserSessions.userId, temporary.principal.userId))
    await connection.db.delete(users).where(eq(users.id, temporary.principal.userId))
  })

  test('rolls back workspace creation when the owner is unavailable', async () => {
    const missingUserId = crypto.randomUUID()
    await expect(
      createWorkspaceWithOwner(connection.db, {
        idempotencyKey: 'rollback',
        name: 'Must not persist',
        owner: { kind: 'user', userId: missingUserId },
      })
    ).rejects.toThrow()
    expect(
      await connection.db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.ownerUserId, missingUserId))
    ).toHaveLength(0)
  })

  test('does not reveal a workspace to another temporary user', async () => {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: `owner-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const outsider = await createTemporaryUserSession(connection.db, {
      credentialDigest: `outsider-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: 'isolation',
      name: 'Private HQ',
      owner: owner.principal,
    })

    expect(await getWorkspaceForUser(connection.db, workspace.id, outsider.principal)).toBeNull()
    await expect(archiveWorkspace(connection.db, workspace.id, outsider.principal)).rejects.toThrow(
      'Workspace unavailable'
    )

    await archiveWorkspace(connection.db, workspace.id, owner.principal)
    await connection.db
      .delete(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, workspace.id))
    await connection.db.delete(workspaces).where(eq(workspaces.id, workspace.id))
    await connection.db
      .delete(temporaryUserSessions)
      .where(eq(temporaryUserSessions.userId, owner.principal.userId))
    await connection.db
      .delete(temporaryUserSessions)
      .where(eq(temporaryUserSessions.userId, outsider.principal.userId))
    await connection.db.delete(users).where(eq(users.id, owner.principal.userId))
    await connection.db.delete(users).where(eq(users.id, outsider.principal.userId))
  })

  test('rejects duplicate memberships and prevents ordinary owner removal', async () => {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: `membership-owner-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const member = await createTemporaryUserSession(connection.db, {
      credentialDigest: `membership-member-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: 'membership',
      name: 'Membership HQ',
      owner: owner.principal,
    })

    await addWorkspaceMembership(connection.db, workspace.id, member.principal, 'member')
    await expect(
      addWorkspaceMembership(connection.db, workspace.id, member.principal, 'admin')
    ).rejects.toThrow()
    await expect(
      removeWorkspaceMembership(connection.db, workspace.id, owner.principal)
    ).rejects.toThrow('Workspace owner membership cannot be removed')

    await recordWorkspaceAuthorizationDecision(connection.db, {
      decision: 'allowed',
      permission: 'membership.manage',
      principal: owner.principal,
      reason: 'permission_granted',
      workspaceId: workspace.id,
    })
    await recordWorkspaceAuthorizationDecision(connection.db, {
      decision: 'denied',
      permission: 'workspace.update',
      principal: member.principal,
      reason: 'permission_missing',
      workspaceId: workspace.id,
    })
    expect(
      await connection.db
        .select({ decision: authorizationAuditRecords.decision })
        .from(authorizationAuditRecords)
        .where(eq(authorizationAuditRecords.workspaceId, workspace.id))
    ).toEqual(expect.arrayContaining([{ decision: 'allowed' }, { decision: 'denied' }]))

    await connection.db
      .delete(authorizationAuditRecords)
      .where(eq(authorizationAuditRecords.workspaceId, workspace.id))
    await connection.db
      .delete(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, workspace.id))
    await connection.db.delete(workspaces).where(eq(workspaces.id, workspace.id))
    for (const principal of [owner.principal, member.principal]) {
      await connection.db
        .delete(temporaryUserSessions)
        .where(eq(temporaryUserSessions.userId, principal.userId))
      await connection.db.delete(users).where(eq(users.id, principal.userId))
    }
  })

  test('claims a temporary workspace for a new account identity', async () => {
    const credentialDigest = `claim-new-${crypto.randomUUID()}`
    const identity = { provider: 'neon', subject: `claim-new-${crypto.randomUUID()}` }
    const temporary = await createTemporaryUserSession(connection.db, {
      credentialDigest,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: 'claim-new',
      name: 'Claimed HQ',
      owner: temporary.principal,
    })

    const claim = {
      credentialDigest,
      identity,
      profile: { displayName: 'Claimed operator' },
    }
    expect(await claimTemporaryUserSession(connection.db, claim)).toEqual(temporary.principal)
    expect(await claimTemporaryUserSession(connection.db, claim)).toEqual(temporary.principal)
    expect(await resolveTemporaryUserSession(connection.db, credentialDigest)).toBeNull()
    expect(await findUserPrincipalsByAuthIdentity(connection.db, identity)).toEqual([
      temporary.principal,
    ])
    expect(
      await getWorkspaceForUser(connection.db, workspace.id, temporary.principal)
    ).not.toBeNull()

    await connection.db
      .delete(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, workspace.id))
    await connection.db.delete(workspaces).where(eq(workspaces.id, workspace.id))
    await connection.db
      .delete(temporaryUserSessions)
      .where(eq(temporaryUserSessions.userId, temporary.principal.userId))
    await connection.db.delete(users).where(eq(users.id, temporary.principal.userId))
  })

  test('transfers temporary workspaces when signing into an existing account', async () => {
    const identity = { provider: 'neon', subject: `claim-existing-${crypto.randomUUID()}` }
    const registered = await createUserWithAuthIdentity(connection.db, { identity })
    const credentialDigest = `claim-existing-${crypto.randomUUID()}`
    const temporary = await createTemporaryUserSession(connection.db, {
      credentialDigest,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: 'default',
      name: 'Transferred HQ',
      owner: temporary.principal,
    })

    expect(await claimTemporaryUserSession(connection.db, { credentialDigest, identity })).toEqual(
      registered
    )
    expect(await claimTemporaryUserSession(connection.db, { credentialDigest, identity })).toEqual(
      registered
    )
    expect(await getWorkspaceForUser(connection.db, workspace.id, temporary.principal)).toBeNull()
    expect(await getWorkspaceForUser(connection.db, workspace.id, registered)).not.toBeNull()
    expect(await findWorkspaceMembership(connection.db, workspace.id, registered)).toMatchObject({
      role: 'owner',
    })

    await connection.db
      .delete(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, workspace.id))
    await connection.db.delete(workspaces).where(eq(workspaces.id, workspace.id))
    await connection.db
      .delete(temporaryUserSessions)
      .where(eq(temporaryUserSessions.userId, temporary.principal.userId))
    await connection.db.delete(users).where(eq(users.id, temporary.principal.userId))
    await connection.db.delete(users).where(eq(users.id, registered.userId))
  })

  test('claims multiple guest workspaces concurrently into one desktop account', async () => {
    const identity = { provider: 'neon', subject: `desktop-claim-${crypto.randomUUID()}` }
    const registered = await createUserWithAuthIdentity(connection.db, { identity })
    const guests = await Promise.all(
      ['first', 'second'].map(async (label) => {
        const credentialDigest = `desktop-${label}-${crypto.randomUUID()}`
        const temporary = await createTemporaryUserSession(connection.db, {
          credentialDigest,
          expiresAt: new Date(Date.now() + 60_000),
        })
        const { workspace } = await createWorkspaceWithOwner(connection.db, {
          idempotencyKey: 'default',
          name: `${label} guest HQ`,
          owner: temporary.principal,
        })
        return { credentialDigest, temporary, workspace }
      })
    )

    await expect(
      Promise.all(
        guests.map(({ credentialDigest }) =>
          claimTemporaryUserSessionForUser(connection.db, {
            credentialDigest,
            target: registered,
          })
        )
      )
    ).resolves.toEqual([registered, registered])
    await expect(
      claimTemporaryUserSessionForUser(connection.db, {
        credentialDigest: guests[0]!.credentialDigest,
        target: registered,
      })
    ).resolves.toEqual(registered)
    expect(await listWorkspacesForUser(connection.db, registered)).toEqual(
      expect.arrayContaining(
        guests.map(({ workspace }) => expect.objectContaining({ id: workspace.id }))
      )
    )

    for (const { temporary, workspace } of guests) {
      await connection.db
        .delete(workspaceMemberships)
        .where(eq(workspaceMemberships.workspaceId, workspace.id))
      await connection.db.delete(workspaces).where(eq(workspaces.id, workspace.id))
      await connection.db
        .delete(temporaryUserSessions)
        .where(eq(temporaryUserSessions.userId, temporary.principal.userId))
      await connection.db.delete(users).where(eq(users.id, temporary.principal.userId))
    }
    await connection.db.delete(users).where(eq(users.id, registered.userId))
  })
})
