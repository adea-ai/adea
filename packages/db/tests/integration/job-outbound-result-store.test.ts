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
import {
  createGroupChannel,
  deleteMessage,
  editMessage,
  setChannelParticipants,
} from '../../src/conversations'
import { createTemporaryUserSession } from '../../src/identity'
import {
  createJobOutboundStoreService,
  publishJobOutboundMessage,
  readJobOutboundAccess,
  readJobOutboundAudience,
  readJobOutboundPublication,
  readJobOutboundSource,
} from '../../src/job-outbound-result-store'
import { createProject } from '../../src/projects'
import { createRuntimeNodeChallenge, registerRuntimeNode } from '../../src/runtime-nodes'
import { channels, workspaceMemberships } from '../../src/schema'
import { enqueueTaskSubmission, type TaskSubmissionInput } from '../../src/task-submissions'
import { completeTask, createTask } from '../../src/tasks'
import { createWorkspaceWithOwner } from '../../src/workspaces'

/**
 * PostgreSQL lane for the #1217 release path on real data. The job is a real
 * submitted and completed Task. The canonical publication is written by the
 * existing message flow, and delivery reads it back under the same locks. The
 * destination owner is the job's original actor, so the publication is written by
 * a real destination writer. The recipient is an ordinary destination member and
 * channel participant.
 */

const url = process.env.DATABASE_URL
const profile = { id: `prf_${'0'.repeat(25)}1`, version: `pfv_${'0'.repeat(25)}1`, revision: 0 }
const NIL_UUID = '00000000-0000-4000-8000-000000000000'
const CHECKSUM = 'c'.repeat(64)

describe.skipIf(!url)('job outbound result release on real data', () => {
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
    const recipient = await createTemporaryUserSession(connection.db, {
      credentialDigest: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'Source workspace',
      owner: owner.principal,
    })
    const { workspace: destination } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'Destination workspace',
      owner: owner.principal,
    })
    await connection.db.insert(workspaceMemberships).values({
      role: 'member',
      userId: recipient.principal.userId,
      workspaceId: destination.id,
    })
    // Channel A is the audience the recipient belongs to. Channel B is a group they are not in.
    const channelA = await createGroupChannel(connection.db, destination.id, owner.principal, {
      idempotencyKey: crypto.randomUUID(),
      title: 'Audience group',
    })
    await setChannelParticipants(
      connection.db,
      destination.id,
      channelA.id,
      owner.principal,
      [owner.principal, { kind: 'user', userId: recipient.principal.userId }],
      channelA.version
    )
    const channelB = await createGroupChannel(connection.db, destination.id, owner.principal, {
      idempotencyKey: crypto.randomUUID(),
      title: 'Other group',
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
    await completeTask(connection.db, workspace.id, task.id, owner.principal, {
      idempotencyKey: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
      expectedVersion: task.version,
    })
    return { agent, channelA, channelB, destination, owner, recipient, task, workspace }
  }

  type Fixture = Awaited<ReturnType<typeof fixture>>

  const service = () => createJobOutboundStoreService(connection.db)

  async function publishTo(
    f: Fixture,
    channelId: string,
    summary: string,
    claim: Parameters<typeof publishJobOutboundMessage>[2]['artifact'] = null,
    artifact: Readonly<Record<string, unknown>> | null = null
  ) {
    const decision = await publishJobOutboundMessage(connection.db, service(), {
      artifact: claim,
      destination: { channelId, workspaceId: f.destination.id },
      jobId: f.task.id,
      result: { ...(artifact ? { artifact } : {}), jobId: f.task.id, summary },
    })
    if (decision.action !== 'publish' || !decision.messageId)
      throw new Error(`publication held: ${JSON.stringify(decision)}`)
    return decision.messageId
  }

  function deliver(f: Fixture, messageId: string) {
    return service().deliver(
      { jobId: f.task.id, messageId, recipientUserId: f.recipient.principal.userId },
      async () => {}
    )
  }

  /** The channel's current roster version, read for the next roster write. */
  async function rosterVersion(channelId: string) {
    const [row] = await connection.db
      .select({ version: channels.version })
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1)
    return row!.version
  }

  test('reads the job, its original actor and its completion from real Task data', async () => {
    const f = await fixture()
    expect(await readJobOutboundSource(connection.db, f.task.id)).toMatchObject({
      originalActorUserId: f.owner.principal.userId,
      sourceWorkspaceId: f.workspace.id,
    })
    const job = await readJobOutboundSource(connection.db, f.task.id)
    expect(job?.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(await readJobOutboundSource(connection.db, NIL_UUID)).toBeNull()
    expect(await readJobOutboundSource(connection.db, 'not-a-uuid')).toBeNull()
  })

  test('reads source ownership and destination standing for the exact channel', async () => {
    const f = await fixture()
    expect(
      await readJobOutboundAccess(connection.db, {
        userId: f.owner.principal.userId,
        workspaceId: f.workspace.id,
      })
    ).toEqual({ role: 'owner', workspaceLive: true })
    const inA = await readJobOutboundAudience(connection.db, {
      channelId: f.channelA.id,
      userId: f.recipient.principal.userId,
      workspaceId: f.destination.id,
    })
    expect(inA).toMatchObject({
      channelIsGroup: true,
      channelLive: true,
      participant: true,
      workspaceLive: true,
    })
    expect(inA.joinedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    const inB = await readJobOutboundAudience(connection.db, {
      channelId: f.channelB.id,
      userId: f.recipient.principal.userId,
      workspaceId: f.destination.id,
    })
    expect(inB.participant).toBe(false)
  })

  test('releases the approved body of a real publication to a participant of its channel', async () => {
    const f = await fixture()
    const messageId = await publishTo(f, f.channelA.id, 'Approved body.')
    expect(
      await readJobOutboundPublication(connection.db, { jobId: f.task.id, messageId })
    ).toMatchObject({
      bodyText: 'Approved body.',
      channelId: f.channelA.id,
      executionRef: f.task.id,
      senderKind: 'user',
      senderUserId: f.owner.principal.userId,
      taskId: null,
      workspaceId: f.destination.id,
    })
    expect(await deliver(f, messageId)).toEqual({
      action: 'deliver',
      destination: { channelId: f.channelA.id, workspaceId: f.destination.id },
      jobId: f.task.id,
      messageId,
      result: { artifact: null, jobId: f.task.id, summary: 'Approved body.' },
    })
  })

  test('cross-group substitution: a publication in a group the recipient is not in is not released to them', async () => {
    const f = await fixture()
    const messageId = await publishTo(f, f.channelB.id, 'Group B only.')
    expect(await deliver(f, messageId)).toEqual({
      action: 'deny',
      gate: 'audience',
      reason: 'recipient_not_destination_participant',
    })
  })

  test('denies a recipient who joined the channel after the publication was written', async () => {
    const f = await fixture()
    const messageId = await publishTo(f, f.channelA.id, 'Written before rejoining.')
    await setChannelParticipants(
      connection.db,
      f.destination.id,
      f.channelA.id,
      f.owner.principal,
      [f.owner.principal],
      await rosterVersion(f.channelA.id)
    )
    await setChannelParticipants(
      connection.db,
      f.destination.id,
      f.channelA.id,
      f.owner.principal,
      [f.owner.principal, { kind: 'user', userId: f.recipient.principal.userId }],
      await rosterVersion(f.channelA.id)
    )
    expect(await deliver(f, messageId)).toEqual({
      action: 'deny',
      gate: 'audience',
      reason: 'recipient_joined_after_publication',
    })
  })

  test('denies an edited publication, so the approved body is never released in altered form', async () => {
    const f = await fixture()
    const messageId = await publishTo(f, f.channelA.id, 'Original body.')
    await editMessage(
      connection.db,
      f.destination.id,
      messageId,
      f.owner.principal,
      { bodyText: 'Altered body.' },
      1
    )
    expect(await deliver(f, messageId)).toEqual({
      action: 'deny',
      gate: 'publication',
      reason: 'publication_altered',
    })
  })

  test('denies a deleted publication', async () => {
    const f = await fixture()
    const messageId = await publishTo(f, f.channelA.id, 'Soon deleted.')
    await deleteMessage(connection.db, f.destination.id, messageId, f.owner.principal, 1)
    expect(await deliver(f, messageId)).toEqual({
      action: 'deny',
      gate: 'publication',
      reason: 'publication_altered',
    })
  })

  test('denies release after the original actor is demoted, even though the publication exists', async () => {
    const f = await fixture()
    const messageId = await publishTo(f, f.channelA.id, 'Published while owner.')
    await connection.db
      .update(workspaceMemberships)
      .set({ role: 'member' })
      .where(eq(workspaceMemberships.userId, f.owner.principal.userId))
    expect(await deliver(f, messageId)).toEqual({
      action: 'deny',
      gate: 'source',
      reason: 'source_access_lost',
    })
  })

  test('publishes an artifact claim under the live #1207 lock, and holds it after revocation', async () => {
    const f = await fixture()
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
    const claim = {
      authority: { kind: 'workspace_grant' as const },
      grant: {
        artifactId: artifact.id,
        audienceWorkspaceId: f.destination.id,
        checksumSha256: CHECKSUM,
        expiresAt: null,
        grantId,
        revokedAt: null,
        revision: registration.state.revision,
        sourceWorkspaceId: f.workspace.id,
        version: artifact.version,
      },
    }
    const artifactTarget = {
      artifactId: artifact.id,
      audienceWorkspaceId: f.destination.id,
      checksumSha256: CHECKSUM,
      sourceWorkspaceId: f.workspace.id,
      version: artifact.version,
    }
    const publish = () =>
      service().publish({
        artifact: claim,
        destination: { channelId: f.channelA.id, workspaceId: f.destination.id },
        jobId: f.task.id,
        result: { artifact: artifactTarget, jobId: f.task.id, summary: 'Report attached.' },
      })
    expect(await publish()).toMatchObject({
      action: 'publish',
      result: { artifact: artifactTarget },
    })
    await revokeArtifactReferenceGrant(connection.db, f.workspace.id, f.owner.principal, grantId)
    expect(await publish()).toEqual({
      action: 'hold',
      gate: 'artifact',
      jobId: f.task.id,
      producerEffect: 'unaffected',
      reason: 'grant_revoked',
    })
  })

  test('the existing message flow refuses to link a cross-workspace artifact, and writes nothing', async () => {
    const f = await fixture()
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
    const artifactTarget = {
      artifactId: artifact.id,
      audienceWorkspaceId: f.destination.id,
      checksumSha256: CHECKSUM,
      sourceWorkspaceId: f.workspace.id,
      version: artifact.version,
    }
    const claim = {
      authority: { kind: 'workspace_grant' as const },
      grant: {
        artifactId: artifact.id,
        audienceWorkspaceId: f.destination.id,
        checksumSha256: CHECKSUM,
        expiresAt: null,
        grantId,
        revokedAt: null,
        revision: registration.state.revision,
        sourceWorkspaceId: f.workspace.id,
        version: artifact.version,
      },
    }
    await expect(
      publishJobOutboundMessage(connection.db, service(), {
        artifact: claim,
        destination: { channelId: f.channelA.id, workspaceId: f.destination.id },
        jobId: f.task.id,
        result: { artifact: artifactTarget, jobId: f.task.id, summary: 'Report attached.' },
      })
    ).rejects.toThrow('Artifact unavailable')
    expect(
      await readJobOutboundPublication(connection.db, { jobId: f.task.id, messageId: NIL_UUID })
    ).toBeNull()
  })

  test('refuses an unknown or malformed publication identifier', async () => {
    const f = await fixture()
    expect(
      await readJobOutboundPublication(connection.db, { jobId: f.task.id, messageId: NIL_UUID })
    ).toBeNull()
    expect(
      await readJobOutboundPublication(connection.db, { jobId: f.task.id, messageId: 'not-a-uuid' })
    ).toBeNull()
  })
})
