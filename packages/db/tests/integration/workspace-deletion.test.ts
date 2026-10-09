import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import type { UserPrincipalRef } from '@adea-ai/types'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspaceCleanup } from '../../../../apps/desktop/shell/src/workspace-cleanup'
import { createMemoryStore } from '../../../../apps/desktop/shell/src/memory/store'
import { workspaceLocalData } from '../../../../apps/desktop/shell/src/workspace-local-data'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import {
  createTemporaryUserSession,
  createUserWithAuthIdentity,
  claimTemporaryUserSession,
  claimTemporaryUserSessionForUser,
} from '../../src/identity'
import {
  createWorkspaceWithOwner,
  deleteWorkspace,
  beginWorkspaceDeletion,
  workspaceDeletionState,
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
  contentReplicas,
  artifacts,
  runtimeNodes,
  runtimeNodeKeys,
  runtimeNodeDeliveryRequests,
  authorizationAuditRecords,
  workspaces,
  workspaceMemberships,
} from '../../src/schema'
import {
  mintControlPlaneIdentifier,
  markWorkspaceControlPlaneUsed,
} from '../../src/control-plane-identifiers'

async function deletionFixtures(connection: DatabaseConnection, owner: UserPrincipalRef) {
  await ensureBootstrapWorkspaces(connection.db, owner)
  const first = await createWorkspaceWithOwner(connection.db, {
    owner,
    idempotencyKey: 'delete-fixture-a',
    name: 'Scratch',
  })
  const second = await createWorkspaceWithOwner(connection.db, {
    owner,
    idempotencyKey: 'delete-fixture-b',
    name: 'Other',
  })
  return [first.workspace, second.workspace] as const
}

// Explicitly disposable database fixtures, including the protected personal root.
// This cleanup is never an application deletion path.
async function purgeFixtureWorkspaces(connection: DatabaseConnection, userId: string) {
  const rows = await connection.db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.ownerUserId, userId))
  const ids = rows.map((row) => row.id)
  if (!ids.length) return
  await connection.db
    .delete(workspaceMemberships)
    .where(inArray(workspaceMemberships.workspaceId, ids))
  await connection.db
    .delete(authorizationAuditRecords)
    .where(inArray(authorizationAuditRecords.workspaceId, ids))
  await connection.db.delete(workspaces).where(inArray(workspaces.id, ids))
}

// Seed historical completed-deletion fixtures / exercise FK cascade only.
// Production deletion cannot call this test-only raw SQL helper.
async function removeFixtureWorkspace(
  connection: DatabaseConnection,
  workspaceId: string,
  owner: UserPrincipalRef
) {
  await connection.db.transaction(async (transaction) => {
    const [workspace] = await transaction
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
    if (!workspace) return
    expect(workspace.ownerUserId).toBe(owner.userId)
    expect(workspace.isPersonal).toBe(false)
    await transaction
      .insert(workspaceDeletions)
      .values({ workspaceId, ownerUserId: owner.userId, idempotencyKey: workspace.idempotencyKey })
    await transaction
      .delete(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, workspaceId))
    await transaction
      .delete(authorizationAuditRecords)
      .where(eq(authorizationAuditRecords.workspaceId, workspaceId))
    await transaction.delete(workspaces).where(eq(workspaces.id, workspaceId))
  })
}

describe.skipIf(!process.env.DATABASE_URL)('permanent workspace deletion', () => {
  let connection: DatabaseConnection
  beforeAll(() => {
    connection = createDatabase(process.env.DATABASE_URL!)
  })
  afterAll(async () => {
    await connection.close()
  })

  test('historical deletion fixture verifies FK cascades and sibling retention; active production deletion is blocked', async () => {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    const [home, work] = await deletionFixtures(connection, owner.principal)
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
    await connection.db.insert(messages).values({
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
    await connection.db.insert(authorizationAuditRecords).values({
      workspaceId,
      principalKind: 'user',
      principalId: owner.principal.userId,
      permission: 'workspace.read',
      decision: 'allowed',
      reason: 'permission_granted',
    })
    await connection.db.insert(contentReplicas).values({
      workspaceId,
      contentRefId: content!.id,
      replicaKind: 'local_authority',
      revision: 1,
      digestSha256: 'a'.repeat(64),
      schemaVersion: 1,
      nonce: 'A'.repeat(16),
      ciphertext: 'A'.repeat(24),
      availability: 'available',
    })
    await connection.db.insert(artifacts).values({
      workspaceId,
      taskId: task!.id,
      agentId: agent!.id,
      ownerPrincipalKind: 'user',
      ownerPrincipalId: owner.principal.userId,
      sourcePrincipalKind: 'agent',
      sourcePrincipalId: agent!.id,
      locationType: 'external_harness',
      locationRef: 'harness-owned-path',
      externalHarnessId: 'codex',
      filename: 'report.md',
      mediaType: 'text/markdown',
      sizeBytes: 1,
      checksumSha256: 'd'.repeat(64),
      sourceArtifactRef: crypto.randomUUID(),
      createPayloadHash: 'e'.repeat(64),
    })
    const [node] = await connection.db
      .insert(runtimeNodes)
      .values({
        workspaceId,
        ownerUserId: owner.principal.userId,
        kind: 'local_device',
        displayName: 'Disposable test node',
        platform: 'darwin',
        softwareVersion: 'test',
        controlPlaneRuntimeNodeRefId: mintControlPlaneIdentifier('rnr'),
      })
      .returning()
    const [key] = await connection.db
      .insert(runtimeNodeKeys)
      .values({
        runtimeNodeId: node!.id,
        role: 'signing',
        algorithm: 'ed25519',
        publicKey: 'test-public-key',
        fingerprint: crypto.randomUUID(),
        keyVersion: 1,
      })
      .returning()
    await connection.db.insert(runtimeNodeDeliveryRequests).values({
      workspaceId,
      runtimeNodeId: node!.id,
      signingKeyId: key!.id,
      nonce: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    expect(await workspaceDeletionState(connection.db, workspaceId, owner.principal)).toBe('active')
    await removeFixtureWorkspace(connection, workspaceId, owner.principal)
    expect(await workspaceDeletionState(connection.db, workspaceId, owner.principal)).toBe(
      'deleted'
    )
    for (const table of [
      projects,
      tasks,
      agents,
      channels,
      messages,
      contentRefs,
      contentReplicas,
      artifacts,
      runtimeNodes,
      runtimeNodeDeliveryRequests,
      workspaceMemberships,
      authorizationAuditRecords,
    ]) {
      expect(
        await connection.db.select().from(table).where(eq(table.workspaceId, workspaceId))
      ).toEqual([])
    }
    expect(
      await connection.db
        .select()
        .from(runtimeNodeKeys)
        .where(eq(runtimeNodeKeys.runtimeNodeId, node!.id))
    ).toEqual([])
    expect(
      await connection.db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
    ).toEqual([])
    const retained = await listWorkspacesForUser(connection.db, owner.principal)
    expect(retained).toHaveLength(2)
    expect(retained.some((w) => w.id === work!.id)).toBe(true)
    expect(retained.filter((w) => w.isPersonal)).toHaveLength(1)
    await removeFixtureWorkspace(connection, work!.id, owner.principal)
    await connection.db
      .delete(workspaceDeletions)
      .where(eq(workspaceDeletions.ownerUserId, owner.principal.userId))
    await connection.db
      .delete(temporaryUserSessions)
      .where(eq(temporaryUserSessions.userId, owner.principal.userId))
    await purgeFixtureWorkspaces(connection, owner.principal.userId)
    await connection.db.delete(users).where(eq(users.id, owner.principal.userId))
  })

  test('requires the owner and current confirmation; retries safely without reseeding deleted additional workspaces', async () => {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    const stranger = await createTemporaryUserSession(connection.db, {
      credentialDigest: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    try {
      const initial = await deletionFixtures(connection, owner.principal)
      expect(initial.map((w) => w.name)).toEqual(['Scratch', 'Other'])
      const home = initial[0]!
      const confirmation = { confirmationName: home.name, expectedVersion: home.version }
      await connection.db.insert(workspaceMemberships).values({
        workspaceId: home.id,
        userId: stranger.principal.userId,
        role: 'admin',
        sortOrder: 0,
      })
      await expect(
        deleteWorkspace(connection.db, home.id, stranger.principal, confirmation)
      ).rejects.toThrow('Workspace unavailable')
      await expect(
        deleteWorkspace(connection.db, home.id, owner.principal, {
          ...confirmation,
          confirmationName: 'wrong',
        })
      ).rejects.toThrow('Workspace version conflict')
      await expect(
        deleteWorkspace(connection.db, home.id, owner.principal, {
          ...confirmation,
          expectedVersion: home.version + 1,
        })
      ).rejects.toThrow('Workspace version conflict')
      expect(
        await connection.db
          .select()
          .from(workspaceDeletions)
          .where(eq(workspaceDeletions.workspaceId, home.id))
      ).toEqual([])
      expect(await listWorkspacesForUser(connection.db, owner.principal)).toHaveLength(3)
      await expect(
        deleteWorkspace(connection.db, home.id, owner.principal, { ...confirmation, device: true })
      ).rejects.toThrow('cannot verify cleanup completion')
      await removeFixtureWorkspace(connection, home.id, owner.principal)
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
      ).toEqual(['Home', 'Other'])
      const work = initial[1]!
      await removeFixtureWorkspace(connection, work.id, owner.principal)
      expect(
        (await ensureBootstrapWorkspaces(connection.db, owner.principal)).map((w) => w.name)
      ).toEqual(['Home'])
      expect(
        (await ensureBootstrapWorkspaces(connection.db, owner.principal)).map((w) => w.name)
      ).toEqual(['Home'])
    } finally {
      for (const user of [owner, stranger]) {
        await connection.db
          .delete(workspaceDeletions)
          .where(eq(workspaceDeletions.ownerUserId, user.principal.userId))
        await connection.db
          .delete(temporaryUserSessions)
          .where(eq(temporaryUserSessions.userId, user.principal.userId))
        await purgeFixtureWorkspaces(connection, user.principal.userId)
        await connection.db.delete(users).where(eq(users.id, user.principal.userId))
      }
    }
  })

  for (const claimPath of ['identity', 'principal'] as const) {
    test(`guest deletion receipts survive an existing account claim via ${claimPath}`, async () => {
      const identity = { provider: 'neon', subject: crypto.randomUUID() }
      const registered = await createUserWithAuthIdentity(connection.db, { identity })
      const credentialDigest = crypto.randomUUID()
      const temporary = await createTemporaryUserSession(connection.db, {
        credentialDigest,
        expiresAt: new Date(Date.now() + 60_000),
      })
      try {
        const initial = await deletionFixtures(connection, temporary.principal)
        for (const workspace of initial)
          await removeFixtureWorkspace(connection, workspace.id, temporary.principal)
        if (claimPath === 'identity')
          await claimTemporaryUserSession(connection.db, { credentialDigest, identity })
        else
          await claimTemporaryUserSessionForUser(connection.db, {
            credentialDigest,
            target: registered,
          })
        expect(
          (await ensureBootstrapWorkspaces(connection.db, registered)).map((w) => w.name)
        ).toEqual(['Home'])
        const home = initial[0]!
        await deleteWorkspace(connection.db, home.id, registered, {
          confirmationName: home.name,
          expectedVersion: home.version,
        })
        await expect(
          createWorkspaceWithOwner(connection.db, {
            owner: registered,
            name: 'Home',
            idempotencyKey: 'delete-fixture-a',
            scene: 'home',
          })
        ).rejects.toThrow('Workspace creation conflict')
      } finally {
        for (const principal of [temporary.principal, registered]) {
          await connection.db
            .delete(workspaceDeletions)
            .where(eq(workspaceDeletions.ownerUserId, principal.userId))
          await connection.db
            .delete(temporaryUserSessions)
            .where(eq(temporaryUserSessions.userId, principal.userId))
          await purgeFixtureWorkspaces(connection, principal.userId)
          await connection.db.delete(users).where(eq(users.id, principal.userId))
        }
      }
    })
  }

  test('preparation is refused without a server completion verifier; interrupted intent and retries preserve all workspaces', async () => {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60000),
    })
    const initial = await deletionFixtures(connection, owner.principal)
    try {
      for (const workspace of initial) {
        const confirmation = {
          confirmationName: workspace.name,
          expectedVersion: workspace.version,
        }
        await expect(
          beginWorkspaceDeletion(connection.db, workspace.id, owner.principal, confirmation)
        ).rejects.toThrow('cannot verify cleanup completion')
        expect(await workspaceDeletionState(connection.db, workspace.id, owner.principal)).toBe(
          'active'
        )
        await connection.db
          .update(workspaces)
          .set({ deletionRequestedAt: new Date() })
          .where(eq(workspaces.id, workspace.id))
        for (let retry = 0; retry < 2; retry++) {
          await expect(
            deleteWorkspace(connection.db, workspace.id, owner.principal, {
              ...confirmation,
              device: true,
            })
          ).rejects.toThrow('cannot verify cleanup completion')
          expect(await workspaceDeletionState(connection.db, workspace.id, owner.principal)).toBe(
            'cleanup_pending'
          )
          expect(
            await connection.db
              .select()
              .from(workspaceDeletions)
              .where(eq(workspaceDeletions.workspaceId, workspace.id))
          ).toEqual([])
        }
      }
      expect(
        (await ensureBootstrapWorkspaces(connection.db, owner.principal)).map((w) => w.name)
      ).toEqual(['Home', 'Scratch', 'Other'])
    } finally {
      await connection.db
        .delete(temporaryUserSessions)
        .where(eq(temporaryUserSessions.userId, owner.principal.userId))
      await purgeFixtureWorkspaces(connection, owner.principal.userId)
      await connection.db.delete(users).where(eq(users.id, owner.principal.userId))
    }
  })

  test('unverified Control Plane ownership, paired hosts and live tasks keep the workspace and its credentials', async () => {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60000),
    })
    const initial = await deletionFixtures(connection, owner.principal)
    try {
      const home = initial[0]!
      const confirmation = { confirmationName: home.name, expectedVersion: home.version }
      await markWorkspaceControlPlaneUsed(connection.db, home.id)
      await expect(
        beginWorkspaceDeletion(connection.db, home.id, owner.principal, confirmation)
      ).rejects.toThrow('Control Plane')
      expect(await workspaceDeletionState(connection.db, home.id, owner.principal)).toBe('active')
      const work = initial[1]!
      const [node] = await connection.db
        .insert(runtimeNodes)
        .values({
          workspaceId: work.id,
          ownerUserId: owner.principal.userId,
          controlPlaneRuntimeNodeRefId: mintControlPlaneIdentifier('rnr'),
          kind: 'remote_host',
          displayName: 'Fixture host',
          platform: 'linux',
          softwareVersion: 'fixture',
        })
        .returning()
      await expect(
        beginWorkspaceDeletion(connection.db, work.id, owner.principal, {
          confirmationName: work.name,
          expectedVersion: work.version,
        })
      ).rejects.toThrow('registered runtime devices')
      expect(
        await connection.db.select().from(runtimeNodes).where(eq(runtimeNodes.id, node!.id))
      ).toHaveLength(1)
      await connection.db.delete(runtimeNodes).where(eq(runtimeNodes.id, node!.id))
      const [task] = await connection.db
        .insert(tasks)
        .values({
          workspaceId: work.id,
          creatorUserId: owner.principal.userId,
          title: 'Running fixture',
          objective: 'Disposable queued task fixture',
          controlPlaneTaskId: mintControlPlaneIdentifier('tsk'),
          lifecycleState: 'queued',
        })
        .returning()
      await expect(
        beginWorkspaceDeletion(connection.db, work.id, owner.principal, {
          confirmationName: work.name,
          expectedVersion: work.version,
        })
      ).rejects.toThrow('running or queued')
      expect(await listWorkspacesForUser(connection.db, owner.principal)).toHaveLength(3)
      await connection.db.delete(tasks).where(eq(tasks.id, task!.id))
      await expect(
        deleteWorkspace(connection.db, work.id, owner.principal, {
          confirmationName: work.name,
          expectedVersion: work.version,
          device: false,
        })
      ).rejects.toThrow('browser cannot verify')
    } finally {
      for (const workspace of initial)
        await removeFixtureWorkspace(connection, workspace.id, owner.principal)
      await connection.db
        .delete(workspaceDeletions)
        .where(eq(workspaceDeletions.ownerUserId, owner.principal.userId))
      await connection.db
        .delete(temporaryUserSessions)
        .where(eq(temporaryUserSessions.userId, owner.principal.userId))
      await purgeFixtureWorkspaces(connection, owner.principal.userId)
      await connection.db.delete(users).where(eq(users.id, owner.principal.userId))
    }
  })

  test('unverified pending/restarted cleanup keeps real local memory, cloud root and identity intact', async () => {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60000),
    })
    const initial = await deletionFixtures(connection, owner.principal)
    const workspace = initial[0]!
    const dir = mkdtempSync(join(tmpdir(), 'adea-db-native-cleanup-'))
    const scope = {
      accountId: randomUUID(),
      workspaceId: workspace.id,
      runtimeNodeId: randomUUID(),
    }
    const key = randomBytes(32)
    const memory = createMemoryStore({ contentDir: join(dir, 'local-content'), key: () => key })
    const note = memory.create(workspace.id, { text: 'fixture private workspace memory' })
    const effects: string[] = []
    const options = {
      dataDir: dir,
      currentScope: () => scope,
      verify: async (workspaceId: string) => {
        const state = await workspaceDeletionState(connection.db, workspaceId, owner.principal)
        if (!state) throw new Error('owner unavailable')
        return state
      },
      assertIdle: async () => {},
      planData: () => {
        workspaceLocalData({ dataDir: dir, scope, memory }).plan()
      },
      archiveSessions: () => {
        effects.push('archive')
      },
      purgeData: () => {
        effects.push('purge')
        workspaceLocalData({ dataDir: dir, scope, memory }).purge()
      },
      forgetWorkspace: () => {
        effects.push('identity')
      },
    }
    const credential = { kind: 'temporary' as const, credential: 'fixture-injected-owner-proof' }
    const confirmation = { confirmationName: workspace.name, expectedVersion: workspace.version }
    try {
      const ticket = await createWorkspaceCleanup(options).prepare(workspace.id, credential)
      await connection.db
        .update(workspaces)
        .set({ deletionRequestedAt: new Date() })
        .where(eq(workspaces.id, workspace.id))
      for (let retry = 0; retry < 2; retry++) {
        await expect(
          createWorkspaceCleanup(options).commit(ticket.operationId, credential)
        ).rejects.toThrow('completion_unverified')
        await expect(
          deleteWorkspace(connection.db, workspace.id, owner.principal, {
            ...confirmation,
            device: true,
          })
        ).rejects.toThrow('cannot verify cleanup completion')
        expect(memory.list(workspace.id).entries).toEqual([note])
        expect(await workspaceDeletionState(connection.db, workspace.id, owner.principal)).toBe(
          'cleanup_pending'
        )
        expect(effects).toEqual([])
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
      await connection.db
        .delete(temporaryUserSessions)
        .where(eq(temporaryUserSessions.userId, owner.principal.userId))
      await purgeFixtureWorkspaces(connection, owner.principal.userId)
      await connection.db.delete(users).where(eq(users.id, owner.principal.userId))
    }
  })
})
