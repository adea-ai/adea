/**
 * Remote relay command/event contract conformance — Adea #38/#39/#40/#187.
 *
 * This suite qualifies the relay command/event and execution-admission
 * contracts that already ship in this repository. It adds no relay, outbox,
 * inbox, event consumer or state machine of its own: every durable effect it
 * observes is produced by the production modules it imports, and every refusal
 * it asserts is a refusal those modules already return. Where a required
 * durable fact has no producer yet, the case records that absence as a store
 * gate instead of inventing a substitute.
 *
 * Each case is one of three proof classes, and the evidence document
 * (`docs/evidence/m18-remote-relay-contract-qualification.md`) lists them
 * case by case:
 *
 * - durable integration proof: the assertion reads committed rows in a real
 *   PostgreSQL instance that production code wrote;
 * - contract qualification: the assertion exercises a frozen pure contract
 *   (the execution-admission policy, the public-envelope projection, the
 *   durable event contract) with fixtures and proves no durable effect;
 * - store gate: the case proves the durable store can or cannot express the
 *   required fact. A gate is a recorded gap, not a passing behaviour.
 *
 * The five original W7 resource-lifecycle paths are out of scope here: this
 * file touches no resource, lease, workspace-deletion or retention path.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { eq, isTable } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { getTableColumns } from 'drizzle-orm/utils'
import { generateRemoteCommandKeyPair, sealRemoteContent } from '@adea-ai/remote-content'
import {
  decideExecutionLocation,
  decideExecutionProfileAdmission,
  executionLocationBlockers,
  executionProfileBlockers,
  resolveExecutionRetry,
  type AgentExecutionIdentity,
  type AgentProfileExecutionReadModel,
  type ExecutionLocationAttempt,
  type ExecutionLocationAttemptScope,
  type ExecutionLocationBlocker,
  type ExecutionLocationPolicyInput,
  type ExecutionLocationProvenance,
  type ExecutionProfilePin,
  type ExecutionProfileState,
  type RuntimeNodeExecutionIdentity,
  type RuntimeNodeExecutionReadModel,
} from '@adea-ai/types'
import { runtimeNodePullMessage } from '@adea-ai/types/runtime-node-delivery'

import { projectControlPlaneExecutionEvent } from '../../../../apps/web/src/server/control-plane-events'
import { createAgent } from '../../src/agents'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import {
  assertCloudSafeEventPayload,
  resolveWorkspaceEventContract,
} from '../../src/event-contract'
import { listWorkspaceEventsAfter, workspaceEventWindow } from '../../src/event-log'
import { createTemporaryUserSession } from '../../src/identity'
import { archiveProject, createProject } from '../../src/projects'
import { pullRuntimeNodeCommand } from '../../src/runtime-node-delivery'
import { createRuntimeNodeChallenge, registerRuntimeNode } from '../../src/runtime-nodes'
import * as schemaIndex from '../../src/schema'
import {
  agents,
  commandOutbox,
  eventInbox,
  projects,
  runtimeNodeDeliveryRequests,
  runtimeNodes,
  taskExecutionAttempts,
  taskSubmissions,
  tasks,
  workspaceEvents,
  workspaces,
} from '../../src/schema'
import { enqueueTaskSubmission, getTaskSubmissionForUser } from '../../src/task-submissions'
import { createTask, getTaskForUser } from '../../src/tasks'
import { appendWorkspaceEvent } from '../../src/transactions'
import { createWorkspaceWithOwner } from '../../src/workspaces'

const url = process.env.DATABASE_URL
const profile = { id: `prf_${'0'.repeat(25)}1`, version: `pfv_${'0'.repeat(25)}1`, revision: 0 }
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * A canonical opaque identifier in the public Control Plane grammar. The
 * durable source-qualified identifiers the fixture reads back use the same
 * grammar, so the two namespaces are directly comparable.
 */
function opaque(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(26))
  let suffix = ''
  for (const byte of bytes) suffix += CROCKFORD[byte % 32]
  return `${prefix}_${suffix}`
}

/**
 * The pinned public canonical JSON serializer, mirrored for this file's
 * fixtures. The projection re-verifies the source digest with the pinned
 * implementation, so a divergence here surfaces as `payload_mismatch` and
 * fails the suite; it can never make a case pass that the pinned contract
 * would refuse.
 */
function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  const entries = Object.keys(record)
    .toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
  return `{${entries.join(',')}}`
}

const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex')
const encoded = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
const rawPublicKey = async (key: CryptoKey) =>
  Buffer.from(await crypto.subtle.exportKey('raw', key)).toString('base64url')

describe.skipIf(!url)('remote relay command/event contract conformance', () => {
  let connection: DatabaseConnection
  beforeAll(() => {
    connection = createDatabase(url!)
  })
  afterAll(() => connection.close())

  /**
   * One isolated relay fixture: its own tenant, project, Agent, Task, paired
   * host, sealed command envelope and signed pull request. Nothing is shared
   * between cases, so one case's rows can never satisfy another's assertion.
   */
  async function relayFixture(kind: 'local_device' | 'remote_host' = 'remote_host') {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 300_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'Relay conformance',
      owner: owner.principal,
    })
    const project = await createProject(connection.db, workspace.id, owner.principal, {
      name: 'Relay project',
      iconKey: 'planning',
    })
    const agent = await createAgent(connection.db, workspace.id, owner.principal, {
      name: 'Relay Agent',
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
        title: 'Relay task',
        objective: 'PRIVATE_OBJECTIVE_CANARY',
      },
      { idempotencyKey: crypto.randomUUID(), requestId: crypto.randomUUID() }
    )
    const signing = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify'])
    const encryption = await generateRemoteCommandKeyPair()
    const challenge = await createRuntimeNodeChallenge(connection.db, {
      createdByUserId: owner.principal.userId,
      kind,
      nonce: crypto.randomUUID(),
      purpose: 'pair',
      workspaceId: workspace.id,
    })
    const node = await registerRuntimeNode(connection.db, {
      challengeId: challenge.challengeId,
      displayName: 'Relay host',
      keys: [
        {
          algorithm: 'ed25519',
          role: 'signing',
          publicKey: await rawPublicKey(signing.publicKey),
        },
        {
          algorithm: 'x25519',
          role: 'command_encryption',
          publicKey: await rawPublicKey(encryption.publicKey),
        },
      ],
      kind,
      ownerUserId: owner.principal.userId,
      platform: 'fixture',
      softwareVersion: '1.0.0',
      workspaceId: workspace.id,
    })
    const scope = { runtimeNodeId: node.id, workspaceId: workspace.id }
    // A second host of the same tenant with its own key material, so a
    // location mismatch can be exercised inside one workspace.
    const secondSigning = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify'])
    const secondEncryption = await generateRemoteCommandKeyPair()
    const secondChallenge = await createRuntimeNodeChallenge(connection.db, {
      createdByUserId: owner.principal.userId,
      kind,
      nonce: crypto.randomUUID(),
      purpose: 'pair',
      workspaceId: workspace.id,
    })
    const secondNode = await registerRuntimeNode(connection.db, {
      challengeId: secondChallenge.challengeId,
      displayName: 'Second relay host',
      keys: [
        {
          algorithm: 'ed25519',
          role: 'signing',
          publicKey: await rawPublicKey(secondSigning.publicKey),
        },
        {
          algorithm: 'x25519',
          role: 'command_encryption',
          publicKey: await rawPublicKey(secondEncryption.publicKey),
        },
      ],
      kind,
      ownerUserId: owner.principal.userId,
      platform: 'fixture',
      softwareVersion: '1.0.0',
      workspaceId: workspace.id,
    })
    const command = {
      expectedVersion: task.version,
      idempotencyKey: `relay-${crypto.randomUUID()}`,
      requestId: crypto.randomUUID(),
    }
    const envelope = await sealRemoteContent({
      keyId: node.keys.find((key) => key.role === 'command_encryption')!.keyId,
      recipientPublicKey: encryption.publicKey,
      aad: {
        workspaceId: workspace.id,
        runtimeNodeId: node.id,
        requestId: command.requestId,
        payloadType: 'command.input',
        schemaVersion: 1,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      },
      plaintext: new TextEncoder().encode('PRIVATE_CONTEXT_CANARY'),
    })
    /** A second sealed command for the same host under another request id. */
    const seal = async (requestId: string) =>
      sealRemoteContent({
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
    const submit = (candidate = envelope, metadata = command) =>
      enqueueTaskSubmission(
        connection.db,
        workspace.id,
        task.id,
        owner.principal,
        { runtimeNodeId: node.id, queueWhenOffline: true, profile, envelope: candidate },
        metadata
      )
    const proof = async (
      nonce: string = crypto.randomUUID(),
      issuedAt: string = new Date().toISOString()
    ) => {
      const input = {
        issuedAt,
        keyId: node.keys.find((key) => key.role === 'signing')!.keyId,
        nonce,
        version: 1 as const,
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
    const pull = async (nonce?: string, issuedAt?: string) =>
      pullRuntimeNodeCommand(connection.db, scope, await proof(nonce, issuedAt))
    /** A signed pull request for the tenant's second host. */
    const secondProof = async (
      nonce: string = crypto.randomUUID(),
      issuedAt: string = new Date().toISOString()
    ) => {
      const input = {
        issuedAt,
        keyId: secondNode.keys.find((key) => key.role === 'signing')!.keyId,
        nonce,
        version: 1 as const,
      }
      const secondScope = { runtimeNodeId: secondNode.id, workspaceId: workspace.id }
      return {
        ...input,
        signature: Buffer.from(
          await crypto.subtle.sign(
            'Ed25519',
            secondSigning.privateKey,
            new TextEncoder().encode(runtimeNodePullMessage(secondScope, input))
          )
        ).toString('base64url'),
      }
    }
    return {
      agent,
      command,
      envelope,
      kind,
      node,
      owner,
      proof,
      project,
      pull,
      scope,
      seal,
      secondNode,
      secondProof,
      submit,
      task,
      workspace,
    }
  }

  /** The source-qualified Control Plane identities the durable rows carry. */
  async function sourceQualifiedScope(f: Awaited<ReturnType<typeof relayFixture>>) {
    const [workspace] = await connection.db
      .select({ value: workspaces.controlPlaneWorkspaceId })
      .from(workspaces)
      .where(eq(workspaces.id, f.workspace.id))
    const [project] = await connection.db
      .select({ value: projects.controlPlaneProjectId })
      .from(projects)
      .where(eq(projects.id, f.project.id))
    const [task] = await connection.db
      .select({ value: tasks.controlPlaneTaskId })
      .from(tasks)
      .where(eq(tasks.id, f.task.id))
    const [agent] = await connection.db
      .select({ value: agents.controlPlaneAgentId })
      .from(agents)
      .where(eq(agents.id, f.agent.id))
    return {
      agentId: agent!.value,
      executionId: opaque('exe'),
      projectId: project!.value,
      taskId: task!.value,
      workspaceId: workspace!.value,
    }
  }

  /** A public Control Plane execution envelope for the fixture's scope. */
  function relayEnvelope(
    scope: Awaited<ReturnType<typeof sourceQualifiedScope>>,
    options: {
      attemptId?: string
      data?: Record<string, unknown>
      eventId?: string
      eventType?: string
      sequence?: number
    } = {}
  ) {
    const data = options.data ?? { state: 'accepted' }
    return {
      ...scope,
      contractVersion: { major: 1, minor: 0 },
      correlation: { requestId: opaque('req'), traceId: opaque('trc') },
      data,
      eventId: options.eventId ?? opaque('evt'),
      eventType: options.eventType ?? 'execution.accepted',
      occurredAt: new Date().toISOString(),
      payloadHash: digest(data),
      recordedAt: new Date().toISOString(),
      schemaVersion: 1,
      sequence: options.sequence ?? 1,
      ...(options.attemptId === undefined ? {} : { attemptId: options.attemptId }),
    }
  }

  async function readOutbox(f: Awaited<ReturnType<typeof relayFixture>>) {
    const rows = await connection.db
      .select()
      .from(commandOutbox)
      .where(eq(commandOutbox.workspaceId, f.workspace.id))
    expect(rows).toHaveLength(1)
    return rows[0]!
  }

  describe('source-qualified identities', () => {
    test('the queued command carries source-qualified Control Plane identities beside the local ids', async () => {
      const f = await relayFixture()
      await f.submit()
      const outbox = await readOutbox(f)
      const qualified = outbox.payload.controlPlane as Record<string, string>

      expect(Object.keys(qualified).toSorted()).toEqual([
        'agentId',
        'projectId',
        'runtimeNodeRefId',
        'taskId',
        'workspaceId',
      ])
      expect(qualified.workspaceId).toMatch(/^wsp_[0-9A-HJKMNP-TV-Z]{26}$/)
      expect(qualified.projectId).toMatch(/^prj_[0-9A-HJKMNP-TV-Z]{26}$/)
      expect(qualified.taskId).toMatch(/^tsk_[0-9A-HJKMNP-TV-Z]{26}$/)
      expect(qualified.agentId).toMatch(/^agt_[0-9A-HJKMNP-TV-Z]{26}$/)
      expect(qualified.runtimeNodeRefId).toMatch(/^rnr_[0-9A-HJKMNP-TV-Z]{26}$/)
      // The two namespaces never collide: the qualified ids are not the local ids.
      expect(qualified.workspaceId).not.toBe(f.workspace.id)
      expect(qualified.taskId).not.toBe(f.task.id)
      expect(qualified.agentId).not.toBe(f.agent.id)
      expect(qualified.runtimeNodeRefId).toBe(f.node.controlPlaneRuntimeNodeRefId)
      expect(outbox.payload.taskId).toBe(f.task.id)
      expect(outbox.payload.agentId).toBe(f.agent.id)
      expect(outbox.payload.runtimeNodeId).toBe(f.node.id)

      const scope = await sourceQualifiedScope(f)
      expect(scope.workspaceId).toBe(qualified.workspaceId)
      expect(scope.projectId).toBe(qualified.projectId)
      expect(scope.taskId).toBe(qualified.taskId)
      expect(scope.agentId).toBe(qualified.agentId)
    })

    test('the release re-resolves the qualified identity and withholds the command when the mapping moved', async () => {
      const f = await relayFixture()
      await f.submit()
      const released = await f.pull()
      expect(released).not.toBeNull()
      const delivered = released!.controlPlane
      expect(delivered).toEqual((await readOutbox(f)).payload.controlPlane as typeof delivered)

      // The Control Plane project mapping stops being live, so the stored
      // qualified scope no longer resolves and the command must not be released.
      await archiveProject(connection.db, f.workspace.id, f.project.id, f.owner.principal)
      expect(await f.pull()).toBeNull()
      const [outbox] = await connection.db
        .select()
        .from(commandOutbox)
        .where(eq(commandOutbox.workspaceId, f.workspace.id))
      expect(outbox!.status).toBe('pending')
      expect(outbox!.payload).toHaveProperty('envelope')
    })

    test('the durable event inbox qualifies its identity by source, and its key is not tenant scoped', async () => {
      const sourceEventId = opaque('evt')
      await connection.db.insert(eventInbox).values({
        payload: { state: 'accepted' },
        source: 'control-plane',
        sourceEventId,
      })
      // The same source-qualified identity is refused a second time.
      await expect(
        connection.db
          .insert(eventInbox)
          .values({ payload: { state: 'accepted' }, source: 'control-plane', sourceEventId })
          .execute()
      ).rejects.toThrow()
      // The same event id from a different source is a different record.
      await connection.db.insert(eventInbox).values({
        payload: { state: 'accepted' },
        source: 'other-host',
        sourceEventId,
      })
      const rows = await connection.db
        .select()
        .from(eventInbox)
        .where(eq(eventInbox.sourceEventId, sourceEventId))
      expect(rows).toHaveLength(2)

      // Store gate: the durable key is (source, sourceEventId) alone. The table
      // carries no tenant column, so a qualified consumer has to scope the
      // source string itself or migrate the table.
      const config = getTableConfig(eventInbox)
      expect(Object.keys(getTableColumns(eventInbox))).toEqual([
        'id',
        'source',
        'sourceEventId',
        'payload',
        'receivedAt',
        'processedAt',
      ])
      expect(config.foreignKeys).toHaveLength(0)
    })
  })

  describe('duplicate, reordered and replayed relay events', () => {
    test('a repeated release is at-least-once over one identity, and a replayed request is refused', async () => {
      const f = await relayFixture()
      await f.submit()
      const first = await f.pull()
      const second = await f.pull()

      expect(first!.commandId).toBe(second!.commandId)
      expect(first!.submissionId).toBe(second!.submissionId)
      expect(first!.requestId).toBe(second!.requestId)
      expect(first!.envelope).toEqual(second!.envelope)
      expect(
        await connection.db
          .select()
          .from(commandOutbox)
          .where(eq(commandOutbox.workspaceId, f.workspace.id))
      ).toHaveLength(1)
      expect(
        await connection.db
          .select()
          .from(taskSubmissions)
          .where(eq(taskSubmissions.workspaceId, f.workspace.id))
      ).toHaveLength(1)

      // Transport replay of one signed request: refused, and durably recorded once.
      const request = await f.proof()
      await pullRuntimeNodeCommand(connection.db, f.scope, request)
      await expect(pullRuntimeNodeCommand(connection.db, f.scope, request)).rejects.toMatchObject({
        code: 'replayed',
      })
      const ledger = await connection.db
        .select()
        .from(runtimeNodeDeliveryRequests)
        .where(eq(runtimeNodeDeliveryRequests.runtimeNodeId, f.node.id))
      expect(ledger).toHaveLength(3)
      expect(new Set(ledger.map((row) => row.nonce)).size).toBe(3)
    })

    test('the durable log alone cannot suppress a replayed source event', async () => {
      const f = await relayFixture()
      const payload = {
        requestId: crypto.randomUUID(),
        runtimeNodeId: f.node.id,
        sourceEventId: opaque('evt'),
        state: 'accepted',
        submissionId: crypto.randomUUID(),
        taskId: f.task.id,
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await connection.db.transaction(async (transaction) => {
          await appendWorkspaceEvent(transaction, {
            actor: { id: f.node.id, kind: 'runtime_node' },
            eventType: 'task.submission_queued',
            payload,
            workspaceId: f.workspace.id,
          })
        })
      }
      const rows = await connection.db
        .select()
        .from(workspaceEvents)
        .where(eq(workspaceEvents.workspaceId, f.workspace.id))
      const relayed = rows.filter((row) => row.eventType === 'task.submission_queued')
      expect(relayed).toHaveLength(2)
      expect(new Set(relayed.map((row) => row.id)).size).toBe(2)
      expect(new Set(relayed.map((row) => row.workspaceSequence)).size).toBe(2)
      expect(relayed.every((row) => row.payload.sourceEventId === payload.sourceEventId)).toBe(true)

      // Store gate: the only durable key qualified by an external source id is
      // `event_inbox`, and no qualified Control Plane consumer writes it.
      const config = getTableConfig(workspaceEvents)
      expect(config.foreignKeys).toHaveLength(1)
      expect(config.foreignKeys.every((key) => key.reference().foreignTable !== eventInbox)).toBe(
        true
      )
    })

    test('an out-of-order arrival is ordered by its durable commit sequence, not by the producer sequence', async () => {
      const f = await relayFixture()
      const head = (await workspaceEventWindow(connection.db, f.workspace.id)).latest
      for (const relaySequence of [7, 3]) {
        await connection.db.transaction(async (transaction) => {
          await appendWorkspaceEvent(transaction, {
            actor: { id: f.node.id, kind: 'runtime_node' },
            eventType: 'task.submission_queued',
            payload: {
              relaySequence,
              requestId: crypto.randomUUID(),
              runtimeNodeId: f.node.id,
              sourceEventId: opaque('evt'),
              state: 'accepted',
              submissionId: crypto.randomUUID(),
              taskId: f.task.id,
            },
            workspaceId: f.workspace.id,
          })
        })
      }
      const replayed = await listWorkspaceEventsAfter(connection.db, f.workspace.id, 0)
      const relayed = replayed.filter((row) => row.eventType === 'task.submission_queued')
      expect(relayed.map((row) => row.workspaceSequence)).toEqual([head + 1, head + 2])
      expect(relayed.map((row) => row.payload.relaySequence)).toEqual([7, 3])

      // The log's own window is contiguous; it says nothing about the relay
      // stream's own sequence, which survives only as payload metadata.
      expect(await workspaceEventWindow(connection.db, f.workspace.id)).toEqual({
        earliest: 1,
        latest: head + 2,
      })
    })
  })

  describe('timeout after acceptance', () => {
    test('a command already released to the host is not released again after its deadline', async () => {
      const f = await relayFixture()
      const submission = await f.submit()
      expect(submission.state).toBe('pending_delivery')
      const released = await f.pull()
      expect(released!.submissionId).toBe(submission.id)

      await connection.db
        .update(taskSubmissions)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(taskSubmissions.id, submission.id))

      // The deadline passed: the release path refuses to hand the command out
      // again, and it never substitutes a different command.
      expect(await f.pull()).toBeNull()
      expect(
        await connection.db
          .select()
          .from(commandOutbox)
          .where(eq(commandOutbox.workspaceId, f.workspace.id))
      ).toHaveLength(1)
      expect(
        await connection.db
          .select()
          .from(taskSubmissions)
          .where(eq(taskSubmissions.workspaceId, f.workspace.id))
      ).toHaveLength(1)
      expect(
        await getTaskSubmissionForUser(connection.db, f.workspace.id, f.task.id, f.owner.principal)
      ).toMatchObject({ id: submission.id, state: 'expired' })

      // A timeout is not a success and not a cancellation: the canonical Task
      // never moved, and no attempt was recorded.
      const task = await getTaskForUser(connection.db, f.workspace.id, f.task.id, f.owner.principal)
      expect(task!.lifecycleState).toBe('created')
      expect(task!.controlPlaneExecutionRef).toBeUndefined()
      expect(
        await connection.db
          .select()
          .from(taskExecutionAttempts)
          .where(eq(taskExecutionAttempts.taskId, f.task.id))
      ).toHaveLength(0)
      const relayed = await connection.db
        .select()
        .from(workspaceEvents)
        .where(eq(workspaceEvents.workspaceId, f.workspace.id))
      const terminal = relayed.filter((row) =>
        ['task.cancelled', 'task.completed', 'task.in_progress', 'task.in_review'].includes(
          row.eventType
        )
      )
      expect(terminal).toHaveLength(0)
    })

    test('the public relay vocabulary carries a timeout outcome and refuses a contradictory one', async () => {
      const f = await relayFixture()
      const scope = await sourceQualifiedScope(f)

      const timedOut = projectControlPlaneExecutionEvent(
        encoded(
          relayEnvelope(scope, { data: { state: 'timed_out' }, eventType: 'execution.timed_out' })
        ),
        scope
      )
      expect(timedOut.data).toEqual({ state: 'timed_out' })
      expect(
        projectControlPlaneExecutionEvent(
          encoded(
            relayEnvelope(scope, { data: { state: 'timed_out' }, eventType: 'attempt.timed_out' })
          ),
          scope
        ).data
      ).toEqual({ state: 'timed_out' })
      const failure = projectControlPlaneExecutionEvent(
        encoded(
          relayEnvelope(scope, {
            data: { failure: { classification: 'timeout', retryable: true }, state: 'failed' },
            eventType: 'execution.failed',
          })
        ),
        scope
      )
      expect(failure.data).toEqual({
        failure: { classification: 'timeout', retryable: true },
        state: 'failed',
      })

      // A terminal event that contradicts its own phase is refused.
      expect(() =>
        projectControlPlaneExecutionEvent(
          encoded(
            relayEnvelope(scope, {
              data: { state: 'timed_out' },
              eventType: 'execution.completed',
            })
          ),
          scope
        )
      ).toThrow('invalid_projection')

      // Store gate: the durable log has no vocabulary for a timed-out outcome.
      expect(() => resolveWorkspaceEventContract('task.timed_out')).toThrow()
      expect(() => resolveWorkspaceEventContract('task.failed')).toThrow()
      expect(() => resolveWorkspaceEventContract('task.reconciliation_required')).toThrow()
      expect(resolveWorkspaceEventContract('task.submission_queued').aggregateType).toBe('task')
    })
  })

  describe('stale and out-of-order terminal events', () => {
    test('a terminal event that contradicts its phase never reaches the durable log', async () => {
      const f = await relayFixture()
      const scope = await sourceQualifiedScope(f)
      const before = await connection.db
        .select()
        .from(workspaceEvents)
        .where(eq(workspaceEvents.workspaceId, f.workspace.id))

      expect(() =>
        projectControlPlaneExecutionEvent(
          encoded(
            relayEnvelope(scope, {
              data: { state: 'running' },
              eventType: 'execution.completed',
            })
          ),
          scope
        )
      ).toThrow('invalid_projection')

      const after = await connection.db
        .select()
        .from(workspaceEvents)
        .where(eq(workspaceEvents.workspaceId, f.workspace.id))
      expect(after).toEqual(before)
    })

    test('the durable contract lets a host actor record a Task terminal event, and the Task itself does not move', async () => {
      const f = await relayFixture()
      const [appended] = await connection.db.transaction(async (transaction) => [
        await appendWorkspaceEvent(transaction, {
          actor: { id: f.node.id, kind: 'runtime_node' },
          eventType: 'task.completed',
          payload: { requestId: crypto.randomUUID(), taskId: f.task.id },
          workspaceId: f.workspace.id,
        }),
      ])
      const [stored] = await connection.db
        .select()
        .from(workspaceEvents)
        .where(eq(workspaceEvents.id, appended!.eventId))
      expect(stored!.actorKind).toBe('runtime_node')
      expect(stored!.actorId).toBe(f.node.id)
      expect(stored!.aggregateId).toBe(f.task.id)

      // The log is not the Task authority: the canonical Task state is unchanged.
      const task = await getTaskForUser(connection.db, f.workspace.id, f.task.id, f.owner.principal)
      expect(task!.lifecycleState).toBe('created')
      expect(task!.controlPlaneExecutionRef).toBeUndefined()
    })

    test('a stale attempt cannot be told apart from the current one by the decoder', async () => {
      const f = await relayFixture()
      const scope = await sourceQualifiedScope(f)
      const stale = projectControlPlaneExecutionEvent(
        encoded(
          relayEnvelope(scope, {
            attemptId: opaque('att'),
            data: { state: 'completed' },
            eventType: 'execution.completed',
          })
        ),
        scope
      )
      const current = projectControlPlaneExecutionEvent(
        encoded(
          relayEnvelope(scope, {
            attemptId: opaque('att'),
            data: { state: 'completed' },
            eventType: 'execution.completed',
          })
        ),
        scope
      )
      // Both project: the decoder has no attempt binding and no ordering state,
      // so it can neither reject a stale attempt nor detect an inversion.
      expect(stale.attemptId).not.toBe(current.attemptId)
      expect(stale.eventId).not.toBe(current.eventId)
      expect(() =>
        projectControlPlaneExecutionEvent(
          encoded(
            relayEnvelope(scope, {
              data: { state: 'completed' },
              eventType: 'execution.completed',
              sequence: 3,
            })
          ),
          scope
        )
      ).not.toThrow()
    })
  })

  describe('tenant, location and attempt mismatch', () => {
    test('a command scoped to another tenant is never released', async () => {
      const f = await relayFixture()
      const foreign = await relayFixture()
      await f.submit()

      await expect(
        pullRuntimeNodeCommand(
          connection.db,
          { runtimeNodeId: f.node.id, workspaceId: foreign.workspace.id },
          await f.proof()
        )
      ).rejects.toMatchObject({ code: 'unavailable' })
      await expect(
        pullRuntimeNodeCommand(
          connection.db,
          { runtimeNodeId: foreign.node.id, workspaceId: f.workspace.id },
          await foreign.proof()
        )
      ).rejects.toMatchObject({ code: 'unavailable' })

      // The qualified request identity is tenant scoped: the same request id in
      // two tenants is two independent durable intents.
      const [row] = await connection.db
        .select({ requestId: taskSubmissions.requestId })
        .from(taskSubmissions)
        .where(eq(taskSubmissions.workspaceId, f.workspace.id))
      expect(row!.requestId).toBe(f.command.requestId)
      await foreign.submit(await foreign.seal(f.command.requestId), {
        ...foreign.command,
        requestId: f.command.requestId,
      })
      const scoped = await connection.db
        .select()
        .from(taskSubmissions)
        .where(eq(taskSubmissions.requestId, f.command.requestId))
      expect(scoped).toHaveLength(2)
      expect(new Set(scoped.map((entry) => entry.workspaceId)).size).toBe(2)
    })

    test('a command bound to another location is withheld from the host that asks', async () => {
      const f = await relayFixture()
      await f.submit()

      // Rebind the durable intent to a second host of the same tenant. The
      // ciphertext still names the first host, so the release must be withheld.
      await connection.db
        .update(taskSubmissions)
        .set({ runtimeNodeId: f.secondNode.id })
        .where(eq(taskSubmissions.workspaceId, f.workspace.id))

      const released = await pullRuntimeNodeCommand(
        connection.db,
        { runtimeNodeId: f.secondNode.id, workspaceId: f.workspace.id },
        await f.secondProof()
      )
      expect(released).toBeNull()
      // The first host still sees nothing either: the intent no longer names it.
      expect(await f.pull()).toBeNull()
    })

    test('the execution-admission contract refuses a reroute that does not match the attempt', () => {
      const scope: ExecutionLocationAttemptScope = {
        accountId: 'account-1',
        actorId: 'actor-1',
        taskId: 'task-1',
        workspaceId: 'workspace-1',
      }
      const attempt: ExecutionLocationAttempt = {
        attempt: 2,
        profile: {
          id: 'prf_0000000000000000000000001',
          revision: 0,
          version: 'pfv_0000000000000000000000001',
        },
        scope,
        selectedLocation: { kind: 'remote_host', runtimeNodeId: 'node-a' },
      }
      const policy: ExecutionLocationPolicyInput = {
        dataAvailability: {
          channelMessageMetadata: 'available',
          localOnlyContent: 'available',
          synchronizedHistory: 'available',
        },
        localRuntimeNodeId: 'node-local',
        nodes: [
          {
            availability: 'available',
            capabilities: [],
            displayName: 'Node A',
            id: 'node-a',
            kind: 'remote_host',
            observedAt: '2026-10-21T10:00:00.000Z',
            proofAt: '2026-10-21T10:00:00.000Z',
          },
        ],
        now: '2026-10-21T10:00:10.000Z',
        requiredCapabilities: [],
      }

      // A reroute to another location needs an explicit authorization.
      expect(
        resolveExecutionRetry({
          attempt,
          policy,
          requestedLocation: { kind: 'remote_host', runtimeNodeId: 'node-b' },
        })
      ).toMatchObject({ change: 'reroute_requires_authorization', ok: false })

      // The authorization must bind the same attempt number.
      expect(
        resolveExecutionRetry({
          attempt,
          policy,
          requestedLocation: { kind: 'remote_host', runtimeNodeId: 'node-b' },
          rerouteAuthorization: {
            attempt: 1,
            authorizationProof: 'proof-1',
            scope,
            targetLocation: { kind: 'remote_host', runtimeNodeId: 'node-b' },
          },
        })
      ).toMatchObject({ change: 'reroute_authorization_invalid', ok: false })

      // It must bind the same tenant and actor scope.
      expect(
        resolveExecutionRetry({
          attempt,
          policy,
          requestedLocation: { kind: 'remote_host', runtimeNodeId: 'node-b' },
          rerouteAuthorization: {
            attempt: 2,
            authorizationProof: 'proof-1',
            scope: { ...scope, workspaceId: 'workspace-other' },
            targetLocation: { kind: 'remote_host', runtimeNodeId: 'node-b' },
          },
        })
      ).toMatchObject({ change: 'reroute_authorization_invalid', ok: false })

      // It must bind the requested target location.
      expect(
        resolveExecutionRetry({
          attempt,
          policy,
          requestedLocation: { kind: 'remote_host', runtimeNodeId: 'node-b' },
          rerouteAuthorization: {
            attempt: 2,
            authorizationProof: 'proof-1',
            scope,
            targetLocation: { kind: 'remote_host', runtimeNodeId: 'node-c' },
          },
        })
      ).toMatchObject({ change: 'reroute_authorization_invalid', ok: false })

      // A sticky retry keeps the attempt's location and profile pin, and
      // advances the attempt.
      expect(resolveExecutionRetry({ attempt, policy })).toMatchObject({
        admission: { provenance: 'sticky_retry' },
        attempt: { attempt: 3, profile: attempt.profile },
        change: 'sticky_retry',
        ok: true,
      })
    })

    test('the execution-admission contract refuses a location that does not match the node', () => {
      const node: RuntimeNodeExecutionReadModel = {
        availability: 'available',
        capabilities: [],
        displayName: 'Local device',
        id: 'node-local',
        kind: 'local_device',
        observedAt: '2026-10-21T10:00:00.000Z',
        proofAt: '2026-10-21T10:00:00.000Z',
      }
      const policy: ExecutionLocationPolicyInput = {
        dataAvailability: {
          channelMessageMetadata: 'available',
          localOnlyContent: 'available',
          synchronizedHistory: 'available',
        },
        localRuntimeNodeId: 'node-local',
        nodes: [node],
        now: '2026-10-21T10:00:10.000Z',
        requiredCapabilities: [],
      }

      // The selected location's kind must match the node's kind.
      expect(
        decideExecutionLocation({
          ...policy,
          requestedLocation: { kind: 'remote_host', runtimeNodeId: 'node-local' },
        })
      ).toMatchObject({ action: 'block', blocker: 'location_missing' })

      // An unrecognised availability is unknown, and unknown never admits.
      expect(
        decideExecutionLocation({
          ...policy,
          nodes: [{ ...node, availability: 'not-a-status' as never }],
        })
      ).toMatchObject({ action: 'block', blocker: 'location_unknown' })
    })

    test('the durable attempt ledger can express attempt identity, but the relay path writes none', async () => {
      const f = await relayFixture()
      await f.submit()
      await f.pull()

      // The relay path leaves the attempt ledger empty.
      expect(
        await connection.db
          .select()
          .from(taskExecutionAttempts)
          .where(eq(taskExecutionAttempts.taskId, f.task.id))
      ).toHaveLength(0)

      // The store can express one attempt identity per Task attempt number.
      await connection.db.insert(taskExecutionAttempts).values({
        attempt: 1,
        locationKind: 'remote_host',
        runtimeNodeId: f.node.id,
        taskId: f.task.id,
        workspaceId: f.workspace.id,
      })
      await expect(
        connection.db
          .insert(taskExecutionAttempts)
          .values({
            attempt: 1,
            locationKind: 'remote_host',
            runtimeNodeId: f.node.id,
            taskId: f.task.id,
            workspaceId: f.workspace.id,
          })
          .execute()
      ).rejects.toThrow()
      expect(
        await connection.db
          .select()
          .from(taskExecutionAttempts)
          .where(eq(taskExecutionAttempts.taskId, f.task.id))
      ).toHaveLength(1)
    })
  })

  describe('unknown outcomes', () => {
    test('an unknown relay outcome stays bounded metadata and claims no acceptance', async () => {
      const f = await relayFixture()
      const scope = await sourceQualifiedScope(f)

      const reconciliation = projectControlPlaneExecutionEvent(
        encoded(
          relayEnvelope(scope, {
            data: { failure: { classification: 'unknown' }, state: 'reconciliation_required' },
            eventType: 'reconciliation.required',
          })
        ),
        scope
      )
      expect(reconciliation.data).toEqual({
        failure: { classification: 'unknown' },
        state: 'reconciliation_required',
      })
      const unavailable = projectControlPlaneExecutionEvent(
        encoded(
          relayEnvelope(scope, {
            data: { availability: 'unavailable' },
            eventType: 'execution.runtime_unavailable',
          })
        ),
        scope
      )
      expect(unavailable.data).toEqual({ availability: 'unavailable' })

      // Store gate: no durable event type carries an unknown or reconciliation
      // outcome, so the log cannot record that the relay reached an unknown
      // state.
      expect(() => resolveWorkspaceEventContract('task.runtime_unavailable')).toThrow()
      expect(() => resolveWorkspaceEventContract('task.reconciliation_required')).toThrow()
    })

    test('an unknown location never admits an execution', () => {
      const decision = decideExecutionLocation({
        dataAvailability: {
          channelMessageMetadata: 'available',
          localOnlyContent: 'available',
          synchronizedHistory: 'available',
        },
        localRuntimeNodeId: 'node-local',
        nodes: [
          {
            availability: 'unknown',
            capabilities: [],
            displayName: 'Unknown host',
            id: 'node-unknown',
            kind: 'remote_host',
            observedAt: '2026-10-21T10:00:00.000Z',
            proofAt: null,
          },
        ],
        now: '2026-10-21T10:00:10.000Z',
        requiredCapabilities: [],
        requestedLocation: { kind: 'remote_host', runtimeNodeId: 'node-unknown' },
      })
      expect(decision).toMatchObject({ action: 'block', blocker: 'location_unknown' })
    })
  })

  describe('content-leak canaries', () => {
    test('a public envelope carrying private canaries is reduced to bounded metadata', async () => {
      const f = await relayFixture()
      const scope = await sourceQualifiedScope(f)
      const envelope = relayEnvelope(scope, {
        data: {
          contextPackage: { body: 'PRIVATE_CONTEXT_CANARY' },
          prompt: 'PRIVATE_PROMPT_CANARY',
          provider: { content: 'PRIVATE_PROVIDER_CANARY' },
          response: 'PRIVATE_RESPONSE_CANARY',
          resultReference: 'file:///PRIVATE_NATIVE_PATH_CANARY',
          state: 'completed',
        },
        eventType: 'execution.completed',
      })
      const projected = projectControlPlaneExecutionEvent(encoded(envelope), scope)
      expect(projected.data).toEqual({ state: 'completed' })
      expect(JSON.stringify(projected)).not.toContain('PRIVATE_')
      expect(Object.isFrozen(projected)).toBe(true)
      expect(Object.isFrozen(projected.data)).toBe(true)
    })

    test('the durable log refuses the raw envelope and accepts only the projected metadata', async () => {
      const f = await relayFixture()
      const scope = await sourceQualifiedScope(f)
      const envelope = relayEnvelope(scope, {
        data: {
          prompt: 'PRIVATE_PROMPT_CANARY',
          provider: { content: 'PRIVATE_PROVIDER_CANARY' },
          state: 'completed',
        },
        eventType: 'execution.completed',
      })
      const projected = projectControlPlaneExecutionEvent(encoded(envelope), scope)

      // The raw envelope cannot enter the durable log.
      expect(() =>
        assertCloudSafeEventPayload('task.submission_queued', {
          prompt: 'PRIVATE_PROMPT_CANARY',
          requestId: crypto.randomUUID(),
          runtimeNodeId: f.node.id,
          sourceEventId: envelope.eventId,
          state: 'completed',
          submissionId: crypto.randomUUID(),
          taskId: f.task.id,
        })
      ).toThrow()
      await expect(
        connection.db.transaction(async (transaction) => {
          await appendWorkspaceEvent(transaction, {
            actor: { id: f.node.id, kind: 'runtime_node' },
            eventType: 'task.submission_queued',
            payload: {
              prompt: 'PRIVATE_PROMPT_CANARY',
              requestId: crypto.randomUUID(),
              runtimeNodeId: f.node.id,
              sourceEventId: envelope.eventId,
              state: 'completed',
              submissionId: crypto.randomUUID(),
              taskId: f.task.id,
            },
            workspaceId: f.workspace.id,
          })
        })
      ).rejects.toThrow()

      // The projected metadata does, and it carries no canary.
      const [appended] = await connection.db.transaction(async (transaction) => [
        await appendWorkspaceEvent(transaction, {
          actor: { id: f.node.id, kind: 'runtime_node' },
          eventType: 'task.submission_queued',
          payload: {
            ...projected.data,
            executionId: projected.executionId,
            requestId: crypto.randomUUID(),
            runtimeNodeId: f.node.id,
            sourceEventId: projected.eventId,
            submissionId: crypto.randomUUID(),
            taskId: f.task.id,
          },
          workspaceId: f.workspace.id,
        }),
      ])
      expect(appended!.eventId).toBeDefined()
      const [stored] = await connection.db
        .select()
        .from(workspaceEvents)
        .where(eq(workspaceEvents.id, appended!.eventId))
      expect(JSON.stringify(stored!.payload)).not.toContain('PRIVATE_')
      expect(stored!.payload.sourceEventId).toBe(projected.eventId)
    })

    test('the durable event inbox would store an unprojected payload verbatim', async () => {
      const f = await relayFixture()
      const sourceEventId = opaque('evt')
      await connection.db.insert(eventInbox).values({
        payload: { prompt: 'PRIVATE_INBOX_CANARY', state: 'completed' },
        source: 'control-plane',
        sourceEventId,
      })
      const [row] = await connection.db
        .select()
        .from(eventInbox)
        .where(eq(eventInbox.sourceEventId, sourceEventId))
      // Store gate: the inbox column is an unbounded jsonb with no contract
      // check, so only the projection keeps a canary out of it.
      expect(row!.payload).toMatchObject({ prompt: 'PRIVATE_INBOX_CANARY' })
      const config = getTableConfig(eventInbox)
      expect(config.checks).toHaveLength(0)
      expect(f.workspace.id).toBeTruthy()
    })
  })

  /**
   * The execution-admission authority transfer (main `beb62c2b0`, #1544) added
   * an immutable profile pin on every attempt, a provenance on every decision,
   * the runtime-connection read model and the Agent-profile read model.
   *
   * The contract owner's own unit suite (`packages/types/tests/execution-location.test.ts`)
   * already proves the pure decisions, including every connection blocked state
   * and every profile state. The cases below therefore do not repeat those
   * decisions: they prove what only the durable store can show — that the
   * durable relay rows and the transferred contract name the same identities,
   * the same pins and the same attempt vocabulary, and where the durable store
   * still cannot express what the contract now requires.
   */
  describe('the transferred execution-admission contract', () => {
    const attemptScope: ExecutionLocationAttemptScope = {
      accountId: 'account-1',
      actorId: 'actor-1',
      taskId: 'task-1',
      workspaceId: 'workspace-1',
    }
    const admissionPolicy: ExecutionLocationPolicyInput = {
      dataAvailability: {
        channelMessageMetadata: 'available',
        localOnlyContent: 'available',
        synchronizedHistory: 'available',
      },
      localRuntimeNodeId: 'node-local',
      nodes: [
        {
          availability: 'available',
          capabilities: [],
          displayName: 'Node A',
          id: 'node-a',
          kind: 'remote_host',
          observedAt: '2026-10-21T10:00:00.000Z',
          proofAt: '2026-10-21T10:00:00.000Z',
        },
      ],
      now: '2026-10-21T10:00:10.000Z',
      requiredCapabilities: [],
    }

    test('the durable node and Agent identities are the contract identities, and the relay scope is the same namespace', async () => {
      const f = await relayFixture()
      await f.submit()
      const [nodeRow] = await connection.db
        .select({
          id: runtimeNodes.id,
          kind: runtimeNodes.kind,
          ref: runtimeNodes.controlPlaneRuntimeNodeRefId,
        })
        .from(runtimeNodes)
        .where(eq(runtimeNodes.id, f.node.id))
      const [agentRow] = await connection.db
        .select({ id: agents.id, ref: agents.controlPlaneAgentId })
        .from(agents)
        .where(eq(agents.id, f.agent.id))

      const nodeIdentity: RuntimeNodeExecutionIdentity = {
        controlPlaneRuntimeNodeRefId: nodeRow!.ref,
        id: nodeRow!.id,
        kind: nodeRow!.kind,
      }
      const agentIdentity: AgentExecutionIdentity = {
        controlPlaneAgentId: agentRow!.ref,
        id: agentRow!.id,
      }
      expect(nodeIdentity.controlPlaneRuntimeNodeRefId).toMatch(/^rnr_[0-9A-HJKMNP-TV-Z]{26}$/)
      expect(agentIdentity.controlPlaneAgentId).toMatch(/^agt_[0-9A-HJKMNP-TV-Z]{26}$/)
      // The identity is exactly the durable join key and its public reference:
      // no display name, platform, key or transport variant.
      expect(Object.keys(nodeIdentity).toSorted()).toEqual([
        'controlPlaneRuntimeNodeRefId',
        'id',
        'kind',
      ])
      expect(nodeIdentity).not.toHaveProperty('displayName')
      expect(nodeIdentity).not.toHaveProperty('platform')

      // The queued relay command carries the very same references, so the
      // command scope, the durable rows and the contract are one namespace.
      const scope = (await readOutbox(f)).payload.controlPlane as Record<string, string>
      expect(scope.runtimeNodeRefId).toBe(nodeIdentity.controlPlaneRuntimeNodeRefId)
      expect(scope.agentId).toBe(agentIdentity.controlPlaneAgentId)
      expect(scope.workspaceId).not.toBe(f.workspace.id)
    })

    test('the attempt profile pin is the submission durable snapshot, and a moved pin is refused', async () => {
      const f = await relayFixture()
      const submission = await f.submit()
      const [row] = await connection.db
        .select({
          id: taskSubmissions.profileId,
          revision: taskSubmissions.profileRevision,
          version: taskSubmissions.profileVersion,
        })
        .from(taskSubmissions)
        .where(eq(taskSubmissions.id, submission.id))

      const pin: ExecutionProfilePin = {
        id: row!.id,
        revision: row!.revision,
        version: row!.version,
      }
      expect(pin).toEqual({ id: profile.id, revision: profile.revision, version: profile.version })
      const attempt: ExecutionLocationAttempt = {
        attempt: 1,
        profile: pin,
        scope: attemptScope,
        selectedLocation: { kind: 'remote_host', runtimeNodeId: 'node-a' },
      }

      // The retry keeps the pinned profile version: a newer one is never
      // substituted for the version the submission was authorized against.
      expect(resolveExecutionRetry({ attempt, policy: admissionPolicy })).toMatchObject({
        attempt: { attempt: 2, profile: pin },
        change: 'sticky_retry',
        ok: true,
      })

      // A different pin is refused, and the refusal names both pins.
      expect(
        resolveExecutionRetry({
          attempt,
          policy: admissionPolicy,
          requestedProfile: { ...pin, revision: pin.revision + 1 },
        })
      ).toMatchObject({
        change: 'profile_pin_changed',
        ok: false,
        previousProfile: pin,
        requestedProfile: { ...pin, revision: pin.revision + 1 },
      })
    })

    test('the durable attempt ledger cannot express the transferred attempt shape', async () => {
      const config = getTableConfig(taskExecutionAttempts)
      const columns = config.columns.map((column) => column.name)
      // The transferred contract binds an immutable profile pin to every
      // attempt. The durable attempt ledger has no column for one.
      expect(columns).not.toContain('profile_id')
      expect(columns).not.toContain('profile_version')
      expect(columns).not.toContain('profile_revision')
      expect(columns).toContain('attempt')
      expect(columns).toContain('location_kind')

      const attempt: ExecutionLocationAttempt = {
        attempt: 1,
        profile: {
          id: 'prf_0000000000000000000000001',
          revision: 0,
          version: 'pfv_0000000000000000000000001',
        },
        scope: attemptScope,
        selectedLocation: { kind: 'remote_host', runtimeNodeId: 'node-a' },
      }
      // A malformed pin is refused with the contract's own typed refusal.
      expect(
        resolveExecutionRetry({
          attempt: { ...attempt, profile: { id: '', revision: -1, version: '' } },
          policy: admissionPolicy,
        })
      ).toMatchObject({ change: 'attempt_invalid', ok: false })
      // An attempt with no pin at all is never silently accepted. The type
      // system refuses to build one, so this is the untyped path; it is
      // recorded as an observation for the contract owner, not an endorsement.
      expect(() =>
        resolveExecutionRetry({
          attempt: { ...attempt, profile: undefined as never },
          policy: admissionPolicy,
        })
      ).toThrow()
    })

    test('the transferred connection states have no durable source', async () => {
      const f = await relayFixture()
      await f.submit()
      const tables = Object.entries(schemaIndex)
        .filter(([, value]) => isTable(value))
        .map(([name]) => name)
      // The transfer models a runtime connection; the durable store has no
      // table for one, so no connection observation can reach this lane.
      expect(tables.filter((name) => /connection/i.test(name))).toEqual([])
      // The connection-level blocked states are part of the contract's
      // vocabulary even though nothing durable can produce them yet.
      for (const blocker of [
        'connection_unavailable',
        'connection_stale',
        'provider_auth_required',
        'provider_auth_expired',
        'transport_unavailable',
        'grant_missing',
        'grant_revoked',
        'entitlement_denied',
      ] as readonly ExecutionLocationBlocker[])
        expect(executionLocationBlockers).toContain(blocker)

      // The released command carries the node, project, Task, Agent and
      // workspace references and nothing connection-shaped.
      const released = await f.pull()
      expect(Object.keys(released!.controlPlane).toSorted()).toEqual([
        'agentId',
        'projectId',
        'runtimeNodeRefId',
        'taskId',
        'workspaceId',
      ])
      expect(
        getTableConfig(taskExecutionAttempts).columns.map((column) => column.name)
      ).not.toContain('runtime_connection_id')
    })

    test('the contract attempt-change vocabulary is the durable attempt ledger vocabulary', async () => {
      const f = await relayFixture()
      const changeColumn = getTableConfig(taskExecutionAttempts).columns.find(
        (column) => column.name === 'change'
      )
      const durableChanges = (
        changeColumn as unknown as {
          enumValues: readonly ('initial' | 'sticky_retry' | 'authorized_reroute')[]
        }
      ).enumValues
      expect(durableChanges).toEqual(['initial', 'sticky_retry', 'authorized_reroute'])

      // The contract's provenance vocabulary maps onto the durable change
      // vocabulary, totally: `satisfies` fails to compile if the contract
      // gains a provenance value this mapping does not cover.
      const provenanceToChange = {
        authorized_reroute: 'authorized_reroute',
        default_local: 'initial',
        explicit_selection: 'initial',
        sticky_retry: 'sticky_retry',
      } as const satisfies Record<ExecutionLocationProvenance, string>
      expect(Object.keys(provenanceToChange).toSorted()).toEqual([
        'authorized_reroute',
        'default_local',
        'explicit_selection',
        'sticky_retry',
      ])
      expect([...new Set(Object.values(provenanceToChange))].toSorted()).toEqual(
        [...durableChanges].toSorted()
      )

      // The durable ledger accepts every one of those changes.
      const provenanceOrder: readonly ExecutionLocationProvenance[] = [
        'default_local',
        'explicit_selection',
        'sticky_retry',
        'authorized_reroute',
      ]
      expect(Object.keys(provenanceToChange).toSorted()).toEqual([...provenanceOrder].toSorted())
      for (const [index, provenance] of provenanceOrder.entries()) {
        await connection.db.insert(taskExecutionAttempts).values({
          attempt: index + 1,
          change: provenanceToChange[provenance],
          locationKind: 'remote_host',
          runtimeNodeId: f.node.id,
          taskId: f.task.id,
          workspaceId: f.workspace.id,
        })
      }
      const stored = await connection.db
        .select()
        .from(taskExecutionAttempts)
        .where(eq(taskExecutionAttempts.taskId, f.task.id))
        .orderBy(taskExecutionAttempts.attempt)
      expect(stored.map((row) => row.attempt)).toEqual([1, 2, 3, 4])
      const expectedChanges: ('initial' | 'sticky_retry' | 'authorized_reroute')[] = [
        'initial',
        'initial',
        'sticky_retry',
        'authorized_reroute',
      ]
      expect(stored.map((row) => row.change)).toEqual(expectedChanges)
      // A change outside the durable vocabulary is refused by the store.
      await expect(
        connection.db
          .insert(taskExecutionAttempts)
          .values({
            attempt: 5,
            change: 'rerouted' as never,
            locationKind: 'remote_host',
            runtimeNodeId: f.node.id,
            taskId: f.task.id,
            workspaceId: f.workspace.id,
          })
          .execute()
      ).rejects.toThrow()
    })

    test('the durable Agent row carries exactly the pin, and the read model carries no free-form column', async () => {
      const f = await relayFixture()
      await connection.db
        .update(agents)
        .set({
          presentationMetadata: { PRIVATE_PRESENTATION_CANARY: 'PRIVATE_PRESENTATION_CANARY' },
        })
        .where(eq(agents.id, f.agent.id))
      const [row] = await connection.db
        .select({
          id: agents.id,
          pinId: agents.profileId,
          pinRevision: agents.profileRevision,
          pinState: agents.profileState,
          pinVersion: agents.profileVersion,
          ref: agents.controlPlaneAgentId,
        })
        .from(agents)
        .where(eq(agents.id, f.agent.id))

      // The durable profile columns are exactly the contract's pin, and the
      // stored state vocabulary stays a subset of the read-time one.
      const pin: ExecutionProfilePin = {
        id: row!.pinId,
        revision: row!.pinRevision,
        version: row!.pinVersion,
      }
      expect(Object.keys(pin).toSorted()).toEqual(['id', 'revision', 'version'])
      const storedStates = (
        getTableConfig(agents).columns.find(
          (column) => column.name === 'profile_state'
        ) as unknown as {
          enumValues: readonly string[]
        }
      ).enumValues
      expect(storedStates).toEqual(['available', 'deprecated', 'missing'])
      // A read-time state the store never persists stays out of the durable
      // vocabulary: the stored one is a strict subset of the read-time one.
      expect(storedStates).not.toContain('revoked')
      expect(storedStates).not.toContain('unapproved')
      // Every stored state is a state the read-time contract understands, so
      // the durable vocabulary is inside the contract's.
      const identity: AgentExecutionIdentity = { controlPlaneAgentId: row!.ref, id: row!.id }
      for (const state of storedStates) {
        const decision = decideExecutionProfileAdmission({
          identity,
          pin,
          state: state as ExecutionProfileState,
        })
        expect(decision).toBeDefined()
        expect(['execute', 'block']).toContain(decision.action)
      }
      // The profile vocabulary and the location vocabulary stay separate
      // authorities: neither names the other's states.
      expect(executionProfileBlockers).not.toContain('location_missing')
      expect(executionLocationBlockers).not.toContain('profile_missing')

      // The read model the contract defines carries the pin and the identity
      // and nothing else: the durable row's free-form presentation column
      // never reaches it.
      const model: AgentProfileExecutionReadModel = {
        identity,
        pin,
        state: row!.pinState as ExecutionProfileState,
      }
      expect(model.pin).toEqual(pin)
      expect(JSON.stringify(model)).not.toContain('PRIVATE_')
      expect(model).not.toHaveProperty('presentationMetadata')
      expect(model).not.toHaveProperty('profileState')
    })
  })
})
