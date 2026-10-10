import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { generateRemoteCommandKeyPair, sealRemoteContent } from '@adea-ai/remote-content'
import type { UserPrincipalRef } from '@adea-ai/types'

import { createAgent } from '../../src/agents'
import { createArtifact, setArtifactAvailability } from '../../src/artifacts'
import {
  regrantArtifactReferenceGrant,
  registerArtifactReferenceGrant,
  revokeArtifactReferenceGrant,
} from '../../src/artifact-reference-grants'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import {
  createGroupChannel,
  createMessage,
  deleteMessage,
  editMessage,
  getMessageForUser,
  listMessagesForUser,
  setChannelParticipants,
} from '../../src/conversations'
import { searchWorkspaceForUser } from '../../src/search'
import { listWorkspaceEventsAfter } from '../../src/event-log'
import { classifyWorkspaceEventsForUser } from '../../src/event-visibility'
import { createTemporaryUserSession } from '../../src/identity'
import {
  completeTaskAndPublishOutboundResult,
  type JobOutboundCompletionRequest,
  createJobOutboundStoreService,
  publishJobOutboundMessage,
  readJobOutboundAccess,
  type JobOutboundCompletionSeams,
  readJobOutboundAudience,
  readJobOutboundPublication,
  readJobOutboundSource,
} from '../../src/job-outbound-result-store'
import { createProject } from '../../src/projects'
import { createRuntimeNodeChallenge, registerRuntimeNode } from '../../src/runtime-nodes'
import {
  channels,
  messageArtifactReferences,
  messages,
  taskMutations,
  taskSubmissions,
  tasks,
  workspaceMemberships,
} from '../../src/schema'
import {
  decodeJobOutboundBinding,
  encodeJobOutboundBinding,
  summarySha256,
} from '../../src/job-outbound-binding'
import { enqueueTaskSubmission, type TaskSubmissionInput } from '../../src/task-submissions'
import { completeTask, createTask } from '../../src/tasks'
import { createWorkspaceWithOwner } from '../../src/workspaces'

/**
 * PostgreSQL lane for the #1217 publication and release path on real data. The job
 * is a real submitted and completed Task. Publication is authorized and written in
 * one transaction, and delivery reads the canonical publication back under the same
 * locks. The destination owner is the job's original actor. The recipient is an
 * ordinary destination member. The artifact is in the source workspace, and its
 * grant is a real #1207 registration for the destination.
 */

const url = process.env.DATABASE_URL
const profile = { id: `prf_${'0'.repeat(25)}1`, version: `pfv_${'0'.repeat(25)}1`, revision: 0 }
const NIL_UUID = '00000000-0000-4000-8000-000000000000'
const CHECKSUM = 'c'.repeat(64)

describe.skipIf(!url)('job outbound publication and release on real data', () => {
  let connection: DatabaseConnection
  beforeAll(() => {
    connection = createDatabase(url!)
  })
  afterAll(() => connection.close())

  async function fixture(options: { complete?: boolean } = {}) {
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
    if (options.complete !== false)
      await completeTask(connection.db, workspace.id, task.id, owner.principal, {
        idempotencyKey: crypto.randomUUID(),
        requestId: crypto.randomUUID(),
        expectedVersion: task.version,
      })
    return { agent, channelA, channelB, destination, owner, recipient, task, workspace }
  }

  type Fixture = Awaited<ReturnType<typeof fixture>>

  const service = () => createJobOutboundStoreService(connection.db)

  /** Publishes and returns the canonical message id; a held publication fails the test. */
  async function publishTo(f: Fixture, channelId: string, summary: string) {
    const outcome = await publishJobOutboundMessage(service(), {
      artifact: null,
      destination: { channelId, workspaceId: f.destination.id },
      jobId: f.task.id,
      result: { jobId: f.task.id, summary },
    })
    if (outcome.decision.action !== 'publish' || !outcome.messageId)
      throw new Error(`publication held: ${JSON.stringify(outcome.decision)}`)
    return outcome.messageId
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

  /** Messages in a channel whose execution reference is the job. */
  async function jobMessages(channelId: string, jobId: string) {
    return connection.db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.channelId, channelId), eq(messages.executionRef, jobId)))
  }

  /** A real artifact in the source workspace, registered to the destination by a real grant. */
  async function registeredArtifact(f: Fixture) {
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
    const target = {
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
    return { artifact, claim, grantId, target }
  }

  /** Publishes a linked artifact result to channel A, through the same atomic path. */
  async function publishArtifact(f: Fixture, reg: Awaited<ReturnType<typeof registeredArtifact>>) {
    return publishJobOutboundMessage(service(), {
      artifact: reg.claim,
      destination: { channelId: f.channelA.id, workspaceId: f.destination.id },
      jobId: f.task.id,
      result: { artifact: reg.target, jobId: f.task.id, summary: 'Report attached.' },
    })
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

  test('reads source ownership and the exact channel standing with its revision', async () => {
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
    expect(inA.channelVersion).toEqual(expect.any(Number))
    const inB = await readJobOutboundAudience(connection.db, {
      channelId: f.channelB.id,
      userId: f.recipient.principal.userId,
      workspaceId: f.destination.id,
    })
    expect(inB.participant).toBe(false)
  })

  test('publishes atomically as a system-sender message bound to the job, and releases its approved body', async () => {
    const f = await fixture()
    const messageId = await publishTo(f, f.channelA.id, 'Approved body.')
    expect(
      await readJobOutboundPublication(connection.db, { jobId: f.task.id, messageId })
    ).toMatchObject({
      bodyText: 'Approved body.',
      channelId: f.channelA.id,
      executionRef: f.task.id,
      senderKind: 'system',
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

  test('a held publication writes no message: nothing is visible before authorization', async () => {
    const f = await fixture()
    await connection.db
      .update(workspaceMemberships)
      .set({ role: 'member' })
      .where(eq(workspaceMemberships.userId, f.owner.principal.userId))
    const outcome = await publishJobOutboundMessage(service(), {
      artifact: null,
      destination: { channelId: f.channelA.id, workspaceId: f.destination.id },
      jobId: f.task.id,
      result: { jobId: f.task.id, summary: 'Held.' },
    })
    expect(outcome).toMatchObject({
      decision: { action: 'hold', gate: 'source', reason: 'source_access_lost' },
      messageId: null,
    })
    expect(await jobMessages(f.channelA.id, f.task.id)).toEqual([])
  })

  test('a user message that names the job and the actor is never a publication', async () => {
    const f = await fixture()
    const forged = await createMessage(
      connection.db,
      f.destination.id,
      f.channelA.id,
      f.owner.principal,
      {
        bodyText: 'Approved body.',
        executionRef: f.task.id,
        idempotencyKey: `forged-${crypto.randomUUID()}`,
        sender: { kind: 'user', userId: f.owner.principal.userId },
      }
    )
    expect(await deliver(f, forged.id)).toEqual({
      action: 'deny',
      gate: 'publication',
      reason: 'publication_unavailable',
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

  test('denies release after a roster change: the channel revision moved since publication', async () => {
    const f = await fixture()
    const messageId = await publishTo(f, f.channelA.id, 'Written before a roster change.')
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
      reason: 'audience_revision_changed',
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

  test('cross-workspace artifact: publication links the source artifact in the destination, and releases it', async () => {
    const f = await fixture()
    const reg = await registeredArtifact(f)
    const outcome = await publishArtifact(f, reg)
    expect(outcome.decision).toMatchObject({ action: 'publish', result: { artifact: reg.target } })
    if (!outcome.messageId) throw new Error('expected a message id')
    const links = await connection.db
      .select({ workspaceId: messageArtifactReferences.workspaceId })
      .from(messageArtifactReferences)
      .where(eq(messageArtifactReferences.messageId, outcome.messageId))
    expect(links).toEqual([{ workspaceId: f.destination.id }])
    expect(
      await service().deliver(
        {
          jobId: f.task.id,
          messageId: outcome.messageId,
          recipientUserId: f.recipient.principal.userId,
        },
        async () => {}
      )
    ).toMatchObject({ action: 'deliver', result: { artifact: reg.target } })
  })

  test('publication under a revoked grant is held atomically: no message and no link are written', async () => {
    const f = await fixture()
    const reg = await registeredArtifact(f)
    await revokeArtifactReferenceGrant(
      connection.db,
      f.workspace.id,
      f.owner.principal,
      reg.grantId
    )
    const outcome = await publishArtifact(f, reg)
    expect(outcome).toMatchObject({
      decision: { action: 'hold', gate: 'artifact', reason: 'grant_revoked' },
      messageId: null,
    })
    expect(await jobMessages(f.channelA.id, f.task.id)).toEqual([])
  })

  test('revocation after publication denies release of the linked artifact', async () => {
    const f = await fixture()
    const reg = await registeredArtifact(f)
    const outcome = await publishArtifact(f, reg)
    if (!outcome.messageId) throw new Error('expected a message id')
    await revokeArtifactReferenceGrant(
      connection.db,
      f.workspace.id,
      f.owner.principal,
      reg.grantId
    )
    expect(
      await service().deliver(
        {
          jobId: f.task.id,
          messageId: outcome.messageId,
          recipientUserId: f.recipient.principal.userId,
        },
        async () => {}
      )
    ).toEqual({ action: 'deny', gate: 'artifact', reason: 'grant_revoked' })
  })

  test('a regrant after publication does not revive the bound revision', async () => {
    const f = await fixture()
    const reg = await registeredArtifact(f)
    const outcome = await publishArtifact(f, reg)
    if (!outcome.messageId) throw new Error('expected a message id')
    await revokeArtifactReferenceGrant(
      connection.db,
      f.workspace.id,
      f.owner.principal,
      reg.grantId
    )
    await regrantArtifactReferenceGrant(
      connection.db,
      f.workspace.id,
      f.owner.principal,
      {
        artifactId: reg.artifact.id,
        audienceWorkspaceId: f.destination.id,
        checksumSha256: CHECKSUM,
        expiresAt: null,
        grantId: reg.grantId,
        version: reg.artifact.version,
      },
      1
    )
    const decision = await service().deliver(
      {
        jobId: f.task.id,
        messageId: outcome.messageId,
        recipientUserId: f.recipient.principal.userId,
      },
      async () => {}
    )
    expect(decision).toMatchObject({ action: 'deny', gate: 'artifact' })
  })

  test('an artifact that is quarantined after publication is not released', async () => {
    const f = await fixture()
    const reg = await registeredArtifact(f)
    const outcome = await publishArtifact(f, reg)
    if (!outcome.messageId) throw new Error('expected a message id')
    await setArtifactAvailability(
      connection.db,
      f.workspace.id,
      reg.artifact.id,
      f.owner.principal,
      'quarantined',
      reg.artifact.version
    )
    // The #1207 lock refuses a quarantined artifact with its own typed error: fail closed, nothing released.
    expect(
      await service().deliver(
        {
          jobId: f.task.id,
          messageId: outcome.messageId,
          recipientUserId: f.recipient.principal.userId,
        },
        async () => {}
      )
    ).toMatchObject({ action: 'deny', gate: 'artifact', reason: 'artifact_binding_mismatch' })
  })

  test('concurrent revocation and release: once revocation has committed, no later release succeeds', async () => {
    const f = await fixture()
    const reg = await registeredArtifact(f)
    const outcome = await publishArtifact(f, reg)
    if (!outcome.messageId) throw new Error('expected a message id')
    const messageId = outcome.messageId
    const [released] = await Promise.all([
      service().deliver(
        { jobId: f.task.id, messageId, recipientUserId: f.recipient.principal.userId },
        async () => {}
      ),
      revokeArtifactReferenceGrant(connection.db, f.workspace.id, f.owner.principal, reg.grantId),
    ])
    expect(['deliver', 'deny'].includes(released.action)).toBe(true)
    expect(
      await service().deliver(
        { jobId: f.task.id, messageId, recipientUserId: f.recipient.principal.userId },
        async () => {}
      )
    ).toEqual({ action: 'deny', gate: 'artifact', reason: 'grant_revoked' })
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

  test('artifact-free summary: a revoked artifact publishes the summary with no link and no artifact identity', async () => {
    const f = await fixture()
    const reg = await registeredArtifact(f)
    await revokeArtifactReferenceGrant(
      connection.db,
      f.workspace.id,
      f.owner.principal,
      reg.grantId
    )
    const outcome = await publishJobOutboundMessage(service(), {
      artifact: reg.claim,
      artifactPolicy: 'omit_unauthorized',
      destination: { channelId: f.channelA.id, workspaceId: f.destination.id },
      jobId: f.task.id,
      result: { artifact: reg.target, jobId: f.task.id, summary: 'Summary without the report.' },
    })
    expect(outcome.decision).toMatchObject({
      action: 'publish',
      artifactOmitted: 'grant_revoked',
      result: { artifact: null },
    })
    if (!outcome.messageId) throw new Error('expected a message id')
    const links = await connection.db
      .select({ artifactId: messageArtifactReferences.artifactId })
      .from(messageArtifactReferences)
      .where(eq(messageArtifactReferences.messageId, outcome.messageId))
    expect(links).toEqual([])
    const stored = await readJobOutboundPublication(connection.db, {
      jobId: f.task.id,
      messageId: outcome.messageId,
    })
    expect(stored?.artifactLinkCount).toBe(0)
    expect(stored?.senderSystemId ?? '').not.toContain(reg.artifact.id)
    expect(await deliver(f, outcome.messageId)).toMatchObject({
      action: 'deliver',
      result: { artifact: null, summary: 'Summary without the report.' },
    })
  })

  test('a quarantined artifact is omitted by name under omit_unauthorized, and held under require', async () => {
    const f = await fixture()
    const reg = await registeredArtifact(f)
    await setArtifactAvailability(
      connection.db,
      f.workspace.id,
      reg.artifact.id,
      f.owner.principal,
      'quarantined',
      reg.artifact.version
    )
    const held = await publishArtifact(f, reg)
    expect(held).toMatchObject({
      decision: { action: 'hold', gate: 'artifact', reason: 'artifact_quarantined' },
      messageId: null,
    })
    const omitted = await publishJobOutboundMessage(service(), {
      artifact: reg.claim,
      artifactPolicy: 'omit_unauthorized',
      destination: { channelId: f.channelA.id, workspaceId: f.destination.id },
      jobId: f.task.id,
      result: { artifact: reg.target, jobId: f.task.id, summary: 'Report withheld.' },
    })
    expect(omitted.decision).toMatchObject({
      action: 'publish',
      artifactOmitted: 'artifact_quarantined',
    })
  })

  test('membership removal: a recipient removed from the destination workspace is not released to', async () => {
    const f = await fixture()
    const messageId = await publishTo(f, f.channelA.id, 'Written before removal.')
    await connection.db
      .delete(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.workspaceId, f.destination.id),
          eq(workspaceMemberships.userId, f.recipient.principal.userId)
        )
      )
    expect(await deliver(f, messageId)).toEqual({
      action: 'deny',
      gate: 'audience',
      reason: 'recipient_not_destination_member',
    })
  })

  test('forged approval: a system message with a valid binding but a foreign key is never released', async () => {
    const f = await fixture()
    const version = await rosterVersion(f.channelA.id)
    const binding = {
      actorUserId: f.owner.principal.userId,
      artifact: null,
      channelId: f.channelA.id,
      channelVersion: version,
      grant: null,
      jobId: f.task.id,
      summarySha256: summarySha256('Forged summary.'),
      workspaceId: f.destination.id,
    }
    const forged = await createMessage(
      connection.db,
      f.destination.id,
      f.channelA.id,
      f.owner.principal,
      {
        bodyText: 'Forged summary.',
        executionRef: f.task.id,
        idempotencyKey: `not-derived-${crypto.randomUUID()}`,
        sender: { kind: 'system', systemId: encodeJobOutboundBinding(binding) },
      }
    )
    expect(await deliver(f, forged.id)).toEqual({
      action: 'deny',
      gate: 'publication',
      reason: 'publication_altered',
    })
  })

  test('concurrent publication and revocation: a message exists exactly when its publication was authorized', async () => {
    const f = await fixture()
    const reg = await registeredArtifact(f)
    const [outcome] = await Promise.all([
      publishArtifact(f, reg),
      revokeArtifactReferenceGrant(connection.db, f.workspace.id, f.owner.principal, reg.grantId),
    ])
    const rows = await jobMessages(f.channelA.id, f.task.id)
    expect(rows).toHaveLength(outcome.decision.action === 'publish' ? 1 : 0)
    if (rows[0]) {
      expect(await deliver(f, rows[0].id)).toEqual({
        action: 'deny',
        gate: 'artifact',
        reason: 'grant_revoked',
      })
    }
  })

  test('concurrent roster change and publication: no release reaches a removed recipient, in either order', async () => {
    const f = await fixture()
    const version = await rosterVersion(f.channelA.id)
    const [outcome] = await Promise.all([
      publishTo(f, f.channelA.id, 'Concurrent with a roster change.').then((messageId) => ({
        messageId,
      })),
      setChannelParticipants(
        connection.db,
        f.destination.id,
        f.channelA.id,
        f.owner.principal,
        [f.owner.principal],
        version
      ),
    ])
    expect(await deliver(f, outcome.messageId)).toMatchObject({
      action: 'deny',
      gate: 'audience',
    })
  })

  test('concurrent membership removal and release: once removal has committed, no later release succeeds', async () => {
    const f = await fixture()
    const messageId = await publishTo(f, f.channelA.id, 'Released during removal.')
    const [released] = await Promise.all([
      deliver(f, messageId),
      connection.db
        .delete(workspaceMemberships)
        .where(
          and(
            eq(workspaceMemberships.workspaceId, f.destination.id),
            eq(workspaceMemberships.userId, f.recipient.principal.userId)
          )
        ),
    ])
    expect(['deliver', 'deny'].includes(released.action)).toBe(true)
    expect(await deliver(f, messageId)).toEqual({
      action: 'deny',
      gate: 'audience',
      reason: 'recipient_not_destination_member',
    })
  })

  test('a production completion publishes its result; history and search show it only while the reader is authorized', async () => {
    const f = await fixture({ complete: false })
    const reg = await registeredArtifact(f)
    const { task, publication } = await completeTaskAndPublishOutboundResult(
      connection.db,
      f.workspace.id,
      f.task.id,
      f.owner.principal,
      {
        idempotencyKey: crypto.randomUUID(),
        requestId: crypto.randomUUID(),
        expectedVersion: f.task.version,
      },
      {
        artifact: { artifactId: reg.artifact.id, grantId: reg.grantId },
        artifactPolicy: 'require',
        channelId: f.channelA.id,
        summary: 'Report attached.',
      }
    )
    expect(task.lifecycleState).toBe('completed')
    expect(publication.decision.action).toBe('publish')
    const messageId = publication.messageId
    if (!messageId) throw new Error('expected a canonical message')
    const shown = await listMessagesForUser(
      connection.db,
      f.destination.id,
      f.channelA.id,
      f.recipient.principal
    )
    expect(shown.messages).toContainEqual(
      expect.objectContaining({
        artifactIds: [reg.artifact.id],
        id: messageId,
        sender: { kind: 'system', systemId: 'job-outbound' },
      })
    )
    const found = await searchWorkspaceForUser(
      connection.db,
      f.destination.id,
      f.recipient.principal,
      'Report attached'
    )
    expect(found.results.some((hit) => hit.id === messageId)).toBe(true)

    await revokeArtifactReferenceGrant(
      connection.db,
      f.workspace.id,
      f.owner.principal,
      reg.grantId
    )
    const after = await listMessagesForUser(
      connection.db,
      f.destination.id,
      f.channelA.id,
      f.recipient.principal
    )
    expect(after.messages.some((message) => message.id === messageId)).toBe(false)
    await expect(
      getMessageForUser(connection.db, f.destination.id, messageId, f.recipient.principal)
    ).rejects.toThrow('Message unavailable')
    const hidden = await searchWorkspaceForUser(
      connection.db,
      f.destination.id,
      f.recipient.principal,
      'Report attached'
    )
    expect(hidden.results.some((hit) => hit.id === messageId)).toBe(false)
  })

  test('omitting an unauthorized artifact from a production completion: history carries the summary, never the artifact or binding', async () => {
    const f = await fixture({ complete: false })
    const reg = await registeredArtifact(f)
    await revokeArtifactReferenceGrant(
      connection.db,
      f.workspace.id,
      f.owner.principal,
      reg.grantId
    )
    const { publication } = await completeTaskAndPublishOutboundResult(
      connection.db,
      f.workspace.id,
      f.task.id,
      f.owner.principal,
      {
        idempotencyKey: crypto.randomUUID(),
        requestId: crypto.randomUUID(),
        expectedVersion: f.task.version,
      },
      {
        artifact: { artifactId: reg.artifact.id, grantId: reg.grantId },
        artifactPolicy: 'omit_unauthorized',
        channelId: f.channelA.id,
        summary: 'Summary only.',
      }
    )
    expect(publication.decision).toMatchObject({
      action: 'publish',
      artifactOmitted: 'grant_revoked',
    })
    const listed = await listMessagesForUser(
      connection.db,
      f.destination.id,
      f.channelA.id,
      f.recipient.principal
    )
    expect(listed.messages).toContainEqual(
      expect.objectContaining({ artifactIds: [], bodyText: 'Summary only.' })
    )
    expect(JSON.stringify(listed)).not.toContain(reg.artifact.id)
    expect(JSON.stringify(listed)).not.toContain('job-outbound:v1:')
  })

  test('a completion that names an unregistered artifact completes nothing and publishes nothing', async () => {
    const f = await fixture({ complete: false })
    await expect(
      completeTaskAndPublishOutboundResult(
        connection.db,
        f.workspace.id,
        f.task.id,
        f.owner.principal,
        {
          idempotencyKey: crypto.randomUUID(),
          requestId: crypto.randomUUID(),
          expectedVersion: f.task.version,
        },
        {
          artifact: { artifactId: NIL_UUID, grantId: `grant-${crypto.randomUUID()}` },
          artifactPolicy: 'require',
          channelId: f.channelA.id,
          summary: 'Never published.',
        }
      )
    ).rejects.toThrow('Artifact grant unavailable')
    expect(await readJobOutboundSource(connection.db, f.task.id)).toMatchObject({
      completedAt: null,
    })
    expect(await jobMessages(f.channelA.id, f.task.id)).toEqual([])
  })

  // Completion and publication share one scope: the Task's state, its idempotency
  // reservation and the canonical message commit together or not at all.

  /** A completion as a client sends it. A retry reuses the key with a fresh request id. */
  function completeJob(
    f: Fixture,
    idempotencyKey: string,
    request: JobOutboundCompletionRequest,
    options: Readonly<{
      actor?: UserPrincipalRef
      expectedVersion?: number
      seams?: JobOutboundCompletionSeams
    }> = {}
  ) {
    return completeTaskAndPublishOutboundResult(
      connection.db,
      f.workspace.id,
      f.task.id,
      options.actor ?? f.owner.principal,
      {
        expectedVersion: options.expectedVersion ?? f.task.version,
        idempotencyKey,
        requestId: crypto.randomUUID(),
      },
      request,
      options.seams
    )
  }

  function outboundRequest(
    f: Fixture,
    overrides: Partial<JobOutboundCompletionRequest> = {}
  ): JobOutboundCompletionRequest {
    return {
      artifact: null,
      artifactPolicy: 'require',
      channelId: f.channelA.id,
      summary: 'Approved summary.',
      ...overrides,
    }
  }

  type ArtifactRef = Readonly<{ artifactId: string; grantId: string }>
  const artifactRef = (reg: Awaited<ReturnType<typeof registeredArtifact>>): ArtifactRef => ({
    artifactId: reg.artifact.id,
    grantId: reg.grantId,
  })

  /** The Task row as stored, read back to prove what a failed call did and did not change. */
  async function taskState(f: Fixture) {
    const [row] = await connection.db
      .select({ lifecycleState: tasks.lifecycleState, version: tasks.version })
      .from(tasks)
      .where(eq(tasks.id, f.task.id))
      .limit(1)
    return row!
  }

  /** Completion reservations under one key. A call that rolled back leaves none. */
  async function reservations(f: Fixture, idempotencyKey: string) {
    return connection.db
      .select({ id: taskMutations.id })
      .from(taskMutations)
      .where(
        and(
          eq(taskMutations.workspaceId, f.workspace.id),
          eq(taskMutations.idempotencyKey, idempotencyKey)
        )
      )
  }

  /**
   * Adds a user to the destination channel's roster. A requester must reach the channel to
   * complete an outbound result into it, so admin requesters are made participants here.
   */
  async function joinChannel(f: Fixture, userId: string) {
    await setChannelParticipants(
      connection.db,
      f.destination.id,
      f.channelA.id,
      f.owner.principal,
      [
        f.owner.principal,
        { kind: 'user', userId: f.recipient.principal.userId },
        { kind: 'user', userId },
      ],
      await rosterVersion(f.channelA.id)
    )
  }

  /** A real user with a membership in the source and/or destination workspace. */
  async function newUser(
    f: Fixture,
    roles: Readonly<{ destination: 'member' | null; source: 'admin' | 'member' | null }>
  ) {
    const session = await createTemporaryUserSession(connection.db, {
      credentialDigest: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    if (roles.source)
      await connection.db.insert(workspaceMemberships).values({
        role: roles.source,
        userId: session.principal.userId,
        workspaceId: f.workspace.id,
      })
    if (roles.destination)
      await connection.db.insert(workspaceMemberships).values({
        role: roles.destination,
        userId: session.principal.userId,
        workspaceId: f.destination.id,
      })
    return session.principal
  }

  test('a crash after completion and before the message is written rolls the completion back; a retry publishes exactly once', async () => {
    const f = await fixture({ complete: false })
    const key = crypto.randomUUID()
    const before = await taskState(f)
    // The seam fails after the Task has completed inside the publication transaction.
    await expect(
      completeJob(f, key, outboundRequest(f), {
        seams: {
          beforePublicationWrite: async () => {
            throw new Error('injected crash after completion')
          },
        },
      })
    ).rejects.toThrow('injected crash after completion')
    expect(await taskState(f)).toEqual(before)
    expect(await reservations(f, key)).toEqual([])
    expect(await jobMessages(f.channelA.id, f.task.id)).toEqual([])

    const retried = await completeJob(f, key, outboundRequest(f))
    expect(retried.publication).toMatchObject({ decision: { action: 'publish' } })
    expect(retried.task.lifecycleState).toBe('completed')
    expect(await jobMessages(f.channelA.id, f.task.id)).toEqual([
      { id: retried.publication.messageId },
    ])
  })

  test('a retry after commit replays the completion and its publication, even after the channel revision moved', async () => {
    const f = await fixture({ complete: false })
    const key = crypto.randomUUID()
    const first = await completeJob(f, key, outboundRequest(f))
    const messageId = first.publication.messageId
    if (!messageId) throw new Error('expected a canonical message')

    // A roster write moves the revision, so the retry's binding key would differ from the first.
    const revisionBefore = await rosterVersion(f.channelA.id)
    await setChannelParticipants(
      connection.db,
      f.destination.id,
      f.channelA.id,
      f.owner.principal,
      [f.owner.principal, { kind: 'user', userId: f.recipient.principal.userId }],
      revisionBefore
    )
    expect(await rosterVersion(f.channelA.id)).not.toBe(revisionBefore)

    const retry = await completeJob(f, key, outboundRequest(f))
    expect(retry.publication).toMatchObject({ decision: { action: 'publish' }, messageId })
    expect(retry.task.lifecycleState).toBe('completed')
    expect(await jobMessages(f.channelA.id, f.task.id)).toEqual([{ id: messageId }])
  })

  for (const variant of [
    {
      name: 'summary',
      request: (f: Fixture, a: ArtifactRef) =>
        outboundRequest(f, { artifact: a, summary: 'A different summary.' }),
    },
    {
      name: 'destination',
      request: (f: Fixture, a: ArtifactRef) =>
        outboundRequest(f, { artifact: a, channelId: f.channelB.id }),
    },
    {
      name: 'artifact',
      request: (f: Fixture, _a: ArtifactRef, b: ArtifactRef) => outboundRequest(f, { artifact: b }),
    },
    {
      name: 'artifact removed',
      request: (f: Fixture) => outboundRequest(f, { artifact: null }),
    },
    {
      name: 'artifact policy',
      request: (f: Fixture, a: ArtifactRef) =>
        outboundRequest(f, { artifact: a, artifactPolicy: 'omit_unauthorized' }),
    },
    { name: 'outbound result dropped', request: null },
  ] as const) {
    test(`a retry under the same completion key with a changed ${variant.name} conflicts and publishes nothing`, async () => {
      const f = await fixture({ complete: false })
      const a = await registeredArtifact(f)
      const b = await registeredArtifact(f)
      const key = crypto.randomUUID()
      const first = await completeJob(f, key, outboundRequest(f, { artifact: artifactRef(a) }))
      const messageId = first.publication.messageId
      if (!messageId) throw new Error('expected a canonical message')

      const retry = variant.request
        ? completeJob(f, key, variant.request(f, artifactRef(a), artifactRef(b)))
        : completeTask(connection.db, f.workspace.id, f.task.id, f.owner.principal, {
            expectedVersion: f.task.version,
            idempotencyKey: key,
            requestId: crypto.randomUUID(),
          })
      await expect(retry).rejects.toThrow('Task idempotency conflict')

      expect(await jobMessages(f.channelA.id, f.task.id)).toEqual([{ id: messageId }])
      expect(await jobMessages(f.channelB.id, f.task.id)).toEqual([])
      expect(await taskState(f)).toMatchObject({ lifecycleState: 'completed' })
    })
  }

  test('a new completion key on an already completed job is refused and publishes nothing', async () => {
    const f = await fixture({ complete: false })
    const first = await completeJob(f, crypto.randomUUID(), outboundRequest(f))
    const messageId = first.publication.messageId
    if (!messageId) throw new Error('expected a canonical message')

    await expect(
      completeJob(f, crypto.randomUUID(), outboundRequest(f, { summary: 'A second result.' }), {
        expectedVersion: f.task.version + 1,
      })
    ).rejects.toThrow('Invalid Task lifecycle transition')
    expect(await jobMessages(f.channelA.id, f.task.id)).toEqual([{ id: messageId }])
  })

  test('a caller who neither submitted the job nor administers its source is refused; the completion rolls back', async () => {
    const f = await fixture({ complete: false })
    const member = await newUser(f, { destination: 'member', source: 'member' })
    const key = crypto.randomUUID()
    const before = await taskState(f)

    await expect(completeJob(f, key, outboundRequest(f), { actor: member })).rejects.toThrow(
      'Job outbound unavailable'
    )
    expect(await taskState(f)).toEqual(before)
    expect(await reservations(f, key)).toEqual([])
    expect(await jobMessages(f.channelA.id, f.task.id)).toEqual([])
  })

  test('a source admin who did not submit the job may complete and publish; the message is authored as the original actor', async () => {
    const f = await fixture({ complete: false })
    const admin = await newUser(f, { destination: 'member', source: 'admin' })
    await joinChannel(f, admin.userId)
    const outcome = await completeJob(f, crypto.randomUUID(), outboundRequest(f), { actor: admin })
    const messageId = outcome.publication.messageId
    if (!messageId) throw new Error('expected a canonical message')

    expect(outcome.task.lifecycleState).toBe('completed')
    // The canonical publication is a system sender; the original actor is the binding's actor.
    const [row] = await connection.db
      .select({ senderKind: messages.senderKind, senderSystemId: messages.senderSystemId })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1)
    expect(row?.senderKind).toBe('system')
    expect(decodeJobOutboundBinding(row?.senderSystemId)).toMatchObject({
      actorUserId: f.owner.principal.userId,
      channelId: f.channelA.id,
    })
  })

  test('a source admin who is not a member of the destination is refused; the completion rolls back', async () => {
    const f = await fixture({ complete: false })
    const admin = await newUser(f, { destination: null, source: 'admin' })
    const key = crypto.randomUUID()
    const before = await taskState(f)

    await expect(completeJob(f, key, outboundRequest(f), { actor: admin })).rejects.toThrow(
      'Job outbound unavailable'
    )
    expect(await taskState(f)).toEqual(before)
    expect(await reservations(f, key)).toEqual([])
    expect(await jobMessages(f.channelA.id, f.task.id)).toEqual([])
  })

  test('a held result cannot be moved to a new artifact version: the grant keeps its version, so a retry publishes nothing', async () => {
    const f = await fixture({ complete: false })
    const reg = await registeredArtifact(f)
    const key = crypto.randomUUID()
    const request = outboundRequest(f, { artifact: artifactRef(reg), summary: 'Version one.' })
    await revokeArtifactReferenceGrant(
      connection.db,
      f.workspace.id,
      f.owner.principal,
      reg.grantId
    )
    const held = await completeJob(f, key, request)
    expect(held.publication).toMatchObject({ decision: { action: 'hold' }, messageId: null })

    // The artifact moves to a new version. The grant's identity fixes its version, so it
    // cannot be re-registered at the new version under the same grant id.
    const unavailable = await setArtifactAvailability(
      connection.db,
      f.workspace.id,
      reg.artifact.id,
      f.owner.principal,
      'unavailable',
      reg.artifact.version
    )
    const moved = await setArtifactAvailability(
      connection.db,
      f.workspace.id,
      reg.artifact.id,
      f.owner.principal,
      'available',
      unavailable.version
    )
    await expect(
      regrantArtifactReferenceGrant(
        connection.db,
        f.workspace.id,
        f.owner.principal,
        {
          artifactId: reg.artifact.id,
          audienceWorkspaceId: f.destination.id,
          checksumSha256: CHECKSUM,
          expiresAt: null,
          grantId: reg.grantId,
          version: moved.version,
        },
        1
      )
    ).rejects.toThrow('Artifact reference grant identity conflict')

    const retry = await completeJob(f, key, request)
    expect(retry.publication).toMatchObject({ decision: { action: 'hold' }, messageId: null })
    expect(await jobMessages(f.channelA.id, f.task.id)).toEqual([])
  })

  test('a retry after the original actor changed is refused: the approved actor is part of the completion identity', async () => {
    const f = await fixture({ complete: false })
    const reg = await registeredArtifact(f)
    const key = crypto.randomUUID()
    const request = outboundRequest(f, { artifact: artifactRef(reg) })
    await revokeArtifactReferenceGrant(
      connection.db,
      f.workspace.id,
      f.owner.principal,
      reg.grantId
    )
    const held = await completeJob(f, key, request)
    expect(held.publication).toMatchObject({ decision: { action: 'hold' }, messageId: null })

    const other = await newUser(f, { destination: 'member', source: 'admin' })
    await connection.db
      .update(taskSubmissions)
      .set({ actorUserId: other.userId })
      .where(eq(taskSubmissions.taskId, f.task.id))
    await regrantArtifactReferenceGrant(
      connection.db,
      f.workspace.id,
      f.owner.principal,
      {
        artifactId: reg.artifact.id,
        audienceWorkspaceId: f.destination.id,
        checksumSha256: CHECKSUM,
        expiresAt: null,
        grantId: reg.grantId,
        version: reg.artifact.version,
      },
      1
    )

    await expect(completeJob(f, key, request)).rejects.toThrow('Task idempotency conflict')
    expect(await jobMessages(f.channelA.id, f.task.id)).toEqual([])
  })

  test('a requester who can complete the source task but cannot reach the destination channel is refused; the Task and the publication are unchanged', async () => {
    const f = await fixture({ complete: false })
    // Source admin (so may complete the source Task) and destination workspace member who is
    // not a participant of the participant-only channel.
    const requester = await newUser(f, { destination: 'member', source: 'admin' })
    // Proof of source-side authority: the requester completes an unrelated Task.
    const other = await createTask(
      connection.db,
      f.workspace.id,
      f.owner.principal,
      { objective: 'Other objective', title: 'Other task' },
      { idempotencyKey: crypto.randomUUID(), requestId: crypto.randomUUID() }
    )
    const otherDone = await completeTask(connection.db, f.workspace.id, other.id, requester, {
      expectedVersion: other.version,
      idempotencyKey: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
    })
    expect(otherDone.lifecycleState).toBe('completed')

    const key = crypto.randomUUID()
    const before = await taskState(f)
    await expect(completeJob(f, key, outboundRequest(f), { actor: requester })).rejects.toThrow(
      'Channel unavailable'
    )
    expect(await taskState(f)).toEqual(before)
    expect(await reservations(f, key)).toEqual([])
    expect(await jobMessages(f.channelA.id, f.task.id)).toEqual([])

    // The original actor, a participant, completes under the same key: the refusal reserved nothing.
    const published = await completeJob(f, key, outboundRequest(f))
    expect(published.publication).toMatchObject({ decision: { action: 'publish' } })
    expect(await jobMessages(f.channelA.id, f.task.id)).toEqual([
      { id: published.publication.messageId },
    ])
  })

  test('a job publication event names no actor and follows current authorization: delivered while authorized, withheld after revocation, live and on replay', async () => {
    const f = await fixture()
    const reg = await registeredArtifact(f)
    const outcome = await publishArtifact(f, reg)
    const messageId = outcome.messageId!
    const ordinary = await createMessage(
      connection.db,
      f.destination.id,
      f.channelA.id,
      f.owner.principal,
      {
        bodyText: 'Ordinary update.',
        idempotencyKey: `ordinary-${crypto.randomUUID()}`,
        sender: { kind: 'user', userId: f.owner.principal.userId },
      }
    )
    const reader = f.recipient.principal.userId
    const log = await listWorkspaceEventsAfter(connection.db, f.destination.id, 0, 200)
    const publicationEvent = log.find(
      (event) => event.eventType === 'message.created' && event.aggregateId === messageId
    )!
    const ordinaryEvent = log.find(
      (event) => event.eventType === 'message.created' && event.aggregateId === ordinary.id
    )!
    expect(publicationEvent.actor).toBeNull()
    expect(publicationEvent.payload).not.toHaveProperty('actorUserId')
    expect(ordinaryEvent.actor).toEqual({ id: f.owner.principal.userId, kind: 'user' })

    const classify = (events: readonly (typeof log)[number][]) =>
      classifyWorkspaceEventsForUser(connection.db, f.destination.id, reader, events)
    expect(await classify([publicationEvent])).toEqual([
      { event: publicationEvent, kind: 'deliver' },
    ])

    await revokeArtifactReferenceGrant(
      connection.db,
      f.workspace.id,
      f.owner.principal,
      reg.grantId
    )
    expect(await classify([publicationEvent])).toEqual([
      { kind: 'withheld', workspaceSequence: publicationEvent.workspaceSequence },
    ])

    // Replay from the start of the log: the publication stays withheld, and nothing names it.
    const replay = await classify(
      await listWorkspaceEventsAfter(connection.db, f.destination.id, 0, 200)
    )
    expect(replay).toContainEqual({
      kind: 'withheld',
      workspaceSequence: publicationEvent.workspaceSequence,
    })
    expect(JSON.stringify(replay)).not.toContain(messageId)
    expect(
      replay.some(
        (delivery) => delivery.kind === 'deliver' && delivery.event.aggregateId === ordinary.id
      )
    ).toBe(true)
  })

  test('a held publication commits the completion and writes nothing; a retry converges to one message once the grant is restored', async () => {
    const f = await fixture({ complete: false })
    const reg = await registeredArtifact(f)
    await revokeArtifactReferenceGrant(
      connection.db,
      f.workspace.id,
      f.owner.principal,
      reg.grantId
    )
    const key = crypto.randomUUID()
    const request = outboundRequest(f, { artifact: artifactRef(reg) })

    const held = await completeJob(f, key, request)
    expect(held.publication).toMatchObject({
      decision: { action: 'hold', gate: 'artifact' },
      messageId: null,
    })
    expect(held.task.lifecycleState).toBe('completed')
    expect(await jobMessages(f.channelA.id, f.task.id)).toEqual([])

    // The retry replays the completion and decides the same request again: still held.
    const again = await completeJob(f, key, request)
    expect(again.publication).toMatchObject({ decision: { action: 'hold' }, messageId: null })
    expect(await jobMessages(f.channelA.id, f.task.id)).toEqual([])

    await regrantArtifactReferenceGrant(
      connection.db,
      f.workspace.id,
      f.owner.principal,
      {
        artifactId: reg.artifact.id,
        audienceWorkspaceId: f.destination.id,
        checksumSha256: CHECKSUM,
        expiresAt: null,
        grantId: reg.grantId,
        version: reg.artifact.version,
      },
      1
    )
    const published = await completeJob(f, key, request)
    const messageId = published.publication.messageId
    expect(published.publication).toMatchObject({ decision: { action: 'publish' } })
    expect(await jobMessages(f.channelA.id, f.task.id)).toEqual([{ id: messageId }])

    const replayed = await completeJob(f, key, request)
    expect(replayed.publication.messageId).toBe(messageId)
    expect(await jobMessages(f.channelA.id, f.task.id)).toEqual([{ id: messageId }])
  })

  test('concurrent retries under one completion key publish exactly once and agree on the message', async () => {
    const f = await fixture({ complete: false })
    const key = crypto.randomUUID()
    const request = outboundRequest(f)
    const outcomes = await Promise.allSettled([
      completeJob(f, key, request),
      completeJob(f, key, request),
      completeJob(f, key, request),
    ])
    const failures = outcomes.flatMap((o) => (o.status === 'rejected' ? [String(o.reason)] : []))
    expect(failures).toEqual([])
    const ids = outcomes.flatMap((o) =>
      o.status === 'fulfilled' && o.value.publication.messageId
        ? [o.value.publication.messageId]
        : []
    )
    expect(ids).toHaveLength(3)
    expect(new Set(ids).size).toBe(1)
    expect(await jobMessages(f.channelA.id, f.task.id)).toEqual([{ id: ids[0] }])
  })

  test('concurrent attempts under one key with different summaries: one commits, the other conflicts, one message exists', async () => {
    const f = await fixture({ complete: false })
    const key = crypto.randomUUID()
    const outcomes = await Promise.allSettled([
      completeJob(f, key, outboundRequest(f, { summary: 'First summary.' })),
      completeJob(f, key, outboundRequest(f, { summary: 'Second summary.' })),
    ])
    const committed = outcomes.filter((o) => o.status === 'fulfilled')
    const refused = outcomes.filter((o) => o.status === 'rejected')
    expect(committed).toHaveLength(1)
    expect(refused).toHaveLength(1)
    expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({
      message: 'Task idempotency conflict',
    })
    const winner = (committed[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof completeJob>>>)
      .value.publication.messageId
    expect(await jobMessages(f.channelA.id, f.task.id)).toEqual([{ id: winner }])
  })

  test('a changed request after a held completion conflicts, even after the grant is restored; only the original publishes', async () => {
    const f = await fixture({ complete: false })
    const reg = await registeredArtifact(f)
    await revokeArtifactReferenceGrant(
      connection.db,
      f.workspace.id,
      f.owner.principal,
      reg.grantId
    )
    const key = crypto.randomUUID()
    const original = outboundRequest(f, { artifact: artifactRef(reg), summary: 'Original.' })
    const changed = outboundRequest(f, { artifact: artifactRef(reg), summary: 'Changed.' })

    const held = await completeJob(f, key, original)
    expect(held.publication).toMatchObject({ decision: { action: 'hold' }, messageId: null })
    await expect(completeJob(f, key, changed)).rejects.toThrow('Task idempotency conflict')

    await regrantArtifactReferenceGrant(
      connection.db,
      f.workspace.id,
      f.owner.principal,
      {
        artifactId: reg.artifact.id,
        audienceWorkspaceId: f.destination.id,
        checksumSha256: CHECKSUM,
        expiresAt: null,
        grantId: reg.grantId,
        version: reg.artifact.version,
      },
      1
    )
    await expect(completeJob(f, key, changed)).rejects.toThrow('Task idempotency conflict')
    expect(await jobMessages(f.channelA.id, f.task.id)).toEqual([])

    const published = await completeJob(f, key, original)
    expect(published.publication).toMatchObject({ decision: { action: 'publish' } })
    const messageId = published.publication.messageId
    expect(await jobMessages(f.channelA.id, f.task.id)).toEqual([{ id: messageId }])
    const [row] = await connection.db
      .select({ bodyText: messages.bodyText })
      .from(messages)
      .where(eq(messages.id, messageId!))
      .limit(1)
    expect(row?.bodyText).toBe('Original.')
  })

  test('a retry after the caller loses source authority is refused and writes nothing new', async () => {
    const f = await fixture({ complete: false })
    const admin = await newUser(f, { destination: 'member', source: 'admin' })
    await joinChannel(f, admin.userId)
    const key = crypto.randomUUID()
    const first = await completeJob(f, key, outboundRequest(f), { actor: admin })
    const messageId = first.publication.messageId
    if (!messageId) throw new Error('expected a canonical message')

    await connection.db
      .update(workspaceMemberships)
      .set({ role: 'member' })
      .where(
        and(
          eq(workspaceMemberships.userId, admin.userId),
          eq(workspaceMemberships.workspaceId, f.workspace.id)
        )
      )
    await expect(completeJob(f, key, outboundRequest(f), { actor: admin })).rejects.toThrow(
      'Job outbound unavailable'
    )
    expect(await jobMessages(f.channelA.id, f.task.id)).toEqual([{ id: messageId }])
  })
})
