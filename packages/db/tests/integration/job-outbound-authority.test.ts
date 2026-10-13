import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { exportPortableWorkspace } from '../../src/portable-export'
import { and, eq, sql } from 'drizzle-orm'

import { generateRemoteCommandKeyPair, sealRemoteContent } from '@adea-ai/remote-content'

import { createAgent } from '../../src/agents'
import { accountConversationInbox } from '../../src/account-inbox'
import { accountWorkspaceSummaries } from '../../src/account-summary'
import { createArtifact } from '../../src/artifacts'
import {
  registerArtifactReferenceGrant,
  revokeArtifactReferenceGrant,
} from '../../src/artifact-reference-grants'
import {
  createDatabase,
  type AgentHqDatabase,
  type AgentHqTransaction,
  type DatabaseConnection,
} from '../../src/connection'
import { createContentRef, getContentRefForUser } from '../../src/content-refs'
import { listContentReplicasForUser, upsertContentReplica } from '../../src/content-replicas'
import { classifyWorkspaceEventsForUser } from '../../src/event-visibility'
import {
  createGroupChannel,
  createMessage,
  getMessageForUser,
  listMessagesForUser,
  setChannelParticipants,
} from '../../src/conversations'
import { createTemporaryUserSession } from '../../src/identity'
import { filterVisibleJobOutboundRows, filterVisibleMessageRows } from '../../src/job-outbound-read'
import {
  completeTaskAndPublishOutboundResult,
  createJobOutboundStoreService,
} from '../../src/job-outbound-result-store'
import { createProject } from '../../src/projects'
import { setProjectVisibility } from '../../src/project-sharing'
import { createRuntimeNodeChallenge, registerRuntimeNode } from '../../src/runtime-nodes'
import { searchWorkspaceForUser } from '../../src/search'
import { listReadStateForUser, markChannelReadState } from '../../src/read-state'
import {
  channels,
  channelParticipants,
  messageArtifactReferences,
  messages,
  tasks,
  workspaceMemberships,
} from '../../src/schema'
import { enqueueTaskSubmission, type TaskSubmissionInput } from '../../src/task-submissions'
import { createTask } from '../../src/tasks'
import { createWorkspaceWithOwner, removeWorkspaceMembership } from '../../src/workspaces'

/**
 * Two-connection proofs for the #1217 outbound authority (#1216 grants). Each test parks
 * one party on its own pooled connection and runs the other party beside it, so the order
 * is decided by locks, not by timing alone. Every fixture is disposable.
 *
 * - A publication whose grant expires while its write is parked commits nothing, and the
 *   Task still completes: the decision is judged again at the write instant.
 * - A revocation that arrives while a reader is parked waits for the read. The read is
 *   ordered before the revocation, and the next read hides the publication.
 */

const url = process.env.DATABASE_URL
const profile = { id: `prf_${'0'.repeat(25)}1`, version: `pfv_${'0'.repeat(25)}1`, revision: 0 }
const CHECKSUM = 'c'.repeat(64)

function eventFor(messageId: string, workspaceSequence: number) {
  return {
    aggregateId: messageId,
    aggregateType: 'message',
    actor: null,
    correlationId: null,
    eventId: crypto.randomUUID(),
    eventType: 'message.updated',
    occurredAt: new Date(),
    payload: { messageId },
    schemaVersion: 1,
    workspaceSequence,
  }
}

function contentRefEventFor(contentRefId: string, workspaceSequence: number) {
  return {
    ...eventFor(contentRefId, workspaceSequence),
    aggregateId: contentRefId,
    aggregateType: 'content_ref',
    eventType: 'content.availability_changed',
    payload: { contentRefId },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function taggedTransaction<T>(
  database: AgentHqDatabase,
  tag: string,
  run: (transaction: AgentHqTransaction) => Promise<T>
): Promise<T> {
  return database.transaction(async (transaction) => {
    await transaction.execute(sql`select set_config('application_name', ${tag}, true)`)
    return run(transaction)
  })
}

describe.skipIf(!url)('job outbound authority under parked writes and parked reads', () => {
  let connection: DatabaseConnection
  beforeAll(() => {
    connection = createDatabase(url!)
  })
  afterAll(() => connection.close())

  /**
   * A granting workspace with a submitted, not yet completed job and a live artifact; an
   * audience whose owner is the job's original actor, and whose member is the reader.
   */
  async function fixture() {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    const recipient = await createTemporaryUserSession(connection.db, {
      credentialDigest: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace: source } = await createWorkspaceWithOwner(connection.db, {
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
    const channel = await createGroupChannel(connection.db, destination.id, owner.principal, {
      idempotencyKey: crypto.randomUUID(),
      title: 'Audience group',
    })
    await setChannelParticipants(
      connection.db,
      destination.id,
      channel.id,
      owner.principal,
      [owner.principal, { kind: 'user', userId: recipient.principal.userId }],
      channel.version
    )
    const project = await createProject(connection.db, source.id, owner.principal, {
      name: 'Selected project',
      iconKey: 'planning',
    })
    const agent = await createAgent(connection.db, source.id, owner.principal, {
      name: 'Selected Agent',
      profileId: profile.id,
      profileVersion: profile.version,
    })
    const task = await createTask(
      connection.db,
      source.id,
      owner.principal,
      { agentId: agent.id, projectId: project.id, title: 'Outbound job', objective: 'PROMPT' },
      { idempotencyKey: crypto.randomUUID(), requestId: crypto.randomUUID() }
    )
    const encryption = await generateRemoteCommandKeyPair()
    const publicKey = Buffer.from(
      await crypto.subtle.exportKey('raw', encryption.publicKey)
    ).toString('base64url')
    const challenge = await createRuntimeNodeChallenge(connection.db, {
      createdByUserId: owner.principal.userId,
      kind: 'remote_host',
      nonce: crypto.randomUUID(),
      purpose: 'pair',
      workspaceId: source.id,
    })
    const node = await registerRuntimeNode(connection.db, {
      challengeId: challenge.challengeId,
      displayName: 'Selected host',
      keys: [
        {
          algorithm: 'ed25519' as const,
          publicKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),
          role: 'signing' as const,
        },
        { algorithm: 'x25519' as const, publicKey, role: 'command_encryption' as const },
      ],
      kind: 'remote_host',
      ownerUserId: owner.principal.userId,
      platform: 'fixture',
      softwareVersion: '1.0.0',
      workspaceId: source.id,
    })
    const requestId = crypto.randomUUID()
    const keyId = node.keys.find((key) => key.role === 'command_encryption')!.keyId
    const envelope = await sealRemoteContent({
      keyId,
      recipientPublicKey: encryption.publicKey,
      aad: {
        workspaceId: source.id,
        runtimeNodeId: node.id,
        requestId,
        payloadType: 'command.input',
        schemaVersion: 1,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      plaintext: new TextEncoder().encode('CONTEXT'),
    })
    const input: TaskSubmissionInput = {
      runtimeNodeId: node.id,
      queueWhenOffline: false,
      profile,
      envelope,
    }
    await enqueueTaskSubmission(connection.db, source.id, task.id, owner.principal, input, {
      idempotencyKey: 'initial-submission',
      requestId,
      expectedVersion: task.version,
    })
    const artifact = await createArtifact(connection.db, source.id, owner.principal, {
      availability: 'available',
      checksumSha256: CHECKSUM,
      filename: 'result.txt',
      location: { reference: `outputs/${crypto.randomUUID()}`, type: 'object_store' },
      mediaType: 'text/plain',
      sizeBytes: 32,
      sourceArtifactRef: `runtime-output:${crypto.randomUUID()}`,
      sourcePrincipal: { kind: 'system', systemId: 'job-runner' },
    })
    return {
      artifact,
      channel,
      destination,
      /** Registers this job's artifact grant to the audience. `expiresAt` null never expires. */
      async registerGrant(expiresAt: string | null) {
        const grantId = `grant-${crypto.randomUUID()}`
        await registerArtifactReferenceGrant(connection.db, source.id, owner.principal, {
          artifactId: artifact.id,
          audienceWorkspaceId: destination.id,
          checksumSha256: CHECKSUM,
          expiresAt,
          grantId,
          version: artifact.version,
        })
        return grantId
      },
      owner,
      recipient,
      source,
      task,
    }
  }

  type Fixture = Awaited<ReturnType<typeof fixture>>

  /** Completes the job through the production path, naming the artifact, with an optional seam. */
  function completeWith(
    f: Fixture,
    grantId: string,
    summary: string,
    seams: Parameters<typeof completeTaskAndPublishOutboundResult>[6] = {}
  ) {
    return completeTaskAndPublishOutboundResult(
      connection.db,
      f.source.id,
      f.task.id,
      f.owner.principal,
      {
        expectedVersion: f.task.version,
        idempotencyKey: crypto.randomUUID(),
        requestId: crypto.randomUUID(),
      },
      {
        artifact: { artifactId: f.artifact.id, grantId },
        artifactPolicy: 'require',
        channelId: f.channel.id,
        summary,
      },
      seams
    )
  }

  /** The job's messages in the audience channel, as the reader sees the canonical rows. */
  async function jobMessages(f: Fixture) {
    return connection.db
      .select({
        executionRef: messages.executionRef,
        id: messages.id,
        senderKind: messages.senderKind,
        senderSystemId: messages.senderSystemId,
      })
      .from(messages)
      .where(and(eq(messages.channelId, f.channel.id), eq(messages.executionRef, f.task.id)))
  }

  /** The reader's view of one publication: the ids the gate lets this reader see now. */
  async function visibleFor(f: Fixture, messageId: string) {
    const rows = (await jobMessages(f)).filter((row) => row.id === messageId)
    const visible = await filterVisibleJobOutboundRows(
      connection.db as AgentHqDatabase,
      rows,
      f.recipient.principal.userId
    )
    return visible.map((row) => row.id)
  }

  /**
   * Holds the owner's membership row in the granting workspace, on its own pooled connection,
   * so any read that needs that row parks at that statement. `done` settles on release.
   */
  function parkMembership(workspaceId: string, userId: string) {
    let ready!: (pid: number) => void
    const held = new Promise<number>((resolve) => {
      ready = resolve
    })
    let open!: () => void
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    const done = connection.db.transaction(async (transaction) => {
      const [backend] = await transaction.execute(sql`select pg_backend_pid() as pid`)
      await transaction
        .select({ id: workspaceMemberships.id })
        .from(workspaceMemberships)
        .where(
          and(
            eq(workspaceMemberships.workspaceId, workspaceId),
            eq(workspaceMemberships.userId, userId)
          )
        )
        .limit(1)
        .for('update')
      ready(Number((backend as { pid?: unknown } | undefined)?.pid))
      await gate
    })
    return { done, held, release: () => open() }
  }

  /** Holds one channel row on its own pooled connection, so a read that needs it parks there. */
  function parkChannel(channelId: string) {
    let ready!: (pid: number) => void
    const held = new Promise<number>((resolve) => {
      ready = resolve
    })
    let open!: () => void
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    const done = connection.db.transaction(async (transaction) => {
      const [backend] = await transaction.execute(sql`select pg_backend_pid() as pid`)
      await transaction
        .select({ id: channels.id })
        .from(channels)
        .where(eq(channels.id, channelId))
        .limit(1)
        .for('update')
      ready(Number((backend as { pid?: unknown } | undefined)?.pid))
      await gate
    })
    return { done, held, release: () => open() }
  }

  /** Holds a publication row so the final locked read can be raced with revocation. */
  function parkMessage(messageId: string) {
    let ready!: (pid: number) => void
    const held = new Promise<number>((resolve) => {
      ready = resolve
    })
    let open!: () => void
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    const done = connection.db.transaction(async (transaction) => {
      const [backend] = await transaction.execute(sql`select pg_backend_pid() as pid`)
      await transaction
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.id, messageId))
        .limit(1)
        .for('update')
      ready(Number((backend as { pid?: unknown } | undefined)?.pid))
      await gate
    })
    return { done, held, release: () => open() }
  }

  /** Polls until a statement containing `fragment` is queued behind the backend `holderPid`. */
  async function waitQueuedBehind(holderPid: number, fragment: string) {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const [row] = await connection.db.execute(
        sql`select count(*)::int as n from pg_stat_activity as waiter
          where waiter.datname = current_database()
            and waiter.wait_event_type = 'Lock'
            and waiter.query ilike ${`%${fragment}%`}
            and ${holderPid}::int = any(pg_blocking_pids(waiter.pid))`
      )
      if (Number((row as { n?: unknown }).n) > 0) return
      await sleep(20)
    }
    throw new Error(`no "${fragment}" queued behind backend ${holderPid}`)
  }

  async function waitForTaggedLock(tag: string): Promise<string> {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const [row] = await connection.db.execute(
        sql`select query from pg_stat_activity
          where datname = current_database()
            and application_name = ${tag}
            and wait_event_type = 'Lock'
          limit 1`
      )
      if (row) return String((row as { query?: unknown }).query ?? '')
      await sleep(20)
    }
    throw new Error(`no lock wait observed for ${tag}`)
  }

  async function readAgainstParkedRoster<T>(
    f: Fixture,
    messageId: string,
    tag: string,
    read: (database: AgentHqDatabase, rows: Awaited<ReturnType<typeof jobMessages>>) => Promise<T>
  ): Promise<T> {
    const rows = (await jobMessages(f)).filter((row) => row.id === messageId)
    const [currentChannel] = await connection.db
      .select({ version: channels.version })
      .from(channels)
      .where(eq(channels.id, f.channel.id))
    const holderLane = createDatabase(url!)
    const rosterLane = createDatabase(url!)
    const readerLane = createDatabase(url!)
    const held = Promise.withResolvers<number>()
    const release = Promise.withResolvers<void>()
    const holder = holderLane.db.transaction(async (transaction) => {
      const [backend] = await transaction.execute(sql`select pg_backend_pid() as pid`)
      await transaction
        .select({ id: channelParticipants.id })
        .from(channelParticipants)
        .where(
          and(
            eq(channelParticipants.workspaceId, f.destination.id),
            eq(channelParticipants.channelId, f.channel.id),
            eq(channelParticipants.principalKind, 'user'),
            eq(channelParticipants.userId, f.recipient.principal.userId)
          )
        )
        .limit(1)
        .for('update')
      held.resolve(Number((backend as { pid?: unknown } | undefined)?.pid))
      await release.promise
    })
    const holderPid = await held.promise
    let rosterUpdate: Promise<unknown> | undefined
    let readerRead: Promise<T> | undefined
    try {
      rosterUpdate = setChannelParticipants(
        rosterLane.db,
        f.destination.id,
        f.channel.id,
        f.owner.principal,
        [f.owner.principal, { kind: 'user', userId: f.recipient.principal.userId }],
        currentChannel!.version
      )
      await waitQueuedBehind(holderPid, 'channel_participants')
      readerRead = taggedTransaction(readerLane.db, tag, (transaction) =>
        read(transaction as unknown as AgentHqDatabase, rows)
      )
      const query = (await waitForTaggedLock(tag)).toLowerCase()
      expect(query).toContain('channels')
      expect(query).not.toContain('channel_participants')
    } finally {
      release.resolve()
      await Promise.allSettled([holder, rosterUpdate, readerRead])
      await Promise.all([holderLane.close(), rosterLane.close(), readerLane.close()])
    }
    await rosterUpdate
    return readerRead!
  }

  test('a publication admitted by the first judgment is refused by the second when its grant expires while the write is parked', async () => {
    const f = await fixture()
    // Set just before completion, so the first judgment runs inside the grant's lifetime.
    const expiresAt = new Date(Date.now() + 3_000).toISOString()
    const expiresMs = Date.parse(expiresAt)
    const grantId = await f.registerGrant(expiresAt)
    const seam = { advancedPastMs: 0, enteredMs: 0, entries: 0 }
    const outcome = await completeWith(f, grantId, 'PARKED_SUMMARY', {
      beforePublicationWrite: async () => {
        // Reached only when the first judgment admitted publication.
        seam.entries += 1
        seam.enteredMs = Date.now()
        await sleep(Math.max(0, expiresMs + 150 - Date.now()))
        seam.advancedPastMs = Date.now()
      },
    })
    // The first judgment admitted publication: the seam was entered, while the grant was still live.
    expect(seam.entries).toBe(1)
    expect(seam.enteredMs).toBeLessThan(expiresMs)
    // The seam then advanced past expiry...
    expect(seam.advancedPastMs).toBeGreaterThanOrEqual(expiresMs)
    // ...so the second judgment refuses the publication.
    expect(outcome.publication).toMatchObject({
      decision: { action: 'hold', reason: 'grant_expired' },
      messageId: null,
    })
    // Independent task semantics: the Task completes; only the publication is held.
    expect(outcome.task.lifecycleState).toBe('completed')
    const [task] = await connection.db
      .select({ lifecycleState: tasks.lifecycleState })
      .from(tasks)
      .where(eq(tasks.id, f.task.id))
    expect(task!.lifecycleState).toBe('completed')
    // No forbidden publication commits: no message, and no artifact link to one.
    expect(await jobMessages(f)).toEqual([])
    expect(
      await connection.db
        .select({ id: messageArtifactReferences.messageId })
        .from(messageArtifactReferences)
        .where(eq(messageArtifactReferences.artifactId, f.artifact.id))
    ).toEqual([])
  }, 30_000)

  test('a revocation that arrives while a reader is parked waits for the read; the read is ordered before it, and the next read hides the publication', async () => {
    const f = await fixture()
    const grantId = await f.registerGrant(null)
    const published = await completeWith(f, grantId, 'VISIBLE_SUMMARY')
    expect(published.publication).toMatchObject({ decision: { action: 'publish' } })
    const messageId = published.publication.messageId!
    expect(await visibleFor(f, messageId)).toEqual([messageId])

    // The reader parks at its source-membership read, on its own connection.
    const parked = parkMembership(f.source.id, f.owner.principal.userId)
    const holderPid = await parked.held
    // Held outside the try: a failed assertion below cannot leave either promise unsettled.
    let read: Promise<string[]> | undefined
    let revocation: Promise<void> | undefined
    let revocationSettled = false
    try {
      read = visibleFor(f, messageId)
      await waitQueuedBehind(holderPid, 'workspace_memberships')
      // Revocation arrives while the read is parked, and must wait for that read.
      revocation = revokeArtifactReferenceGrant(
        connection.db,
        f.source.id,
        f.owner.principal,
        grantId
      ).then(() => {
        revocationSettled = true
      })
      await sleep(300)
      expect(revocationSettled).toBe(false)
      parked.release()
      // The read returns the publication visible: it is ordered before the revocation.
      expect(await read).toEqual([messageId])
      await revocation
    } finally {
      // Open the gate first, then settle every promise this test started.
      parked.release()
      await Promise.allSettled([read, revocation, parked.done])
    }
    // Once the revocation has committed, no read shows the publication.
    expect(await visibleFor(f, messageId)).toEqual([])
  }, 30_000)

  test('a membership removal that arrives while a reader is parked waits for the read; the read is ordered before it, and the next read hides the publication', async () => {
    const f = await fixture()
    const grantId = await f.registerGrant(null)
    const published = await completeWith(f, grantId, 'MEMBER_SUMMARY')
    const messageId = published.publication.messageId!
    expect(await visibleFor(f, messageId)).toEqual([messageId])

    // The reader holds the recipient's destination membership, then parks at the channel row.
    const parked = parkChannel(f.channel.id)
    const holderPid = await parked.held
    let read: Promise<string[]> | undefined
    let removal: Promise<void> | undefined
    let removalSettled = false
    try {
      read = visibleFor(f, messageId)
      await waitQueuedBehind(holderPid, 'channels')
      removal = removeWorkspaceMembership(
        connection.db as AgentHqDatabase,
        f.destination.id,
        f.recipient.principal
      ).then(() => {
        removalSettled = true
      })
      await sleep(300)
      expect(removalSettled).toBe(false)
      parked.release()
      expect(await read).toEqual([messageId])
      await removal
    } finally {
      parked.release()
      await Promise.allSettled([read, removal, parked.done])
    }
    expect(await visibleFor(f, messageId)).toEqual([])
  }, 30_000)

  test('ContentRefs, encrypted replies, and replicas become unavailable when their publication grant is revoked', async () => {
    const f = await fixture()
    const grantId = await f.registerGrant(null)
    const published = await completeWith(f, grantId, 'CONTENT_REF_SUMMARY')
    const publicationId = published.publication.messageId!
    const rootContentRefId = crypto.randomUUID()
    await createContentRef(connection.db, f.destination.id, f.owner.principal, {
      availability: 'available',
      contentType: 'message_body',
      digestSha256: 'd'.repeat(64),
      id: rootContentRefId,
      keyVersion: 1,
      messageId: publicationId,
      schemaVersion: 1,
      sensitivity: 'restricted',
      storagePolicy: 'local_authority',
      synchronizationPolicy: 'agent_hq_e2ee_sync',
    })

    const replyContentRefId = crypto.randomUUID()
    await createContentRef(connection.db, f.destination.id, f.owner.principal, {
      availability: 'available',
      contentType: 'message_body',
      digestSha256: 'e'.repeat(64),
      id: replyContentRefId,
      keyVersion: 1,
      schemaVersion: 1,
      sensitivity: 'restricted',
      storagePolicy: 'local_authority',
      synchronizationPolicy: 'agent_hq_e2ee_sync',
    })
    const encryptedReply = await createMessage(
      connection.db,
      f.destination.id,
      f.channel.id,
      f.owner.principal,
      {
        bodyContentRefId: replyContentRefId,
        idempotencyKey: crypto.randomUUID(),
        replyToMessageId: publicationId,
        sender: { kind: 'user', userId: f.owner.principal.userId },
        threadRootMessageId: publicationId,
      }
    )
    const replica = await upsertContentReplica(
      connection.db,
      f.destination.id,
      replyContentRefId,
      f.recipient.principal,
      {
        availability: 'available',
        ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA',
        digestSha256: 'e'.repeat(64),
        keyEpochId: crypto.randomUUID(),
        nonce: 'AAAAAAAAAAAAAAAA',
        replicaKind: 'agent_hq_e2ee_sync',
        revision: 1,
        schemaVersion: 1,
      }
    )
    const unthreadedReply = await createMessage(
      connection.db,
      f.destination.id,
      f.channel.id,
      f.owner.principal,
      {
        bodyText: 'Reply target only',
        idempotencyKey: crypto.randomUUID(),
        replyToMessageId: publicationId,
        sender: { kind: 'user', userId: f.owner.principal.userId },
      }
    )

    expect(
      await getContentRefForUser(
        connection.db,
        f.destination.id,
        rootContentRefId,
        f.recipient.principal
      )
    ).not.toBeNull()
    expect(
      await getContentRefForUser(
        connection.db,
        f.destination.id,
        replyContentRefId,
        f.recipient.principal
      )
    ).not.toBeNull()
    expect(
      await listContentReplicasForUser(
        connection.db,
        f.destination.id,
        replyContentRefId,
        f.recipient.principal
      )
    ).toHaveLength(1)
    expect(
      (
        await getMessageForUser(
          connection.db,
          f.destination.id,
          unthreadedReply.id,
          f.recipient.principal
        )
      ).replyToMessageId
    ).toBe(publicationId)
    expect(
      (
        await listMessagesForUser(
          connection.db,
          f.destination.id,
          f.channel.id,
          f.recipient.principal
        )
      ).messages.map((message) => message.id)
    ).toContain(unthreadedReply.id)

    await revokeArtifactReferenceGrant(connection.db, f.source.id, f.owner.principal, grantId)

    expect(
      await getContentRefForUser(
        connection.db,
        f.destination.id,
        rootContentRefId,
        f.recipient.principal
      )
    ).toBeNull()
    expect(
      await getContentRefForUser(
        connection.db,
        f.destination.id,
        replyContentRefId,
        f.recipient.principal
      )
    ).toBeNull()
    await expect(
      listContentReplicasForUser(
        connection.db,
        f.destination.id,
        replyContentRefId,
        f.recipient.principal
      )
    ).rejects.toThrow('Content replica unavailable')
    await expect(
      getMessageForUser(connection.db, f.destination.id, encryptedReply.id, f.recipient.principal)
    ).rejects.toThrow('Message unavailable')
    await expect(
      getMessageForUser(connection.db, f.destination.id, unthreadedReply.id, f.recipient.principal)
    ).rejects.toThrow('Message unavailable')
    const visibleHistory = await listMessagesForUser(
      connection.db,
      f.destination.id,
      f.channel.id,
      f.recipient.principal
    )
    expect(visibleHistory.messages.map((message) => message.id)).not.toContain(publicationId)
    expect(visibleHistory.messages.map((message) => message.id)).not.toContain(encryptedReply.id)
    expect(visibleHistory.messages.map((message) => message.id)).not.toContain(unthreadedReply.id)
    expect(
      visibleHistory.messages.flatMap((message) =>
        message.replyToMessageId ? [message.replyToMessageId] : []
      )
    ).not.toContain(publicationId)
    await expect(
      createMessage(connection.db, f.destination.id, f.channel.id, f.owner.principal, {
        bodyText: 'New reply after revocation',
        idempotencyKey: crypto.randomUUID(),
        replyToMessageId: publicationId,
        sender: { kind: 'user', userId: f.owner.principal.userId },
      })
    ).rejects.toThrow('Message unavailable')
    expect(replica.outcome).toBe('created')
  }, 30_000)

  test('roster updates acquire channel locks before participant rows against bulk history reads', async () => {
    const f = await fixture()
    const grantId = await f.registerGrant(null)
    const published = await completeWith(f, grantId, 'ROSTER_HISTORY_LOCK_SUMMARY')
    const messageId = published.publication.messageId!
    const historyRead = await readAgainstParkedRoster(
      f,
      messageId,
      `adea-1237-history-${crypto.randomUUID()}`,
      (database, rows) => filterVisibleJobOutboundRows(database, rows, f.recipient.principal.userId)
    )
    expect(historyRead).toEqual([])
  }, 30_000)

  test('roster updates acquire channel locks before participant rows against delivery reads', async () => {
    const f = await fixture()
    const grantId = await f.registerGrant(null)
    const published = await completeWith(f, grantId, 'ROSTER_DELIVERY_LOCK_SUMMARY')
    const messageId = published.publication.messageId!
    const deliveryRead = await readAgainstParkedRoster(
      f,
      messageId,
      `adea-1237-deliver-${crypto.randomUUID()}`,
      (database) =>
        createJobOutboundStoreService(database).deliver(
          {
            jobId: f.task.id,
            messageId,
            recipientUserId: f.recipient.principal.userId,
          },
          async () => {}
        )
    )
    expect(deliveryRead).toMatchObject({ action: 'deny' })
  }, 30_000)

  test('concurrent readers and a revocation over shared grants all settle, and none reopens a revoked publication', async () => {
    const f = await fixture()
    const grantId = await f.registerGrant(null)
    const published = await completeWith(f, grantId, 'SHARED_SUMMARY')
    const messageId = published.publication.messageId!
    const reads = Array.from({ length: 6 }, () => visibleFor(f, messageId))
    const revocation = revokeArtifactReferenceGrant(
      connection.db,
      f.source.id,
      f.owner.principal,
      grantId
    )
    const [results] = await Promise.all([Promise.all(reads), revocation])
    // Each read is either before the revocation (visible) or after it (hidden). Nothing else.
    for (const result of results)
      expect([JSON.stringify([messageId]), '[]']).toContain(JSON.stringify(result))
    expect(await visibleFor(f, messageId)).toEqual([])
  }, 30_000)

  test('a missing reference ancestor fails closed', async () => {
    const candidateId = crypto.randomUUID()
    const missingAncestorId = crypto.randomUUID()
    const channelId = crypto.randomUUID()
    const workspaceId = crypto.randomUUID()
    let referenceReads = 0
    const database = {
      select: () => ({
        from: () => ({
          where: async () => {
            referenceReads += 1
            return referenceReads === 1
              ? [
                  {
                    channelId,
                    executionRef: null,
                    id: candidateId,
                    replyToMessageId: missingAncestorId,
                    senderKind: 'user',
                    senderSystemId: null,
                    threadRootMessageId: null,
                    workspaceId,
                  },
                ]
              : []
          },
        }),
      }),
    } as unknown as AgentHqDatabase
    const visible = await filterVisibleMessageRows(
      database,
      [
        {
          executionRef: null,
          id: candidateId,
          senderKind: 'user',
          senderSystemId: null,
        },
      ],
      crypto.randomUUID()
    )
    expect(visible).toEqual([])
    expect(referenceReads).toBe(2)
  })

  test('reference chains allow 64 links and fail closed at 65', async () => {
    const f = await fixture()
    const root = await createMessage(
      connection.db,
      f.destination.id,
      f.channel.id,
      f.owner.principal,
      {
        bodyText: 'Reference boundary root',
        idempotencyKey: crypto.randomUUID(),
        sender: { kind: 'user', userId: f.owner.principal.userId },
      }
    )
    const ids = Array.from({ length: 65 }, () => crypto.randomUUID())
    const chain = await connection.db
      .insert(messages)
      .values(
        ids.map((id, index) => ({
          bodyText: `Reference boundary ${index + 1}`,
          channelId: f.channel.id,
          createPayloadHash: CHECKSUM,
          id,
          idempotencyKey: `reference-boundary-${crypto.randomUUID()}`,
          replyToMessageId: index === 0 ? root.id : ids[index - 1]!,
          senderKind: 'user' as const,
          senderUserId: f.owner.principal.userId,
          workspaceId: f.destination.id,
        }))
      )
      .returning()
    const byId = new Map(chain.map((row) => [row.id, row]))
    const visible = await filterVisibleMessageRows(
      connection.db,
      [byId.get(ids[63])!, byId.get(ids[64])!],
      f.recipient.principal.userId
    )
    expect(visible.map(({ id }) => id)).toEqual([ids[63]])
  }, 30_000)

  test('reply references cannot cross project and channel ownership', async () => {
    const f = await fixture()
    const privateProject = await createProject(connection.db, f.destination.id, f.owner.principal, {
      iconKey: 'private',
      name: `Private ${crypto.randomUUID()}`,
    })
    await setProjectVisibility(
      connection.db,
      f.destination.id,
      privateProject.id,
      f.owner.principal,
      'members'
    )
    const [privateChannel] = await connection.db
      .select()
      .from(channels)
      .where(eq(channels.projectId, privateProject.id))
    const privateParent = await createMessage(
      connection.db,
      f.destination.id,
      privateChannel!.id,
      f.owner.principal,
      {
        bodyText: 'Private project parent',
        idempotencyKey: crypto.randomUUID(),
        sender: { kind: 'user', userId: f.owner.principal.userId },
      }
    )
    const contentRefId = crypto.randomUUID()
    await createContentRef(connection.db, f.destination.id, f.owner.principal, {
      availability: 'available',
      contentType: 'message_body',
      digestSha256: '1'.repeat(64),
      id: contentRefId,
      keyVersion: 1,
      schemaVersion: 1,
      sensitivity: 'restricted',
      storagePolicy: 'local_authority',
      synchronizationPolicy: 'agent_hq_e2ee_sync',
    })
    const publicChild = await createMessage(
      connection.db,
      f.destination.id,
      f.channel.id,
      f.owner.principal,
      {
        bodyContentRefId: contentRefId,
        idempotencyKey: crypto.randomUUID(),
        sender: { kind: 'user', userId: f.owner.principal.userId },
      }
    )
    // Model a legacy/corrupt cross-channel reference that the public write path rejects.
    await connection.db
      .update(messages)
      .set({ replyToMessageId: privateParent.id })
      .where(eq(messages.id, publicChild.id))

    expect(
      await getContentRefForUser(
        connection.db,
        f.destination.id,
        contentRefId,
        f.recipient.principal
      )
    ).toBeNull()
    await expect(
      getMessageForUser(connection.db, f.destination.id, publicChild.id, f.recipient.principal)
    ).rejects.toThrow('Message unavailable')
  }, 30_000)

  test('a grant revoked after the reference read but before the final publication gate stays hidden', async () => {
    const f = await fixture()
    const grantId = await f.registerGrant(null)
    const published = await completeWith(f, grantId, 'FINAL_REFERENCE_GATE')
    const publicationId = published.publication.messageId!
    const contentRefId = crypto.randomUUID()
    await createContentRef(connection.db, f.destination.id, f.owner.principal, {
      availability: 'available',
      contentType: 'message_body',
      digestSha256: '2'.repeat(64),
      id: contentRefId,
      keyVersion: 1,
      schemaVersion: 1,
      sensitivity: 'restricted',
      storagePolicy: 'local_authority',
      synchronizationPolicy: 'agent_hq_e2ee_sync',
    })
    await createMessage(connection.db, f.destination.id, f.channel.id, f.owner.principal, {
      bodyContentRefId: contentRefId,
      idempotencyKey: crypto.randomUUID(),
      replyToMessageId: publicationId,
      sender: { kind: 'user', userId: f.owner.principal.userId },
    })

    const parked = parkMessage(publicationId)
    const holderPid = await parked.held
    let read: Promise<unknown> | undefined
    let revocation: Promise<unknown> | undefined
    try {
      read = getContentRefForUser(
        connection.db,
        f.destination.id,
        contentRefId,
        f.recipient.principal
      )
      await waitQueuedBehind(holderPid, 'for share')
      // The reader has already resolved the ref and reply chain; hold its final publication read.
      revocation = revokeArtifactReferenceGrant(
        connection.db,
        f.source.id,
        f.owner.principal,
        grantId
      )
      await revocation
      parked.release()
      expect(await read).toBeNull()
    } finally {
      parked.release()
      await Promise.allSettled([read, revocation, parked.done])
    }
  }, 30_000)

  async function bareReplyAncestryFixture() {
    const f = await fixture()
    const visibleRoot = await createMessage(
      connection.db,
      f.destination.id,
      f.channel.id,
      f.owner.principal,
      {
        bodyText: 'Visible pre-publication root',
        idempotencyKey: crypto.randomUUID(),
        sender: { kind: 'user', userId: f.owner.principal.userId },
      }
    )
    await markChannelReadState(
      connection.db,
      f.destination.id,
      f.channel.id,
      f.recipient.principal,
      'read'
    )
    const grantId = await f.registerGrant(null)
    const published = await completeWith(f, grantId, 'ANCESTRY_PUBLICATION')
    const publicationId = published.publication.messageId!
    const token = `barechain-${crypto.randomUUID()}`
    const bareB = await createMessage(
      connection.db,
      f.destination.id,
      f.channel.id,
      f.owner.principal,
      {
        bodyText: `SEARCH-${token}-B`,
        idempotencyKey: crypto.randomUUID(),
        mentions: [{ kind: 'user', userId: f.recipient.principal.userId }],
        replyToMessageId: publicationId,
        sender: { kind: 'user', userId: f.owner.principal.userId },
      }
    )
    const bareC = await createMessage(
      connection.db,
      f.destination.id,
      f.channel.id,
      f.owner.principal,
      {
        bodyText: `SEARCH-${token}-C`,
        idempotencyKey: crypto.randomUUID(),
        replyToMessageId: bareB.id,
        sender: { kind: 'user', userId: f.owner.principal.userId },
      }
    )
    const rootedAtBareB = await createMessage(
      connection.db,
      f.destination.id,
      f.channel.id,
      f.owner.principal,
      {
        bodyText: 'Thread rooted at a reply whose parent is hidden',
        idempotencyKey: crypto.randomUUID(),
        replyToMessageId: bareB.id,
        sender: { kind: 'user', userId: f.owner.principal.userId },
        threadRootMessageId: bareB.id,
      }
    )
    const encryptedRefId = crypto.randomUUID()
    await createContentRef(connection.db, f.destination.id, f.owner.principal, {
      availability: 'available',
      contentType: 'message_body',
      digestSha256: 'f'.repeat(64),
      id: encryptedRefId,
      keyVersion: 1,
      schemaVersion: 1,
      sensitivity: 'restricted',
      storagePolicy: 'local_authority',
      synchronizationPolicy: 'agent_hq_e2ee_sync',
    })
    const encryptedBareReply = await createMessage(
      connection.db,
      f.destination.id,
      f.channel.id,
      f.owner.principal,
      {
        bodyContentRefId: encryptedRefId,
        idempotencyKey: crypto.randomUUID(),
        replyToMessageId: publicationId,
        sender: { kind: 'user', userId: f.owner.principal.userId },
      }
    )
    const replica = await upsertContentReplica(
      connection.db,
      f.destination.id,
      encryptedRefId,
      f.recipient.principal,
      {
        availability: 'available',
        ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA',
        digestSha256: 'f'.repeat(64),
        keyEpochId: crypto.randomUUID(),
        nonce: 'AAAAAAAAAAAAAAAA',
        replicaKind: 'agent_hq_e2ee_sync',
        revision: 1,
        schemaVersion: 1,
      }
    )
    return {
      bareB,
      bareC,
      encryptedBareReply,
      encryptedRefId,
      f,
      grantId,
      replica,
      rootedAtBareB,
      token,
      visibleRoot,
    }
  }

  test('ordinary message ContentRefs follow current channel participation for reads, writes and events', async () => {
    const f = await fixture()
    const contentRefId = crypto.randomUUID()
    await createContentRef(connection.db, f.destination.id, f.owner.principal, {
      availability: 'available',
      contentType: 'message_body',
      digestSha256: 'e'.repeat(64),
      id: contentRefId,
      keyVersion: 1,
      schemaVersion: 1,
      sensitivity: 'restricted',
      storagePolicy: 'local_authority',
      synchronizationPolicy: 'agent_hq_e2ee_sync',
    })
    await createMessage(connection.db, f.destination.id, f.channel.id, f.owner.principal, {
      bodyContentRefId: contentRefId,
      idempotencyKey: crypto.randomUUID(),
      sender: { kind: 'user', userId: f.owner.principal.userId },
    })
    const replicaInput = {
      availability: 'available' as const,
      ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA',
      digestSha256: 'e'.repeat(64),
      keyEpochId: crypto.randomUUID(),
      nonce: 'AAAAAAAAAAAAAAAA',
      replicaKind: 'agent_hq_e2ee_sync' as const,
      revision: 1,
      schemaVersion: 1,
    }
    await upsertContentReplica(
      connection.db,
      f.destination.id,
      contentRefId,
      f.recipient.principal,
      replicaInput
    )
    expect(
      await getContentRefForUser(
        connection.db,
        f.destination.id,
        contentRefId,
        f.recipient.principal
      )
    ).not.toBeNull()
    expect(
      await listContentReplicasForUser(
        connection.db,
        f.destination.id,
        contentRefId,
        f.recipient.principal
      )
    ).toHaveLength(1)
    expect(
      (
        await classifyWorkspaceEventsForUser(
          connection.db,
          f.destination.id,
          f.recipient.principal.userId,
          [contentRefEventFor(contentRefId, 1)]
        )
      )?.map(({ kind }) => kind)
    ).toEqual(['deliver'])

    const [channelBeforeRevocation] = await connection.db
      .select({ version: channels.version })
      .from(channels)
      .where(eq(channels.id, f.channel.id))
      .limit(1)
    await setChannelParticipants(
      connection.db,
      f.destination.id,
      f.channel.id,
      f.owner.principal,
      [f.owner.principal],
      channelBeforeRevocation!.version
    )
    expect(
      await getContentRefForUser(
        connection.db,
        f.destination.id,
        contentRefId,
        f.recipient.principal
      )
    ).toBeNull()
    await expect(
      listContentReplicasForUser(
        connection.db,
        f.destination.id,
        contentRefId,
        f.recipient.principal
      )
    ).rejects.toThrow('Content replica unavailable')
    await expect(
      upsertContentReplica(connection.db, f.destination.id, contentRefId, f.recipient.principal, {
        ...replicaInput,
        revision: 2,
      })
    ).rejects.toThrow('Content replica unavailable')
    expect(
      (
        await classifyWorkspaceEventsForUser(
          connection.db,
          f.destination.id,
          f.recipient.principal.userId,
          [contentRefEventFor(contentRefId, 2)]
        )
      )?.map(({ kind }) => kind)
    ).toEqual(['withheld'])
  }, 30_000)

  test('a thread-root-only write requires the root reply ancestry to be visible', async () => {
    const { f, grantId, bareB } = await bareReplyAncestryFixture()
    await revokeArtifactReferenceGrant(connection.db, f.source.id, f.owner.principal, grantId)
    const idempotencyKey = crypto.randomUUID()
    await expect(
      createMessage(connection.db, f.destination.id, f.channel.id, f.owner.principal, {
        bodyText: 'Cannot join a hidden reply-root thread',
        idempotencyKey,
        sender: { kind: 'user', userId: f.owner.principal.userId },
        threadRootMessageId: bareB.id,
      })
    ).rejects.toThrow('Message unavailable')
    expect(
      await connection.db
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.workspaceId, f.destination.id),
            eq(messages.idempotencyKey, idempotencyKey)
          )
        )
    ).toEqual([])
  }, 30_000)

  test('revocation hides bare-reply ancestry from encrypted refs, replicas, message reads and history', async () => {
    const { bareB, bareC, encryptedBareReply, encryptedRefId, f, grantId, replica, rootedAtBareB } =
      await bareReplyAncestryFixture()
    expect(
      await getContentRefForUser(
        connection.db,
        f.destination.id,
        encryptedRefId,
        f.recipient.principal
      )
    ).not.toBeNull()
    expect(
      await listContentReplicasForUser(
        connection.db,
        f.destination.id,
        encryptedRefId,
        f.recipient.principal
      )
    ).toHaveLength(1)

    await revokeArtifactReferenceGrant(connection.db, f.source.id, f.owner.principal, grantId)
    expect(
      await getContentRefForUser(
        connection.db,
        f.destination.id,
        encryptedRefId,
        f.recipient.principal
      )
    ).toBeNull()
    await expect(
      listContentReplicasForUser(
        connection.db,
        f.destination.id,
        encryptedRefId,
        f.recipient.principal
      )
    ).rejects.toThrow('Content replica unavailable')
    for (const messageId of [bareB.id, bareC.id, rootedAtBareB.id, encryptedBareReply.id])
      await expect(
        getMessageForUser(connection.db, f.destination.id, messageId, f.recipient.principal)
      ).rejects.toThrow('Message unavailable')
    const history = await listMessagesForUser(
      connection.db,
      f.destination.id,
      f.channel.id,
      f.recipient.principal
    )
    expect(history.messages.map(({ id }) => id)).not.toEqual(
      expect.arrayContaining([bareB.id, bareC.id, rootedAtBareB.id, encryptedBareReply.id])
    )
    await connection.db
      .update(messages)
      .set({ replyToMessageId: bareC.id })
      .where(eq(messages.id, bareB.id))
    await expect(
      getMessageForUser(connection.db, f.destination.id, bareB.id, f.recipient.principal)
    ).rejects.toThrow('Message unavailable')
    await expect(
      getMessageForUser(connection.db, f.destination.id, bareC.id, f.recipient.principal)
    ).rejects.toThrow('Message unavailable')
    expect(replica.outcome).toBe('created')
  }, 30_000)

  test('search independently hides bare replies after their publication grant is revoked', async () => {
    const { bareB, bareC, f, grantId, token } = await bareReplyAncestryFixture()
    expect(
      (
        await searchWorkspaceForUser(connection.db, f.destination.id, f.recipient.principal, token)
      ).results.map((result) => result.messageId)
    ).toEqual(expect.arrayContaining([bareB.id, bareC.id]))

    await revokeArtifactReferenceGrant(connection.db, f.source.id, f.owner.principal, grantId)
    const searched = await searchWorkspaceForUser(
      connection.db,
      f.destination.id,
      f.recipient.principal,
      token
    )
    expect(searched.results.map((result) => result.messageId)).not.toEqual(
      expect.arrayContaining([bareB.id, bareC.id])
    )
    expect(searched.privateResultsUnavailable).toBe(false)
  }, 30_000)

  test('events independently withhold bare replies after their publication grant is revoked', async () => {
    const { bareB, bareC, encryptedRefId, f, grantId } = await bareReplyAncestryFixture()
    expect(
      (
        await classifyWorkspaceEventsForUser(
          connection.db,
          f.destination.id,
          f.recipient.principal.userId,
          [eventFor(bareB.id, 1), eventFor(bareC.id, 2), contentRefEventFor(encryptedRefId, 3)]
        )
      )?.map(({ kind }) => kind)
    ).toEqual(['deliver', 'deliver', 'deliver'])

    await revokeArtifactReferenceGrant(connection.db, f.source.id, f.owner.principal, grantId)
    expect(
      (
        await classifyWorkspaceEventsForUser(
          connection.db,
          f.destination.id,
          f.recipient.principal.userId,
          [eventFor(bareB.id, 4), eventFor(bareC.id, 5), contentRefEventFor(encryptedRefId, 6)]
        )
      )?.map(({ kind }) => kind)
    ).toEqual(['withheld', 'withheld', 'withheld'])
  }, 30_000)

  test('read-state unread counts exclude revoked bare-reply ancestry', async () => {
    const { f, grantId } = await bareReplyAncestryFixture()
    await revokeArtifactReferenceGrant(connection.db, f.source.id, f.owner.principal, grantId)

    const channelState = (
      await listReadStateForUser(connection.db, f.destination.id, f.recipient.principal)
    ).find(({ channelId }) => channelId === f.channel.id)
    expect(channelState).toMatchObject({
      topLevelUnreadCount: 0,
      threadUnreadCount: 0,
      unread: false,
    })
  }, 30_000)

  test('account workspace summaries exclude revoked bare-reply mentions and unread channels', async () => {
    const { f, grantId } = await bareReplyAncestryFixture()
    await revokeArtifactReferenceGrant(connection.db, f.source.id, f.owner.principal, grantId)

    expect(
      (await accountWorkspaceSummaries(connection.db, f.recipient.principal)).find(
        ({ workspaceId }) => workspaceId === f.destination.id
      )
    ).toMatchObject({ mentions: 0, unreadChannels: 0 })
  }, 30_000)

  test('account inbox unread counts and mentions exclude revoked bare-reply ancestry', async () => {
    const { f, grantId } = await bareReplyAncestryFixture()
    await revokeArtifactReferenceGrant(connection.db, f.source.id, f.owner.principal, grantId)

    expect(
      (await accountConversationInbox(connection.db, f.recipient.principal)).conversations.find(
        ({ id }) => id === f.channel.id
      )
    ).toMatchObject({
      topLevelUnreadCount: 0,
      unread: false,
      unreadMentions: 0,
    })
  }, 30_000)

  test('read-state frontier stops at the newest visible message after revocation', async () => {
    const { f, grantId, visibleRoot } = await bareReplyAncestryFixture()
    await revokeArtifactReferenceGrant(connection.db, f.source.id, f.owner.principal, grantId)

    const channelState = (
      await listReadStateForUser(connection.db, f.destination.id, f.recipient.principal)
    ).find(({ channelId }) => channelId === f.channel.id)
    expect(channelState).toMatchObject({ latestTopLevelSequence: visibleRoot.sequence })
  }, 30_000)

  test('account inbox frontier stops at the newest visible message after revocation', async () => {
    const { f, grantId, visibleRoot } = await bareReplyAncestryFixture()
    await revokeArtifactReferenceGrant(connection.db, f.source.id, f.owner.principal, grantId)

    expect(
      (await accountConversationInbox(connection.db, f.recipient.principal)).conversations.find(
        ({ id }) => id === f.channel.id
      )
    ).toMatchObject({ latestTopLevelSequence: visibleRoot.sequence })
  }, 30_000)

  test('portable export refuses a buffered publication after source authority is revoked', async () => {
    const f = await fixture()
    const grantId = await f.registerGrant(null)
    const published = await completeWith(f, grantId, 'EXPORT_SOURCE_AUTHORITY')
    expect(published.publication.decision.action).toBe('publish')
    const before = await exportPortableWorkspace(connection.db, {
      workspaceId: f.destination.id,
      principal: f.owner.principal,
    })
    expect(before.content.messages.map((message) => message.messageId)).toContain(
      published.publication.messageId!
    )
    await expect(
      exportPortableWorkspace(connection.db, {
        workspaceId: f.destination.id,
        principal: f.owner.principal,
        hooks: {
          beforeStep: async (step) => {
            if (step.name === 'final')
              await connection.db
                .delete(workspaceMemberships)
                .where(
                  and(
                    eq(workspaceMemberships.workspaceId, f.source.id),
                    eq(workspaceMemberships.userId, f.owner.principal.userId)
                  )
                )
          },
        },
      })
    ).rejects.toMatchObject({ code: 'denied' })
    expect(
      await listMessagesForUser(connection.db, f.destination.id, f.channel.id, f.owner.principal)
    ).toMatchObject({ messages: [] })
  }, 30_000)

  test('portable export refuses a buffered publication and reply ancestry after grant revocation', async () => {
    const f = await fixture()
    const grantId = await f.registerGrant(null)
    const published = await completeWith(f, grantId, 'EXPORT_GRANT_AUTHORITY')
    expect(published.publication.decision.action).toBe('publish')
    const reply = await createMessage(
      connection.db,
      f.destination.id,
      f.channel.id,
      f.owner.principal,
      {
        bodyText: 'Reply to exported publication',
        sender: f.owner.principal,
        idempotencyKey: crypto.randomUUID(),
        replyToMessageId: published.publication.messageId!,
      }
    )
    const before = await exportPortableWorkspace(connection.db, {
      workspaceId: f.destination.id,
      principal: f.owner.principal,
    })
    expect(before.content.messages.map((message) => message.messageId)).toContain(reply.id)
    await expect(
      exportPortableWorkspace(connection.db, {
        workspaceId: f.destination.id,
        principal: f.owner.principal,
        hooks: {
          beforeStep: async (step) => {
            if (step.name === 'final')
              await revokeArtifactReferenceGrant(
                connection.db,
                f.source.id,
                f.owner.principal,
                grantId
              )
          },
        },
      })
    ).rejects.toMatchObject({ code: 'denied' })
    const after = await listMessagesForUser(
      connection.db,
      f.destination.id,
      f.channel.id,
      f.owner.principal
    )
    expect(after.messages.map((message) => message.id)).not.toContain(reply.id)
    expect(after.messages.map((message) => message.id)).not.toContain(
      published.publication.messageId!
    )
  }, 30_000)
})
