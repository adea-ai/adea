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
  listArchivedWorkspacesForOwner,
  listWorkspacesForUser,
  recordWorkspaceAuthorizationDecision,
  removeWorkspaceMembership,
  reopenWorkspace,
  updateWorkspace,
  WorkspaceVersionConflictError,
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
      idempotencyKey: 'retry-fixture',
      name: 'My Adea',
      owner: temporary.principal,
    })
    const retry = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: 'retry-fixture',
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

  test('protects the legacy default identity without replacing its name or seeding Work', async () => {
    const temporary = await createTemporaryUserSession(connection.db, {
      credentialDigest: `bootstrap-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const legacy = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: 'default',
      name: 'My Adea',
      owner: temporary.principal,
    })

    const bootstrapped = await ensureBootstrapWorkspaces(connection.db, temporary.principal)

    expect(bootstrapped.map(({ name }) => name)).toEqual(['My Adea'])
    expect(
      await getWorkspaceForUser(connection.db, legacy.workspace.id, temporary.principal)
    ).toMatchObject({
      id: legacy.workspace.id,
      name: 'My Adea',
      scene: 'home',
      isPersonal: true,
      canDelete: false,
    })
    expect(bootstrapped).toHaveLength(1)

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

  test("orders a user's workspaces by their own position and appends new ones", async () => {
    const temporary = await createTemporaryUserSession(connection.db, {
      credentialDigest: `order-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const bootstrapped = await ensureBootstrapWorkspaces(connection.db, temporary.principal)
    const created = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `pink-${crypto.randomUUID()}`,
      name: 'Pink Binder',
      owner: temporary.principal,
    })

    expect(bootstrapped.map(({ name, sortOrder }) => [name, sortOrder])).toEqual([['Home', 0]])
    expect(created.workspace).toMatchObject({
      accent: null,
      logo: { kind: 'box' },
      sortOrder: 1,
      version: 1,
    })

    // Updating a workspace must not move it: order is the member's choice.
    const [home] = bootstrapped
    await updateWorkspace(connection.db, home!.id, temporary.principal, {
      expectedVersion: home!.version,
      update: { name: 'Personal' },
    })
    expect(
      (await listWorkspacesForUser(connection.db, temporary.principal)).map(({ name }) => name)
    ).toEqual(['Personal', 'Pink Binder'])
  })

  test('applies a versioned identity update and records one event', async () => {
    const temporary = await createTemporaryUserSession(connection.db, {
      credentialDigest: `identity-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `identity-${crypto.randomUUID()}`,
      name: 'Nifty League',
      owner: temporary.principal,
    })

    const updated = await updateWorkspace(connection.db, workspace.id, temporary.principal, {
      expectedVersion: 1,
      update: {
        accent: 'green',
        logo: { kind: 'emoji', value: '🎮' },
        name: 'Nifty',
        scene: 'work',
      },
    })
    expect(updated).toMatchObject({
      accent: 'green',
      logo: { kind: 'emoji', value: '🎮' },
      name: 'Nifty',
      scene: 'work',
      version: 2,
    })
    expect(await getWorkspaceForUser(connection.db, workspace.id, temporary.principal)).toEqual(
      updated
    )

    await expect(
      updateWorkspace(connection.db, workspace.id, temporary.principal, {
        expectedVersion: 1,
        update: { name: 'Stale' },
      })
    ).rejects.toBeInstanceOf(WorkspaceVersionConflictError)

    const cleared = await updateWorkspace(connection.db, workspace.id, temporary.principal, {
      expectedVersion: 2,
      update: { accent: null, logo: { kind: 'monogram' } },
    })
    expect(cleared).toMatchObject({ accent: null, logo: { kind: 'box' }, version: 3 })

    const events = await connection.db
      .select({ payload: workspaceEvents.payload })
      .from(workspaceEvents)
      .where(
        and(
          eq(workspaceEvents.workspaceId, workspace.id),
          eq(workspaceEvents.eventType, 'workspace.updated')
        )
      )
    expect(events).toHaveLength(2)
    expect(events[0]!.payload).toEqual({ actorUserId: temporary.principal.userId })
  })

  test('refuses an update from a non-member and to an archived workspace', async () => {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: `owner-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const stranger = await createTemporaryUserSession(connection.db, {
      credentialDigest: `stranger-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `private-${crypto.randomUUID()}`,
      name: 'Private',
      owner: owner.principal,
    })

    await expect(
      updateWorkspace(connection.db, workspace.id, stranger.principal, {
        expectedVersion: 1,
        update: { name: 'Taken' },
      })
    ).rejects.toThrow('Workspace unavailable')

    await archiveWorkspace(connection.db, workspace.id, owner.principal)
    await expect(
      updateWorkspace(connection.db, workspace.id, owner.principal, {
        expectedVersion: 1,
        update: { name: 'Archived' },
      })
    ).rejects.toThrow('Workspace unavailable')
  })
})

describe.skipIf(!connectionUrl)('workspace archive presentation (#1175)', () => {
  let connection: DatabaseConnection

  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })

  afterAll(async () => {
    await connection.close()
  })

  test('only the owner of an optional workspace is offered archive; Home never is', async () => {
    const owner = (
      await createTemporaryUserSession(connection.db, {
        credentialDigest: `archive-presentation-owner-${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 600_000),
      })
    ).principal
    const member = (
      await createTemporaryUserSession(connection.db, {
        credentialDigest: `archive-presentation-member-${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 600_000),
      })
    ).principal
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `archive-presentation-${crypto.randomUUID()}`,
      name: 'Optional archive presentation',
      owner,
    })
    await addWorkspaceMembership(connection.db, workspace.id, member, 'member')

    const ownerView = (await listWorkspacesForUser(connection.db, owner)).find(
      (candidate) => candidate.id === workspace.id
    )
    const memberView = (await listWorkspacesForUser(connection.db, member)).find(
      (candidate) => candidate.id === workspace.id
    )
    expect(ownerView?.canArchive).toBe(true)
    expect(memberView?.canArchive).toBe(false)

    const bootstrapped = await ensureBootstrapWorkspaces(connection.db, owner)
    const home = bootstrapped.find((candidate) => candidate.isPersonal)
    expect(home).toBeDefined()
    expect(home?.canArchive).toBe(false)
  })
})

describe.skipIf(!connectionUrl)('archived workspace discovery (#1175)', () => {
  let connection: DatabaseConnection

  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })

  afterAll(async () => {
    await connection.close()
  })

  async function principal(label: string) {
    return (
      await createTemporaryUserSession(connection.db, {
        credentialDigest: `archived-discovery-${label}-${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 600_000),
      })
    ).principal
  }

  test('an owner lists only their own archived workspaces, with the same identity; other roles and owners see none', async () => {
    const owner = await principal('owner')
    const admin = await principal('admin')
    const member = await principal('member')
    const otherOwner = await principal('other-owner')
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `archived-discovery-${crypto.randomUUID()}`,
      name: 'Archived discovery target',
      owner,
    })
    await addWorkspaceMembership(connection.db, workspace.id, admin, 'admin')
    await addWorkspaceMembership(connection.db, workspace.id, member, 'member')
    const { workspace: foreign } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `archived-discovery-foreign-${crypto.randomUUID()}`,
      name: 'Foreign archived',
      owner: otherOwner,
    })
    await archiveWorkspace(connection.db, workspace.id, owner)
    await archiveWorkspace(connection.db, foreign.id, otherOwner)

    const ownerList = await listArchivedWorkspacesForOwner(connection.db, owner)
    expect(ownerList.map((candidate) => candidate.id)).toEqual([workspace.id])
    expect(ownerList[0]?.name).toBe('Archived discovery target')
    expect(await listArchivedWorkspacesForOwner(connection.db, admin)).toEqual([])
    expect(await listArchivedWorkspacesForOwner(connection.db, member)).toEqual([])
    expect(
      (await listArchivedWorkspacesForOwner(connection.db, otherOwner)).map(
        (candidate) => candidate.id
      )
    ).toEqual([foreign.id])

    await reopenWorkspace(connection.db, workspace.id, owner)
    expect(await listArchivedWorkspacesForOwner(connection.db, owner)).toEqual([])
    expect(
      (await listWorkspacesForUser(connection.db, owner)).map((candidate) => candidate.id)
    ).toContain(workspace.id)
  })
})
