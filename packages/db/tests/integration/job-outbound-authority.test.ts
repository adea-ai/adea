import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { and, eq, sql } from 'drizzle-orm'

import { generateRemoteCommandKeyPair, sealRemoteContent } from '@adea-ai/remote-content'

import { createAgent } from '../../src/agents'
import { createArtifact } from '../../src/artifacts'
import {
  registerArtifactReferenceGrant,
  revokeArtifactReferenceGrant,
} from '../../src/artifact-reference-grants'
import { createDatabase, type AgentHqDatabase, type DatabaseConnection } from '../../src/connection'
import { createGroupChannel, setChannelParticipants } from '../../src/conversations'
import { createTemporaryUserSession } from '../../src/identity'
import { filterVisibleJobOutboundRows } from '../../src/job-outbound-read'
import { completeTaskAndPublishOutboundResult } from '../../src/job-outbound-result-store'
import { createProject } from '../../src/projects'
import { createRuntimeNodeChallenge, registerRuntimeNode } from '../../src/runtime-nodes'
import { messageArtifactReferences, messages, tasks, workspaceMemberships } from '../../src/schema'
import { enqueueTaskSubmission, type TaskSubmissionInput } from '../../src/task-submissions'
import { createTask } from '../../src/tasks'
import { createWorkspaceWithOwner } from '../../src/workspaces'

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
  async function fixture(grantExpiresAt: string | null) {
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
    const grantId = `grant-${crypto.randomUUID()}`
    await registerArtifactReferenceGrant(connection.db, source.id, owner.principal, {
      artifactId: artifact.id,
      audienceWorkspaceId: destination.id,
      checksumSha256: CHECKSUM,
      expiresAt: grantExpiresAt,
      grantId,
      version: artifact.version,
    })
    return {
      artifact,
      channel,
      destination,
      grantId,
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
        artifact: { artifactId: f.artifact.id, grantId: f.grantId },
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

  test('a publication whose grant expires while its write is parked commits nothing, and the Task still completes', async () => {
    const expiresAt = new Date(Date.now() + 1_500).toISOString()
    const f = await fixture(expiresAt)
    const outcome = await completeWith(f, 'PARKED_SUMMARY', {
      // The write is judged, then parked past the grant's expiry, then committed or held.
      beforePublicationWrite: async () => {
        await sleep(Math.max(0, Date.parse(expiresAt) + 150 - Date.now()))
      },
    })
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
    const f = await fixture(null)
    const published = await completeWith(f, 'VISIBLE_SUMMARY')
    expect(published.publication).toMatchObject({ decision: { action: 'publish' } })
    const messageId = published.publication.messageId!
    expect(await visibleFor(f, messageId)).toEqual([messageId])

    // The reader parks at its source-membership read, on its own connection.
    const parked = parkMembership(f.source.id, f.owner.principal.userId)
    const holderPid = await parked.held
    let revocationSettled = false
    try {
      const read = visibleFor(f, messageId)
      await waitQueuedBehind(holderPid, 'workspace_memberships')
      // Revocation arrives while the read is parked, and must wait for that read.
      const revocation = revokeArtifactReferenceGrant(
        connection.db,
        f.source.id,
        f.owner.principal,
        f.grantId
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
      parked.release()
      await parked.done.catch(() => {})
    }
    // Once the revocation has committed, no read shows the publication.
    expect(await visibleFor(f, messageId)).toEqual([])
  }, 30_000)

  test('concurrent readers and a revocation over shared grants all settle, and none reopens a revoked publication', async () => {
    const f = await fixture(null)
    const published = await completeWith(f, 'SHARED_SUMMARY')
    const messageId = published.publication.messageId!
    const reads = Array.from({ length: 6 }, () => visibleFor(f, messageId))
    const revocation = revokeArtifactReferenceGrant(
      connection.db,
      f.source.id,
      f.owner.principal,
      f.grantId
    )
    const [results] = await Promise.all([Promise.all(reads), revocation])
    // Each read is either before the revocation (visible) or after it (hidden). Nothing else.
    for (const result of results)
      expect([JSON.stringify([messageId]), '[]']).toContain(JSON.stringify(result))
    expect(await visibleFor(f, messageId)).toEqual([])
  }, 30_000)
})
