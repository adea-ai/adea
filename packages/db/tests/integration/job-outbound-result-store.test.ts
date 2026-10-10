import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import * as schema from '../../src/schema'
import { generateRemoteCommandKeyPair, sealRemoteContent } from '@adea-ai/remote-content'
import type { UserPrincipalRef } from '@adea-ai/types'

import { createAgent } from '../../src/agents'
import { createArtifact, setArtifactAvailability } from '../../src/artifacts'
import {
  regrantArtifactReferenceGrant,
  registerArtifactReferenceGrant,
  revokeArtifactReferenceGrant,
} from '../../src/artifact-reference-grants'
import { createDatabase, type AgentHqDatabase, type DatabaseConnection } from '../../src/connection'
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
import { accountConversationInbox } from '../../src/account-inbox'
import { accountWorkspaceSummaries } from '../../src/account-summary'
import { listWorkspaceEventsAfter } from '../../src/event-log'
import {
  listReadStateForUser,
  markChannelReadState,
  markThreadReadState,
} from '../../src/read-state'
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
    // A further job in the same workspaces, submitted but not completed, so a second publication
    // can be made through the production completion path.
    async function submitAnotherJob() {
      const extra = await createTask(
        connection.db,
        workspace.id,
        owner.principal,
        {
          agentId: agent.id,
          projectId: project.id,
          title: 'Second outbound job',
          objective: 'SECOND_PROMPT_SENTINEL',
        },
        { idempotencyKey: crypto.randomUUID(), requestId: crypto.randomUUID() }
      )
      const extraRequestId = crypto.randomUUID()
      const extraEnvelope = await sealRemoteContent({
        keyId,
        recipientPublicKey: encryption.publicKey,
        aad: {
          workspaceId: workspace.id,
          runtimeNodeId: node.id,
          requestId: extraRequestId,
          payloadType: 'command.input',
          schemaVersion: 1,
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        plaintext: new TextEncoder().encode('SECOND_CONTEXT_SENTINEL'),
      })
      await enqueueTaskSubmission(
        connection.db,
        workspace.id,
        extra.id,
        owner.principal,
        { runtimeNodeId: node.id, queueWhenOffline: false, profile, envelope: extraEnvelope },
        {
          idempotencyKey: crypto.randomUUID(),
          requestId: extraRequestId,
          expectedVersion: extra.version,
        }
      )
      return extra
    }

    return {
      agent,
      channelA,
      channelB,
      destination,
      owner,
      recipient,
      submitAnotherJob,
      task,
      workspace,
    }
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

  test('an unauthorized publication is neither unread nor the exposed frontier in read state, the account summary or the inbox; mark-read cannot run past it; a regrant does not revive it', async () => {
    const f = await fixture()
    const reader = f.recipient.principal
    const sequenceOf = async (messageId: string) => {
      const [row] = await connection.db
        .select({ sequence: messages.sequence })
        .from(messages)
        .where(eq(messages.id, messageId))
        .limit(1)
      return row!.sequence
    }
    const channelRead = async () =>
      (await listReadStateForUser(connection.db, f.destination.id, reader)).find(
        (row) => row.channelId === f.channelA.id
      )!
    const summaryUnread = async () =>
      (await accountWorkspaceSummaries(connection.db, reader)).find(
        (row) => row.workspaceId === f.destination.id
      )!.unreadChannels
    const inboxRow = async () =>
      (await accountConversationInbox(connection.db, reader)).conversations.find(
        (row) => row.id === f.channelA.id
      )!

    // An ordinary message the reader reads through: the watermark is its sequence.
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
    await markChannelReadState(connection.db, f.destination.id, f.channelA.id, reader, 'read')
    const ordinarySeq = await sequenceOf(ordinary.id)
    expect(await channelRead()).toMatchObject({
      lastReadSequence: ordinarySeq,
      topLevelUnreadCount: 0,
      unread: false,
    })

    // An authorized publication past the watermark: unread everywhere, and the newest frontier.
    const reg = await registeredArtifact(f)
    const published = await publishArtifact(f, reg)
    const publicationSeq = await sequenceOf(published.messageId!)
    expect(await channelRead()).toMatchObject({
      latestTopLevelSequence: publicationSeq,
      topLevelUnreadCount: 1,
      unread: true,
    })
    expect(await summaryUnread()).toBe(1)
    expect(await inboxRow()).toMatchObject({
      latestTopLevelSequence: publicationSeq,
      topLevelUnreadCount: 1,
      unread: true,
    })

    // Revoked: not unread anywhere, and the exposed frontier walks down past it to the ordinary message.
    await revokeArtifactReferenceGrant(
      connection.db,
      f.workspace.id,
      f.owner.principal,
      reg.grantId
    )
    expect(await channelRead()).toMatchObject({
      latestTopLevelSequence: ordinarySeq,
      topLevelUnreadCount: 0,
      unread: false,
    })
    expect(await summaryUnread()).toBe(0)
    expect(await inboxRow()).toMatchObject({
      latestTopLevelSequence: ordinarySeq,
      topLevelUnreadCount: 0,
      unread: false,
    })

    // Mark-read cannot run past what the reader can see, and a stale sequence cannot rewind.
    await markChannelReadState(connection.db, f.destination.id, f.channelA.id, reader, 'read')
    expect(await channelRead()).toMatchObject({ lastReadSequence: ordinarySeq })
    await markChannelReadState(connection.db, f.destination.id, f.channelA.id, reader, 'read', 0)
    expect(await channelRead()).toMatchObject({ lastReadSequence: ordinarySeq })

    // The thread of a hidden publication still marks: its replies are ordinary, visible messages.
    await markThreadReadState(
      connection.db,
      f.destination.id,
      f.channelA.id,
      published.messageId!,
      reader,
      'read'
    )

    // A regrant does not revive a publication: it stays bound to the revision it was published
    // under, so it remains hidden, and nothing about it turns unread again.
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
    expect(await channelRead()).toMatchObject({
      latestTopLevelSequence: ordinarySeq,
      topLevelUnreadCount: 0,
      unread: false,
    })
    expect(await summaryUnread()).toBe(0)
    expect(publicationSeq).toBeGreaterThan(ordinarySeq)
  })

  test('a publication hidden only by the original actor losing source authority is unread again when that authority returns, because mark-read never ran past it', async () => {
    const f = await fixture()
    const reader = f.recipient.principal
    const sequenceOf = async (messageId: string) => {
      const [row] = await connection.db
        .select({ sequence: messages.sequence })
        .from(messages)
        .where(eq(messages.id, messageId))
        .limit(1)
      return row!.sequence
    }
    const channelRead = async () =>
      (await listReadStateForUser(connection.db, f.destination.id, reader)).find(
        (row) => row.channelId === f.channelA.id
      )!
    const summaryUnread = async () =>
      (await accountWorkspaceSummaries(connection.db, reader)).find(
        (row) => row.workspaceId === f.destination.id
      )!.unreadChannels
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
    await markChannelReadState(connection.db, f.destination.id, f.channelA.id, reader, 'read')
    const ordinarySeq = await sequenceOf(ordinary.id)
    const reg = await registeredArtifact(f)
    const published = await publishArtifact(f, reg)
    const publicationSeq = await sequenceOf(published.messageId!)
    expect(await channelRead()).toMatchObject({
      latestTopLevelSequence: publicationSeq,
      topLevelUnreadCount: 1,
      unread: true,
    })

    // The original actor (the owner) stops being an owner or admin of the source: the publication's
    // source authority is lost, so it is hidden from the reader for as long as that holds.
    await connection.db
      .update(workspaceMemberships)
      .set({ role: 'member' })
      .where(
        and(
          eq(workspaceMemberships.userId, f.owner.principal.userId),
          eq(workspaceMemberships.workspaceId, f.workspace.id)
        )
      )
    expect(await channelRead()).toMatchObject({
      latestTopLevelSequence: ordinarySeq,
      topLevelUnreadCount: 0,
      unread: false,
    })
    expect(await summaryUnread()).toBe(0)

    // Mark-read while hidden reads through the visible frontier, not the publication.
    await markChannelReadState(connection.db, f.destination.id, f.channelA.id, reader, 'read')
    expect(await channelRead()).toMatchObject({ lastReadSequence: ordinarySeq })

    // Authority returns: the publication is past the watermark, so it is unread again.
    await connection.db
      .update(workspaceMemberships)
      .set({ role: 'owner' })
      .where(
        and(
          eq(workspaceMemberships.userId, f.owner.principal.userId),
          eq(workspaceMemberships.workspaceId, f.workspace.id)
        )
      )
    expect(await channelRead()).toMatchObject({
      latestTopLevelSequence: publicationSeq,
      topLevelUnreadCount: 1,
      unread: true,
    })
    expect(await summaryUnread()).toBe(1)
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

  // -- Mixed ordinary and job messages under audience changes ---------------------------
  // The reader's own history is the ground truth. Every surface must agree with it: read
  // state (counts, frontier, thread counts), the account summary and inbox, search, and
  // event notifications for the reader.

  /** The messages the reader can see in the channel, read through their own history, every page. */
  async function historyOf(reader: UserPrincipalRef, workspaceId: string, channelId: string) {
    const visible: {
      bodyText: string | null
      id: string
      sequence: number
      threadRootMessageId: string | null
    }[] = []
    let afterSequence: number | undefined
    for (;;) {
      const page = await listMessagesForUser(connection.db, workspaceId, channelId, reader, {
        limit: 100,
        ...(afterSequence === undefined ? {} : { afterSequence }),
      })
      for (const message of page.messages)
        visible.push({
          bodyText: message.bodyText ?? null,
          id: message.id,
          sequence: message.sequence,
          threadRootMessageId: message.threadRootMessageId ?? null,
        })
      if (!page.nextAfterSequence) return visible
      afterSequence = page.nextAfterSequence
    }
  }

  /** Asserts every surface agrees with the reader's own history at this step. */
  async function expectSurfacesAgree(f: Fixture, step: string) {
    const reader = f.recipient.principal
    const workspaceId = f.destination.id
    const channelId = f.channelA.id
    const state = (await listReadStateForUser(connection.db, workspaceId, reader)).find(
      (row) => row.channelId === channelId
    )
    // No channel access means no history and no channel state; both sides must say so.
    const visible = state ? await historyOf(reader, workspaceId, channelId) : []
    const topLevel = visible.filter((message) => message.threadRootMessageId === null)
    const watermark = state?.lastReadSequence ?? 0
    const topLevelUnreadCount = topLevel.filter((message) => message.sequence > watermark).length
    const frontier = Math.max(0, ...topLevel.map((message) => message.sequence))
    const roots = [
      ...new Set(visible.flatMap((message) => message.threadRootMessageId ?? [])),
    ].toSorted()
    const threadsExpected = roots.map((root) => {
      const threadWatermark =
        state?.threads.find((thread) => thread.threadRootMessageId === root)?.lastReadSequence ?? 0
      return [
        root,
        visible.filter(
          (message) => message.threadRootMessageId === root && message.sequence > threadWatermark
        ).length,
      ]
    })
    const threadsObserved = (state?.threads ?? [])
      .map((thread) => [thread.threadRootMessageId, thread.unreadCount])
      .toSorted(([left], [right]) => String(left).localeCompare(String(right)))
    expect({
      step,
      frontier: state?.latestTopLevelSequence ?? 0,
      threads: threadsObserved,
      topLevelUnreadCount: state?.topLevelUnreadCount ?? 0,
      unread: state?.unread ?? false,
    }).toEqual({
      step,
      frontier,
      threads: threadsExpected,
      topLevelUnreadCount,
      unread: topLevelUnreadCount > 0 || threadsExpected.some(([, count]) => Number(count) > 0),
    })

    // Account summary and inbox: a channel is unread only for visible top-level or manual unread.
    const summary = (await accountWorkspaceSummaries(connection.db, reader)).find(
      (row) => row.workspaceId === workspaceId
    )
    expect({ step, unreadChannels: summary?.unreadChannels ?? 0 }).toEqual({
      step,
      unreadChannels: topLevelUnreadCount > 0 || Boolean(state?.manuallyUnread) ? 1 : 0,
    })
    const inbox = (await accountConversationInbox(connection.db, reader)).conversations.find(
      (row) => row.id === channelId
    )
    expect({
      step,
      inbox: inbox
        ? {
            latest: inbox.latestTopLevelSequence,
            topLevelUnreadCount: inbox.topLevelUnreadCount,
            unread: inbox.unread,
          }
        : null,
    }).toEqual({
      step,
      inbox: state
        ? {
            latest: frontier,
            topLevelUnreadCount,
            unread:
              topLevelUnreadCount > 0 || threadsExpected.some(([, count]) => Number(count) > 0),
          }
        : null,
    })

    // Search: exactly the visible messages that contain the term.
    const hits = (
      await searchWorkspaceForUser(connection.db, workspaceId, reader, 'lumen', { limit: 100 })
    ).results
      .flatMap((result) => (result.kind === 'message' ? [result.id] : []))
      .toSorted()
    const expectedHits = visible
      .filter((message) => (message.bodyText ?? '').toLowerCase().includes('lumen'))
      .map((message) => message.id)
      .toSorted()
    expect({ step, hits }).toEqual({ step, hits: expectedHits })

    // Event notifications: a message.created is delivered exactly when its message is visible.
    const log = await listWorkspaceEventsAfter(connection.db, workspaceId, 0, 200)
    const deliveries = await classifyWorkspaceEventsForUser(
      connection.db,
      workspaceId,
      reader.userId,
      log
    )
    const notified = log.flatMap((event, index) =>
      event.eventType === 'message.created' && deliveries?.[index]?.kind === 'deliver'
        ? [event]
        : []
    )
    expect({ step, notified: notified.map((event) => event.aggregateId).toSorted() }).toEqual({
      step,
      notified: visible.map((message) => message.id).toSorted(),
    })
    // Job publication events name no actor, and the hidden ones never reach the reader.
    const systemMessages = await connection.db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.channelId, channelId), eq(messages.senderKind, 'system')))
    const visibleIds = new Set(visible.map((message) => message.id))
    const hiddenPublicationIds = systemMessages
      .map((row) => row.id)
      .filter((id) => !visibleIds.has(id))
    for (const event of notified)
      if (
        event.aggregateType === 'message' &&
        event.aggregateId &&
        !visibleIds.has(event.aggregateId)
      )
        throw new Error(`hidden publication notified at ${step}`)
    for (const event of notified)
      if (systemMessages.some((row) => row.id === event.aggregateId))
        expect(event.payload).not.toHaveProperty('actorUserId')
    const leak = JSON.stringify({ notified, hits, inbox })
    for (const hidden of hiddenPublicationIds) expect(leak).not.toContain(hidden)
  }

  test('mixed ordinary and job messages under audience changes: counts, frontier, search, thread marks and event notifications agree with the reader’s own history', async () => {
    const f = await fixture({ complete: false })
    const reader = f.recipient.principal
    const workspaceId = f.destination.id
    const channelId = f.channelA.id
    const note = (bodyText: string, threadRootMessageId?: string) =>
      createMessage(connection.db, workspaceId, channelId, f.owner.principal, {
        bodyText,
        idempotencyKey: `note-${crypto.randomUUID()}`,
        sender: { kind: 'user', userId: f.owner.principal.userId },
        ...(threadRootMessageId ? { threadRootMessageId } : {}),
      })
    const completeAs = (
      job: { id: string; version: number },
      request: JobOutboundCompletionRequest
    ) =>
      completeTaskAndPublishOutboundResult(
        connection.db,
        f.workspace.id,
        job.id,
        f.owner.principal,
        {
          expectedVersion: job.version,
          idempotencyKey: crypto.randomUUID(),
          requestId: crypto.randomUUID(),
        },
        request
      )

    // Ordinary history, then the first job, authorized.
    await note('lumen alpha')
    const root = await note('root note')
    await note('lumen reply', root.id)
    const first = await completeAs(f.task, {
      artifact: null,
      artifactPolicy: 'require',
      channelId,
      summary: 'lumen published one',
    })
    expect(first.publication.decision.action).toBe('publish')
    await expectSurfacesAgree(f, 'job one authorized')

    // The reader reads everything: nothing is unread.
    await markChannelReadState(connection.db, workspaceId, channelId, reader, 'read')
    await expectSurfacesAgree(f, 'read through')

    // A new ordinary message, then a second job with an artifact, then a reply to that job.
    await note('lumen beta')
    const second = await f.submitAnotherJob()
    const registration = await registeredArtifact(f)
    const published = await completeAs(second, {
      artifact: { artifactId: registration.artifact.id, grantId: registration.grantId },
      artifactPolicy: 'require',
      channelId,
      summary: 'lumen published two',
    })
    expect(published.publication.decision.action).toBe('publish')
    const publicationTwo = published.publication.messageId!
    await note('lumen reply to two', publicationTwo)
    await expectSurfacesAgree(f, 'job two authorized, with a reply to it')

    // Audience change: the source revokes the second job's grant. Job two is hidden; its reply is
    // an ordinary message in the channel and stays visible.
    await revokeArtifactReferenceGrant(
      connection.db,
      f.workspace.id,
      f.owner.principal,
      registration.grantId
    )
    await expectSurfacesAgree(f, 'job two revoked')

    // The thread of the hidden job can be marked: its replies are visible, so their unread count clears.
    await markThreadReadState(connection.db, workspaceId, channelId, publicationTwo, reader, 'read')
    await expectSurfacesAgree(f, 'thread of the hidden job marked read')

    // Watermarks are monotonic: an older sequence cannot rewind the channel frontier.
    const watermark = async () =>
      (await listReadStateForUser(connection.db, workspaceId, reader)).find(
        (row) => row.channelId === channelId
      )?.lastReadSequence ?? 0
    const before = await watermark()
    await markChannelReadState(connection.db, workspaceId, channelId, reader, 'read', 0)
    expect(await watermark()).toBe(before)
    await markChannelReadState(connection.db, workspaceId, channelId, reader, 'read')
    expect(await watermark()).toBeGreaterThanOrEqual(before)
    await expectSurfacesAgree(f, 'read through the visible frontier')

    // Audience change: the reader leaves the channel. Nothing from it is visible, counted or
    // notified, and the account summary and inbox drop it.
    const channelRevision = async () =>
      (
        await connection.db
          .select({ version: channels.version })
          .from(channels)
          .where(eq(channels.id, channelId))
          .limit(1)
      )[0]!.version
    await setChannelParticipants(
      connection.db,
      workspaceId,
      channelId,
      f.owner.principal,
      [f.owner.principal],
      await channelRevision()
    )
    await expectSurfacesAgree(f, 'reader removed from the channel')

    // Back in: ordinary messages are visible again. Both jobs stay hidden, because a publication
    // is bound to the roster revision it was published under.
    await setChannelParticipants(
      connection.db,
      workspaceId,
      channelId,
      f.owner.principal,
      [f.owner.principal, { kind: 'user', userId: reader.userId }],
      await channelRevision()
    )
    await expectSurfacesAgree(f, 'reader back in the channel')
  })

  test('query counts do not grow with ordinary messages; they grow only with the job publications a reader must gate', async () => {
    const f = await fixture({ complete: false })
    const reader = f.recipient.principal
    const workspaceId = f.destination.id
    const channelId = f.channelA.id
    const databaseUrl = process.env.DATABASE_URL!
    const note = (bodyText: string) =>
      createMessage(connection.db, workspaceId, channelId, f.owner.principal, {
        bodyText,
        idempotencyKey: `note-${crypto.randomUUID()}`,
        sender: { kind: 'user', userId: f.owner.principal.userId },
      })
    const completeAs = (
      job: { id: string; version: number },
      request: JobOutboundCompletionRequest
    ) =>
      completeTaskAndPublishOutboundResult(
        connection.db,
        f.workspace.id,
        job.id,
        f.owner.principal,
        {
          expectedVersion: job.version,
          idempotencyKey: crypto.randomUUID(),
          requestId: crypto.randomUUID(),
        },
        request
      )
    /** Statements one call issues on its own connection, excluding connection setup. */
    async function statementsOf(run: (db: AgentHqDatabase) => Promise<unknown>) {
      let statements = 0
      const counting = postgres(databaseUrl, {
        debug: () => {
          statements += 1
        },
        max: 1,
        prepare: false,
      })
      try {
        await counting`select 1`
        statements = 0
        await run(drizzle(counting, { schema }))
        return statements
      } finally {
        await counting.end({ timeout: 5 })
      }
    }
    /** Statements for each reader surface at this moment. */
    async function measure() {
      const log = await listWorkspaceEventsAfter(connection.db, workspaceId, 0, 200)
      return {
        events: await statementsOf((db) =>
          classifyWorkspaceEventsForUser(db, workspaceId, reader.userId, log)
        ),
        inbox: await statementsOf((db) => accountConversationInbox(db, reader)),
        readState: await statementsOf((db) => listReadStateForUser(db, workspaceId, reader)),
        search: await statementsOf((db) =>
          searchWorkspaceForUser(db, workspaceId, reader, 'lumen', { limit: 100 })
        ),
        summary: await statementsOf((db) => accountWorkspaceSummaries(db, reader)),
      }
    }

    // One visible publication, then five ordinary messages.
    await completeAs(f.task, {
      artifact: null,
      artifactPolicy: 'require',
      channelId,
      summary: 'lumen one',
    })
    for (let index = 0; index < 5; index += 1) await note(`lumen ${index}`)
    // Ordinary frontier: the cost does not move with the number of ordinary messages.
    const ordinaryFew = await measure()
    for (let index = 0; index < 40; index += 1) await note(`lumen more ${index}`)
    const ordinaryMany = await measure()
    expect(ordinaryMany).toEqual(ordinaryFew)

    // A second publication, its artifact revoked. It is the frontier, so the walk past it runs.
    const second = await f.submitAnotherJob()
    const registration = await registeredArtifact(f)
    await completeAs(second, {
      artifact: { artifactId: registration.artifact.id, grantId: registration.grantId },
      artifactPolicy: 'require',
      channelId,
      summary: 'lumen two',
    })
    await revokeArtifactReferenceGrant(
      connection.db,
      f.workspace.id,
      f.owner.principal,
      registration.grantId
    )
    const walkPath = await measure()

    // Ordinary messages again: the frontier is ordinary, and one hidden publication is gated.
    for (let index = 0; index < 40; index += 1) await note(`lumen even more ${index}`)
    const hiddenFew = await measure()
    for (let index = 0; index < 40; index += 1) await note(`lumen last ${index}`)
    const hiddenMany = await measure()
    expect(hiddenMany).toEqual(hiddenFew)

    // A third hidden publication, now the frontier again: the walk path, one more gate.
    const third = await f.submitAnotherJob()
    const thirdRegistration = await registeredArtifact(f)
    await completeAs(third, {
      artifact: { artifactId: thirdRegistration.artifact.id, grantId: thirdRegistration.grantId },
      artifactPolicy: 'require',
      channelId,
      summary: 'lumen three',
    })
    await revokeArtifactReferenceGrant(
      connection.db,
      f.workspace.id,
      f.owner.principal,
      thirdRegistration.grantId
    )
    const walkPathTwo = await measure()
    // Growth is per publication a surface gates, never per ordinary message.
    for (const surface of Object.keys(ordinaryFew) as (keyof typeof ordinaryFew)[]) {
      expect(hiddenMany[surface]).toBeGreaterThanOrEqual(ordinaryMany[surface])
      expect(walkPathTwo[surface]).toBeGreaterThanOrEqual(walkPath[surface])
    }
  })
})
