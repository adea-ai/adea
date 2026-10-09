import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { generateRemoteCommandKeyPair, sealRemoteContent } from '@adea-ai/remote-content'

import { createAgent } from '../../src/agents'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createTemporaryUserSession } from '../../src/identity'
import {
  readJobOutboundAccess,
  readJobOutboundSource,
  createJobOutboundStorePorts,
} from '../../src/job-outbound-result-store'
import { createJobOutboundResultService } from '../../src/job-outbound-result-service'
import { createProject } from '../../src/projects'
import { createRuntimeNodeChallenge, registerRuntimeNode } from '../../src/runtime-nodes'
import { workspaceMemberships, workspaces } from '../../src/schema'
import { enqueueTaskSubmission, type TaskSubmissionInput } from '../../src/task-submissions'
import { completeTask, createTask } from '../../src/tasks'
import { createWorkspaceWithOwner } from '../../src/workspaces'

/**
 * PostgreSQL lane for the #1217 store adapters. The fixture admits a real Task
 * submission and completes the Task through the production paths, then reads
 * the job, access and destination state back through the adapters. No row is
 * written by hand except the explicit demotion and workspace soft delete.
 */

const url = process.env.DATABASE_URL
const profile = { id: `prf_${'0'.repeat(25)}1`, version: `pfv_${'0'.repeat(25)}1`, revision: 0 }
const NIL_UUID = '00000000-0000-4000-8000-000000000000'

describe.skipIf(!url)('job outbound result store adapters', () => {
  let connection: DatabaseConnection
  beforeAll(() => {
    connection = createDatabase(url!)
  })
  afterAll(() => connection.close())

  async function fixture() {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'Source workspace',
      owner: owner.principal,
    })
    const recipient = await createTemporaryUserSession(connection.db, {
      credentialDigest: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace: destination } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'Destination workspace',
      owner: recipient.principal,
    })
    const project = await createProject(connection.db, workspace.id, owner.principal, {
      name: 'Selected project',
      iconKey: 'planning',
    })
    const agent = await createAgent(connection.db, workspace.id, owner.principal, {
      name: 'Selected Agent',
      profileId: profile.id,
      profileVersion: profile.version,
    })
    const task = await createTask(
      connection.db,
      workspace.id,
      owner.principal,
      {
        agentId: agent.id,
        projectId: project.id,
        title: 'Outbound job',
        objective: 'PRIVATE_PROMPT_SENTINEL',
      },
      { idempotencyKey: crypto.randomUUID(), requestId: crypto.randomUUID() }
    )

    const encryption = await generateRemoteCommandKeyPair()
    const publicKey = Buffer.from(
      await crypto.subtle.exportKey('raw', encryption.publicKey)
    ).toString('base64url')
    const keys = [
      {
        algorithm: 'ed25519' as const,
        publicKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),
        role: 'signing' as const,
      },
      { algorithm: 'x25519' as const, publicKey, role: 'command_encryption' as const },
    ]
    const challenge = await createRuntimeNodeChallenge(connection.db, {
      createdByUserId: owner.principal.userId,
      kind: 'remote_host',
      nonce: crypto.randomUUID(),
      purpose: 'pair',
      workspaceId: workspace.id,
    })
    const node = await registerRuntimeNode(connection.db, {
      challengeId: challenge.challengeId,
      displayName: 'Selected host',
      keys,
      kind: 'remote_host',
      ownerUserId: owner.principal.userId,
      platform: 'fixture',
      softwareVersion: '1.0.0',
      workspaceId: workspace.id,
    })
    const requestId = crypto.randomUUID()
    const keyId = node.keys.find((key) => key.role === 'command_encryption')!.keyId
    const envelope = await sealRemoteContent({
      keyId,
      recipientPublicKey: encryption.publicKey,
      aad: {
        workspaceId: workspace.id,
        runtimeNodeId: node.id,
        requestId,
        payloadType: 'command.input',
        schemaVersion: 1,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      plaintext: new TextEncoder().encode('PRIVATE_CONTEXT_SENTINEL'),
    })
    const input: TaskSubmissionInput = {
      runtimeNodeId: node.id,
      queueWhenOffline: false,
      profile,
      envelope,
    }
    await enqueueTaskSubmission(connection.db, workspace.id, task.id, owner.principal, input, {
      idempotencyKey: 'initial-submission',
      requestId,
      expectedVersion: task.version,
    })
    return { owner, recipient, workspace, destination, task }
  }

  test('reads a submitted but uncompleted job with its original actor and source workspace', async () => {
    const f = await fixture()
    const job = await readJobOutboundSource(connection.db, f.task.id)
    expect(job).toEqual({
      completedAt: null,
      jobId: f.task.id,
      originalActorUserId: f.owner.principal.userId,
      sourceWorkspaceId: f.workspace.id,
    })
  })

  test('reads completion from the task.completed mutation and refuses unknown or malformed ids', async () => {
    const f = await fixture()
    const submitted = await readJobOutboundSource(connection.db, f.task.id)
    const current = await completeTask(
      connection.db,
      f.workspace.id,
      f.task.id,
      f.owner.principal,
      {
        idempotencyKey: crypto.randomUUID(),
        requestId: crypto.randomUUID(),
        expectedVersion: f.task.version,
      }
    )
    expect(current.lifecycleState).toBe('completed')
    const completed = await readJobOutboundSource(connection.db, f.task.id)
    expect(completed?.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(completed?.originalActorUserId).toBe(submitted?.originalActorUserId)
    expect(await readJobOutboundSource(connection.db, NIL_UUID)).toBeNull()
    expect(await readJobOutboundSource(connection.db, 'not-a-uuid')).toBeNull()
  })

  test('reads current access by membership role and workspace liveness', async () => {
    const f = await fixture()
    const stranger = await createTemporaryUserSession(connection.db, {
      credentialDigest: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    expect(
      await readJobOutboundAccess(connection.db, {
        userId: f.owner.principal.userId,
        workspaceId: f.workspace.id,
      })
    ).toEqual({ role: 'owner', workspaceLive: true })
    expect(
      await readJobOutboundAccess(connection.db, {
        userId: stranger.principal.userId,
        workspaceId: f.workspace.id,
      })
    ).toEqual({ role: null, workspaceLive: true })
    expect(
      await readJobOutboundAccess(connection.db, { userId: 'bogus', workspaceId: f.workspace.id })
    ).toEqual({ role: null, workspaceLive: false })

    await connection.db
      .update(workspaces)
      .set({ deletedAt: new Date() })
      .where(eq(workspaces.id, f.destination.id))
    expect(
      await readJobOutboundAccess(connection.db, {
        userId: f.recipient.principal.userId,
        workspaceId: f.destination.id,
      })
    ).toEqual({ role: 'owner', workspaceLive: false })
  })

  test('denies publication and later delivery after the original actor is demoted', async () => {
    const f = await fixture()
    const service = createJobOutboundResultService({
      ...createJobOutboundStorePorts(connection.db),
      readArtifactGrantState: async () => null,
    })
    const payload = { jobId: f.task.id, summary: 'Outbound summary.' }
    await completeTask(connection.db, f.workspace.id, f.task.id, f.owner.principal, {
      idempotencyKey: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
      expectedVersion: f.task.version,
    })
    // Read the clock after completion: a completion instant later than `now` is not yet complete.
    const now = new Date().toISOString()

    const published = await service.publish({
      artifact: null,
      destinationWorkspaceId: f.destination.id,
      jobId: f.task.id,
      now,
      result: payload,
    })
    expect(published).toMatchObject({ action: 'publish', destinationWorkspaceId: f.destination.id })
    if (published.action !== 'publish') throw new Error('expected publish')

    const deliver = () =>
      service.deliver({
        artifact: null,
        destinationWorkspaceId: f.destination.id,
        jobId: f.task.id,
        now: new Date().toISOString(),
        published: published.result,
        recipientUserId: f.recipient.principal.userId,
      })
    expect(await deliver()).toMatchObject({ action: 'deliver' })

    await connection.db
      .update(workspaceMemberships)
      .set({ role: 'member' })
      .where(eq(workspaceMemberships.userId, f.owner.principal.userId))
    expect(await deliver()).toEqual({
      action: 'deny',
      gate: 'source',
      reason: 'source_access_lost',
    })
    expect(
      await service.publish({
        artifact: null,
        destinationWorkspaceId: f.destination.id,
        jobId: f.task.id,
        now: new Date().toISOString(),
        result: payload,
      })
    ).toMatchObject({ action: 'hold', gate: 'source', reason: 'source_access_lost' })
  })

  test('refuses artifact evidence for malformed or unknown identifiers', async () => {
    const f = await fixture()
    const ports = createJobOutboundStorePorts(connection.db)
    expect(
      await ports.readArtifactEvidence({
        artifactId: 'not-a-uuid',
        principalUserId: f.owner.principal.userId,
        workspaceId: f.workspace.id,
      })
    ).toBeNull()
    expect(
      await ports.readArtifactEvidence({
        artifactId: NIL_UUID,
        principalUserId: f.owner.principal.userId,
        workspaceId: f.workspace.id,
      })
    ).toBeNull()
  })
})
