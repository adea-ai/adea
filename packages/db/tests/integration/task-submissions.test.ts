import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { generateRemoteCommandKeyPair, sealRemoteContent } from '@adea-ai/remote-content'

import { createAgent } from '../../src/agents'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createGroupChannel, createMessage } from '../../src/conversations'
import { createTemporaryUserSession } from '../../src/identity'
import { createProject } from '../../src/projects'
import {
  createRuntimeNodeChallenge,
  registerRuntimeNode,
  revokeRuntimeNode,
  rotateRuntimeNodeKeys,
} from '../../src/runtime-nodes'
import {
  agents,
  commandOutbox,
  contentRefs,
  runtimeNodeKeys,
  runtimeNodes,
  taskExecutionAttempts,
  taskSubmissions,
  tasks,
  workspaceEvents,
} from '../../src/schema'
import {
  enqueueTaskSubmission,
  getTaskSubmissionForUser,
  type TaskSubmissionInput,
} from '../../src/task-submissions'
import { createTask, getTaskForUser, setTaskConversationReferences } from '../../src/tasks'
import { createWorkspaceWithOwner } from '../../src/workspaces'

const url = process.env.DATABASE_URL
const profile = { id: `prf_${'0'.repeat(25)}1`, version: `pfv_${'0'.repeat(25)}1`, revision: 0 }

describe.skipIf(!url)('durable encrypted Task intent', () => {
  let connection: DatabaseConnection
  beforeAll(() => {
    connection = createDatabase(url!)
  })
  afterAll(() => connection.close())

  async function fixture(kind: 'local_device' | 'remote_host' = 'remote_host') {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'Relay fixture',
      owner: owner.principal,
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
        title: 'Delivery intent',
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
      kind,
      nonce: crypto.randomUUID(),
      purpose: 'pair',
      workspaceId: workspace.id,
    })
    const node = await registerRuntimeNode(connection.db, {
      challengeId: challenge.challengeId,
      displayName: 'Selected host',
      keys,
      kind,
      ownerUserId: owner.principal.userId,
      platform: 'fixture',
      softwareVersion: '1.0.0',
      workspaceId: workspace.id,
    })
    const command = {
      idempotencyKey: 'initial-submission',
      requestId: crypto.randomUUID(),
      expectedVersion: task.version,
    }
    const keyId = node.keys.find((key) => key.role === 'command_encryption')!.keyId
    const envelope = await sealRemoteContent({
      keyId,
      recipientPublicKey: encryption.publicKey,
      aad: {
        workspaceId: workspace.id,
        runtimeNodeId: node.id,
        requestId: command.requestId,
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
    const enqueue = (candidate = input, metadata = command) =>
      enqueueTaskSubmission(
        connection.db,
        workspace.id,
        task.id,
        owner.principal,
        candidate,
        metadata
      )
    return { owner, workspace, project, agent, task, node, keys, command, input, envelope, enqueue }
  }

  test('one selected host, immutable profile snapshot, canonical conversation correlation and no false acceptance', async () => {
    const f = await fixture('local_device')
    const channel = await createGroupChannel(connection.db, f.workspace.id, f.owner.principal, {
      idempotencyKey: 'origin',
      title: 'Origin',
    })
    const message = await createMessage(
      connection.db,
      f.workspace.id,
      channel.id,
      f.owner.principal,
      { bodyText: 'PRIVATE_MESSAGE_SENTINEL', idempotencyKey: 'origin', sender: f.owner.principal }
    )
    const linked = await setTaskConversationReferences(
      connection.db,
      f.workspace.id,
      f.task.id,
      f.owner.principal,
      { channelId: channel.id, messageId: message.id },
      { idempotencyKey: 'link', requestId: crypto.randomUUID(), expectedVersion: 1 }
    )
    const result = await f.enqueue(f.input, { ...f.command, expectedVersion: linked.version })
    expect(result).toMatchObject({
      taskId: f.task.id,
      runtimeNodeId: f.node.id,
      locationKind: 'local_device',
      state: 'pending_delivery',
      profile,
      taskVersion: linked.version,
    })
    const [queued] = await connection.db
      .select()
      .from(commandOutbox)
      .where(eq(commandOutbox.workspaceId, f.workspace.id))
    expect(queued!.payload).toMatchObject({
      conversation: { channelId: channel.id, messageId: message.id },
      envelope: f.envelope,
      profile,
    })
    expect(queued!.status).toBe('pending')
    expect(queued!.attempts).toBe(0)
    for (const secret of [
      'PRIVATE_PROMPT_SENTINEL',
      'PRIVATE_CONTEXT_SENTINEL',
      'PRIVATE_MESSAGE_SENTINEL',
    ])
      expect(JSON.stringify(queued)).not.toContain(secret)
    const product = await getTaskForUser(
      connection.db,
      f.workspace.id,
      f.task.id,
      f.owner.principal
    )
    expect(product).toMatchObject({
      lifecycleState: 'created',
      version: linked.version,
      conversation: { channelId: channel.id, messageId: message.id },
    })
    expect(product!.controlPlaneExecutionRef).toBeUndefined()
    expect(
      await connection.db
        .select()
        .from(taskExecutionAttempts)
        .where(eq(taskExecutionAttempts.taskId, f.task.id))
    ).toHaveLength(0)
    const events = await connection.db
      .select()
      .from(workspaceEvents)
      .where(
        and(
          eq(workspaceEvents.workspaceId, f.workspace.id),
          eq(workspaceEvents.eventType, 'task.submission_queued')
        )
      )
    expect(events).toHaveLength(1)
    expect(JSON.stringify(events)).not.toContain('ciphertext')
    expect(JSON.stringify(queued!.payload.controlPlane)).toMatch(/tsk_[0-9A-HJKMNP-TV-Z]{26}/u)
    expect(JSON.stringify(queued!.payload.controlPlane)).toMatch(/agt_[0-9A-HJKMNP-TV-Z]{26}/u)
  })

  test('concurrent duplicate, restarted connection and changed payload converge without a second command', async () => {
    const f = await fixture()
    const results = await Promise.all(Array.from({ length: 8 }, () => f.enqueue()))
    expect(new Set(results.map((row) => row.id)).size).toBe(1)
    const restarted = createDatabase(url!)
    try {
      expect(
        await enqueueTaskSubmission(
          restarted.db,
          f.workspace.id,
          f.task.id,
          f.owner.principal,
          f.input,
          f.command
        )
      ).toEqual(results[0]!)
    } finally {
      await restarted.close()
    }
    await expect(f.enqueue({ ...f.input, queueWhenOffline: true })).rejects.toThrow(
      'idempotency_conflict'
    )
    await expect(f.enqueue(f.input, { ...f.command, idempotencyKey: 'second' })).rejects.toThrow(
      'already_submitted'
    )
    expect(
      await connection.db
        .select()
        .from(commandOutbox)
        .where(eq(commandOutbox.workspaceId, f.workspace.id))
    ).toHaveLength(1)
    expect(
      await getTaskSubmissionForUser(connection.db, f.workspace.id, f.task.id, f.owner.principal)
    ).toEqual(results[0]!)
  })

  test('queueing offline is explicit and never changes the selected node', async () => {
    const f = await fixture()
    await connection.db
      .update(runtimeNodes)
      .set({ lastProofAt: new Date(Date.now() - 600_000) })
      .where(eq(runtimeNodes.id, f.node.id))
    await expect(f.enqueue()).rejects.toThrow('node_offline')
    expect(
      await connection.db
        .select()
        .from(taskSubmissions)
        .where(eq(taskSubmissions.taskId, f.task.id))
    ).toHaveLength(0)
    expect(await f.enqueue({ ...f.input, queueWhenOffline: true })).toMatchObject({
      state: 'queued_for_node',
      runtimeNodeId: f.node.id,
      locationKind: 'remote_host',
    })
  })

  test('denies foreign workspace/principal, stale task/profile revisions, retired or unverified keys, expiry and wrong direction', async () => {
    const f = await fixture()
    const foreign = await fixture()
    await expect(
      enqueueTaskSubmission(
        connection.db,
        f.workspace.id,
        f.task.id,
        foreign.owner.principal,
        f.input,
        f.command
      )
    ).rejects.toThrow('unavailable')
    await expect(
      enqueueTaskSubmission(
        connection.db,
        foreign.workspace.id,
        f.task.id,
        foreign.owner.principal,
        f.input,
        f.command
      )
    ).rejects.toThrow('invalid')
    await expect(f.enqueue(f.input, { ...f.command, expectedVersion: 99 })).rejects.toThrow(
      'version_conflict'
    )
    await expect(f.enqueue({ ...f.input, profile: { ...profile, revision: 99 } })).rejects.toThrow(
      'profile_conflict'
    )
    await expect(
      f.enqueue({
        ...f.input,
        envelope: { ...f.envelope, aad: { ...f.envelope.aad, payloadType: 'execution.result' } },
      })
    ).rejects.toThrow('invalid')
    await expect(
      f.enqueue({
        ...f.input,
        envelope: {
          ...f.envelope,
          aad: { ...f.envelope.aad, expiresAt: new Date(Date.now() - 1000).toISOString() },
        },
      })
    ).rejects.toThrow('expired')
    await connection.db
      .update(runtimeNodeKeys)
      .set({ verifiedAt: null })
      .where(eq(runtimeNodeKeys.id, f.envelope.keyId))
    await expect(f.enqueue()).rejects.toThrow('key_unavailable')
    await connection.db
      .update(runtimeNodeKeys)
      .set({ verifiedAt: new Date(), retiredAt: new Date() })
      .where(eq(runtimeNodeKeys.id, f.envelope.keyId))
    await expect(f.enqueue()).rejects.toThrow('key_unavailable')
    expect(
      await connection.db
        .select()
        .from(commandOutbox)
        .where(eq(commandOutbox.workspaceId, f.workspace.id))
    ).toHaveLength(0)
  })

  test('scope/pin checks serialize with profile changes; original retry preserves its snapshot', async () => {
    const f = await fixture()
    const race = await Promise.allSettled([
      f.enqueue(),
      connection.db
        .update(agents)
        .set({ profileRevision: 1, profileVersion: `pfv_${'0'.repeat(25)}2` })
        .where(eq(agents.id, f.agent.id)),
    ])
    if (race[0]!.status === 'fulfilled') {
      expect(race[0]!.value.profile).toEqual(profile)
      expect((await f.enqueue()).profile).toEqual(profile)
    } else {
      expect(race[0]!.reason.message).toContain('profile_conflict')
      expect(
        await connection.db
          .select()
          .from(taskSubmissions)
          .where(eq(taskSubmissions.taskId, f.task.id))
      ).toHaveLength(0)
    }
  })

  test('rotation/revocation serialize with admission without deadlock or admitting an already-revoked node', async () => {
    const f = await fixture()
    const challenge = await createRuntimeNodeChallenge(connection.db, {
      createdByUserId: f.owner.principal.userId,
      kind: 'remote_host',
      nonce: crypto.randomUUID(),
      purpose: 'rotate',
      runtimeNodeId: f.node.id,
      workspaceId: f.workspace.id,
    })
    const replacements = f.keys.map((key) => ({
      ...key,
      publicKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),
    }))
    const race = await Promise.allSettled([
      f.enqueue(),
      rotateRuntimeNodeKeys(connection.db, {
        challengeId: challenge.challengeId,
        keys: replacements,
        ownerUserId: f.owner.principal.userId,
        runtimeNodeId: f.node.id,
        workspaceId: f.workspace.id,
      }),
    ])
    expect(race[1]!.status).toBe('fulfilled')
    if (race[0]!.status === 'rejected') expect(race[0]!.reason.message).toContain('key_unavailable')
    const revoked = await fixture()
    await revokeRuntimeNode(connection.db, {
      actorUserId: revoked.owner.principal.userId,
      reason: 'revoked',
      runtimeNodeId: revoked.node.id,
      workspaceId: revoked.workspace.id,
    })
    await expect(revoked.enqueue()).rejects.toThrow('unavailable')
  })

  test('commit failure rolls back intent, ciphertext and event together', async () => {
    const f = await fixture()
    const failingDatabase = new Proxy(connection.db, {
      get(target, key, receiver) {
        if (key === 'transaction')
          return (callback: Parameters<typeof connection.db.transaction>[0]) =>
            target.transaction(async (transaction) => {
              await callback(transaction)
              throw new Error('simulated commit failure')
            })
        return Reflect.get(target, key, receiver)
      },
    })
    await expect(
      enqueueTaskSubmission(
        failingDatabase,
        f.workspace.id,
        f.task.id,
        f.owner.principal,
        f.input,
        f.command
      )
    ).rejects.toThrow('simulated commit failure')
    expect(
      await connection.db
        .select()
        .from(taskSubmissions)
        .where(eq(taskSubmissions.taskId, f.task.id))
    ).toHaveLength(0)
    expect(
      await connection.db
        .select()
        .from(commandOutbox)
        .where(eq(commandOutbox.workspaceId, f.workspace.id))
    ).toHaveLength(0)
    expect(
      await connection.db
        .select()
        .from(workspaceEvents)
        .where(
          and(
            eq(workspaceEvents.workspaceId, f.workspace.id),
            eq(workspaceEvents.eventType, 'task.submission_queued')
          )
        )
    ).toHaveLength(0)
    expect((await f.enqueue()).state).toBe('pending_delivery')
  })

  test('identical client idempotency keys in separate workspaces remain independent', async () => {
    const [left, right] = await Promise.all([fixture(), fixture()])
    const [first, second] = await Promise.all([left.enqueue(), right.enqueue()])
    expect(first.id).not.toBe(second.id)
    expect(first.workspaceId).not.toBe(second.workspaceId)
  })

  test('expiry preserves the original identity and cannot silently start a replacement', async () => {
    const f = await fixture()
    const original = await f.enqueue()
    await connection.db
      .update(taskSubmissions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(taskSubmissions.id, original.id))
    expect(
      await getTaskSubmissionForUser(connection.db, f.workspace.id, f.task.id, f.owner.principal)
    ).toMatchObject({ id: original.id, state: 'expired' })
    expect(await f.enqueue()).toMatchObject({ id: original.id, state: 'expired' })
    await expect(
      f.enqueue(f.input, { ...f.command, idempotencyKey: 'replacement' })
    ).rejects.toThrow('already_submitted')
  })

  test('deleting an outbox command cannot erase the original submission identity', async () => {
    const f = await fixture()
    const original = await f.enqueue()
    await expect(
      connection.db
        .delete(commandOutbox)
        .where(eq(commandOutbox.workspaceId, f.workspace.id))
        .execute()
    ).rejects.toThrow()
    expect(await f.enqueue()).toMatchObject({ id: original.id })
  })

  test('an existing execution reference refuses a new initial intent without relay writes', async () => {
    const f = await fixture()
    await connection.db
      .update(tasks)
      .set({ controlPlaneExecutionRef: 'existing-execution' })
      .where(eq(tasks.id, f.task.id))
    await expect(f.enqueue()).rejects.toThrow('unavailable')
    expect(
      await connection.db
        .select()
        .from(commandOutbox)
        .where(eq(commandOutbox.workspaceId, f.workspace.id))
    ).toHaveLength(0)
  })

  test('foreign and mismatched conversation references refuse initial admission', async () => {
    const [f, other] = await Promise.all([fixture(), fixture()])
    const foreign = await createGroupChannel(
      connection.db,
      other.workspace.id,
      other.owner.principal,
      { idempotencyKey: 'foreign', title: 'Foreign' }
    )
    await connection.db.update(tasks).set({ channelId: foreign.id }).where(eq(tasks.id, f.task.id))
    await expect(f.enqueue()).rejects.toThrow('unavailable')
    const channels = await Promise.all(
      ['one', 'two'].map((idempotencyKey) =>
        createGroupChannel(connection.db, f.workspace.id, f.owner.principal, {
          idempotencyKey,
          title: idempotencyKey,
        })
      )
    )
    const message = await createMessage(
      connection.db,
      f.workspace.id,
      channels[1]!.id,
      f.owner.principal,
      { bodyText: 'private', idempotencyKey: 'message', sender: f.owner.principal }
    )
    await connection.db
      .update(tasks)
      .set({ channelId: channels[0]!.id, messageId: message.id })
      .where(eq(tasks.id, f.task.id))
    await expect(f.enqueue()).rejects.toThrow('unavailable')
    expect(
      await connection.db
        .select()
        .from(commandOutbox)
        .where(eq(commandOutbox.workspaceId, f.workspace.id))
    ).toHaveLength(0)
  })

  test('same request racing with different keys yields one intent and a stable conflict', async () => {
    const f = await fixture()
    const second = await createTask(
      connection.db,
      f.workspace.id,
      f.owner.principal,
      { agentId: f.agent.id, projectId: f.project.id, title: 'Second', objective: 'Private' },
      { requestId: crypto.randomUUID(), idempotencyKey: 'second-task' }
    )
    const outcomes = await Promise.allSettled([
      f.enqueue(),
      enqueueTaskSubmission(connection.db, f.workspace.id, second.id, f.owner.principal, f.input, {
        ...f.command,
        idempotencyKey: 'different-key',
      }),
    ])
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    const refused = outcomes.find((outcome) => outcome.status === 'rejected')
    expect(refused?.status === 'rejected' && refused.reason.message).toContain(
      'idempotency_conflict'
    )
  })

  test('an objective reference from another workspace cannot enter the selected host relay', async () => {
    const [f, other] = await Promise.all([fixture(), fixture()])
    const [reference] = await connection.db
      .insert(contentRefs)
      .values({
        workspaceId: other.workspace.id,
        contentType: 'task_objective',
        digestSha256: 'a'.repeat(64),
        sensitivity: 'sensitive',
        storagePolicy: 'local_authority',
        synchronizationPolicy: 'local_only',
        availability: 'available',
        schemaVersion: 1,
        keyVersion: 1,
      })
      .returning({ id: contentRefs.id })
    await connection.db
      .update(tasks)
      .set({ objective: null, objectiveContentRefId: reference!.id })
      .where(eq(tasks.id, f.task.id))
    await expect(f.enqueue()).rejects.toThrow('unavailable')
    expect(
      await connection.db
        .select()
        .from(commandOutbox)
        .where(eq(commandOutbox.workspaceId, f.workspace.id))
    ).toHaveLength(0)
    await connection.db
      .update(contentRefs)
      .set({ workspaceId: f.workspace.id, taskId: f.task.id })
      .where(eq(contentRefs.id, reference!.id))
    expect((await f.enqueue()).state).toBe('pending_delivery')
  })

  test('same workspace/key racing on different Tasks yields one intent and a stable conflict', async () => {
    const f = await fixture()
    const second = await createTask(
      connection.db,
      f.workspace.id,
      f.owner.principal,
      {
        agentId: f.agent.id,
        projectId: f.project.id,
        title: 'Second Task',
        objective: 'Private second objective',
      },
      { requestId: crypto.randomUUID(), idempotencyKey: 'second-task' }
    )
    const outcomes = await Promise.allSettled([
      f.enqueue(),
      enqueueTaskSubmission(
        connection.db,
        f.workspace.id,
        second.id,
        f.owner.principal,
        f.input,
        f.command
      ),
    ])
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    const refused = outcomes.find((outcome) => outcome.status === 'rejected')
    expect(refused?.status === 'rejected' && refused.reason.message).toContain(
      'idempotency_conflict'
    )
    expect(
      await connection.db
        .select()
        .from(commandOutbox)
        .where(eq(commandOutbox.workspaceId, f.workspace.id))
    ).toHaveLength(1)
  })
})
