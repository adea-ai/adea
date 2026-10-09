import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { generateRemoteCommandKeyPair, sealRemoteContent } from '@adea-ai/remote-content'

import { createAgent } from '../../src/agents'
import { createArtifact } from '../../src/artifacts'
import {
  registerArtifactReferenceGrant,
  revokeArtifactReferenceGrant,
} from '../../src/artifact-reference-grants'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createGroupChannel, setChannelParticipants } from '../../src/conversations'
import { createTemporaryUserSession } from '../../src/identity'
import {
  createJobOutboundAuthorizer,
  readJobOutboundAccess,
  readJobOutboundAudience,
  readJobOutboundSource,
} from '../../src/job-outbound-result-store'
import { createJobOutboundResultService } from '../../src/job-outbound-result-service'
import { createProject } from '../../src/projects'
import { createRuntimeNodeChallenge, registerRuntimeNode } from '../../src/runtime-nodes'
import { channels, workspaceMemberships } from '../../src/schema'
import { enqueueTaskSubmission, type TaskSubmissionInput } from '../../src/task-submissions'
import { completeTask, createTask } from '../../src/tasks'
import { createWorkspaceWithOwner } from '../../src/workspaces'

/**
 * PostgreSQL lane for the #1217 authorization scope and store adapters. The
 * fixture admits a real Task submission and completes the Task through the
 * production paths, creates a real destination group channel, and registers a
 * real artifact grant (#1207). Only the demotion, channel archive and workspace
 * soft delete are written by hand.
 */

const url = process.env.DATABASE_URL
const profile = { id: `prf_${'0'.repeat(25)}1`, version: `pfv_${'0'.repeat(25)}1`, revision: 0 }
const NIL_UUID = '00000000-0000-4000-8000-000000000000'
const CHECKSUM = 'c'.repeat(64)

describe.skipIf(!url)('job outbound result store adapters', () => {
  let connection: DatabaseConnection
  beforeAll(() => {
    connection = createDatabase(url!)
  })
  afterAll(() => connection.close())

  /** A completed-to-be Task in a source workspace, and a destination group channel with one participant. */
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
    const channel = await createGroupChannel(connection.db, destination.id, recipient.principal, {
      idempotencyKey: crypto.randomUUID(),
      title: 'Destination group',
    })
    await setChannelParticipants(
      connection.db,
      destination.id,
      channel.id,
      recipient.principal,
      [{ kind: 'user', userId: recipient.principal.userId }],
      channel.version
    )
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
    return { channel, destination, owner, recipient, task, workspace }
  }

  async function completed(f: Awaited<ReturnType<typeof fixture>>) {
    await completeTask(connection.db, f.workspace.id, f.task.id, f.owner.principal, {
      idempotencyKey: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
      expectedVersion: f.task.version,
    })
  }

  test('reads a submitted but uncompleted job with its original actor and source workspace', async () => {
    const f = await fixture()
    expect(await readJobOutboundSource(connection.db, f.task.id)).toEqual({
      completedAt: null,
      jobId: f.task.id,
      originalActorUserId: f.owner.principal.userId,
      sourceWorkspaceId: f.workspace.id,
    })
  })

  test('reads completion from the task.completed mutation and refuses unknown or malformed ids', async () => {
    const f = await fixture()
    const before = await readJobOutboundSource(connection.db, f.task.id)
    await completed(f)
    const after = await readJobOutboundSource(connection.db, f.task.id)
    expect(after?.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(after?.originalActorUserId).toBe(before?.originalActorUserId)
    expect(await readJobOutboundSource(connection.db, NIL_UUID)).toBeNull()
    expect(await readJobOutboundSource(connection.db, 'not-a-uuid')).toBeNull()
  })

  test('reads current source access by membership role and workspace liveness', async () => {
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
  })

  test('reads destination standing for the exact channel only, never a standing in another group', async () => {
    const f = await fixture()
    const other = await createGroupChannel(connection.db, f.destination.id, f.recipient.principal, {
      idempotencyKey: crypto.randomUUID(),
      title: 'Other destination group',
    })
    // The creator joins automatically; clear the roster so the recipient is in the first group only.
    await setChannelParticipants(
      connection.db,
      f.destination.id,
      other.id,
      f.recipient.principal,
      [],
      other.version
    )
    const inChannel = await readJobOutboundAudience(connection.db, {
      channelId: f.channel.id,
      userId: f.recipient.principal.userId,
      workspaceId: f.destination.id,
    })
    expect(inChannel).toEqual({
      channelId: f.channel.id,
      channelIsGroup: true,
      channelLive: true,
      participant: true,
      workspaceLive: true,
    })
    // The recipient participates in the first group only; the second group is not a stand-in.
    const substituted = await readJobOutboundAudience(connection.db, {
      channelId: other.id,
      userId: f.recipient.principal.userId,
      workspaceId: f.destination.id,
    })
    expect(substituted.participant).toBe(false)
    expect(substituted.channelId).toBe(other.id)
  })

  test('reads an archived destination channel as not live', async () => {
    const f = await fixture()
    await connection.db
      .update(channels)
      .set({ lifecycleState: 'archived' })
      .where(eq(channels.id, f.channel.id))
    const standing = await readJobOutboundAudience(connection.db, {
      channelId: f.channel.id,
      userId: f.recipient.principal.userId,
      workspaceId: f.destination.id,
    })
    expect(standing).toMatchObject({ channelLive: false, participant: true })
  })

  test('releases a plain result under the real scope, then denies once the original actor is demoted', async () => {
    const f = await fixture()
    await completed(f)
    const service = createJobOutboundResultService(createJobOutboundAuthorizer(connection.db))
    const destination = { channelId: f.channel.id, workspaceId: f.destination.id }
    const payload = { jobId: f.task.id, summary: 'Outbound summary.' }
    const released: unknown[] = []
    const release = async (context: { transaction: unknown }, result: unknown) => {
      // The release runs inside the authorization transaction, not on the root connection.
      expect(context.transaction).not.toBe(connection.db)
      released.push(result)
    }
    const deliver = () =>
      service.deliver(
        {
          artifact: null,
          destination,
          jobId: f.task.id,
          now: new Date().toISOString(),
          published: payload,
          recipientUserId: f.recipient.principal.userId,
        },
        release
      )

    expect(
      await service.publish({
        artifact: null,
        destination,
        jobId: f.task.id,
        now: new Date().toISOString(),
        result: payload,
      })
    ).toMatchObject({ action: 'publish', destination })
    expect(await deliver()).toMatchObject({ action: 'deliver', destination })
    expect(released).toEqual([{ artifact: null, jobId: f.task.id, summary: 'Outbound summary.' }])

    await connection.db
      .update(workspaceMemberships)
      .set({ role: 'member' })
      .where(eq(workspaceMemberships.userId, f.owner.principal.userId))
    expect(await deliver()).toEqual({
      action: 'deny',
      gate: 'source',
      reason: 'source_access_lost',
    })
    expect(released.length).toBe(1)
  })

  test('releases an artifact only under the live #1207 registration and denies after revocation', async () => {
    const f = await fixture()
    await completed(f)
    const artifact = await createArtifact(connection.db, f.workspace.id, f.owner.principal, {
      availability: 'available',
      checksumSha256: CHECKSUM,
      filename: 'result.txt',
      location: { reference: `outputs/${crypto.randomUUID()}`, type: 'object_store' },
      mediaType: 'text/plain',
      sizeBytes: 32,
      sourceArtifactRef: `runtime-output:${crypto.randomUUID()}`,
      sourcePrincipal: { kind: 'system', systemId: 'job-runner' },
    })
    const grantId = `grant-${crypto.randomUUID()}`
    const registration = await registerArtifactReferenceGrant(
      connection.db,
      f.workspace.id,
      f.owner.principal,
      {
        artifactId: artifact.id,
        audienceWorkspaceId: f.destination.id,
        checksumSha256: CHECKSUM,
        expiresAt: null,
        grantId,
        version: artifact.version,
      }
    )
    const grant = {
      artifactId: artifact.id,
      audienceWorkspaceId: f.destination.id,
      checksumSha256: CHECKSUM,
      expiresAt: null,
      grantId,
      revokedAt: null,
      revision: registration.state.revision,
      sourceWorkspaceId: f.workspace.id,
      version: artifact.version,
    }
    const artifactTarget = {
      artifactId: artifact.id,
      audienceWorkspaceId: f.destination.id,
      checksumSha256: CHECKSUM,
      sourceWorkspaceId: f.workspace.id,
      version: artifact.version,
    }
    const claim = { authority: { kind: 'workspace_grant' as const }, grant }
    const destination = { channelId: f.channel.id, workspaceId: f.destination.id }
    const service = createJobOutboundResultService(createJobOutboundAuthorizer(connection.db))
    const payload = { artifact: artifactTarget, jobId: f.task.id, summary: 'Report attached.' }
    const released: unknown[] = []
    const release = async (_context: unknown, result: unknown) => {
      released.push(result)
    }
    const deliver = () =>
      service.deliver(
        {
          artifact: claim,
          destination,
          jobId: f.task.id,
          now: new Date().toISOString(),
          published: payload,
          recipientUserId: f.recipient.principal.userId,
        },
        release
      )

    expect(
      await service.publish({
        artifact: claim,
        destination,
        jobId: f.task.id,
        now: new Date().toISOString(),
        result: payload,
      })
    ).toMatchObject({ action: 'publish', result: { artifact: artifactTarget } })
    expect(await deliver()).toMatchObject({
      action: 'deliver',
      result: { artifact: artifactTarget },
    })
    expect(released.length).toBe(1)

    await revokeArtifactReferenceGrant(connection.db, f.workspace.id, f.owner.principal, grantId)
    expect(await deliver()).toEqual({ action: 'deny', gate: 'artifact', reason: 'grant_revoked' })
    expect(released.length).toBe(1)
  })

  test('refuses artifact evidence for malformed or unknown identifiers through the scope reads', async () => {
    const f = await fixture()
    const reads = createJobOutboundAuthorizer(connection.db)
    const probe = await reads(null, async ({ reads: scopedReads }) => ({
      evidence: await scopedReads.readArtifactEvidence({
        artifactId: 'not-a-uuid',
        principalUserId: f.owner.principal.userId,
        workspaceId: f.workspace.id,
      }),
      unknown: await scopedReads.readArtifactEvidence({
        artifactId: NIL_UUID,
        principalUserId: f.owner.principal.userId,
        workspaceId: f.workspace.id,
      }),
    }))
    expect(probe).toEqual({ evidence: null, unknown: null })
  })
})
