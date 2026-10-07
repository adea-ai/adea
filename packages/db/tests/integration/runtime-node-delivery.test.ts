import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { and, eq, sql } from 'drizzle-orm'
import { generateRemoteCommandKeyPair, sealRemoteContent } from '@adea-ai/remote-content'
import {
  runtimeNodePullMessage,
  RUNTIME_NODE_PULL_WINDOW_MS,
} from '@adea-ai/types/runtime-node-delivery'

import { createAgent } from '../../src/agents'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createTemporaryUserSession } from '../../src/identity'
import { createProject } from '../../src/projects'
import {
  createRuntimeNodeChallenge,
  registerRuntimeNode,
  revokeRuntimeNode,
  rotateRuntimeNodeKeys,
} from '../../src/runtime-nodes'
import {
  pullRuntimeNodeCommand,
  pruneRuntimeNodeDeliveryRequests,
} from '../../src/runtime-node-delivery'
import {
  agents,
  commandOutbox,
  taskExecutionAttempts,
  taskSubmissions,
  tasks,
  workspaceMemberships,
  runtimeNodeDeliveryRequests,
  runtimeNodeKeys,
  runtimeNodes,
  workspaceEvents,
} from '../../src/schema'
import { enqueueTaskSubmission } from '../../src/task-submissions'
import { createTask } from '../../src/tasks'
import { createWorkspaceWithOwner } from '../../src/workspaces'
import { purgeExpiredTaskSubmissionCiphertext } from '../../src/task-submission-retention'

const publicKey = async (key: CryptoKey) =>
  Buffer.from(await crypto.subtle.exportKey('raw', key)).toString('base64url')

describe.skipIf(!process.env.DATABASE_URL)('authenticated outbound command delivery', () => {
  let connection: DatabaseConnection
  beforeAll(() => {
    connection = createDatabase(process.env.DATABASE_URL!)
  })
  afterAll(() => connection.close())

  async function fixture() {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 300_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'Outbound fixture',
      owner: owner.principal,
    })
    const project = await createProject(connection.db, workspace.id, owner.principal, {
      name: 'Project',
      iconKey: 'planning',
    })
    const profile = { id: `prf_${'0'.repeat(25)}1`, version: `pfv_${'0'.repeat(25)}1`, revision: 0 }
    const agent = await createAgent(connection.db, workspace.id, owner.principal, {
      name: 'Agent',
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
        title: 'Command',
        objective: 'PRIVATE_OBJECTIVE_CANARY',
      },
      { idempotencyKey: crypto.randomUUID(), requestId: crypto.randomUUID() }
    )
    const signing = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify'])
    const encryption = await generateRemoteCommandKeyPair()
    const challenge = await createRuntimeNodeChallenge(connection.db, {
      createdByUserId: owner.principal.userId,
      kind: 'remote_host',
      nonce: crypto.randomUUID(),
      purpose: 'pair',
      workspaceId: workspace.id,
    })
    const node = await registerRuntimeNode(connection.db, {
      challengeId: challenge.challengeId,
      displayName: 'Host',
      keys: [
        { algorithm: 'ed25519', role: 'signing', publicKey: await publicKey(signing.publicKey) },
        {
          algorithm: 'x25519',
          role: 'command_encryption',
          publicKey: await publicKey(encryption.publicKey),
        },
      ],
      kind: 'remote_host',
      ownerUserId: owner.principal.userId,
      platform: 'fixture',
      softwareVersion: '1.0.0',
      workspaceId: workspace.id,
    })
    const requestId = crypto.randomUUID()
    const envelope = await sealRemoteContent({
      keyId: node.keys.find((key) => key.role === 'command_encryption')!.keyId,
      recipientPublicKey: encryption.publicKey,
      aad: {
        workspaceId: workspace.id,
        runtimeNodeId: node.id,
        requestId,
        payloadType: 'command.input',
        schemaVersion: 1,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      },
      plaintext: new TextEncoder().encode('PRIVATE_CONTEXT_CANARY'),
    })
    const submission = await enqueueTaskSubmission(
      connection.db,
      workspace.id,
      task.id,
      owner.principal,
      { runtimeNodeId: node.id, queueWhenOffline: true, profile, envelope },
      { requestId, idempotencyKey: 'start', expectedVersion: task.version }
    )
    const scope = { workspaceId: workspace.id, runtimeNodeId: node.id }
    async function proof(issuedAt = new Date().toISOString()) {
      const input = {
        version: 1 as const,
        keyId: node.keys.find((key) => key.role === 'signing')!.keyId,
        nonce: crypto.randomUUID(),
        issuedAt,
      }
      return {
        ...input,
        signature: Buffer.from(
          await crypto.subtle.sign(
            'Ed25519',
            signing.privateKey,
            new TextEncoder().encode(runtimeNodePullMessage(scope, input))
          )
        ).toString('base64url'),
      }
    }
    const pull = async () => pullRuntimeNodeCommand(connection.db, scope, await proof())
    return { owner, workspace, agent, task, node, envelope, submission, scope, proof, pull }
  }

  test('an expired purged command cannot be redelivered or erase the retained intent', async () => {
    const f = await fixture()
    const first = await f.pull()
    expect(first?.submissionId).toBe(f.submission.id)
    await connection.db
      .update(taskSubmissions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(taskSubmissions.id, f.submission.id))
    expect(await purgeExpiredTaskSubmissionCiphertext(connection.db, f.workspace.id)).toBe(1)
    expect(await f.pull()).toBeNull()
    const [intent] = await connection.db
      .select()
      .from(taskSubmissions)
      .where(eq(taskSubmissions.id, f.submission.id))
    expect(intent!.commandId).toBe(first!.commandId)
    const [outbox] = await connection.db
      .select()
      .from(commandOutbox)
      .where(eq(commandOutbox.id, first!.commandId))
    expect(outbox!.status).toBe('pending')
    expect(outbox!.payload).not.toHaveProperty('envelope')
  })

  test('fresh signatures redeliver one immutable ciphertext identity after reconnect without acceptance', async () => {
    const f = await fixture()
    const first = await f.pull()
    expect(first).toMatchObject({
      commandId: expect.any(String),
      submissionId: f.submission.id,
      taskId: f.task.id,
      requestId: f.envelope.aad.requestId,
      envelope: f.envelope,
    })
    const restarted = createDatabase(process.env.DATABASE_URL!)
    try {
      expect(await pullRuntimeNodeCommand(restarted.db, f.scope, await f.proof())).toEqual(first)
    } finally {
      await restarted.close()
    }
    expect(JSON.stringify(first)).not.toContain('PRIVATE_')
    expect(JSON.stringify(first)).not.toContain('actorUserId')
    expect(
      (
        await connection.db
          .select()
          .from(commandOutbox)
          .where(eq(commandOutbox.workspaceId, f.workspace.id))
      )[0]
    ).toMatchObject({ status: 'pending', attempts: 0, deliveredAt: null })
    expect(
      (await connection.db.select().from(tasks).where(eq(tasks.id, f.task.id)))[0]
    ).toMatchObject({ version: 1, lifecycleState: 'created', controlPlaneExecutionRef: null })
    expect(
      await connection.db
        .select()
        .from(taskExecutionAttempts)
        .where(eq(taskExecutionAttempts.taskId, f.task.id))
    ).toHaveLength(0)
  })

  test('replay is atomic and scope, key and expiry failures cannot release ciphertext', async () => {
    const f = await fixture()
    const input = await f.proof()
    const results = await Promise.allSettled([
      pullRuntimeNodeCommand(connection.db, f.scope, input),
      pullRuntimeNodeCommand(connection.db, f.scope, input),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    await expect(
      pullRuntimeNodeCommand(
        connection.db,
        { ...f.scope, workspaceId: crypto.randomUUID() },
        await f.proof()
      )
    ).rejects.toMatchObject({ code: 'unavailable' })
    await expect(
      pullRuntimeNodeCommand(connection.db, f.scope, {
        ...(await f.proof()),
        keyId: crypto.randomUUID(),
      })
    ).rejects.toMatchObject({ code: 'unavailable' })
    await expect(
      pullRuntimeNodeCommand(
        connection.db,
        f.scope,
        await f.proof(new Date(Date.now() - 121_000).toISOString())
      )
    ).rejects.toMatchObject({ code: 'unavailable' })
    await expect(
      pullRuntimeNodeCommand(
        connection.db,
        f.scope,
        await f.proof(new Date(Date.now() + 31_000).toISOString())
      )
    ).rejects.toMatchObject({ code: 'unavailable' })
    await revokeRuntimeNode(connection.db, {
      runtimeNodeId: f.node.id,
      workspaceId: f.workspace.id,
      actorUserId: f.owner.principal.userId,
      reason: 'Revoke',
    })
    await expect(f.pull()).rejects.toMatchObject({ code: 'unavailable' })
  })

  test('an old but valid signed request retains rate accounting beyond its remaining replay window', async () => {
    const f = await fixture()
    // Keep less than one full rate window, but enough validity for hosted DB admission.
    // A one-second remainder expired during real Neon round trips; rejection was correct.
    const proof = await f.proof(
      new Date(Date.now() - (RUNTIME_NODE_PULL_WINDOW_MS - 30_000)).toISOString()
    )
    expect(await pullRuntimeNodeCommand(connection.db, f.scope, proof)).not.toBeNull()
    const [request] = await connection.db
      .select()
      .from(runtimeNodeDeliveryRequests)
      .where(eq(runtimeNodeDeliveryRequests.nonce, proof.nonce))
    expect(request!.expiresAt.getTime() - request!.createdAt.getTime()).toBeGreaterThanOrEqual(
      60_000
    )
    expect(request!.expiresAt.getTime()).toBeGreaterThan(
      Date.parse(proof.issuedAt) + RUNTIME_NODE_PULL_WINDOW_MS
    )
  })

  test('a pull waiting on another transaction starts rate accounting when admitted', async () => {
    const f = await fixture()
    const waiting = await connection.db.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`adea-node-pull:${f.node.id}`}, 0))`
      )
      const input = await f.proof()
      const pending = pullRuntimeNodeCommand(connection.db, f.scope, input)
      // Observe the real lock wait before releasing it; no fixed sleep guesses the schedule.
      let blocked = false
      for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
        const rows = await transaction.execute(
          sql`select pid from pg_stat_activity where wait_event = 'advisory' and datname = current_database()`
        )
        blocked = rows.length > 0
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(blocked).toBe(true)
      return { pending, nonce: input.nonce, releasedAt: Date.now() }
    })
    expect(await waiting.pending).not.toBeNull()
    const [request] = await connection.db
      .select()
      .from(runtimeNodeDeliveryRequests)
      .where(eq(runtimeNodeDeliveryRequests.nonce, waiting.nonce))
    expect(request!.createdAt.getTime()).toBeGreaterThanOrEqual(waiting.releasedAt)
  })

  test('an authenticated outbound pull publishes node liveness with a node actor, not a user session', async () => {
    const f = await fixture()
    await connection.db
      .update(runtimeNodes)
      .set({ lastProofAt: new Date(Date.now() - 600_000) })
      .where(eq(runtimeNodes.id, f.node.id))
    expect(await f.pull()).not.toBeNull()
    const [node] = await connection.db
      .select()
      .from(runtimeNodes)
      .where(eq(runtimeNodes.id, f.node.id))
    expect(Date.now() - node!.lastProofAt!.getTime()).toBeLessThan(10_000)
    const events = await connection.db
      .select()
      .from(workspaceEvents)
      .where(eq(workspaceEvents.workspaceId, f.workspace.id))
    const proof = events.find(
      (event) =>
        event.eventType === 'runtime_node.proof_accepted' && event.actorKind === 'runtime_node'
    )
    expect(proof).toMatchObject({ actorId: f.node.id })
    expect(JSON.stringify(proof)).not.toContain('ciphertext')
    expect(proof!.payload.actorUserId).toBeUndefined()
  })

  test('authenticated rate limits survive process replacement and include empty polls', async () => {
    const f = await fixture()
    await connection.db
      .update(taskSubmissions)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(taskSubmissions.id, f.submission.id))
    await connection.db.insert(runtimeNodeDeliveryRequests).values(
      Array.from({ length: 60 }, () => ({
        workspaceId: f.workspace.id,
        runtimeNodeId: f.node.id,
        signingKeyId: f.node.keys.find((key) => key.role === 'signing')!.keyId,
        nonce: crypto.randomUUID(),
        expiresAt: new Date(Date.now() + 120_000),
      }))
    )
    await expect(f.pull()).rejects.toMatchObject({ code: 'rate_limited' })
    await connection.db
      .update(runtimeNodeDeliveryRequests)
      .set({ createdAt: new Date(Date.now() - 61_000) })
      .where(eq(runtimeNodeDeliveryRequests.runtimeNodeId, f.node.id))
    expect(await f.pull()).toBeNull()
  })

  test('bounded nonce cleanup retains unexpired proof/rate records', async () => {
    const f = await fixture()
    await f.pull()
    const stale = await connection.db
      .insert(runtimeNodeDeliveryRequests)
      .values({
        workspaceId: f.workspace.id,
        runtimeNodeId: f.node.id,
        signingKeyId: f.node.keys.find((key) => key.role === 'signing')!.keyId,
        nonce: crypto.randomUUID(),
        createdAt: new Date(Date.now() - 180_000),
        expiresAt: new Date(Date.now() - 1),
      })
      .returning()
    await pruneRuntimeNodeDeliveryRequests(connection.db, 1)
    expect(
      await connection.db
        .select()
        .from(runtimeNodeDeliveryRequests)
        .where(eq(runtimeNodeDeliveryRequests.id, stale[0]!.id))
    ).toHaveLength(0)
    expect(
      await connection.db
        .select()
        .from(runtimeNodeDeliveryRequests)
        .where(eq(runtimeNodeDeliveryRequests.runtimeNodeId, f.node.id))
    ).toHaveLength(1)
    await expect(pruneRuntimeNodeDeliveryRequests(connection.db, 1001)).rejects.toThrow()
  })

  test('legacy submission authority is recovered only from its exact audit event', async () => {
    const f = await fixture()
    const migration = await Bun.file(
      new URL('../../drizzle/0037_runtime-node-delivery.sql', import.meta.url)
    ).text()
    const backfill = migration
      .split('--> statement-breakpoint')
      .find((statement) => statement.includes('UPDATE "app"."task_submissions" AS submission'))!
    await connection.db
      .update(taskSubmissions)
      .set({ actorUserId: null })
      .where(eq(taskSubmissions.id, f.submission.id))
    expect(await f.pull()).toBeNull()
    await connection.db.execute(sql.raw(backfill))
    expect(
      (
        await connection.db
          .select()
          .from(taskSubmissions)
          .where(eq(taskSubmissions.id, f.submission.id))
      )[0]!.actorUserId
    ).toBe(f.owner.principal.userId)
    expect(await f.pull()).not.toBeNull()
    await connection.db
      .update(taskSubmissions)
      .set({ actorUserId: null })
      .where(eq(taskSubmissions.id, f.submission.id))
    // Model legacy queue-audit retention: the current owner is never substituted.
    await connection.db
      .delete(workspaceEvents)
      .where(
        and(
          eq(workspaceEvents.workspaceId, f.workspace.id),
          eq(workspaceEvents.eventType, 'task.submission_queued')
        )
      )
    await connection.db.execute(sql.raw(backfill))
    expect(await f.pull()).toBeNull()
  })

  test('encryption rotation retains only admitted ciphertext while retired signing keys stop authenticating', async () => {
    const f = await fixture()
    const replacement = await generateRemoteCommandKeyPair()
    const challenge = await createRuntimeNodeChallenge(connection.db, {
      createdByUserId: f.owner.principal.userId,
      kind: 'remote_host',
      nonce: crypto.randomUUID(),
      purpose: 'rotate',
      workspaceId: f.workspace.id,
      runtimeNodeId: f.node.id,
    })
    await rotateRuntimeNodeKeys(connection.db, {
      challengeId: challenge.challengeId,
      ownerUserId: f.owner.principal.userId,
      runtimeNodeId: f.node.id,
      workspaceId: f.workspace.id,
      keys: [
        {
          algorithm: 'ed25519',
          role: 'signing',
          publicKey: f.node.keys.find((key) => key.role === 'signing')!.publicKey,
        },
        {
          algorithm: 'x25519',
          role: 'command_encryption',
          publicKey: await publicKey(replacement.publicKey),
        },
      ],
    })
    expect(await f.pull()).toMatchObject({ submissionId: f.submission.id, envelope: f.envelope })
    await connection.db
      .update(runtimeNodeKeys)
      .set({ retiredAt: new Date() })
      .where(eq(runtimeNodeKeys.id, f.node.keys.find((key) => key.role === 'signing')!.keyId))
    await expect(f.pull()).rejects.toMatchObject({ code: 'unavailable' })
  })

  test('revoked submitter, changed profile/task and expired intent are withheld rather than silently replaced', async () => {
    const f = await fixture()
    await connection.db
      .update(workspaceMemberships)
      .set({ role: 'member' })
      .where(eq(workspaceMemberships.userId, f.owner.principal.userId))
    expect(await f.pull()).toBeNull()
    await connection.db
      .update(workspaceMemberships)
      .set({ role: 'owner' })
      .where(eq(workspaceMemberships.userId, f.owner.principal.userId))
    await connection.db.update(agents).set({ profileRevision: 1 }).where(eq(agents.id, f.agent.id))
    expect(await f.pull()).toBeNull()
    await connection.db.update(agents).set({ profileRevision: 0 }).where(eq(agents.id, f.agent.id))
    await connection.db.update(tasks).set({ version: 2 }).where(eq(tasks.id, f.task.id))
    expect(await f.pull()).toBeNull()
    await connection.db.update(tasks).set({ version: 1 }).where(eq(tasks.id, f.task.id))
    await connection.db
      .update(taskSubmissions)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(taskSubmissions.id, f.submission.id))
    expect(await f.pull()).toBeNull()
  })
})
