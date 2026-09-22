import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import { createContentRef } from '../../src/content-refs'
import { listContentReplicasForUser, upsertContentReplica } from '../../src/content-replicas'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import {
  contentRefs,
  contentReplicas,
  temporaryUserSessions,
  users,
  workspaceMemberships,
  workspaces,
} from '../../src/schema'
import { createTemporaryUserSession } from '../../src/identity'
import { createWorkspaceWithOwner } from '../../src/workspaces'

const connectionUrl = process.env.DATABASE_URL

describe.skipIf(!connectionUrl)('cloud-safe ContentReplica persistence', () => {
  let connection: DatabaseConnection

  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })
  afterAll(async () => connection.close())

  test('converges duplicate and stale encrypted replays and rejects digest conflicts', async () => {
    const plaintextCanary = 'NEVER-PERSIST-PRIVATE-CONTENT'
    const keyCanary = 'NEVER-PERSIST-CONTENT-KEY'
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: `content-replica-owner-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `content-replica-${crypto.randomUUID()}`,
      name: 'Encrypted Replica HQ',
      owner: owner.principal,
    })
    const contentRefId = crypto.randomUUID()
    await createContentRef(connection.db, workspace.id, owner.principal, {
      availability: 'available',
      contentType: 'message_body',
      digestSha256: 'a'.repeat(64),
      id: contentRefId,
      keyVersion: 1,
      messageId: undefined,
      schemaVersion: 1,
      sensitivity: 'restricted',
      storagePolicy: 'local_authority',
      synchronizationPolicy: 'agent_hq_e2ee_sync',
    })
    const localOnlyContentRefId = crypto.randomUUID()
    await createContentRef(connection.db, workspace.id, owner.principal, {
      availability: 'available',
      contentType: 'private_field',
      digestSha256: 'c'.repeat(64),
      id: localOnlyContentRefId,
      keyVersion: 1,
      schemaVersion: 1,
      sensitivity: 'restricted',
      storagePolicy: 'local_authority',
      synchronizationPolicy: 'local_only',
    })
    const { workspace: foreignWorkspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `content-replica-foreign-${crypto.randomUUID()}`,
      name: 'Foreign Replica Workspace',
      owner: owner.principal,
    })
    const foreignContentRefId = crypto.randomUUID()
    await createContentRef(connection.db, foreignWorkspace.id, owner.principal, {
      availability: 'available',
      contentType: 'private_field',
      digestSha256: 'd'.repeat(64),
      id: foreignContentRefId,
      keyVersion: 1,
      schemaVersion: 1,
      sensitivity: 'restricted',
      storagePolicy: 'local_authority',
      synchronizationPolicy: 'agent_hq_e2ee_sync',
    })
    await expect(
      listContentReplicasForUser(
        connection.db,
        workspace.id,
        localOnlyContentRefId,
        owner.principal
      )
    ).rejects.toThrow('Content replica unavailable')
    await expect(
      listContentReplicasForUser(connection.db, workspace.id, crypto.randomUUID(), owner.principal)
    ).rejects.toThrow('Content replica unavailable')
    await expect(
      listContentReplicasForUser(connection.db, workspace.id, foreignContentRefId, owner.principal)
    ).rejects.toThrow('Content replica unavailable')

    const revisionOne = {
      availability: 'available' as const,
      ciphertext: Buffer.from(`${plaintextCanary}:ciphertext`).toString('base64url'),
      digestSha256: 'a'.repeat(64),
      nonce: 'A'.repeat(16),
      replicaKind: 'local_authority' as const,
      revision: 1,
      schemaVersion: 1,
    }
    const created = await upsertContentReplica(
      connection.db,
      workspace.id,
      contentRefId,
      owner.principal,
      revisionOne
    )
    expect(created.outcome).toBe('created')
    await expect(
      upsertContentReplica(connection.db, workspace.id, contentRefId, owner.principal, {
        ...revisionOne,
        ciphertext: 'A',
      })
    ).rejects.toThrow('metadata invalid')
    await expect(
      upsertContentReplica(connection.db, workspace.id, contentRefId, owner.principal, {
        ...revisionOne,
        ciphertext: Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64url'),
      })
    ).rejects.toThrow('metadata invalid')
    const duplicate = await upsertContentReplica(
      connection.db,
      workspace.id,
      contentRefId,
      owner.principal,
      revisionOne
    )
    expect(duplicate).toEqual({ contentReplica: created.contentReplica, outcome: 'duplicate' })

    const revisionTwo = {
      ...revisionOne,
      ciphertext: Buffer.from('encrypted-revision-two').toString('base64url'),
      digestSha256: 'b'.repeat(64),
      nonce: 'B'.repeat(16),
      revision: 2,
    }
    const advanced = await upsertContentReplica(
      connection.db,
      workspace.id,
      contentRefId,
      owner.principal,
      revisionTwo
    )
    expect(advanced.outcome).toBe('created')
    const stale = await upsertContentReplica(
      connection.db,
      workspace.id,
      contentRefId,
      owner.principal,
      revisionOne
    )
    expect(stale.outcome).toBe('stale')
    expect(stale.contentReplica.revision).toBe(2)

    await expect(
      upsertContentReplica(connection.db, workspace.id, contentRefId, owner.principal, {
        ...revisionTwo,
        digestSha256: 'c'.repeat(64),
        nonce: 'C'.repeat(16),
      })
    ).rejects.toThrow('digest conflict')

    await expect(
      upsertContentReplica(connection.db, workspace.id, contentRefId, owner.principal, {
        ...revisionTwo,
        digestSha256: 'b'.repeat(64),
        nonce: 'C'.repeat(16),
      })
    ).rejects.toThrow('digest conflict')

    const encryptedKeyEpoch = crypto.randomUUID()
    const e2e = await upsertContentReplica(
      connection.db,
      workspace.id,
      contentRefId,
      owner.principal,
      {
        ...revisionTwo,
        ciphertext: Buffer.from('encrypted-e2e-revision-two').toString('base64url'),
        keyEpochId: encryptedKeyEpoch,
        nonce: 'D'.repeat(16),
        replicaKind: 'agent_hq_e2ee_sync',
      }
    )
    expect(e2e.contentReplica.keyEpochId).toBe(encryptedKeyEpoch)

    const concurrentRevision = {
      ...revisionTwo,
      ciphertext: Buffer.from('encrypted-concurrent-revision-three').toString('base64url'),
      nonce: 'E'.repeat(16),
      revision: 3,
    }
    const concurrent = await Promise.all([
      upsertContentReplica(
        connection.db,
        workspace.id,
        contentRefId,
        owner.principal,
        concurrentRevision
      ),
      upsertContentReplica(
        connection.db,
        workspace.id,
        contentRefId,
        owner.principal,
        concurrentRevision
      ),
    ])
    expect(concurrent.map(({ outcome }) => outcome).toSorted()).toEqual(['created', 'duplicate'])
    expect(concurrent[0]?.contentReplica.id).toBe(concurrent[1]?.contentReplica.id)

    const persisted = await connection.db
      .select()
      .from(contentReplicas)
      .where(eq(contentReplicas.contentRefId, contentRefId))
    expect(persisted).toHaveLength(4)
    expect(JSON.stringify(persisted)).not.toContain(plaintextCanary)
    expect(JSON.stringify(persisted)).not.toContain(keyCanary)
    expect(
      await listContentReplicasForUser(connection.db, workspace.id, contentRefId, owner.principal)
    ).toHaveLength(4)

    await connection.db.delete(contentReplicas).where(eq(contentReplicas.workspaceId, workspace.id))
    await connection.db.delete(contentRefs).where(eq(contentRefs.workspaceId, workspace.id))
    await connection.db
      .delete(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, workspace.id))
    await connection.db.delete(workspaces).where(eq(workspaces.id, workspace.id))
    await connection.db
      .delete(contentReplicas)
      .where(eq(contentReplicas.workspaceId, foreignWorkspace.id))
    await connection.db.delete(contentRefs).where(eq(contentRefs.workspaceId, foreignWorkspace.id))
    await connection.db
      .delete(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, foreignWorkspace.id))
    await connection.db.delete(workspaces).where(eq(workspaces.id, foreignWorkspace.id))
    await connection.db
      .delete(temporaryUserSessions)
      .where(eq(temporaryUserSessions.userId, owner.principal.userId))
    await connection.db.delete(users).where(eq(users.id, owner.principal.userId))
  })
})
