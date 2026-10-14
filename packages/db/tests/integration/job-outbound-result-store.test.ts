import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { and, eq, inArray, sql } from 'drizzle-orm'
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
import { shareGroupHistory } from '../../src/group-channels'
import { searchWorkspaceForUser } from '../../src/search'
import { accountConversationInbox } from '../../src/account-inbox'
import { accountWorkspaceSummaries } from '../../src/account-summary'
import { listWorkspaceEventsAfter } from '../../src/event-log'
import {
  listReadStateForUser,
  markAllChannelsRead,
  markChannelReadState,
  markThreadReadState,
} from '../../src/read-state'
import { classifyWorkspaceEventsForUser } from '../../src/event-visibility'
import { readerVisibleThreadRootIds } from '../../src/job-outbound-visibility'
import { createContentRef } from '../../src/content-refs'
import { filterVisibleJobOutboundRows } from '../../src/job-outbound-read'
import { UNREAD_PUBLICATION_PAGE, WALK_BATCH } from '../../src/job-outbound-frontier'
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
  coordinationPlanCitations,
  coordinationPlanRevisions,
  coordinationPlans,
  groupAdmissions,
  messageArtifactReferences,
  messages,
  taskMutations,
  taskSubmissions,
  tasks,
  threadReadStates,
  workspaceMemberships,
} from '../../src/schema'
import {
  decodeJobOutboundBinding,
  encodeJobOutboundBinding,
  summarySha256,
} from '../../src/job-outbound-binding'
import { enqueueTaskSubmission, type TaskSubmissionInput } from '../../src/task-submissions'
import {
  COORDINATION_PLAN_MAX_CITATIONS,
  createCoordinationPlan,
  readCoordinationPlanJobReferences,
  reviseCoordinationPlan,
} from '../../src/coordination-plans'
import {
  JOB_REFERENCE_MAX_BATCH,
  JobReferenceBatchError,
  resolveJobReferences,
} from '../../src/job-outbound-reference'
import { completeTask, createTask, getTaskForUser, setTaskDependencies } from '../../src/tasks'
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
/** Publications in the large hidden run; more than one unread page and several walk batches. */
const LARGE_HIDDEN_RUN = 210
/**
 * The statements one bulk gate issues. Measured at 14 to 15 before visibility took its share
 * locks, and at 16 to 17 after: one statement locks the artifacts, and one locks the grants, in
 * the canonical artifact-then-grant order. The bound is per gate and fixed, so it still grows
 * with pages, not publications.
 */
const STATEMENTS_PER_GATE = 17
const CHECKSUM = 'c'.repeat(64)

/** A cited job the reader has no released result for; every such case reads this way. */
const unavailableReference = (jobId: string) => ({
  authority: 'none',
  availability: 'unavailable',
  jobId,
})

/** A write the database must refuse; a drizzle builder is awaited here, not handed to `expect`. */
const refuses = (write: PromiseLike<unknown>) =>
  expect(
    (async () => {
      await write
    })()
  ).rejects.toThrow()

const planKey = () => `plan-${crypto.randomUUID()}`

/** Rejection message of a call, or null when it succeeded. */
async function rejection(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run()
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** Statements one call issues on its own connection, excluding connection setup. */
async function statementsOf(run: (db: AgentHqDatabase) => Promise<unknown>) {
  let statements = 0
  const counting = postgres(process.env.DATABASE_URL!, {
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

  async function addDestinationMember(f: Fixture) {
    const session = await createTemporaryUserSession(connection.db, {
      credentialDigest: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    await connection.db.insert(workspaceMemberships).values({
      role: 'member',
      userId: session.principal.userId,
      workspaceId: f.destination.id,
    })
    return session.principal
  }

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

  test('a source-admin requester whose group admission expires while publication is parked is refused', async () => {
    const f = await fixture({ complete: false })
    const requester = await newUser(f, { destination: 'member', source: 'admin' })
    await joinChannel(f, requester.userId)
    expect(requester.userId).not.toBe(f.owner.principal.userId)

    const expiresAt = new Date(Date.now() + 2_000).toISOString()
    const [grant] = await connection.db
      .update(schema.groupAudienceGrants)
      .set({ expiresAt })
      .where(
        and(
          eq(schema.groupAudienceGrants.channelId, f.channelA.id),
          eq(schema.groupAudienceGrants.userId, requester.userId)
        )
      )
      .returning({ id: schema.groupAudienceGrants.id })
    expect(grant).toBeDefined()

    const key = crypto.randomUUID()
    const before = await taskState(f)
    const seam = { enteredMs: 0, expiredMs: 0 }
    await expect(
      completeJob(f, key, outboundRequest(f), {
        actor: requester,
        seams: {
          beforePublicationWrite: async () => {
            seam.enteredMs = Date.now()
            await new Promise((resolve) =>
              setTimeout(resolve, Math.max(0, Date.parse(expiresAt) + 150 - Date.now()))
            )
            seam.expiredMs = Date.now()
          },
        },
      })
    ).rejects.toThrow('Channel unavailable')

    expect(seam.enteredMs).toBeGreaterThan(0)
    expect(seam.enteredMs).toBeLessThan(Date.parse(expiresAt))
    expect(seam.expiredMs).toBeGreaterThanOrEqual(Date.parse(expiresAt))
    expect(await taskState(f)).toEqual(before)
    expect(await reservations(f, key)).toEqual([])
    expect(await jobMessages(f.channelA.id, f.task.id)).toEqual([])
  }, 30_000)

  test("a held publication keeps an authorized completion when the requester's admission expires afterward", async () => {
    const f = await fixture({ complete: false })
    const requester = await newUser(f, { destination: 'member', source: 'admin' })
    await joinChannel(f, requester.userId)
    expect(requester.userId).not.toBe(f.owner.principal.userId)

    const reg = await registeredArtifact(f)
    const expiresAt = new Date(Date.now() + 2_000).toISOString()
    const [groupGrant] = await connection.db
      .update(schema.groupAudienceGrants)
      .set({ expiresAt })
      .where(
        and(
          eq(schema.groupAudienceGrants.channelId, f.channelA.id),
          eq(schema.groupAudienceGrants.userId, requester.userId)
        )
      )
      .returning({ id: schema.groupAudienceGrants.id })
    expect(groupGrant).toBeDefined()
    const [artifactGrant] = await connection.db
      .update(schema.artifactReferenceGrants)
      .set({ expiresAt })
      .where(eq(schema.artifactReferenceGrants.grantId, reg.grantId))
      .returning({ grantId: schema.artifactReferenceGrants.grantId })
    expect(artifactGrant).toBeDefined()

    const key = crypto.randomUUID()
    const seam = { enteredMs: 0, expiredMs: 0 }
    const held = await completeJob(f, key, outboundRequest(f, { artifact: artifactRef(reg) }), {
      actor: requester,
      seams: {
        beforePublicationWrite: async () => {
          seam.enteredMs = Date.now()
          await new Promise((resolve) =>
            setTimeout(resolve, Math.max(0, Date.parse(expiresAt) + 150 - Date.now()))
          )
          seam.expiredMs = Date.now()
        },
      },
    })

    expect(seam.enteredMs).toBeGreaterThan(0)
    expect(seam.enteredMs).toBeLessThan(Date.parse(expiresAt))
    expect(seam.expiredMs).toBeGreaterThanOrEqual(Date.parse(expiresAt))
    expect(held.publication).toMatchObject({
      decision: { action: 'hold', gate: 'artifact', reason: 'grant_expired' },
      messageId: null,
    })
    expect(held.task.lifecycleState).toBe('completed')
    expect(await reservations(f, key)).toHaveLength(1)
    expect(await jobMessages(f.channelA.id, f.task.id)).toEqual([])
  }, 30_000)

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

  test('a completion whose destination is in its own source workspace is refused before the Task completes', async () => {
    const f = await fixture({ complete: false })
    const sourceChannel = await createGroupChannel(
      connection.db,
      f.workspace.id,
      f.owner.principal,
      {
        idempotencyKey: crypto.randomUUID(),
        title: 'Source group',
      }
    )
    const key = crypto.randomUUID()
    const before = await taskState(f)
    await expect(
      completeJob(f, key, outboundRequest(f, { channelId: sourceChannel.id }))
    ).rejects.toThrow('Destination unavailable')
    expect(await taskState(f)).toEqual(before)
    expect(await reservations(f, key)).toEqual([])
    expect(await jobMessages(sourceChannel.id, f.task.id)).toEqual([])
    // The same key with an outbound destination completes and publishes once.
    const published = await completeJob(f, key, outboundRequest(f))
    expect(published.publication).toMatchObject({ decision: { action: 'publish' } })
    expect(await jobMessages(f.channelA.id, f.task.id)).toEqual([
      { id: published.publication.messageId },
    ])
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

  test('message event replay respects the group join point after removal and rejoin', async () => {
    const f = await fixture()
    const reader = f.recipient.principal
    const workspaceId = f.destination.id
    const channelId = f.channelA.id
    const oldRoot = await createMessage(connection.db, workspaceId, channelId, f.owner.principal, {
      bodyText: 'pre-join root',
      idempotencyKey: `pre-join-root-${crypto.randomUUID()}`,
      sender: { kind: 'user', userId: f.owner.principal.userId },
    })
    const oldReply = await createMessage(connection.db, workspaceId, channelId, f.owner.principal, {
      bodyText: 'pre-join reply',
      idempotencyKey: `pre-join-reply-${crypto.randomUUID()}`,
      sender: { kind: 'user', userId: f.owner.principal.userId },
      threadRootMessageId: oldRoot.id,
    })

    await setChannelParticipants(
      connection.db,
      workspaceId,
      channelId,
      f.owner.principal,
      [f.owner.principal],
      await rosterVersion(channelId)
    )
    await setChannelParticipants(
      connection.db,
      workspaceId,
      channelId,
      f.owner.principal,
      [f.owner.principal, { kind: 'user', userId: reader.userId }],
      await rosterVersion(channelId)
    )
    const newRoot = await createMessage(connection.db, workspaceId, channelId, f.owner.principal, {
      bodyText: 'post-join root',
      idempotencyKey: `post-join-root-${crypto.randomUUID()}`,
      sender: { kind: 'user', userId: f.owner.principal.userId },
    })
    const newReply = await createMessage(connection.db, workspaceId, channelId, f.owner.principal, {
      bodyText: 'post-join reply',
      idempotencyKey: `post-join-reply-${crypto.randomUUID()}`,
      sender: { kind: 'user', userId: f.owner.principal.userId },
      threadRootMessageId: newRoot.id,
    })

    const messageIds = new Set([oldRoot.id, oldReply.id, newRoot.id, newReply.id])
    const events = (await listWorkspaceEventsAfter(connection.db, workspaceId, 0, 200)).filter(
      (event) => event.eventType === 'message.created' && messageIds.has(event.aggregateId ?? '')
    )
    expect(events).toHaveLength(messageIds.size)
    const classified = await classifyWorkspaceEventsForUser(
      connection.db,
      workspaceId,
      reader.userId,
      events
    )
    expect(classified?.map((delivery) => delivery.kind)).toEqual([
      'withheld',
      'withheld',
      'deliver',
      'deliver',
    ])
    expect(JSON.stringify(classified)).not.toContain(oldRoot.id)
    expect(JSON.stringify(classified)).not.toContain(oldReply.id)
    expect(
      classified?.flatMap((delivery) =>
        delivery.kind === 'deliver' ? [delivery.event.aggregateId] : []
      )
    ).toEqual([newRoot.id, newReply.id])
  })

  test('event classification keeps one repeatable-read decision when group membership is revoked concurrently', async () => {
    const f = await fixture()
    const reader = f.recipient.principal
    const workspaceId = f.destination.id
    const channelId = f.channelA.id
    const message = await createMessage(connection.db, workspaceId, channelId, f.owner.principal, {
      bodyText: 'visible at snapshot start',
      idempotencyKey: `snapshot-${crypto.randomUUID()}`,
      sender: { kind: 'user', userId: f.owner.principal.userId },
    })
    const event = (await listWorkspaceEventsAfter(connection.db, workspaceId, 0, 200)).find(
      (candidate) =>
        candidate.eventType === 'message.created' && candidate.aggregateId === message.id
    )
    if (!event) throw new Error('message.created event missing')

    const snapshotReady = Promise.withResolvers<void>()
    const continueClassification = Promise.withResolvers<void>()
    const inFlight = connection.db.transaction(
      async (transaction) => {
        // Establish the repeatable-read snapshot before the roster update commits.
        await transaction
          .select({ userId: workspaceMemberships.userId })
          .from(workspaceMemberships)
          .where(eq(workspaceMemberships.userId, reader.userId))
        snapshotReady.resolve()
        await continueClassification.promise
        return classifyWorkspaceEventsForUser(transaction, workspaceId, reader.userId, [event])
      },
      { accessMode: 'read only', isolationLevel: 'repeatable read' }
    )
    try {
      await snapshotReady.promise
      await setChannelParticipants(
        connection.db,
        workspaceId,
        channelId,
        f.owner.principal,
        [f.owner.principal],
        await rosterVersion(channelId)
      )
    } finally {
      continueClassification.resolve()
    }
    const snapshotDecision = await inFlight
    expect(snapshotDecision?.map((delivery) => delivery.kind)).toEqual(['deliver'])
    const freshDecision = await classifyWorkspaceEventsForUser(
      connection.db,
      workspaceId,
      reader.userId,
      [event]
    )
    expect(freshDecision?.map((delivery) => delivery.kind)).toEqual(['withheld'])
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

    // The thread of a hidden publication is unavailable to mark: its root is not visible, so its
    // replies are not shown, counted or marked, and its watermark is left as it was.
    await expect(
      markThreadReadState(
        connection.db,
        f.destination.id,
        f.channelA.id,
        published.messageId!,
        reader,
        'read'
      )
    ).rejects.toThrow('Read state unavailable')

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

  test('a replay after restoring a grant cannot report an artifact absent from the stored summary-only publication', async () => {
    const f = await fixture({ complete: false })
    const reg = await registeredArtifact(f)
    await revokeArtifactReferenceGrant(
      connection.db,
      f.workspace.id,
      f.owner.principal,
      reg.grantId
    )
    const key = crypto.randomUUID()
    const request = outboundRequest(f, {
      artifact: artifactRef(reg),
      artifactPolicy: 'omit_unauthorized',
    })

    const initial = await completeJob(f, key, request)
    expect(initial.publication).toMatchObject({
      decision: { action: 'publish', artifactOmitted: 'grant_revoked' },
    })
    const messageId = initial.publication.messageId
    if (!messageId) throw new Error('expected the summary-only publication')
    expect(
      await connection.db
        .select({ artifactId: messageArtifactReferences.artifactId })
        .from(messageArtifactReferences)
        .where(eq(messageArtifactReferences.messageId, messageId))
    ).toEqual([])

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

    const replayed = await completeJob(f, key, request)
    expect(replayed.publication).toMatchObject({
      decision: {
        action: 'hold',
        gate: 'publication',
        reason: 'publication_replay_conflict',
      },
      messageId: null,
    })
    expect(await jobMessages(f.channelA.id, f.task.id)).toEqual([{ id: messageId }])
    expect(
      await connection.db
        .select({ artifactId: messageArtifactReferences.artifactId })
        .from(messageArtifactReferences)
        .where(eq(messageArtifactReferences.messageId, messageId))
    ).toEqual([])

    const concurrent = await Promise.all([
      completeJob(f, key, request),
      completeJob(f, key, request),
      completeJob(f, key, request),
    ])
    for (const outcome of concurrent) {
      expect(outcome.publication).toMatchObject({
        decision: {
          action: 'hold',
          gate: 'publication',
          reason: 'publication_replay_conflict',
        },
        messageId: null,
      })
    }
    expect(await jobMessages(f.channelA.id, f.task.id)).toEqual([{ id: messageId }])
    expect(
      await connection.db
        .select({ artifactId: messageArtifactReferences.artifactId })
        .from(messageArtifactReferences)
        .where(eq(messageArtifactReferences.messageId, messageId))
    ).toEqual([])
  })

  test('a replay after grant revocation cannot reuse an artifact-bound publication as summary-only', async () => {
    const f = await fixture({ complete: false })
    const reg = await registeredArtifact(f)
    const key = crypto.randomUUID()
    const request = outboundRequest(f, {
      artifact: artifactRef(reg),
      artifactPolicy: 'omit_unauthorized',
    })

    const initial = await completeJob(f, key, request)
    expect(initial.publication).toMatchObject({
      decision: { action: 'publish', artifactOmitted: null },
    })
    const messageId = initial.publication.messageId
    if (!messageId) throw new Error('expected the artifact publication')
    expect(
      await connection.db
        .select({ artifactId: messageArtifactReferences.artifactId })
        .from(messageArtifactReferences)
        .where(eq(messageArtifactReferences.messageId, messageId))
    ).toEqual([{ artifactId: reg.artifact.id }])

    await revokeArtifactReferenceGrant(
      connection.db,
      f.workspace.id,
      f.owner.principal,
      reg.grantId
    )

    const replayed = await completeJob(f, key, request)
    expect(replayed.publication).toMatchObject({
      decision: {
        action: 'hold',
        gate: 'publication',
        reason: 'publication_replay_conflict',
      },
      messageId: null,
    })
    expect(await jobMessages(f.channelA.id, f.task.id)).toEqual([{ id: messageId }])
    expect(
      await connection.db
        .select({ artifactId: messageArtifactReferences.artifactId })
        .from(messageArtifactReferences)
        .where(eq(messageArtifactReferences.messageId, messageId))
    ).toEqual([{ artifactId: reg.artifact.id }])
    expect(await deliver(f, messageId)).toEqual({
      action: 'deny',
      gate: 'artifact',
      reason: 'grant_revoked',
    })
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

    // The thread of the hidden job cannot be marked while its root is hidden; its replies are not
    // shown in any surface, and the surfaces still agree with the reader's history.
    await expect(
      markThreadReadState(connection.db, workspaceId, channelId, publicationTwo, reader, 'read')
    ).rejects.toThrow('Read state unavailable')
    await expectSurfacesAgree(f, 'thread of the hidden job refused')

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

    // Rejoining starts a new history window. Earlier messages and both publications stay hidden;
    // only content written after rejoining becomes visible.
    await setChannelParticipants(
      connection.db,
      workspaceId,
      channelId,
      f.owner.principal,
      [f.owner.principal, { kind: 'user', userId: reader.userId }],
      await channelRevision()
    )
    await note('lumen gamma after rejoin')
    await expectSurfacesAgree(f, 'reader back in the channel')
  })

  /** Statements for each reader surface at this moment, for the fixture's reader and workspace. */
  async function measureSurfaces(f: Fixture) {
    const reader = f.recipient.principal
    const workspaceId = f.destination.id
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

  test('query counts do not grow with ordinary messages; they grow only with the job publications a reader must gate', async () => {
    const f = await fixture({ complete: false })
    const workspaceId = f.destination.id
    const channelId = f.channelA.id
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
    // One visible publication, then five ordinary messages.
    await completeAs(f.task, {
      artifact: null,
      artifactPolicy: 'require',
      channelId,
      summary: 'lumen one',
    })
    for (let index = 0; index < 5; index += 1) await note(`lumen ${index}`)
    // Ordinary frontier: the cost does not move with the number of ordinary messages.
    const ordinaryFew = await measureSurfaces(f)
    for (let index = 0; index < 40; index += 1) await note(`lumen more ${index}`)
    const ordinaryMany = await measureSurfaces(f)
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
    const walkPath = await measureSurfaces(f)

    // Ordinary messages again: the frontier is ordinary, and one hidden publication is gated.
    for (let index = 0; index < 40; index += 1) await note(`lumen even more ${index}`)
    const hiddenFew = await measureSurfaces(f)
    for (let index = 0; index < 40; index += 1) await note(`lumen last ${index}`)
    const hiddenMany = await measureSurfaces(f)
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
    const walkPathTwo = await measureSurfaces(f)
    // Ordinary messages leave cost unchanged. These paths contain at most three publications,
    // which fit in one walk batch and one unread page; page packing can make the later path cheaper.
    const pathGateBudget =
      (Math.ceil(3 / WALK_BATCH) + Math.ceil(3 / UNREAD_PUBLICATION_PAGE)) * STATEMENTS_PER_GATE + 4
    for (const surface of Object.keys(ordinaryFew) as (keyof typeof ordinaryFew)[]) {
      expect(hiddenMany[surface]).toBeGreaterThanOrEqual(ordinaryMany[surface])
      expect(walkPath[surface] - ordinaryMany[surface]).toBeLessThanOrEqual(pathGateBudget)
      expect(walkPathTwo[surface] - ordinaryMany[surface]).toBeLessThanOrEqual(pathGateBudget)
    }
  })

  test('the batch gate agrees with the locked delivery decision for every publication state', async () => {
    const f = await fixture({ complete: false })
    const reader = f.recipient.principal
    const channelId = f.channelA.id
    const complete = (
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
    // Visible: a summary-only publication, and one whose artifact grant is current.
    const plain = await f.submitAnotherJob()
    await complete(plain, {
      artifact: null,
      artifactPolicy: 'require',
      channelId,
      summary: 'state plain',
    })
    const current = await registeredArtifact(f)
    const granted = await f.submitAnotherJob()
    await complete(granted, {
      artifact: { artifactId: current.artifact.id, grantId: current.grantId },
      artifactPolicy: 'require',
      channelId,
      summary: 'state granted',
    })
    // Hidden: a grant revoked after publication, and an artifact quarantined after publication.
    const revokedRegistration = await registeredArtifact(f)
    const revoked = await f.submitAnotherJob()
    await complete(revoked, {
      artifact: {
        artifactId: revokedRegistration.artifact.id,
        grantId: revokedRegistration.grantId,
      },
      artifactPolicy: 'require',
      channelId,
      summary: 'state revoked',
    })
    await revokeArtifactReferenceGrant(
      connection.db,
      f.workspace.id,
      f.owner.principal,
      revokedRegistration.grantId
    )
    const quarantinedRegistration = await registeredArtifact(f)
    const quarantined = await f.submitAnotherJob()
    await complete(quarantined, {
      artifact: {
        artifactId: quarantinedRegistration.artifact.id,
        grantId: quarantinedRegistration.grantId,
      },
      artifactPolicy: 'require',
      channelId,
      summary: 'state quarantined',
    })
    await setArtifactAvailability(
      connection.db,
      f.workspace.id,
      quarantinedRegistration.artifact.id,
      f.owner.principal,
      'quarantined',
      quarantinedRegistration.artifact.version
    )

    const rows = await connection.db
      .select({
        executionRef: messages.executionRef,
        id: messages.id,
        senderKind: messages.senderKind,
        senderSystemId: messages.senderSystemId,
      })
      .from(messages)
      .where(
        and(
          eq(messages.channelId, channelId),
          eq(messages.senderKind, 'system'),
          inArray(messages.executionRef, [plain.id, granted.id, revoked.id, quarantined.id])
        )
      )
    expect(rows).toHaveLength(4)
    // The oracle is the locked delivery decision, one publication at a time.
    const locked = new Set<string>()
    for (const row of rows) {
      const decision = await service().deliver(
        { jobId: row.executionRef!, messageId: row.id, recipientUserId: reader.userId },
        async () => {}
      )
      if (decision.action === 'deliver') locked.add(row.id)
    }
    const batch = new Set(
      (await filterVisibleJobOutboundRows(connection.db, rows, reader.userId)).map((row) => row.id)
    )
    expect(locked.size).toBe(2)
    expect([...batch].toSorted()).toEqual([...locked].toSorted())
  })

  /** An ordinary thread and a thread rooted in the job publication, both in channel A. */
  async function mixedThreads(f: Fixture) {
    const workspaceId = f.destination.id
    const channelId = f.channelA.id
    const post = (principal: UserPrincipalRef, bodyText: string, threadRootMessageId?: string) =>
      createMessage(connection.db, workspaceId, channelId, principal, {
        bodyText,
        idempotencyKey: `thread-${crypto.randomUUID()}`,
        sender: { kind: 'user', userId: principal.userId },
        ...(threadRootMessageId ? { threadRootMessageId } : {}),
      })
    const ordinaryRoot = await post(f.owner.principal, 'alpha root')
    const ordinaryReply = await post(f.recipient.principal, 'alpha reply', ordinaryRoot.id)
    const publicationId = await publishTo(f, channelId, 'bravo root')
    const jobReplyOne = await post(f.owner.principal, 'bravo reply one', publicationId)
    const jobReplyTwo = await post(f.recipient.principal, 'bravo reply two', publicationId)
    return { jobReplyOne, jobReplyTwo, ordinaryReply, ordinaryRoot, publicationId }
  }

  /** The reader's history in channel A, with each message's thread root. */
  async function threadedHistory(reader: UserPrincipalRef, workspaceId: string, channelId: string) {
    return (await historyOf(reader, workspaceId, channelId)).map((message) => ({
      id: message.id,
      threadRootMessageId: message.threadRootMessageId,
    }))
  }

  /** Each message.created event in the log, as the reader's stream delivers it. */
  async function deliveryOfMessages(reader: UserPrincipalRef, workspaceId: string) {
    const log = await listWorkspaceEventsAfter(connection.db, workspaceId, 0, 500)
    const delivered = await classifyWorkspaceEventsForUser(
      connection.db,
      workspaceId,
      reader.userId,
      log
    )
    const kinds = new Map<string, string>()
    log.forEach((event, index) => {
      if (event.eventType === 'message.created')
        kinds.set(String(event.payload.messageId), delivered![index]!.kind)
    })
    return kinds
  }

  /** The stored thread watermark of one reader in one thread, read from the table. */
  async function storedThreadWatermark(reader: UserPrincipalRef, threadRootMessageId: string) {
    const [row] = await connection.db
      .select({ lastReadSequence: threadReadStates.lastReadSequence })
      .from(threadReadStates)
      .where(
        and(
          eq(threadReadStates.userId, reader.userId),
          eq(threadReadStates.threadRootMessageId, threadRootMessageId)
        )
      )
      .limit(1)
    return row?.lastReadSequence ?? null
  }

  async function setOriginalActorRole(f: Fixture, role: 'owner' | 'member') {
    await connection.db
      .update(workspaceMemberships)
      .set({ role })
      .where(
        and(
          eq(workspaceMemberships.userId, f.owner.principal.userId),
          eq(workspaceMemberships.workspaceId, f.workspace.id)
        )
      )
  }

  test('a mixed thread is shown whole while its job publication is authorized: history, read state, search, inbox and events agree', async () => {
    const f = await fixture()
    const reader = f.recipient.principal
    const workspaceId = f.destination.id
    const channelId = f.channelA.id
    const t = await mixedThreads(f)

    const history = await threadedHistory(reader, workspaceId, channelId)
    expect(history.map((message) => message.id).toSorted()).toEqual(
      [t.ordinaryRoot, t.ordinaryReply, t.publicationId, t.jobReplyOne, t.jobReplyTwo]
        .map((message) => (typeof message === 'string' ? message : message.id))
        .toSorted()
    )
    expect(history.find((message) => message.id === t.jobReplyOne.id)).toEqual({
      id: t.jobReplyOne.id,
      threadRootMessageId: t.publicationId,
    })
    const state = (await listReadStateForUser(connection.db, workspaceId, reader)).find(
      (row) => row.channelId === channelId
    )!
    expect(
      state.threads.map((thread) => [thread.threadRootMessageId, thread.unreadCount]).toSorted()
    ).toEqual(
      [
        [t.ordinaryRoot.id, 1],
        [t.publicationId, 2],
      ].toSorted()
    )
    const inbox = (await accountConversationInbox(connection.db, reader)).conversations.find(
      (row) => row.id === channelId
    )!
    expect(inbox.threadUnreadCount).toBe(3)
    const bravo = await searchWorkspaceForUser(connection.db, workspaceId, reader, 'bravo', {
      limit: 100,
    })
    expect(
      bravo.results.flatMap((result) => (result.kind === 'message' ? [result.id] : [])).toSorted()
    ).toEqual([t.publicationId, t.jobReplyOne.id, t.jobReplyTwo.id].toSorted())
    const kinds = await deliveryOfMessages(reader, workspaceId)
    for (const id of [t.jobReplyOne.id, t.jobReplyTwo.id, t.ordinaryReply.id])
      expect(kinds.get(id)).toBe('deliver')
    await expectSurfacesAgree(f, 'mixed threads, authorized')
  })

  test('revoked job thread: history, read state, search, inbox, events and marks hide it; mark-all cannot run past it; its replies return with the authority, watermark intact', async () => {
    const f = await fixture()
    const reader = f.recipient.principal
    const workspaceId = f.destination.id
    const channelId = f.channelA.id
    const t = await mixedThreads(f)
    // Authorized: the reader reads the job thread through its first reply. That watermark must survive.
    await markThreadReadState(
      connection.db,
      workspaceId,
      channelId,
      t.publicationId,
      reader,
      'read',
      t.jobReplyOne.sequence
    )
    const watermarkBefore = await storedThreadWatermark(reader, t.publicationId)
    expect(watermarkBefore).toBe(t.jobReplyOne.sequence)
    const ordinaryThreadBefore = (await listReadStateForUser(connection.db, workspaceId, reader))
      .find((row) => row.channelId === channelId)!
      .threads.find((thread) => thread.threadRootMessageId === t.ordinaryRoot.id)

    // Source authority lost: the original actor is no longer an owner or admin, so the publication,
    // and with it the thread, is hidden.
    await setOriginalActorRole(f, 'member')
    const history = await threadedHistory(reader, workspaceId, channelId)
    expect(history.map((message) => message.id).toSorted()).toEqual(
      [t.ordinaryRoot.id, t.ordinaryReply.id].toSorted()
    )
    expect(JSON.stringify(history)).not.toContain(t.publicationId)
    const stateHidden = (await listReadStateForUser(connection.db, workspaceId, reader)).find(
      (row) => row.channelId === channelId
    )!
    expect(stateHidden.threads.map((thread) => thread.threadRootMessageId)).toEqual([
      t.ordinaryRoot.id,
    ])
    expect(stateHidden.threadUnreadCount).toBe(1)
    // The ordinary thread is unchanged by the hidden one.
    expect(
      stateHidden.threads.find((thread) => thread.threadRootMessageId === t.ordinaryRoot.id)
    ).toEqual(ordinaryThreadBefore)
    expect(JSON.stringify(stateHidden)).not.toContain(t.publicationId)
    expect(
      (await accountConversationInbox(connection.db, reader)).conversations.find(
        (row) => row.id === channelId
      )!.threadUnreadCount
    ).toBe(1)
    const bravo = await searchWorkspaceForUser(connection.db, workspaceId, reader, 'bravo', {
      limit: 100,
    })
    expect(bravo.results.filter((result) => result.kind === 'message')).toEqual([])
    const kinds = await deliveryOfMessages(reader, workspaceId)
    expect(kinds.get(t.jobReplyOne.id)).toBe('withheld')
    expect(kinds.get(t.jobReplyTwo.id)).toBe('withheld')
    expect(kinds.get(t.ordinaryReply.id)).toBe('deliver')
    await expect(
      getMessageForUser(connection.db, workspaceId, t.jobReplyOne.id, reader)
    ).rejects.toThrow('Message unavailable')

    // Marks cannot run past the hidden thread: a direct mark is refused, and mark-all advances only
    // the ordinary thread. The hidden thread's stored watermark does not move.
    await expect(
      markThreadReadState(connection.db, workspaceId, channelId, t.publicationId, reader, 'read')
    ).rejects.toThrow('Read state unavailable')
    await markAllChannelsRead(connection.db, workspaceId, reader)
    expect(await storedThreadWatermark(reader, t.publicationId)).toBe(watermarkBefore)
    expect(await storedThreadWatermark(reader, t.ordinaryRoot.id)).toBe(t.ordinaryReply.sequence)

    // Stored, not deleted: both replies are still in the database.
    const stored = await connection.db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.threadRootMessageId, t.publicationId))
    expect(stored.map((row) => row.id).toSorted()).toEqual(
      [t.jobReplyOne.id, t.jobReplyTwo.id].toSorted()
    )
    // A hidden reply cannot be changed or deleted by the reader, and the version check does not
    // reveal it: a wrong version is also refused as unavailable.
    for (const version of [t.jobReplyOne.version, t.jobReplyOne.version + 7]) {
      await expect(
        editMessage(
          connection.db,
          workspaceId,
          t.jobReplyOne.id,
          reader,
          { bodyText: 'changed' },
          version
        )
      ).rejects.toThrow('Message unavailable')
      await expect(
        deleteMessage(connection.db, workspaceId, t.jobReplyOne.id, reader, version)
      ).rejects.toThrow('Message unavailable')
    }
    const [unchanged] = await connection.db
      .select({
        bodyText: messages.bodyText,
        deletedAt: messages.deletedAt,
        version: messages.version,
      })
      .from(messages)
      .where(eq(messages.id, t.jobReplyOne.id))
    expect(unchanged).toEqual({
      bodyText: 'bravo reply one',
      deletedAt: null,
      version: t.jobReplyOne.version,
    })
    await expectSurfacesAgree(f, 'job thread hidden')

    // Authority returns: the replies return under the same ids. The stored watermark still stands, so
    // only the reply past it is unread.
    await setOriginalActorRole(f, 'owner')
    const restored = await threadedHistory(reader, workspaceId, channelId)
    expect(restored.map((message) => message.id).toSorted()).toEqual(
      [t.ordinaryRoot, t.ordinaryReply, t.publicationId, t.jobReplyOne, t.jobReplyTwo]
        .map((message) => (typeof message === 'string' ? message : message.id))
        .toSorted()
    )
    const stateRestored = (await listReadStateForUser(connection.db, workspaceId, reader)).find(
      (row) => row.channelId === channelId
    )!
    expect(
      stateRestored.threads.find((thread) => thread.threadRootMessageId === t.publicationId)
    ).toMatchObject({
      lastReadSequence: t.jobReplyOne.sequence,
      unreadCount: 1,
    })
    expect(await storedThreadWatermark(reader, t.publicationId)).toBe(watermarkBefore)
    await expectSurfacesAgree(f, 'job thread restored')
  })

  test('a revoked audience hides a job thread for good: a reply is refused, the replies stay stored, and restoring the owner does not return them', async () => {
    const f = await fixture()
    const reader = f.recipient.principal
    const workspaceId = f.destination.id
    const channelId = f.channelA.id
    const t = await mixedThreads(f)
    // Change the audience while retaining the reader. This advances the roster revision and hides
    // publications bound to the old revision without resetting the reader's join-point history.
    const extraParticipant = await addDestinationMember(f)
    await setChannelParticipants(
      connection.db,
      workspaceId,
      channelId,
      f.owner.principal,
      [
        f.owner.principal,
        { kind: 'user', userId: reader.userId },
        { kind: 'user', userId: extraParticipant.userId },
      ],
      await rosterVersion(channelId)
    )
    await setChannelParticipants(
      connection.db,
      workspaceId,
      channelId,
      f.owner.principal,
      [f.owner.principal, { kind: 'user', userId: reader.userId }],
      await rosterVersion(channelId)
    )
    const history = await threadedHistory(reader, workspaceId, channelId)
    expect(history.map((message) => message.id).toSorted()).toEqual(
      [t.ordinaryRoot.id, t.ordinaryReply.id].toSorted()
    )
    expect(JSON.stringify(history)).not.toContain(t.publicationId)
    const kinds = await deliveryOfMessages(reader, workspaceId)
    expect(kinds.get(t.jobReplyTwo.id)).toBe('withheld')
    // A reply cannot join a thread the writer cannot see; it is refused as a missing message.
    await expect(
      createMessage(connection.db, workspaceId, channelId, reader, {
        bodyText: 'bravo late reply',
        idempotencyKey: `late-${crypto.randomUUID()}`,
        sender: { kind: 'user', userId: reader.userId },
        threadRootMessageId: t.publicationId,
      })
    ).rejects.toThrow('Message unavailable')
    // Replies stay stored, and the owner's authority does not return them: the audience revision moved.
    await setOriginalActorRole(f, 'member')
    await setOriginalActorRole(f, 'owner')
    expect(
      (await threadedHistory(reader, workspaceId, channelId)).map((message) => message.id)
    ).not.toContain(t.jobReplyOne.id)
    const stored = await connection.db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.threadRootMessageId, t.publicationId))
    expect(stored).toHaveLength(2)
    await expectSurfacesAgree(f, 'audience revoked')
  })

  test('a malformed job root hides its thread, and a root that is missing or not top-level fails closed', async () => {
    const f = await fixture()
    const reader = f.recipient.principal
    const workspaceId = f.destination.id
    const channelId = f.channelA.id
    const t = await mixedThreads(f)
    expect(
      await readerVisibleThreadRootIds(
        connection.db,
        [t.ordinaryRoot.id, t.publicationId],
        reader.userId
      )
    ).toEqual(new Set([t.ordinaryRoot.id, t.publicationId]))
    // Missing, and a reply named as a root: neither is provably visible, so neither is shown.
    expect(
      await readerVisibleThreadRootIds(
        connection.db,
        [crypto.randomUUID(), t.jobReplyOne.id],
        reader.userId
      )
    ).toEqual(new Set())
    // A job publication whose binding no longer decodes: the gate denies it, and its thread goes with it.
    await connection.db
      .update(messages)
      .set({ senderSystemId: 'job-outbound:v1:malformed' })
      .where(eq(messages.id, t.publicationId))
    expect(
      (await threadedHistory(reader, workspaceId, channelId))
        .map((message) => message.id)
        .toSorted()
    ).toEqual([t.ordinaryRoot.id, t.ordinaryReply.id].toSorted())
    const state = (await listReadStateForUser(connection.db, workspaceId, reader)).find(
      (row) => row.channelId === channelId
    )!
    expect(state.threads.map((thread) => thread.threadRootMessageId)).toEqual([t.ordinaryRoot.id])
    expect(JSON.stringify(state)).not.toContain(t.publicationId)
  })

  test('the thread rule costs a fixed number of statements, however many threads the reader must gate', async () => {
    const f = await fixture({ complete: false })
    const reader = f.recipient.principal
    const workspaceId = f.destination.id
    const channelId = f.channelA.id
    const log = () => listWorkspaceEventsAfter(connection.db, workspaceId, 0, 500)
    const threadedJob = async (index: number) => {
      const job = await f.submitAnotherJob()
      const outcome = await completeTaskAndPublishOutboundResult(
        connection.db,
        f.workspace.id,
        job.id,
        f.owner.principal,
        {
          expectedVersion: job.version,
          idempotencyKey: crypto.randomUUID(),
          requestId: crypto.randomUUID(),
        },
        { artifact: null, artifactPolicy: 'require', channelId, summary: `bravo thread ${index}` }
      )
      await createMessage(connection.db, workspaceId, channelId, reader, {
        bodyText: `bravo reply ${index}`,
        idempotencyKey: `reply-${crypto.randomUUID()}`,
        sender: { kind: 'user', userId: reader.userId },
        threadRootMessageId: outcome.publication.messageId!,
      })
    }
    async function measure() {
      const events = await log()
      return {
        events: await statementsOf((db) =>
          classifyWorkspaceEventsForUser(db, workspaceId, reader.userId, events)
        ),
        history: await statementsOf((db) =>
          listMessagesForUser(db, workspaceId, channelId, reader, { limit: 100 })
        ),
        inbox: await statementsOf((db) => accountConversationInbox(db, reader)),
        readState: await statementsOf((db) => listReadStateForUser(db, workspaceId, reader)),
        search: await statementsOf((db) =>
          searchWorkspaceForUser(db, workspaceId, reader, 'bravo', { limit: 100 })
        ),
      }
    }
    const threadCount = async () =>
      (await listReadStateForUser(connection.db, workspaceId, reader)).find(
        (row) => row.channelId === channelId
      )!.threads.length
    for (let index = 0; index < 2; index += 1) await threadedJob(index)
    expect(await threadCount()).toBe(2)
    const few = await measure()
    for (let index = 2; index < 12; index += 1) await threadedJob(index)
    expect(await threadCount()).toBe(12)
    const many = await measure()
    expect(many).toEqual(few)
  })

  test('a search fills its window from the messages the reader may see: hidden publications take no place in it', async () => {
    const f = await fixture({ complete: false })
    const reader = f.recipient.principal
    const workspaceId = f.destination.id
    const channelId = f.channelA.id
    // Three matching publications, older than the visible match, and a page of one result: the
    // window is two raw matches, which the three hidden publications would fill on their own.
    for (let index = 0; index < 3; index += 1) {
      const job = await f.submitAnotherJob()
      await completeTaskAndPublishOutboundResult(
        connection.db,
        f.workspace.id,
        job.id,
        f.owner.principal,
        {
          expectedVersion: job.version,
          idempotencyKey: crypto.randomUUID(),
          requestId: crypto.randomUUID(),
        },
        { artifact: null, artifactPolicy: 'require', channelId, summary: `lumen hidden ${index}` }
      )
    }
    await setOriginalActorRole(f, 'member')
    const visible = await createMessage(connection.db, workspaceId, channelId, f.owner.principal, {
      bodyText: 'lumen visible',
      idempotencyKey: `visible-${crypto.randomUUID()}`,
      sender: { kind: 'user', userId: f.owner.principal.userId },
    })
    const page = await searchWorkspaceForUser(connection.db, workspaceId, reader, 'lumen', {
      limit: 1,
    })
    expect(
      page.results.flatMap((result) => (result.kind === 'message' ? [result.id] : []))
    ).toEqual([visible.id])
  })

  test('an encrypted reply in a hidden thread is not reported as a private result while the thread is hidden', async () => {
    const f = await fixture()
    const reader = f.recipient.principal
    const workspaceId = f.destination.id
    const channelId = f.channelA.id
    const publicationId = await publishTo(f, channelId, 'hint root')
    const contentId = crypto.randomUUID()
    await createContentRef(connection.db, workspaceId, f.owner.principal, {
      availability: 'offline',
      contentType: 'message_body',
      digestSha256: 'b'.repeat(64),
      id: contentId,
      keyVersion: 1,
      schemaVersion: 1,
      sensitivity: 'restricted',
      storagePolicy: 'local_authority',
      synchronizationPolicy: 'local_only',
    })
    await createMessage(connection.db, workspaceId, channelId, f.owner.principal, {
      bodyContentRefId: contentId,
      idempotencyKey: `private-reply-${crypto.randomUUID()}`,
      sender: { kind: 'user', userId: f.owner.principal.userId },
      threadRootMessageId: publicationId,
    })
    const privateHint = async () =>
      (await searchWorkspaceForUser(connection.db, workspaceId, reader, 'hint', { limit: 50 }))
        .privateResultsUnavailable
    expect(await privateHint()).toBe(true)
    await setOriginalActorRole(f, 'member')
    expect(await privateHint()).toBe(false)
    await setOriginalActorRole(f, 'owner')
    expect(await privateHint()).toBe(true)
  })

  test('a large hidden run is gated in pages: counts stay exact, and statements grow with pages, not publications', async () => {
    const f = await fixture({ complete: false })
    const reader = f.recipient.principal
    const workspaceId = f.destination.id
    const channelId = f.channelA.id
    // Ordinary messages first, so the newest message after the run is a publication and the
    // frontier walk reads through the whole hidden run.
    for (let index = 0; index < 3; index += 1)
      await createMessage(connection.db, workspaceId, channelId, f.owner.principal, {
        bodyText: `lumen ordinary ${index}`,
        idempotencyKey: `note-${crypto.randomUUID()}`,
        sender: { kind: 'user', userId: f.owner.principal.userId },
      })
    const baseline = await measureSurfaces(f)
    for (let index = 0; index < LARGE_HIDDEN_RUN; index += 1) {
      const job = await f.submitAnotherJob()
      await completeTaskAndPublishOutboundResult(
        connection.db,
        f.workspace.id,
        job.id,
        f.owner.principal,
        {
          expectedVersion: job.version,
          idempotencyKey: crypto.randomUUID(),
          requestId: crypto.randomUUID(),
        },
        { artifact: null, artifactPolicy: 'require', channelId, summary: `lumen run ${index}` }
      )
    }
    // Move the roster revision twice while retaining the reader, so the old publications are
    // hidden and the ordinary notes remain within the reader's original history window.
    const extraParticipant = await addDestinationMember(f)
    await setChannelParticipants(
      connection.db,
      workspaceId,
      channelId,
      f.owner.principal,
      [
        f.owner.principal,
        { kind: 'user', userId: reader.userId },
        { kind: 'user', userId: extraParticipant.userId },
      ],
      await rosterVersion(channelId)
    )
    await setChannelParticipants(
      connection.db,
      workspaceId,
      channelId,
      f.owner.principal,
      [f.owner.principal, { kind: 'user', userId: reader.userId }],
      await rosterVersion(channelId)
    )

    await expectSurfacesAgree(f, 'large hidden run')
    const state = (await listReadStateForUser(connection.db, workspaceId, reader)).find(
      (row) => row.channelId === channelId
    )
    expect(state?.topLevelUnreadCount).toBe(3)
    expect(await historyOf(reader, workspaceId, channelId)).toHaveLength(3)

    // Each surface pays for the walk's batches and the scan's pages, one bulk gate each. The
    // hidden run is never gated once per publication.
    const gates =
      Math.ceil(LARGE_HIDDEN_RUN / WALK_BATCH) +
      Math.ceil(LARGE_HIDDEN_RUN / UNREAD_PUBLICATION_PAGE)
    const hidden = await measureSurfaces(f)
    for (const surface of Object.keys(baseline) as (keyof typeof baseline)[])
      expect(hidden[surface] - baseline[surface]).toBeLessThanOrEqual(gates * STATEMENTS_PER_GATE)
  })

  // ─── Memory-derived results (#1217) ────────────────────────────────────────────
  // The producer declares the memory behind a summary. The product cannot inspect a summary, so
  // it enforces the declaration: a memory-derived summary is held, the Task still completes, and
  // nothing reaches the audience through any surface.

  for (const memorySource of ['private', 'unknown', 'workspace'] as const) {
    test(`a ${memorySource}-memory result is held: the Task completes, and no surface carries the summary`, async () => {
      const f = await fixture({ complete: false })
      const reg = await registeredArtifact(f)
      const summary = `lumen ${memorySource} memory: the account prefers the blue plan`
      const held = await completeJob(
        f,
        crypto.randomUUID(),
        outboundRequest(f, { artifact: artifactRef(reg), memorySource, summary })
      )
      expect(held.publication).toEqual({
        decision: {
          action: 'hold',
          gate: 'provenance',
          jobId: f.task.id,
          producerEffect: 'unaffected',
          reason:
            memorySource === 'private' ? 'memory_private_context' : 'memory_derived_unreleased',
        },
        messageId: null,
      })
      expect(held.task.lifecycleState).toBe('completed')
      expect(await taskState(f)).toMatchObject({ lifecycleState: 'completed' })

      // Nothing was written, linked, or counted.
      expect(await jobMessages(f.channelA.id, f.task.id)).toEqual([])
      expect(await jobMessages(f.channelB.id, f.task.id)).toEqual([])
      expect(
        await connection.db
          .select({ id: messageArtifactReferences.id })
          .from(messageArtifactReferences)
          .where(eq(messageArtifactReferences.artifactId, reg.artifact.id))
      ).toEqual([])
      for (const reader of [f.recipient.principal, f.owner.principal])
        expect(await historyOf(reader, f.destination.id, f.channelA.id)).toEqual([])
      await expectSurfacesAgree(f, `${memorySource} memory held`)
      const hits = await searchWorkspaceForUser(
        connection.db,
        f.destination.id,
        f.recipient.principal,
        'lumen',
        { limit: 100 }
      )
      expect(hits.results).toEqual([])
      expect(
        await listWorkspaceEventsAfter(connection.db, f.destination.id, 0, 200)
      ).not.toContainEqual(expect.objectContaining({ eventType: 'message.created' }))
    })
  }

  test('the memory hold is not a way to learn the job: a source-side caller sees only its typed reason', async () => {
    const f = await fixture({ complete: false })
    const held = await completeJob(
      f,
      crypto.randomUUID(),
      outboundRequest(f, { memorySource: 'private', summary: 'PRIVATE_MEMORY_SENTINEL' })
    )
    expect(JSON.stringify(held.publication)).not.toContain('PRIVATE_MEMORY_SENTINEL')
    expect(JSON.stringify(held.publication)).not.toContain(f.destination.id)
    expect(JSON.stringify(held.publication)).not.toContain(f.channelA.id)
  })

  test('a retry of a memory-held completion is held again and writes nothing; a changed declaration conflicts', async () => {
    const f = await fixture({ complete: false })
    const key = crypto.randomUUID()
    const request = outboundRequest(f, { memorySource: 'workspace' })
    const first = await completeJob(f, key, request)
    expect(first.publication).toMatchObject({ decision: { action: 'hold', gate: 'provenance' } })

    const again = await completeJob(f, key, request)
    expect(again.publication).toMatchObject({
      decision: { action: 'hold', gate: 'provenance' },
      messageId: null,
    })
    expect(await jobMessages(f.channelA.id, f.task.id)).toEqual([])

    // Dropping or changing the declaration under the same key is a different request.
    for (const changed of [
      outboundRequest(f),
      outboundRequest(f, { memorySource: 'none' }),
      outboundRequest(f, { memorySource: 'private' }),
    ])
      await expect(completeJob(f, key, changed)).rejects.toThrow('Task idempotency conflict')
    expect(await jobMessages(f.channelA.id, f.task.id)).toEqual([])
    expect(await taskState(f)).toMatchObject({ lifecycleState: 'completed' })
  })

  test('an explicit `none` is the request that existed before the field: same identity, same publication', async () => {
    const f = await fixture({ complete: false })
    const key = crypto.randomUUID()
    const first = await completeJob(f, key, outboundRequest(f, { memorySource: 'none' }))
    const messageId = first.publication.messageId
    if (!messageId) throw new Error('expected a canonical message')
    // The request without the field replays it: the declaration is part of identity only when set.
    const replayed = await completeJob(f, key, outboundRequest(f))
    expect(replayed.publication.messageId).toBe(messageId)
    expect(await jobMessages(f.channelA.id, f.task.id)).toEqual([{ id: messageId }])
  })

  // ─── References to separately owned jobs (#1217) ───────────────────────────────

  /** What a plan in the audience's channel can learn about the cited jobs, for one reader. */
  function referencesFor(
    f: Fixture,
    reader: UserPrincipalRef,
    jobIds: readonly string[],
    channelId = f.channelA.id
  ) {
    return resolveJobReferences(connection.db, {
      channelId,
      jobIds,
      reader,
      workspaceId: f.destination.id,
    })
  }

  test('a plan resolves a separately owned job to the publication the reader can already open, and to nothing else', async () => {
    const f = await fixture()
    const messageId = await publishTo(f, f.channelA.id, 'Published for the plan.')
    const views = await referencesFor(f, f.recipient.principal, [f.task.id])
    expect(views).toEqual([
      { authority: 'none', availability: 'available', jobId: f.task.id, messageId },
    ])
    // No private context: the job's title, objective, workspace, project, agent or runtime.
    const text = JSON.stringify(views)
    for (const secret of ['Outbound job', 'PRIVATE_PROMPT_SENTINEL', f.workspace.id, f.agent.id])
      expect(text).not.toContain(secret)
    // The reader is the audience; the job stays at its source.
    expect(await readJobOutboundSource(connection.db, f.task.id)).toMatchObject({
      sourceWorkspaceId: f.workspace.id,
    })
  })

  test('every case that is not a released publication reads the same, so a plan cannot probe a job', async () => {
    const f = await fixture()
    const published = await publishTo(f, f.channelA.id, 'Released to channel A only.')
    expect(published).toBeTruthy()
    const unsubmitted = await f.submitAnotherJob()
    const held = await f.submitAnotherJob()
    await completeTaskAndPublishOutboundResult(
      connection.db,
      f.workspace.id,
      held.id,
      f.owner.principal,
      {
        expectedVersion: held.version,
        idempotencyKey: crypto.randomUUID(),
        requestId: crypto.randomUUID(),
      },
      {
        artifact: null,
        artifactPolicy: 'require',
        channelId: f.channelA.id,
        memorySource: 'private',
        summary: 'held',
      }
    )
    const outsider = await addDestinationMember(f)
    const sourceOnly = await newUser(f, { destination: null, source: 'admin' })
    const cited = [f.task.id, unsubmitted.id, held.id, NIL_UUID, 'not-a-uuid']

    // A destination member outside the channel, a source admin outside the destination, and the
    // right reader asked about a channel the job was not published to.
    const expected = cited.map(unavailableReference)
    expect(await referencesFor(f, outsider, [f.task.id])).toEqual([unavailableReference(f.task.id)])
    expect(await referencesFor(f, sourceOnly, [f.task.id])).toEqual([
      unavailableReference(f.task.id),
    ])
    expect(await referencesFor(f, f.recipient.principal, [f.task.id], f.channelB.id)).toEqual([
      unavailableReference(f.task.id),
    ])

    // From the right place, only the released job is available. Unsubmitted, held, unknown and
    // malformed ids are indistinguishable from each other.
    const views = await referencesFor(f, f.recipient.principal, cited)
    expect(views[0]).toMatchObject({ availability: 'available', messageId: published })
    expect(views.slice(1)).toEqual(expected.slice(1))
  })

  test('a reference follows the publication gate: revocation, regrant, roster removal and lost source authority each end it', async () => {
    const f = await fixture({ complete: false })
    const reg = await registeredArtifact(f)
    const published = await completeJob(
      f,
      crypto.randomUUID(),
      outboundRequest(f, { artifact: artifactRef(reg) })
    )
    const messageId = published.publication.messageId!
    const reader = f.recipient.principal
    expect(await referencesFor(f, reader, [f.task.id])).toEqual([
      { authority: 'none', availability: 'available', jobId: f.task.id, messageId },
    ])

    await revokeArtifactReferenceGrant(
      connection.db,
      f.workspace.id,
      f.owner.principal,
      reg.grantId
    )
    expect(await referencesFor(f, reader, [f.task.id])).toEqual([unavailableReference(f.task.id)])
    // A regrant is a later revision: the bound revision is not revived.
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
    expect(await referencesFor(f, reader, [f.task.id])).toEqual([unavailableReference(f.task.id)])
  })

  test('a reference ends with the reader’s membership and with the original actor’s source authority', async () => {
    const f = await fixture()
    const messageId = await publishTo(f, f.channelA.id, 'Published while everyone is in.')
    const reader = f.recipient.principal
    const open = [{ authority: 'none', availability: 'available', jobId: f.task.id, messageId }]
    expect(await referencesFor(f, reader, [f.task.id])).toEqual(open)

    await setOriginalActorRole(f, 'member')
    expect(await referencesFor(f, reader, [f.task.id])).toEqual([unavailableReference(f.task.id)])
    await setOriginalActorRole(f, 'owner')
    expect(await referencesFor(f, reader, [f.task.id])).toEqual(open)

    await setChannelParticipants(
      connection.db,
      f.destination.id,
      f.channelA.id,
      f.owner.principal,
      [f.owner.principal],
      await rosterVersion(f.channelA.id)
    )
    expect(await referencesFor(f, reader, [f.task.id])).toEqual([unavailableReference(f.task.id)])
  })

  test('a lookalike system message never resolves a reference', async () => {
    const f = await fixture()
    const version = await rosterVersion(f.channelA.id)
    const forgedBinding = {
      actorUserId: f.owner.principal.userId,
      artifact: null,
      channelId: f.channelA.id,
      channelVersion: version,
      grant: null,
      jobId: f.task.id,
      summarySha256: summarySha256('Forged.'),
      workspaceId: f.destination.id,
    }
    await createMessage(connection.db, f.destination.id, f.channelA.id, f.owner.principal, {
      bodyText: 'Forged.',
      executionRef: f.task.id,
      idempotencyKey: `not-derived-${crypto.randomUUID()}`,
      sender: { kind: 'system', systemId: encodeJobOutboundBinding(forgedBinding) },
    })
    // An ordinary message that merely names the job is no publication either.
    await createMessage(connection.db, f.destination.id, f.channelA.id, f.owner.principal, {
      bodyText: 'See the job.',
      executionRef: f.task.id,
      idempotencyKey: `note-${crypto.randomUUID()}`,
      sender: { kind: 'user', userId: f.owner.principal.userId },
    })
    expect(await referencesFor(f, f.recipient.principal, [f.task.id])).toEqual([
      unavailableReference(f.task.id),
    ])
  })

  test('citations resolve in order, once each, up to the cap; more is refused before any read', async () => {
    const f = await fixture()
    const messageId = await publishTo(f, f.channelA.id, 'Ordered.')
    const reader = f.recipient.principal
    const views = await referencesFor(f, reader, [
      NIL_UUID,
      f.task.id,
      NIL_UUID,
      f.task.id.toUpperCase(),
    ])
    expect(views).toEqual([
      unavailableReference(NIL_UUID),
      { authority: 'none', availability: 'available', jobId: f.task.id, messageId },
    ])
    const ids = Array.from({ length: JOB_REFERENCE_MAX_BATCH }, () => crypto.randomUUID())
    expect(await referencesFor(f, reader, ids)).toHaveLength(JOB_REFERENCE_MAX_BATCH)
    await expect(referencesFor(f, reader, [...ids, crypto.randomUUID()])).rejects.toBeInstanceOf(
      JobReferenceBatchError
    )
  })

  test('holding a reference confers no authority over the job: the audience cannot read, depend on, or complete it', async () => {
    const f = await fixture()
    await publishTo(f, f.channelA.id, 'Referenced by a plan.')
    const audienceOwner = f.owner.principal
    expect(await referencesFor(f, f.recipient.principal, [f.task.id])).toMatchObject([
      { availability: 'available' },
    ])
    // The audience workspace has its own task; the cited job is not one it may depend on.
    const local = await createTask(
      connection.db,
      f.destination.id,
      audienceOwner,
      { title: 'Plan step in the audience workspace', objective: 'Wait for the cited job.' },
      { idempotencyKey: crypto.randomUUID(), requestId: crypto.randomUUID() }
    )
    await expect(
      setTaskDependencies(connection.db, f.destination.id, local.id, audienceOwner, [f.task.id], {
        expectedVersion: local.version,
        idempotencyKey: crypto.randomUUID(),
        requestId: crypto.randomUUID(),
      })
    ).rejects.toThrow('Task dependency unavailable')
    await expect(
      createTask(
        connection.db,
        f.destination.id,
        audienceOwner,
        { dependencyIds: [f.task.id], title: 'Depends on a foreign job', objective: 'No.' },
        { idempotencyKey: crypto.randomUUID(), requestId: crypto.randomUUID() }
      )
    ).rejects.toThrow('Task dependency unavailable')
    // Addressing the job through the audience workspace finds nothing to read or move.
    expect(
      await getTaskForUser(connection.db, f.destination.id, f.task.id, audienceOwner)
    ).toBeNull()
    await expect(
      completeTask(connection.db, f.destination.id, f.task.id, audienceOwner, {
        expectedVersion: f.task.version,
        idempotencyKey: crypto.randomUUID(),
        requestId: crypto.randomUUID(),
      })
    ).rejects.toThrow()
    expect(await taskState(f)).toMatchObject({ lifecycleState: 'completed' })
  })

  // ─── Coordination plans citing separately owned jobs (#1217) ───────────────────

  const PLAN_PRIVATE_SENTINELS = [
    'PRIVATE_PROMPT_SENTINEL',
    'PRIVATE_CONTEXT_SENTINEL',
    'SECOND_PROMPT_SENTINEL',
    'PRIVATE_MEMORY_SENTINEL',
    'Source workspace',
  ]

  /** A second, separately owned and completed job in the same fixture, as a fixture of its own. */
  async function anotherCompletedJob(f: Fixture): Promise<Fixture> {
    const extra = await f.submitAnotherJob()
    const g = { ...f, task: extra } as Fixture
    await completeJob(g, crypto.randomUUID(), outboundRequest(g, { summary: 'Second result.' }))
    return g
  }

  function createPlan(
    f: Fixture,
    actor: UserPrincipalRef,
    jobIds: readonly string[],
    idempotencyKey = planKey(),
    channelId = f.channelA.id
  ) {
    return createCoordinationPlan(connection.db, f.destination.id, channelId, actor, {
      idempotencyKey,
      jobIds,
    })
  }

  function revisePlan(
    f: Fixture,
    actor: UserPrincipalRef,
    planId: string,
    expectedRevision: number,
    jobIds: readonly string[]
  ) {
    return reviseCoordinationPlan(connection.db, f.destination.id, f.channelA.id, planId, actor, {
      expectedRevision,
      jobIds,
    })
  }

  function readPlan(
    f: Fixture,
    reader: UserPrincipalRef,
    planId: string,
    revision: number,
    channelId = f.channelA.id
  ) {
    return readCoordinationPlanJobReferences(
      connection.db,
      f.destination.id,
      channelId,
      planId,
      revision,
      reader
    )
  }

  async function planRows(f: Fixture) {
    return connection.db
      .select()
      .from(coordinationPlans)
      .where(eq(coordinationPlans.workspaceId, f.destination.id))
  }

  test('an actor creates a plan from results released to them; a reader resolves it as safe references', async () => {
    const f = await fixture()
    const messageId = await publishTo(f, f.channelA.id, 'Plan input.')
    const created = await createPlan(f, f.recipient.principal, [f.task.id])
    expect(created).toMatchObject({ jobIds: [f.task.id], revision: 1 })
    const [row] = await planRows(f)
    // The author comes from the principal, not from anything the caller could assert.
    expect(row).toMatchObject({
      channelId: f.channelA.id,
      createdByUserId: f.recipient.principal.userId,
      currentRevision: 1,
      workspaceId: f.destination.id,
    })
    const [revision] = await connection.db
      .select()
      .from(coordinationPlanRevisions)
      .where(eq(coordinationPlanRevisions.planId, created.planId))
    expect(revision).toMatchObject({ authorUserId: f.recipient.principal.userId, revision: 1 })

    for (const reader of [f.recipient.principal, f.owner.principal])
      expect(await readPlan(f, reader, created.planId, 1)).toEqual({
        planId: created.planId,
        references: [{ authority: 'none', availability: 'available', jobId: f.task.id, messageId }],
        revision: 1,
      })
  })

  test('a plan stores nothing of the job but its id, and the read carries no private context', async () => {
    const f = await fixture()
    await publishTo(f, f.channelA.id, 'Plan input.')
    const created = await createPlan(f, f.recipient.principal, [f.task.id])
    const stored = JSON.stringify({
      citations: await connection.db.select().from(coordinationPlanCitations),
      plans: await planRows(f),
      revisions: await connection.db.select().from(coordinationPlanRevisions),
    })
    const read = JSON.stringify(await readPlan(f, f.recipient.principal, created.planId, 1))
    for (const sentinel of PLAN_PRIVATE_SENTINELS) {
      expect(stored).not.toContain(sentinel)
      expect(read).not.toContain(sentinel)
    }
    // The pointer names neither workspace of the job's source nor any task title or objective.
    expect(read).not.toContain(f.workspace.id)
    expect(Object.keys(JSON.parse(read).references[0]).toSorted()).toEqual([
      'authority',
      'availability',
      'jobId',
      'messageId',
    ])
  })

  test('writes are group-channel participant writes: outsiders, other channels and non-members are refused alike', async () => {
    const f = await fixture()
    await publishTo(f, f.channelA.id, 'Plan input.')
    const outsider = await addDestinationMember(f)
    const stranger = (
      await createTemporaryUserSession(connection.db, {
        credentialDigest: crypto.randomUUID(),
        expiresAt: new Date(Date.now() + 60_000),
      })
    ).principal
    const refused = await Promise.all([
      // A workspace member who is not in the group.
      rejection(() => createPlan(f, outsider, [f.task.id])),
      // Not a member of the workspace at all.
      rejection(() => createPlan(f, stranger, [f.task.id])),
      // A participant of channel A, writing to channel B where the job was never published.
      rejection(() => createPlan(f, f.recipient.principal, [f.task.id], planKey(), f.channelB.id)),
    ])
    expect(refused.every((message) => message === 'Channel unavailable')).toBe(true)
    expect(await planRows(f)).toEqual([])

    const created = await createPlan(f, f.recipient.principal, [f.task.id])
    expect(await rejection(() => revisePlan(f, outsider, created.planId, 1, [f.task.id]))).toBe(
      'Channel unavailable'
    )
    expect(await rejection(() => revisePlan(f, stranger, created.planId, 1, [f.task.id]))).toBe(
      'Channel unavailable'
    )
    expect((await planRows(f))[0]?.currentRevision).toBe(1)
  })

  test('reads need current read access: outsiders, other channels and unknown plans answer the same', async () => {
    const f = await fixture()
    await publishTo(f, f.channelA.id, 'Plan input.')
    const created = await createPlan(f, f.recipient.principal, [f.task.id])
    const outsider = await addDestinationMember(f)
    expect(await rejection(() => readPlan(f, outsider, created.planId, 1))).toBe(
      'Channel unavailable'
    )
    // The plan is in channel A; naming it through channel B is the same as naming nothing.
    const wrongChannel = await rejection(() =>
      readPlan(f, f.owner.principal, created.planId, 1, f.channelB.id)
    )
    const unknownPlan = await rejection(() => readPlan(f, f.owner.principal, NIL_UUID, 1))
    const unknownRevision = await rejection(() => readPlan(f, f.owner.principal, created.planId, 2))
    const badRevision = await rejection(() => readPlan(f, f.owner.principal, created.planId, 0))
    expect(wrongChannel).toBe('Plan unavailable')
    expect([unknownPlan, unknownRevision, badRevision]).toEqual([
      'Plan unavailable',
      'Plan unavailable',
      'Plan unavailable',
    ])
    // A participant removed from the group loses the plan with the channel.
    await setChannelParticipants(
      connection.db,
      f.destination.id,
      f.channelA.id,
      f.owner.principal,
      [f.owner.principal],
      await rosterVersion(f.channelA.id)
    )
    expect(await rejection(() => readPlan(f, f.recipient.principal, created.planId, 1))).toBe(
      'Channel unavailable'
    )
  })

  test('a citation must already be released to the actor in this channel; the refusal is one error and writes nothing', async () => {
    const f = await fixture({ complete: false })
    // A result held by memory provenance is never a publication, so it cannot be cited.
    await completeJob(
      f,
      crypto.randomUUID(),
      outboundRequest(f, { memorySource: 'private', summary: 'PRIVATE_MEMORY_SENTINEL' })
    )
    const released = await anotherCompletedJob(f)
    const refused = await Promise.all(
      [f.task.id, NIL_UUID, crypto.randomUUID()].map((jobId) =>
        rejection(() => createPlan(f, f.recipient.principal, [jobId]))
      )
    )
    expect(new Set(refused)).toEqual(new Set(['Plan citation unavailable']))
    expect(await planRows(f)).toEqual([])

    // One released and one not: the whole request is refused and nothing is saved.
    expect(
      await rejection(() => createPlan(f, f.recipient.principal, [released.task.id, NIL_UUID]))
    ).toBe('Plan citation unavailable')
    expect(await planRows(f)).toEqual([])

    // A result released in channel A is not released in channel B, where the actor is a participant
    // of neither the channel nor its audience.
    expect(
      await rejection(() =>
        createPlan(f, f.owner.principal, [released.task.id], planKey(), f.channelB.id)
      )
    ).toBe('Plan citation unavailable')
    expect(await planRows(f)).toEqual([])
    expect(await createPlan(f, f.recipient.principal, [released.task.id])).toMatchObject({
      revision: 1,
    })
  })

  test('citations are ordered and deduplicated; the cap holds after deduplication; malformed input is refused whole', async () => {
    const f = await fixture()
    const first = await publishTo(f, f.channelA.id, 'First.')
    const g = await anotherCompletedJob(f)
    const second = (
      await resolveJobReferences(connection.db, {
        channelId: f.channelA.id,
        jobIds: [g.task.id],
        reader: f.recipient.principal,
        workspaceId: f.destination.id,
      })
    )[0]
    expect(second).toMatchObject({ availability: 'available' })

    const created = await createPlan(f, f.recipient.principal, [
      g.task.id,
      f.task.id.toUpperCase(),
      g.task.id,
      f.task.id,
    ])
    expect(created.jobIds).toEqual([g.task.id, f.task.id])
    const read = await readPlan(f, f.recipient.principal, created.planId, 1)
    expect(read.references.map((reference) => reference.jobId)).toEqual([g.task.id, f.task.id])
    expect(read.references).toContainEqual(expect.objectContaining({ messageId: first }))

    // 50 distinct is within the bound; duplicates do not count toward it.
    const filler = Array.from({ length: COORDINATION_PLAN_MAX_CITATIONS - 2 }, () =>
      crypto.randomUUID()
    )
    const invalid = await Promise.all([
      rejection(() =>
        createPlan(f, f.recipient.principal, [...filler, f.task.id, g.task.id, crypto.randomUUID()])
      ),
      rejection(() => createPlan(f, f.recipient.principal, [f.task.id, 'not-a-uuid'])),
      rejection(() => createPlan(f, f.recipient.principal, 'nope' as never)),
      rejection(() => createPlan(f, f.recipient.principal, [123 as never])),
      rejection(() => createPlan(f, f.recipient.principal, [f.task.id], '   ')),
      rejection(() => createPlan(f, f.recipient.principal, [f.task.id], 'k'.repeat(129))),
    ])
    expect(invalid).toEqual(Array(6).fill('Plan citations invalid'))
    expect(await planRows(f)).toHaveLength(1)
  })

  test('an empty plan is allowed, and the stored position and uniqueness bounds hold at the database', async () => {
    const f = await fixture()
    const empty = await createPlan(f, f.recipient.principal, [])
    expect(empty.jobIds).toEqual([])
    expect((await readPlan(f, f.recipient.principal, empty.planId, 1)).references).toEqual([])
    await refuses(
      connection.db.insert(coordinationPlanCitations).values({
        jobId: crypto.randomUUID(),
        planId: empty.planId,
        position: 50,
        revision: 1,
      })
    )
    await publishTo(f, f.channelA.id, 'x')
    const cited = await createPlan(f, f.recipient.principal, [f.task.id])
    await refuses(
      connection.db.insert(coordinationPlanCitations).values({
        jobId: f.task.id,
        planId: cited.planId,
        position: 1,
        revision: 1,
      })
    )
  })

  test('create is idempotent per key; a different request or actor under the key conflicts', async () => {
    const f = await fixture()
    await publishTo(f, f.channelA.id, 'Plan input.')
    const key = planKey()
    const first = await createPlan(f, f.recipient.principal, [f.task.id], key)
    const again = await createPlan(f, f.recipient.principal, [f.task.id.toUpperCase()], key)
    expect(again).toEqual(first)
    expect(await planRows(f)).toHaveLength(1)
    expect(await rejection(() => createPlan(f, f.recipient.principal, [], key))).toBe(
      'Plan idempotency conflict'
    )
    expect(await rejection(() => createPlan(f, f.owner.principal, [f.task.id], key))).toBe(
      'Plan idempotency conflict'
    )
    expect(await planRows(f)).toHaveLength(1)

    // Concurrent creates under one key converge on one plan.
    const raceKey = planKey()
    const results = await Promise.all(
      Array.from({ length: 4 }, () => createPlan(f, f.recipient.principal, [f.task.id], raceKey))
    )
    expect(new Set(results.map((result) => result.planId)).size).toBe(1)
    expect(await planRows(f)).toHaveLength(2)
  })

  test('revisions advance by one from the revision the writer saw; a stale writer is refused and changes nothing', async () => {
    const f = await fixture()
    await publishTo(f, f.channelA.id, 'Plan input.')
    const g = await anotherCompletedJob(f)
    const created = await createPlan(f, f.recipient.principal, [f.task.id])

    const second = await revisePlan(f, f.owner.principal, created.planId, 1, [g.task.id, f.task.id])
    expect(second).toMatchObject({ jobIds: [g.task.id, f.task.id], revision: 2 })
    // Both writers last saw revision 1; the loser changes nothing.
    expect(await rejection(() => revisePlan(f, f.recipient.principal, created.planId, 1, []))).toBe(
      'Plan version conflict'
    )
    expect(await rejection(() => revisePlan(f, f.recipient.principal, created.planId, 3, []))).toBe(
      'Plan version conflict'
    )
    const [row] = await planRows(f)
    expect(row?.currentRevision).toBe(2)
    expect(
      await connection.db
        .select()
        .from(coordinationPlanRevisions)
        .where(eq(coordinationPlanRevisions.planId, created.planId))
    ).toHaveLength(2)

    // Two writers race on the same expected revision: exactly one wins.
    const outcomes = await Promise.allSettled([
      revisePlan(f, f.recipient.principal, created.planId, 2, [f.task.id]),
      revisePlan(f, f.owner.principal, created.planId, 2, [g.task.id]),
    ])
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    const lost = outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult
    expect(lost.reason.message).toBe('Plan version conflict')
    expect((await planRows(f))[0]?.currentRevision).toBe(3)

    // Invalid expected revisions never reach the plan.
    for (const expected of [0, -1, 1.5, Number.NaN, 2_147_483_647])
      expect(
        await rejection(() => revisePlan(f, f.owner.principal, created.planId, expected, []))
      ).toBe('Plan citations invalid')
    expect(await rejection(() => revisePlan(f, f.owner.principal, NIL_UUID, 1, []))).toBe(
      'Plan unavailable'
    )
  })

  test('accepted revisions are immutable: history reads unchanged and the database refuses to alter it', async () => {
    const f = await fixture()
    await publishTo(f, f.channelA.id, 'Plan input.')
    const g = await anotherCompletedJob(f)
    const created = await createPlan(f, f.recipient.principal, [f.task.id])
    await revisePlan(f, f.recipient.principal, created.planId, 1, [g.task.id])
    const one = await readPlan(f, f.recipient.principal, created.planId, 1)
    const two = await readPlan(f, f.recipient.principal, created.planId, 2)
    expect(one.references.map((reference) => reference.jobId)).toEqual([f.task.id])
    expect(two.references.map((reference) => reference.jobId)).toEqual([g.task.id])

    await refuses(
      connection.db
        .update(coordinationPlanCitations)
        .set({ jobId: crypto.randomUUID() })
        .where(eq(coordinationPlanCitations.planId, created.planId))
    )
    await refuses(
      connection.db
        .delete(coordinationPlanCitations)
        .where(eq(coordinationPlanCitations.planId, created.planId))
    )
    await refuses(
      connection.db
        .update(coordinationPlanRevisions)
        .set({ authorUserId: f.owner.principal.userId })
        .where(eq(coordinationPlanRevisions.planId, created.planId))
    )
    await refuses(
      connection.db
        .delete(coordinationPlanRevisions)
        .where(eq(coordinationPlanRevisions.planId, created.planId))
    )
    await refuses(
      connection.db.delete(coordinationPlans).where(eq(coordinationPlans.id, created.planId))
    )
    // The plan row advances by one and keeps its identity.
    await refuses(
      connection.db
        .update(coordinationPlans)
        .set({ currentRevision: 5 })
        .where(eq(coordinationPlans.id, created.planId))
    )
    await refuses(
      connection.db
        .update(coordinationPlans)
        .set({ createdByUserId: f.owner.principal.userId })
        .where(eq(coordinationPlans.id, created.planId))
    )
    expect(await readPlan(f, f.recipient.principal, created.planId, 1)).toEqual(one)
    expect(await readPlan(f, f.recipient.principal, created.planId, 2)).toEqual(two)
  })

  test('a citation is not authority: no dependency, no source read, no completion, and the job is unchanged', async () => {
    const f = await fixture()
    await publishTo(f, f.channelA.id, 'Plan input.')
    const before = await taskState(f)
    const created = await createPlan(f, f.owner.principal, [f.task.id])
    expect(await readPlan(f, f.owner.principal, created.planId, 1)).toMatchObject({
      references: [{ authority: 'none', availability: 'available' }],
    })
    expect(await taskState(f)).toEqual(before)
    expect(
      await getTaskForUser(connection.db, f.destination.id, f.task.id, f.owner.principal)
    ).toBeNull()
    await expect(
      completeTask(connection.db, f.destination.id, f.task.id, f.owner.principal, {
        expectedVersion: f.task.version,
        idempotencyKey: crypto.randomUUID(),
        requestId: crypto.randomUUID(),
      })
    ).rejects.toThrow()
    const local = await createTask(
      connection.db,
      f.destination.id,
      f.owner.principal,
      { title: 'Plan step', objective: 'Depends on nothing foreign.' },
      { idempotencyKey: crypto.randomUUID(), requestId: crypto.randomUUID() }
    )
    await expect(
      setTaskDependencies(
        connection.db,
        f.destination.id,
        local.id,
        f.owner.principal,
        [f.task.id],
        {
          expectedVersion: local.version,
          idempotencyKey: crypto.randomUUID(),
          requestId: crypto.randomUUID(),
        }
      )
    ).rejects.toThrow('Task dependency unavailable')
    // The citation row carries no foreign key to tasks: deleting nothing and constraining nothing.
    const references = await connection.db.execute<{ count: number }>(
      sql`select count(*)::int as count from pg_constraint c
          join pg_class t on t.oid = c.conrelid
          where t.relname = 'coordination_plan_citations' and c.contype = 'f'
            and c.confrelid::regclass::text like '%tasks%'`
    )
    expect(references[0]?.count).toBe(0)
  })

  test('revocation ends the reference in every revision, for every reader, and reads like an unknown job', async () => {
    const f = await fixture({ complete: false })
    const reg = await registeredArtifact(f)
    const published = await completeJob(
      f,
      crypto.randomUUID(),
      outboundRequest(f, { artifact: artifactRef(reg) })
    )
    const messageId = published.publication.messageId!
    const created = await createPlan(f, f.recipient.principal, [f.task.id])
    const next = await revisePlan(f, f.recipient.principal, created.planId, 1, [f.task.id])
    expect(next.revision).toBe(2)
    const open = [{ authority: 'none', availability: 'available', jobId: f.task.id, messageId }]
    for (const revision of [1, 2])
      expect(
        (await readPlan(f, f.recipient.principal, created.planId, revision)).references
      ).toEqual(open)

    await revokeArtifactReferenceGrant(
      connection.db,
      f.workspace.id,
      f.owner.principal,
      reg.grantId
    )

    const unknown = await createPlan(f, f.recipient.principal, [])
    for (const revision of [1, 2])
      for (const reader of [f.recipient.principal, f.owner.principal])
        expect((await readPlan(f, reader, created.planId, revision)).references).toEqual([
          unavailableReference(f.task.id),
        ])
    // The revoked answer has the shape of an answer about a job that never existed.
    const ghost = await readPlan(f, f.recipient.principal, created.planId, 1)
    expect(Object.keys(ghost.references[0]!).toSorted()).toEqual([
      'authority',
      'availability',
      'jobId',
    ])
    expect(unknown.revision).toBe(1)

    // Carrying the revoked id forward needs no new release; adding it fresh does.
    const carried = await revisePlan(f, f.recipient.principal, created.planId, 2, [f.task.id])
    expect(carried.revision).toBe(3)
    expect(await rejection(() => createPlan(f, f.recipient.principal, [f.task.id]))).toBe(
      'Plan citation unavailable'
    )
  })

  test('a regrant does not revive a reference bound to the revoked revision', async () => {
    const f = await fixture({ complete: false })
    const reg = await registeredArtifact(f)
    await completeJob(f, crypto.randomUUID(), outboundRequest(f, { artifact: artifactRef(reg) }))
    const created = await createPlan(f, f.recipient.principal, [f.task.id])
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
    expect((await readPlan(f, f.recipient.principal, created.planId, 1)).references).toEqual([
      unavailableReference(f.task.id),
    ])
  })

  test('roster and source-authority changes end a reference for the affected reader only', async () => {
    const f = await fixture()
    const messageId = await publishTo(f, f.channelA.id, 'Plan input.')
    const created = await createPlan(f, f.owner.principal, [f.task.id])
    const open = [{ authority: 'none', availability: 'available', jobId: f.task.id, messageId }]
    expect((await readPlan(f, f.recipient.principal, created.planId, 1)).references).toEqual(open)

    // The original actor loses source-workspace standing: nobody can resolve the result.
    await setOriginalActorRole(f, 'member')
    for (const reader of [f.owner.principal, f.recipient.principal])
      expect((await readPlan(f, reader, created.planId, 1)).references).toEqual([
        unavailableReference(f.task.id),
      ])
    await setOriginalActorRole(f, 'owner')
    expect((await readPlan(f, f.recipient.principal, created.planId, 1)).references).toEqual(open)
  })

  test('history from before the reader joined is unavailable in a plan exactly as in the channel, until history is shared', async () => {
    const f = await fixture()
    const publishedId = await publishTo(f, f.channelA.id, 'Published before the reader joined.')
    const created = await createPlan(f, f.owner.principal, [f.task.id])
    const inHistory = async (reader: UserPrincipalRef) =>
      (await historyOf(reader, f.destination.id, f.channelA.id)).some(
        (message) => message.id === publishedId
      )
    const resolves = async (reader: UserPrincipalRef) =>
      (await readPlan(f, reader, created.planId, 1)).references[0]?.availability === 'available'
    const reader = f.recipient.principal
    expect(await inHistory(reader)).toBe(true)
    expect(await resolves(reader)).toBe(true)

    // A real roster change also ends every publication bound to the earlier channel revision, which
    // would hide this case behind a different gate. Moving only the reader's join point, past the
    // publication and with the channel revision unchanged, isolates the join-point rule.
    const [message] = await connection.db
      .select({ sequence: messages.sequence })
      .from(messages)
      .where(eq(messages.id, publishedId))
    await connection.db
      .update(groupAdmissions)
      .set({ joinedSequence: message!.sequence + 1 })
      .where(
        and(eq(groupAdmissions.channelId, f.channelA.id), eq(groupAdmissions.userId, reader.userId))
      )
    // The reader may still open the plan, which is channel content, but the earlier publication is
    // held back exactly as the channel history holds it back. Other readers are not affected.
    expect(await inHistory(reader)).toBe(false)
    expect((await readPlan(f, reader, created.planId, 1)).references).toEqual([
      unavailableReference(f.task.id),
    ])
    expect(await resolves(f.owner.principal)).toBe(true)
    // They cannot cite what they cannot read either.
    expect(await rejection(() => createPlan(f, reader, [f.task.id]))).toBe(
      'Plan citation unavailable'
    )

    // Sharing earlier history with this reader releases it, through the same rule, for them only.
    await shareGroupHistory(connection.db, f.destination.id, f.channelA.id, f.owner.principal, {
      expiresAt: null,
      grantId: `share-${crypto.randomUUID()}`,
      groupId: f.channelA.id,
      issuedAt: new Date(Date.now() - 1000).toISOString(),
      participant: { kind: 'user', userId: reader.userId },
      revision: 1,
      revokedAt: null,
      scope: 'earlier_history',
    })
    expect(await inHistory(reader)).toBe(true)
    expect(await resolves(reader)).toBe(true)
  })

  test('an accepted revision cannot grow: a late citation into any unused position, or an incomplete revision, is refused', async () => {
    const f = await fixture()
    await publishTo(f, f.channelA.id, 'Plan input.')
    const g = await anotherCompletedJob(f)
    const empty = await createPlan(f, f.recipient.principal, [])
    const one = await createPlan(f, f.recipient.principal, [f.task.id])
    const two = await revisePlan(f, f.recipient.principal, one.planId, 1, [f.task.id, g.task.id])
    const snapshot = async () =>
      JSON.stringify(
        await connection.db
          .select()
          .from(coordinationPlanCitations)
          .orderBy(
            coordinationPlanCitations.planId,
            coordinationPlanCitations.revision,
            coordinationPlanCitations.position
          )
      )
    const before = await snapshot()
    const late = (planId: string, revision: number, position: number) =>
      connection.db.insert(coordinationPlanCitations).values({
        jobId: crypto.randomUUID(),
        planId,
        position,
        revision,
      })

    // An empty revision takes nothing; a full one takes nothing beyond its last position; a filled
    // position is taken already; a revision that does not exist has no position at all.
    await refuses(late(empty.planId, 1, 0))
    await refuses(late(one.planId, 1, 1))
    await refuses(late(one.planId, 1, 0))
    await refuses(late(one.planId, two.revision, 2))
    await refuses(late(one.planId, two.revision, 49))
    await refuses(late(one.planId, 3, 0))
    expect(await snapshot()).toBe(before)

    // A revision must hold exactly the citations it declares by the time it commits.
    await refuses(
      connection.db.insert(coordinationPlanRevisions).values({
        authorUserId: f.owner.principal.userId,
        channelId: f.channelA.id,
        citationCount: 1,
        planId: empty.planId,
        revision: 2,
        workspaceId: f.destination.id,
      })
    )
    await refuses(
      connection.db.transaction(async (transaction) => {
        await transaction.insert(coordinationPlanRevisions).values({
          authorUserId: f.owner.principal.userId,
          channelId: f.channelA.id,
          citationCount: 2,
          planId: empty.planId,
          revision: 2,
          workspaceId: f.destination.id,
        })
        await transaction.insert(coordinationPlanCitations).values({
          jobId: f.task.id,
          planId: empty.planId,
          position: 0,
          revision: 2,
        })
      })
    )
    expect(await snapshot()).toBe(before)
    expect(
      await connection.db
        .select({ revision: coordinationPlanRevisions.revision })
        .from(coordinationPlanRevisions)
        .where(eq(coordinationPlanRevisions.planId, empty.planId))
    ).toEqual([{ revision: 1 }])
    // The product path is unaffected: the same plan still takes its next revision.
    expect(await revisePlan(f, f.recipient.principal, empty.planId, 1, [f.task.id])).toMatchObject({
      jobIds: [f.task.id],
      revision: 2,
    })
  })

  test('a history-sharing grant revoked before the plan commits cannot validate the citation', async () => {
    const f = await fixture()
    const publishedId = await publishTo(f, f.channelA.id, 'Published before the reader joined.')
    const reader = f.recipient.principal
    // The reader's join point is after the publication, so only a sharing grant releases it.
    const [message] = await connection.db
      .select({ sequence: messages.sequence })
      .from(messages)
      .where(eq(messages.id, publishedId))
    await connection.db
      .update(groupAdmissions)
      .set({ joinedSequence: message!.sequence + 1 })
      .where(
        and(eq(groupAdmissions.channelId, f.channelA.id), eq(groupAdmissions.userId, reader.userId))
      )
    const grantId = `share-${crypto.randomUUID()}`
    await shareGroupHistory(connection.db, f.destination.id, f.channelA.id, f.owner.principal, {
      expiresAt: null,
      grantId,
      groupId: f.channelA.id,
      issuedAt: new Date(Date.now() - 1000).toISOString(),
      participant: { kind: 'user', userId: reader.userId },
      revision: 1,
      revokedAt: null,
      scope: 'earlier_history',
    })
    // Positive control: the grant is what releases the result, and the plan is accepted with it.
    const accepted = await createPlan(f, reader, [f.task.id])
    expect(accepted.revision).toBe(1)

    // A second connection revokes the grant and holds the revocation open. The plan write must
    // wait for it instead of validating against the grant as it was before.
    const revoker = postgres(url!, { max: 1, prepare: false })
    try {
      await revoker.unsafe('begin')
      await revoker.unsafe(
        'update app.group_sharing_grants set revoked_at = $1 where channel_id = $2 and grant_id = $3',
        [new Date(Date.now() - 1000).toISOString(), f.channelA.id, grantId]
      )
      let settled = false
      const pending = rejection(() => createPlan(f, reader, [f.task.id])).finally(() => {
        settled = true
      })
      await new Promise((resolve) => setTimeout(resolve, 750))
      expect(settled).toBe(false)
      await revoker.unsafe('commit')
      expect(await pending).toBe('Plan citation unavailable')
    } finally {
      await revoker.end({ timeout: 5 })
    }
    // The refused write left nothing behind, and the revoked release cannot be added by a revision.
    expect(await planRows(f)).toHaveLength(1)
    const bare = await createPlan(f, reader, [])
    expect(await rejection(() => revisePlan(f, reader, bare.planId, 1, [f.task.id]))).toBe(
      'Plan citation unavailable'
    )
  })

  test('a memory-derived result is held, so a plan cannot cite it and no reference reveals it', async () => {
    const f = await fixture({ complete: false })
    await completeJob(
      f,
      crypto.randomUUID(),
      outboundRequest(f, { memorySource: 'workspace', summary: 'PRIVATE_MEMORY_SENTINEL' })
    )
    expect(await rejection(() => createPlan(f, f.recipient.principal, [f.task.id]))).toBe(
      'Plan citation unavailable'
    )
    const empty = await createPlan(f, f.recipient.principal, [])
    const read = JSON.stringify(await readPlan(f, f.recipient.principal, empty.planId, 1))
    expect(read).not.toContain('PRIVATE_MEMORY_SENTINEL')
    expect(await planRows(f)).toHaveLength(1)
  })

  test('a grant revoked while a plan is being written orders either before the plan or after it, never between', async () => {
    for (let round = 0; round < 3; round += 1) {
      const f = await fixture({ complete: false })
      const reg = await registeredArtifact(f)
      await completeJob(f, crypto.randomUUID(), outboundRequest(f, { artifact: artifactRef(reg) }))
      const [created, revoked] = await Promise.allSettled([
        createPlan(f, f.recipient.principal, [f.task.id]),
        revokeArtifactReferenceGrant(connection.db, f.workspace.id, f.owner.principal, reg.grantId),
      ])
      // Revocation always succeeds; the plan either saw the live grant or was refused.
      expect(revoked.status).toBe('fulfilled')
      if (created.status === 'rejected')
        expect(created.reason.message).toBe('Plan citation unavailable')
      // Whatever the order, the settled state hides the result from every reader.
      const rows = await planRows(f)
      for (const row of rows)
        expect((await readPlan(f, f.recipient.principal, row.id, 1)).references).toEqual([
          unavailableReference(f.task.id),
        ])
      expect(rows).toHaveLength(created.status === 'fulfilled' ? 1 : 0)
    }
  })

  test('errors and refusals carry no job, workspace or channel detail', async () => {
    const f = await fixture()
    await publishTo(f, f.channelA.id, 'Plan input.')
    const outsider = await addDestinationMember(f)
    const messagesSeen = (
      await Promise.all([
        rejection(() => createPlan(f, f.recipient.principal, [NIL_UUID])),
        rejection(() => createPlan(f, outsider, [f.task.id])),
        rejection(() => readPlan(f, f.recipient.principal, NIL_UUID, 1)),
        rejection(() => readPlan(f, outsider, NIL_UUID, 1)),
        rejection(() => revisePlan(f, f.recipient.principal, NIL_UUID, 1, [f.task.id])),
        rejection(() => revisePlan(f, f.recipient.principal, NIL_UUID, 1, ['bad'])),
      ])
    ).map(String)
    for (const message of messagesSeen)
      for (const secret of [f.task.id, f.workspace.id, f.destination.id, f.channelA.id, NIL_UUID])
        expect(message).not.toContain(secret)
  })
})
