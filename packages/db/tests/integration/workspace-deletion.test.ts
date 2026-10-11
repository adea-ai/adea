import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createTemporaryUserSession, createUserWithAuthIdentity, claimTemporaryUserSession, claimTemporaryUserSessionForUser } from '../../src/identity'
import {
  createWorkspaceWithOwner,
  deleteWorkspace,
  ensureBootstrapWorkspaces,
  listWorkspacesForUser,
  reopenWorkspace,
} from '../../src/workspaces'
import {
  users,
  temporaryUserSessions,
  workspaceDeletions,
  projects,
  tasks,
  agents,
  channels,
  messages,
  contentRefs,
  authorizationAuditRecords,
  workspaces,
  workspaceMemberships,
} from '../../src/schema'
import { mintControlPlaneIdentifier } from '../../src/control-plane-identifiers'

describe.skipIf(!process.env.DATABASE_URL)('permanent workspace deletion', () => {
  let connection: DatabaseConnection
  beforeAll(() => {
    connection = createDatabase(process.env.DATABASE_URL!)
  })
  afterAll(async () => {
    await connection.close()
  })

  test('prunes real dependent content, conversations, memberships and audit rows without touching a sibling workspace', async () => {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    const [home, work] = await ensureBootstrapWorkspaces(connection.db, owner.principal)
    const workspaceId = home!.id
    const [project] = await connection.db
      .insert(projects)
      .values({
        workspaceId,
        name: 'Project',
        iconKey: 'folder',
        controlPlaneProjectId: mintControlPlaneIdentifier('prj'),
      })
      .returning()
    const [agent] = await connection.db
      .insert(agents)
      .values({
        workspaceId,
        projectId: project!.id,
        name: 'Agent',
        profileId: 'profile',
        profileVersion: 'v1',
        controlPlaneAgentId: mintControlPlaneIdentifier('agt'),
      })
      .returning()
    const [content] = await connection.db
      .insert(contentRefs)
      .values({
        workspaceId,
        contentType: 'private_field',
        digestSha256: 'a'.repeat(64),
        sensitivity: 'restricted',
        storagePolicy: 'local_authority',
        synchronizationPolicy: 'local_only',
        availability: 'available',
        schemaVersion: 1,
        keyVersion: 1,
      })
      .returning()
    const [task] = await connection.db
      .insert(tasks)
      .values({
        workspaceId,
        creatorUserId: owner.principal.userId,
        title: 'Task',
        projectId: project!.id,
        agentId: agent!.id,
        objectiveContentRefId: content!.id,
        controlPlaneTaskId: mintControlPlaneIdentifier('tsk'),
      })
      .returning()
    const [channel] = await connection.db
      .insert(channels)
      .values({
        workspaceId,
        title: 'Chat',
        kind: 'project',
        projectId: project!.id,
        idempotencyKey: crypto.randomUUID(),
      })
      .returning()
    const [message] = await connection.db
      .insert(messages)
      .values({
        workspaceId,
        channelId: channel!.id,
        senderKind: 'agent',
        senderAgentId: agent!.id,
        bodyContentRefId: content!.id,
        taskId: task!.id,
        idempotencyKey: crypto.randomUUID(),
        createPayloadHash: 'b'.repeat(64),
        externalSessionRef: 'harness-owned-session',
      })
      .returning()
    await connection.db
      .insert(messages)
      .values({
        workspaceId,
        channelId: channel!.id,
        senderKind: 'user',
        senderUserId: owner.principal.userId,
        bodyText: 'Reply',
        threadRootMessageId: message!.id,
        replyToMessageId: message!.id,
        idempotencyKey: crypto.randomUUID(),
        createPayloadHash: 'c'.repeat(64),
      })
    await connection.db
      .insert(authorizationAuditRecords)
      .values({
        workspaceId,
        principalKind: 'user',
        principalId: owner.principal.userId,
        permission: 'workspace.read',
        decision: 'allowed',
        reason: 'permission_granted',
      })
    await deleteWorkspace(connection.db, workspaceId, owner.principal, {
      confirmationName: home!.name,
      expectedVersion: home!.version,
    })
    for (const table of [
      projects,
      tasks,
      agents,
      channels,
      messages,
      contentRefs,
      workspaceMemberships,
      authorizationAuditRecords,
    ]) {
      expect(
        await connection.db.select().from(table).where(eq(table.workspaceId, workspaceId))
      ).toEqual([])
    }
    expect(
      await connection.db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
    ).toEqual([])
    expect((await listWorkspacesForUser(connection.db, owner.principal)).map((w) => w.id)).toEqual([
      work!.id,
    ])
    await deleteWorkspace(connection.db, work!.id, owner.principal, {
      confirmationName: work!.name,
      expectedVersion: work!.version,
    })
    await connection.db
      .delete(workspaceDeletions)
      .where(eq(workspaceDeletions.ownerUserId, owner.principal.userId))
    await connection.db
      .delete(temporaryUserSessions)
      .where(eq(temporaryUserSessions.userId, owner.principal.userId))
    await connection.db.delete(users).where(eq(users.id, owner.principal.userId))
  })

  test('requires the owner and current confirmation; retries safely and never reseeds deleted defaults', async () => {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    const stranger = await createTemporaryUserSession(connection.db, {
      credentialDigest: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    try {
      const initial = await ensureBootstrapWorkspaces(connection.db, owner.principal)
      expect(initial.map((w) => w.name)).toEqual(['Home', 'Work'])
      const home = initial[0]!
      const confirmation = { confirmationName: home.name, expectedVersion: home.version }
      await expect(
        deleteWorkspace(connection.db, home.id, stranger.principal, confirmation)
      ).rejects.toThrow('Workspace unavailable')
      await expect(
        deleteWorkspace(connection.db, home.id, owner.principal, {
          ...confirmation,
          confirmationName: 'wrong',
        })
      ).rejects.toThrow('Workspace version conflict')
      await expect(deleteWorkspace(connection.db, home.id, owner.principal, { ...confirmation, expectedVersion: home.version + 1 })).rejects.toThrow('Workspace version conflict')
      expect(await connection.db.select().from(workspaceDeletions).where(eq(workspaceDeletions.workspaceId, home.id))).toEqual([])
      expect(await listWorkspacesForUser(connection.db, owner.principal)).toHaveLength(2)
      await Promise.all([
        deleteWorkspace(connection.db, home.id, owner.principal, confirmation),
        deleteWorkspace(connection.db, home.id, owner.principal, confirmation),
        ensureBootstrapWorkspaces(connection.db, owner.principal),
      ])
      await expect(reopenWorkspace(connection.db, home.id, owner.principal)).rejects.toThrow(
        'Workspace unavailable'
      )
      expect(
        (await ensureBootstrapWorkspaces(connection.db, owner.principal)).map((w) => w.name)
      ).toEqual(['Work'])
      const work = initial[1]!
      await deleteWorkspace(connection.db, work.id, owner.principal, {
        confirmationName: work.name,
        expectedVersion: work.version,
      })
      expect(await ensureBootstrapWorkspaces(connection.db, owner.principal)).toEqual([])
      expect(await ensureBootstrapWorkspaces(connection.db, owner.principal)).toEqual([])
    } finally {
      for (const user of [owner, stranger]) {
        await connection.db
          .delete(workspaceDeletions)
          .where(eq(workspaceDeletions.ownerUserId, user.principal.userId))
        await connection.db
          .delete(temporaryUserSessions)
          .where(eq(temporaryUserSessions.userId, user.principal.userId))
        await connection.db.delete(users).where(eq(users.id, user.principal.userId))
      }
    }
  })

  for (const claimPath of ['identity', 'principal'] as const) {
    test(`guest deletion receipts survive an existing account claim via ${claimPath}`, async () => {
      const identity = { provider: 'neon', subject: crypto.randomUUID() }
      const registered = await createUserWithAuthIdentity(connection.db, { identity })
      const credentialDigest = crypto.randomUUID()
      const temporary = await createTemporaryUserSession(connection.db, { credentialDigest, expiresAt: new Date(Date.now() + 60_000) })
      try {
        const initial = await ensureBootstrapWorkspaces(connection.db, temporary.principal)
        for (const workspace of initial) await deleteWorkspace(connection.db, workspace.id, temporary.principal, { confirmationName: workspace.name, expectedVersion: workspace.version })
        if (claimPath === 'identity') await claimTemporaryUserSession(connection.db, { credentialDigest, identity })
        else await claimTemporaryUserSessionForUser(connection.db, { credentialDigest, target: registered })
        expect(await ensureBootstrapWorkspaces(connection.db, registered)).toEqual([])
        const home = initial[0]!
        await deleteWorkspace(connection.db, home.id, registered, { confirmationName: home.name, expectedVersion: home.version })
        await expect(createWorkspaceWithOwner(connection.db, { owner: registered, name: 'Home', idempotencyKey: 'default-home', scene: 'home' })).rejects.toThrow('Workspace creation conflict')
      } finally {
        for (const principal of [temporary.principal, registered]) {
          await connection.db.delete(workspaceDeletions).where(eq(workspaceDeletions.ownerUserId, principal.userId))
          await connection.db.delete(temporaryUserSessions).where(eq(temporaryUserSessions.userId, principal.userId))
          await connection.db.delete(users).where(eq(users.id, principal.userId))
        }
      }
    })
  }
})
