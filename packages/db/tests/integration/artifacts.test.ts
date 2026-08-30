import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'

import { createAgent } from '../../src/agents'
import {
  createArtifact,
  deleteArtifact,
  getArtifactForUser,
  listArtifactsForUser,
  setArtifactAvailability,
} from '../../src/artifacts'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createTemporaryUserSession } from '../../src/identity'
import {
  agents,
  artifacts,
  taskMutations,
  tasks,
  temporaryUserSessions,
  users,
  workspaceEvents,
  workspaceMemberships,
  workspaces,
} from '../../src/schema'
import { createTask } from '../../src/tasks'
import { createWorkspaceWithOwner } from '../../src/workspaces'

const connectionUrl = process.env.DATABASE_URL

describe.skipIf(!connectionUrl)('Artifact metadata and references', () => {
  let connection: DatabaseConnection

  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })
  afterAll(async () => connection.close())

  async function fixture(name: string) {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: `${name}-owner-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const outsider = await createTemporaryUserSession(connection.db, {
      credentialDigest: `${name}-outsider-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `${name}-${crypto.randomUUID()}`,
      name,
      owner: owner.principal,
    })
    return { outsider, owner, workspace }
  }

  async function cleanup(workspaceId: string, userIds: readonly string[]) {
    await connection.db.delete(artifacts).where(eq(artifacts.workspaceId, workspaceId))
    await connection.db.delete(taskMutations).where(eq(taskMutations.workspaceId, workspaceId))
    await connection.db.delete(tasks).where(eq(tasks.workspaceId, workspaceId))
    await connection.db.delete(agents).where(eq(agents.workspaceId, workspaceId))
    await connection.db
      .delete(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, workspaceId))
    await connection.db.delete(workspaces).where(eq(workspaces.id, workspaceId))
    for (const userId of userIds) {
      await connection.db
        .delete(temporaryUserSessions)
        .where(eq(temporaryUserSessions.userId, userId))
      await connection.db.delete(users).where(eq(users.id, userId))
    }
  }

  test('creates idempotent metadata with optional Task, Agent, and execution provenance', async () => {
    const { outsider, owner, workspace } = await fixture('Artifact provenance')
    const agent = await createAgent(connection.db, workspace.id, owner.principal, {
      name: 'Builder',
      profileId: 'builder',
      profileVersion: '1',
    })
    const task = await createTask(
      connection.db,
      workspace.id,
      owner.principal,
      { objective: 'Produce a report', title: 'Report' },
      { idempotencyKey: 'artifact-task', requestId: crypto.randomUUID() }
    )
    const input = {
      agentId: agent.id,
      availability: 'available' as const,
      checksumSha256: 'a'.repeat(64),
      executionRef: 'execution:report-1',
      filename: 'report.txt',
      location: {
        reference: 'outputs/report-1',
        runtimeNodeId: 'node-1',
        type: 'runtime_node' as const,
      },
      mediaType: 'text/plain',
      provenance: { command: 'report' },
      retentionPolicy: 'standard' as const,
      sensitivity: 'workspace' as const,
      sizeBytes: 42,
      sourceArtifactRef: 'runtime-output:report-1',
      sourcePrincipal: { agentId: agent.id, kind: 'agent' as const },
      taskId: task.id,
    }
    const created = await createArtifact(connection.db, workspace.id, owner.principal, input)
    const retried = await createArtifact(connection.db, workspace.id, owner.principal, input)

    expect(retried.id).toBe(created.id)
    expect(created).toMatchObject({
      agentId: agent.id,
      availability: 'available',
      location: input.location,
      owner: owner.principal,
      sourcePrincipal: input.sourcePrincipal,
      taskId: task.id,
      version: 1,
    })
    expect(await listArtifactsForUser(connection.db, workspace.id, owner.principal)).toHaveLength(1)
    expect(
      await getArtifactForUser(connection.db, workspace.id, created.id, outsider.principal)
    ).toBeNull()
    await expect(
      createArtifact(connection.db, workspace.id, owner.principal, {
        ...input,
        filename: 'different.txt',
      })
    ).rejects.toThrow('Artifact source conflict')

    await cleanup(workspace.id, [owner.principal.userId, outsider.principal.userId])
  })

  test('rejects local paths, URLs, credentials, and malformed location ownership', async () => {
    const { outsider, owner, workspace } = await fixture('Artifact validation')
    const base = {
      checksumSha256: 'b'.repeat(64),
      filename: 'unsafe.txt',
      mediaType: 'text/plain',
      sizeBytes: 1,
      sourcePrincipal: owner.principal,
    }
    for (const [index, reference] of [
      '/Users/example/private.txt',
      'C:\\private\\secret.txt',
      'file:///tmp/private.txt',
      'https://store.example/object?token=secret',
      '../private.txt',
      'aws_access_key_id=secret',
    ].entries()) {
      await expect(
        createArtifact(connection.db, workspace.id, owner.principal, {
          ...base,
          location: { reference, runtimeNodeId: 'node-1', type: 'runtime_node' },
          sourceArtifactRef: `unsafe:${index}`,
        })
      ).rejects.toThrow('Artifact location reference invalid')
    }
    await expect(
      createArtifact(connection.db, workspace.id, owner.principal, {
        ...base,
        location: { reference: 'safe-ref', type: 'runtime_node' },
        sourceArtifactRef: 'missing-node',
      })
    ).rejects.toThrow('Artifact location invalid')
    await expect(
      createArtifact(connection.db, workspace.id, owner.principal, {
        ...base,
        location: { reference: 'safe-ref', type: 'object_store' },
        provenance: { accessToken: 'secret' },
        sourceArtifactRef: 'unsafe-provenance',
      })
    ).rejects.toThrow('Artifact provenance invalid')
    await expect(
      createArtifact(connection.db, workspace.id, owner.principal, {
        ...base,
        location: { reference: 'safe-ref', type: 'external_harness' },
        sourceArtifactRef: 'missing-harness',
      })
    ).rejects.toThrow('Artifact location invalid')

    await cleanup(workspace.id, [owner.principal.userId, outsider.principal.userId])
  })

  test('models offline availability and audited deletion with optimistic conflicts', async () => {
    const { outsider, owner, workspace } = await fixture('Artifact lifecycle')
    const created = await createArtifact(connection.db, workspace.id, owner.principal, {
      checksumSha256: 'c'.repeat(64),
      filename: 'local.bin',
      location: {
        reference: 'runtime-output-1',
        runtimeNodeId: 'node-offline',
        type: 'runtime_node',
      },
      mediaType: 'application/octet-stream',
      sizeBytes: 128,
      sourceArtifactRef: 'runtime-output:offline',
      sourcePrincipal: { kind: 'runtime_node', runtimeNodeId: 'node-offline' },
    })
    const unavailable = await setArtifactAvailability(
      connection.db,
      workspace.id,
      created.id,
      owner.principal,
      'unavailable',
      created.version
    )
    expect(unavailable).toMatchObject({ availability: 'unavailable', version: 2 })
    await expect(
      setArtifactAvailability(
        connection.db,
        workspace.id,
        created.id,
        owner.principal,
        'available',
        created.version
      )
    ).rejects.toThrow('Artifact version conflict')
    const deleted = await deleteArtifact(
      connection.db,
      workspace.id,
      created.id,
      owner.principal,
      unavailable.version
    )
    expect(deleted).toMatchObject({
      availability: 'unavailable',
      deletionState: 'deleted',
      version: 3,
    })
    expect(deleted.location.reference).toBeUndefined()
    expect(
      await getArtifactForUser(connection.db, workspace.id, created.id, owner.principal)
    ).toBeNull()
    expect(
      await getArtifactForUser(connection.db, workspace.id, created.id, owner.principal, {
        includeDeleted: true,
      })
    ).toMatchObject({ deletionState: 'deleted' })
    expect(
      await connection.db
        .select({ eventType: workspaceEvents.eventType })
        .from(workspaceEvents)
        .where(
          and(
            eq(workspaceEvents.workspaceId, workspace.id),
            eq(workspaceEvents.eventType, 'artifact.deleted')
          )
        )
    ).toHaveLength(1)

    await cleanup(workspace.id, [owner.principal.userId, outsider.principal.userId])
  })
})
