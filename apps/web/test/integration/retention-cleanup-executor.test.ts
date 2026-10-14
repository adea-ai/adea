// Source-level cleanup executor proofs (#1221). The executor runs inside the
// retention gate and deletes only from owned, disposable replica tables in a
// per-run schema. Receipts reach the gate through the real signed receipt
// handler, the same boundary a node uses, with an in-test node key.
//
// Lane: part of `bun run test:integration` (react-server, real PostgreSQL). The
// replicas live in a schema this file creates and drops. No production data,
// no chosen period (the fixture period is test-only), no scheduler.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'

import {
  createArtifact,
  createDatabase,
  parseRetentionPeriods,
  RETENTION_COVERAGE_RULES,
  artifactReferenceGrants,
  registerArtifactReferenceGrant,
  UNSET_RETENTION_PERIODS,
  type CleanupCoverageKind,
  type RetentionCategory,
  createTemporaryUserSession,
  createWorkspaceWithOwner,
  evaluateStoredRetentionDeletion,
  fingerprintOf,
  grantRetentionDeletionAuthorization,
  placeRetentionHold,
  retentionCleanupReceipts,
  retentionDeletionAuthorizations,
  retentionDeletionDispatches,
  retentionHolds,
  revokeRetentionDeletionAuthorization,
  runRetentionCleanupExecutor,
  runtimeNodeKeys,
  runtimeNodes,
  temporaryUserSessions,
  users,
  workspaceMemberships,
  workspaces,
  type AgentHqDatabase,
  type AgentHqTransaction,
  type DatabaseConnection,
  type RetentionCleanupStoreOutcome,
  type RetentionCleanupStorePort,
  type RetentionReceiptDraft,
} from '@adea-ai/db'
import { runtimeNodeRetentionReceiptMessage } from '@adea-ai/types/runtime-node-delivery'
import type { UserPrincipalRef } from '@adea-ai/types'

import { handleRuntimeNodeRetentionReceipt } from '../../src/server/retention-receipt-request'

const connectionUrl = process.env.DATABASE_URL
const migrationUrl = process.env.DATABASE_MIGRATION_URL
const CHECKSUM = 'd'.repeat(64)
const DAY_MS = 86_400_000
const EXPIRED_ANCHOR = new Date(Date.now() - 3 * DAY_MS).toISOString()
const ONE_DAY_PERIODS = parseRetentionPeriods(
  Object.fromEntries(Object.keys(UNSET_RETENTION_PERIODS).map((category) => [category, 1]))
)
const TABLE_FOR_COVERAGE: Record<CleanupCoverageKind, string> = {
  cache: 'cache_rows',
  index: 'index_rows',
  object_version: 'object_version_rows',
  primary: 'primary_rows',
  replica: 'replica_rows',
  runtime_state: 'runtime_state_rows',
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type RetentionHoldResult = Awaited<ReturnType<typeof placeRetentionHold>>

type PromiseOutcome<T> =
  | Readonly<{ status: 'fulfilled'; value: T }>
  | Readonly<{ status: 'rejected'; reason: unknown }>

/** Attach rejection handling as soon as an async operation starts. */
function observePromise<T>(promise: Promise<T>): Promise<PromiseOutcome<T>> {
  return promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason: unknown) => ({ status: 'rejected', reason })
  )
}

/** Wait for readiness only while its owning operation remains unsettled. */
async function awaitReadiness<T>(
  ready: Promise<T>,
  operation: Promise<PromiseOutcome<unknown>>,
  label: string,
  timeoutMs = 10_000
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const readyOutcome = ready.then(
    (value) => ({ kind: 'ready' as const, value }),
    (reason: unknown) => ({ kind: 'readiness_error' as const, reason })
  )
  const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
    timeoutId = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs)
  })
  try {
    const result = await Promise.race([
      readyOutcome,
      operation.then((outcome) => ({ kind: 'operation' as const, outcome })),
      timeout,
    ])
    if (result.kind === 'ready') return result.value
    if (result.kind === 'readiness_error') throw result.reason
    if (result.kind === 'timeout') {
      throw new Error(`${label} did not become ready within ${timeoutMs}ms`)
    }
    if (result.outcome.status === 'rejected') throw result.outcome.reason
    throw new Error(`${label}: operation settled before readiness`)
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  }
}

async function settleWithin<T>(
  operation: Promise<PromiseOutcome<T>>,
  label: string,
  timeoutMs = 15_000
): Promise<PromiseOutcome<T>> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`${label} did not settle within ${timeoutMs}ms`)),
      timeoutMs
    )
  })
  try {
    return await Promise.race([operation, timeout])
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  }
}

/** Every pause opened by a test. A failed proof releases them, so no store call outlives its test. */
const heldPauses: Array<() => void> = []

type PausePoint = Readonly<{
  at: 'delete' | 'residual'
  entered(holderPid: number): void
  release: Promise<void>
}>

/**
 * Holds one store call open at a chosen point. `reached` resolves with the executor's
 * backend pid once the call is in flight, so a test can find what queues behind it.
 */
function pausePoint(at: 'delete' | 'residual' = 'delete') {
  let entered!: (holderPid: number) => void
  const reached = new Promise<number>((resolve) => {
    entered = resolve
  })
  let open!: () => void
  const gate = new Promise<void>((resolve) => {
    open = resolve
  })
  heldPauses.push(open)
  const pause: PausePoint = { at, entered, release: gate }
  return { open, pause, reached }
}

/** The backend running this transaction. Locks it holds are the ones a racing operation queues behind. */
async function backendPid(transaction: AgentHqTransaction): Promise<number> {
  const rows = await transaction.execute(sql`select pg_backend_pid() as pid`)
  return Number((rows[0] as { pid?: unknown }).pid)
}

function base64url(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString('base64url')
}

describe.skipIf(!connectionUrl || !migrationUrl)(
  'cleanup executor behind the retention gate',
  () => {
    let connection: DatabaseConnection
    let migration: DatabaseConnection
    const schema = `ret_replica_${crypto.randomUUID().replaceAll('-', '')}`
    const workspaceIds: string[] = []
    const userIds: string[] = []

    afterEach(() => {
      for (const open of heldPauses.splice(0)) open()
    })

    beforeAll(async () => {
      connection = createDatabase(connectionUrl!)
      migration = createDatabase(migrationUrl!)
      await migration.db.execute(sql`create schema ${sql.identifier(schema)}`)
      for (const table of Object.values(TABLE_FOR_COVERAGE)) {
        await migration.db.execute(
          sql`create table ${sql.identifier(schema)}.${sql.identifier(table)} (
          row_id uuid primary key default gen_random_uuid(),
          workspace_id uuid not null,
          subject_id text not null
        )`
        )
        await migration.db.execute(
          sql`grant select, insert, delete on ${sql.identifier(schema)}.${sql.identifier(table)} to agent_hq_local_app`
        )
      }
      await migration.db.execute(
        sql`grant usage on schema ${sql.identifier(schema)} to agent_hq_local_app`
      )
    })

    afterAll(async () => {
      for (const workspaceId of workspaceIds) {
        await connection.db
          .delete(retentionCleanupReceipts)
          .where(eq(retentionCleanupReceipts.workspaceId, workspaceId))
        await connection.db
          .delete(retentionHolds)
          .where(eq(retentionHolds.workspaceId, workspaceId))
        await connection.db
          .delete(retentionDeletionDispatches)
          .where(eq(retentionDeletionDispatches.workspaceId, workspaceId))
        await connection.db
          .delete(retentionDeletionAuthorizations)
          .where(eq(retentionDeletionAuthorizations.workspaceId, workspaceId))
        await connection.db
          .delete(workspaceMemberships)
          .where(eq(workspaceMemberships.workspaceId, workspaceId))
        await connection.db.delete(workspaces).where(eq(workspaces.id, workspaceId))
      }
      for (const userId of userIds) {
        await connection.db
          .delete(temporaryUserSessions)
          .where(eq(temporaryUserSessions.userId, userId))
        await connection.db.delete(users).where(eq(users.id, userId))
      }
      await migration.db.execute(sql`drop schema if exists ${sql.identifier(schema)} cascade`)
      await connection.close()
      await migration.close()
    })

    async function principal(name: string): Promise<UserPrincipalRef> {
      const session = await createTemporaryUserSession(connection.db, {
        credentialDigest: `cleanup-executor-${name}-${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 60 * 60_000),
      })
      userIds.push(session.principal.userId)
      return session.principal
    }

    /** A workspace, one paired executor node with a real Ed25519 key, and seeded replicas. */
    async function fixture(name: string) {
      const owner = await principal(name)
      const { workspace } = await createWorkspaceWithOwner(connection.db, {
        idempotencyKey: `cleanup-executor-${name}-${crypto.randomUUID()}`,
        name: `cleanup executor ${name}`,
        owner,
      })
      workspaceIds.push(workspace.id)
      const pair = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify'])
      const publicKey = base64url(await crypto.subtle.exportKey('raw', pair.publicKey))
      const keyId = crypto.randomUUID()
      const [node] = await connection.db
        .insert(runtimeNodes)
        .values({
          displayName: `${name} executor`,
          kind: 'local_device',
          ownerUserId: owner.userId,
          platform: 'darwin',
          softwareVersion: '1.0.0',
          workspaceId: workspace.id,
        })
        .returning()
      await connection.db.insert(runtimeNodeKeys).values({
        algorithm: 'ed25519',
        fingerprint: fingerprintOf(publicKey),
        id: keyId,
        keyVersion: 1,
        publicKey,
        role: 'signing',
        runtimeNodeId: node!.id,
        verifiedAt: new Date(),
      })
      return {
        keyId,
        nodeId: node!.id,
        owner,
        privateKey: pair.privateKey,
        workspaceId: workspace.id,
      }
    }

    /** Seeds the same subject in every replica table, plus an untouched sibling subject. */
    async function seed(
      workspaceId: string,
      subjects: readonly string[],
      tables: readonly string[]
    ) {
      for (const table of tables) {
        for (const subjectId of subjects) {
          await migration.db.execute(
            sql`insert into ${sql.identifier(schema)}.${sql.identifier(table)} (workspace_id, subject_id)
              values (${workspaceId}::uuid, ${subjectId})`
          )
        }
      }
    }

    async function rowCount(
      workspaceId: string,
      table: string,
      subjectId: string
    ): Promise<number> {
      const rows = await migration.db.execute(
        sql`select count(*)::int as n from ${sql.identifier(schema)}.${sql.identifier(table)}
          where workspace_id = ${workspaceId}::uuid and subject_id = ${subjectId}`
      )
      return Number((rows[0] as { n?: unknown }).n)
    }

    /**
     * An owned replica store. Deletes and read-backs are real statements on the disposable
     * table. `outcome` and `residual` replace the store's own result with an arbitrary value,
     * for port-validation proofs. `pause` holds one call open at `at` and reports the
     * executor's backend pid once the call is in flight.
     */
    function replicaPort(
      coverage: CleanupCoverageKind,
      table: string,
      options: Readonly<{
        outcome?: unknown
        pause?: PausePoint
        reinsertAfterDelete?: boolean
        residual?: unknown
      }> = {}
    ): RetentionCleanupStorePort {
      const target = sql`${sql.identifier(schema)}.${sql.identifier(table)}`
      const pauseAt = async (point: 'delete' | 'residual', transaction: AgentHqTransaction) => {
        if (options.pause?.at !== point) return
        options.pause.entered(await backendPid(transaction))
        await options.pause.release
      }
      return {
        coverage,
        async deleteSubject(transaction, subject) {
          await pauseAt('delete', transaction)
          if (options.outcome !== undefined && options.outcome !== 'completed')
            return options.outcome as RetentionCleanupStoreOutcome
          await transaction.execute(
            sql`delete from ${target} where workspace_id = ${subject.workspaceId}::uuid and subject_id = ${subject.subjectId}`
          )
          if (options.reinsertAfterDelete)
            await transaction.execute(
              sql`insert into ${target} (workspace_id, subject_id) values (${subject.workspaceId}::uuid, ${subject.subjectId})`
            )
          return 'completed'
        },
        async residualCount(transaction, subject) {
          await pauseAt('residual', transaction)
          const rows = await transaction.execute(
            sql`select count(*)::int as n from ${target} where workspace_id = ${subject.workspaceId}::uuid and subject_id = ${subject.subjectId}`
          )
          if (options.residual !== undefined) return options.residual as number
          return Number((rows[0] as { n?: unknown }).n)
        },
      }
    }

    function portsFor(
      category: RetentionCategory,
      overrides: Partial<Record<CleanupCoverageKind, Parameters<typeof replicaPort>[2]>> = {}
    ): RetentionCleanupStorePort[] {
      const coverage: readonly CleanupCoverageKind[] =
        category === 'artifacts'
          ? ['primary', 'object_version', 'cache', 'replica']
          : ['primary', 'index', 'cache', 'replica']
      return coverage.map((kind) => replicaPort(kind, TABLE_FOR_COVERAGE[kind], overrides[kind]))
    }

    async function grant(
      f: Awaited<ReturnType<typeof fixture>>,
      subjectId: string,
      category: RetentionCategory = 'messages',
      expiresAt = new Date(Date.now() + 60 * 60_000).toISOString()
    ) {
      const record = await grantRetentionDeletionAuthorization(connection.db, {
        actor: f.owner,
        category,
        expiresAt,
        subjectId,
        workspaceId: f.workspaceId,
      })
      await sleep(20)
      return record
    }

    /** The node signs each draft with its key over the receipt digest, then calls the real handler. */
    async function submit(f: Awaited<ReturnType<typeof fixture>>, receipt: RetentionReceiptDraft) {
      const envelope = {
        issuedAt: new Date().toISOString(),
        keyId: f.keyId,
        nonce: crypto.randomUUID(),
        signature: '',
        version: 1 as const,
      }
      const body = {
        category: receipt.category,
        envelope,
        receipt: {
          coverage: receipt.coverage,
          observedAt: receipt.observedAt,
          operation: receipt.operation,
          outcome: receipt.outcome,
          requestId: receipt.requestId,
          residualCount: receipt.residualCount,
          subjectId: receipt.subjectId,
        },
      }
      const scope = { runtimeNodeId: f.nodeId, workspaceId: f.workspaceId }
      const signature = base64url(
        await crypto.subtle.sign(
          'Ed25519',
          f.privateKey,
          new TextEncoder().encode(await runtimeNodeRetentionReceiptMessage(scope, body))
        )
      )
      const text = JSON.stringify({ ...body, envelope: { ...envelope, signature } })
      const response = await handleRuntimeNodeRetentionReceipt(
        new Request(
          `https://cloud.test/api/v1/workspaces/${f.workspaceId}/runtime-nodes/${f.nodeId}/retention/cleanup-receipts`,
          {
            body: text,
            headers: {
              'content-length': String(Buffer.byteLength(text)),
              'content-type': 'application/json',
            },
            method: 'POST',
          }
        ),
        { runtimeNodeId: f.nodeId, workspaceId: f.workspaceId },
        { database: () => connection.db as AgentHqDatabase }
      )
      return {
        body: (await response.json()) as Record<string, unknown>,
        status: response.status,
        text,
      }
    }

    async function execute(
      f: Awaited<ReturnType<typeof fixture>>,
      subjectId: string,
      options: Readonly<{
        category?: RetentionCategory
        periods?: typeof ONE_DAY_PERIODS
        reconciliationOpen?: boolean
        beforeSubmit?: () => Promise<unknown>
        stores?: readonly RetentionCleanupStorePort[]
      }> = {}
    ) {
      const responses: Array<{ body: Record<string, unknown>; status: number; text: string }> = []
      const category = options.category ?? 'messages'
      const execution = await runRetentionCleanupExecutor(connection.db as AgentHqDatabase, {
        anchorAt: EXPIRED_ANCHOR,
        category,
        executorId: f.nodeId,
        coverageInventory: Object.fromEntries(
          RETENTION_COVERAGE_RULES[category].requiredCoverage.map((coverage) => [
            coverage,
            [f.nodeId],
          ])
        ),
        periods: options.periods ?? ONE_DAY_PERIODS,
        reconciliationOpen: options.reconciliationOpen ?? false,
        stores: options.stores ?? portsFor(category),
        subjectId,
        submit: async (receipt) => {
          await options.beforeSubmit?.()
          responses.push(await submit(f, receipt))
        },
        workspaceId: f.workspaceId,
      })
      return { execution, responses }
    }

    async function statusOf(
      f: Awaited<ReturnType<typeof fixture>>,
      subjectId: string,
      category: RetentionCategory = 'messages'
    ) {
      return evaluateStoredRetentionDeletion(connection.db as AgentHqDatabase, {
        anchorAt: EXPIRED_ANCHOR,
        category,
        coverageInventory: Object.fromEntries(
          RETENTION_COVERAGE_RULES[category].requiredCoverage.map((coverage) => [
            coverage,
            [f.nodeId],
          ])
        ),
        periods: ONE_DAY_PERIODS,
        reconciliationOpen: false,
        subjectId,
        workspaceId: f.workspaceId,
      })
    }

    async function dispatchedCoverage(subjectId: string) {
      const rows = await connection.db
        .select({ coverage: retentionDeletionDispatches.coverage })
        .from(retentionDeletionDispatches)
        .where(eq(retentionDeletionDispatches.subjectId, subjectId))
      return rows.map((row) => row.coverage).toSorted()
    }

    /** A live artifact in the fixture's workspace, with replicas seeded in every artifact store. */
    async function seededArtifact(f: Awaited<ReturnType<typeof fixture>>) {
      const artifact = await createArtifact(connection.db, f.workspaceId, f.owner, {
        availability: 'available',
        checksumSha256: CHECKSUM,
        filename: 'deleted.txt',
        location: { reference: `outputs/${crypto.randomUUID()}`, type: 'object_store' },
        mediaType: 'text/plain',
        sizeBytes: 32,
        sourceArtifactRef: `runtime-output:${crypto.randomUUID()}`,
        sourcePrincipal: { kind: 'system', systemId: 'job-runner' },
      })
      await seed(
        f.workspaceId,
        [artifact.id],
        ['primary_rows', 'object_version_rows', 'cache_rows', 'replica_rows']
      )
      return artifact
    }

    async function audienceWorkspace(name: string) {
      const audience = await createWorkspaceWithOwner(connection.db, {
        idempotencyKey: `cleanup-audience-${name}-${crypto.randomUUID()}`,
        name: `cleanup executor audience ${name}`,
        owner: await principal(`${name}-audience`),
      })
      workspaceIds.push(audience.workspace.id)
      return audience.workspace
    }

    function registerReference(
      f: Awaited<ReturnType<typeof fixture>>,
      audienceId: string,
      artifactId: string
    ) {
      return registerArtifactReferenceGrant(connection.db, f.workspaceId, f.owner, {
        artifactId,
        audienceWorkspaceId: audienceId,
        checksumSha256: CHECKSUM,
        expiresAt: null,
        grantId: `grant-${crypto.randomUUID()}`,
        version: 1,
      })
    }

    /**
     * Polls until the racing operation is queued behind the executor's own backend. A
     * waiter counts only if the executor's backend blocks it and its statement contains
     * `statement`, so another session's lock wait cannot satisfy the proof.
     */
    async function waitForQueuedOperation(holderPid: number, statement: string): Promise<void> {
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        const [row] = await connection.db.execute(
          sql`select count(*)::int as n from pg_stat_activity as waiter
            where waiter.datname = current_database()
              and waiter.wait_event_type = 'Lock'
              and waiter.query ilike ${`%${statement}%`}
              and ${holderPid}::int = any(pg_blocking_pids(waiter.pid))`
        )
        if (Number((row as { n?: unknown }).n) > 0) return
        await sleep(20)
      }
      throw new Error(`no "${statement}" queued behind executor backend ${holderPid}`)
    }

    /** Polls the database clock, the one the gate judges expiry on, until it has passed `iso`. */
    async function waitForDatabaseClockPast(iso: string): Promise<void> {
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        const [row] = await connection.db.execute(
          sql`select (extract(epoch from clock_timestamp()) * 1000)::bigint as ms`
        )
        if (Number((row as { ms?: unknown }).ms) > Date.parse(iso)) return
        await sleep(20)
      }
      throw new Error(`database clock did not pass ${iso}`)
    }

    test('executes behind the gates: deletes the subject from every replica, reads back absence, and records verified receipts', async () => {
      const f = await fixture('happy')
      const subject = crypto.randomUUID()
      const sibling = crypto.randomUUID()
      await seed(f.workspaceId, [subject, sibling], Object.values(TABLE_FOR_COVERAGE))
      await grant(f, subject)
      const { execution, responses } = await execute(f, subject)
      expect(execution.status).toBe('executed')
      expect(execution.drafts).toHaveLength(8)
      for (const table of ['primary_rows', 'index_rows', 'cache_rows', 'replica_rows']) {
        expect(await rowCount(f.workspaceId, table, subject)).toBe(0)
        expect(await rowCount(f.workspaceId, table, sibling)).toBe(1)
      }
      expect(responses.map((response) => response.status)).toEqual(Array(8).fill(200))
      expect(responses.every((response) => response.body.outcome === 'recorded')).toBe(true)
      // One durable dispatch mark per store, written in the deleting transaction.
      expect(await dispatchedCoverage(subject)).toEqual(['cache', 'index', 'primary', 'replica'])
      expect(await statusOf(f, subject)).toEqual({
        coverage: ['primary', 'index', 'cache', 'replica'],
        outcome: 'verified_complete',
      })
    })

    test('with an unset period, the executor refuses before any store is touched', async () => {
      const f = await fixture('unset')
      const subject = crypto.randomUUID()
      await seed(f.workspaceId, [subject], ['primary_rows'])
      await grant(f, subject)
      const { execution, responses } = await execute(f, subject, {
        periods: UNSET_RETENTION_PERIODS,
      })
      expect(execution).toMatchObject({
        decision: { outcome: 'refused', reason: 'policy_unset' },
        status: 'skipped',
      })
      expect(responses).toEqual([])
      expect(await rowCount(f.workspaceId, 'primary_rows', subject)).toBe(1)
    })

    test('a revoked authority refuses before any store is touched', async () => {
      const f = await fixture('revoked')
      const subject = crypto.randomUUID()
      await seed(f.workspaceId, [subject], ['primary_rows'])
      const record = await grant(f, subject)
      await revokeRetentionDeletionAuthorization(connection.db, {
        actor: f.owner,
        authorizationId: record.id,
        workspaceId: f.workspaceId,
      })
      const { execution, responses } = await execute(f, subject)
      expect(execution).toMatchObject({
        decision: { outcome: 'refused', reason: 'authorization_not_current' },
        status: 'skipped',
      })
      expect(responses).toEqual([])
      expect(await rowCount(f.workspaceId, 'primary_rows', subject)).toBe(1)
    })

    test('a live hold, an open reconciliation, and a live reference each refuse before any store is touched', async () => {
      const f = await fixture('blocks')
      const held = crypto.randomUUID()
      await seed(f.workspaceId, [held], ['primary_rows'])
      await grant(f, held)
      await placeRetentionHold(connection.db, {
        actor: f.owner,
        category: 'messages',
        subjectId: held,
        workspaceId: f.workspaceId,
      })
      expect((await execute(f, held)).execution).toMatchObject({
        decision: { outcome: 'refused', reason: 'hold_active' },
        status: 'skipped',
      })

      const open = crypto.randomUUID()
      await seed(f.workspaceId, [open], ['primary_rows'])
      await grant(f, open)
      expect((await execute(f, open, { reconciliationOpen: true })).execution).toMatchObject({
        decision: { outcome: 'refused', reason: 'reconciliation_open' },
        status: 'skipped',
      })
      expect(await rowCount(f.workspaceId, 'primary_rows', held)).toBe(1)
      expect(await rowCount(f.workspaceId, 'primary_rows', open)).toBe(1)
    })

    test('a live reference from another workspace refuses before any store is touched', async () => {
      const f = await fixture('live-reference')
      const audience = await createWorkspaceWithOwner(connection.db, {
        idempotencyKey: `cleanup-live-audience-${crypto.randomUUID()}`,
        name: 'cleanup live reference audience',
        owner: await principal('live-reference-audience'),
      })
      workspaceIds.push(audience.workspace.id)
      const artifact = await createArtifact(connection.db, f.workspaceId, f.owner, {
        availability: 'available',
        checksumSha256: CHECKSUM,
        filename: 'referenced.txt',
        location: { reference: `outputs/${crypto.randomUUID()}`, type: 'object_store' },
        mediaType: 'text/plain',
        sizeBytes: 32,
        sourceArtifactRef: `runtime-output:${crypto.randomUUID()}`,
        sourcePrincipal: { kind: 'system', systemId: 'job-runner' },
      })
      await seed(f.workspaceId, [artifact.id], ['primary_rows'])
      // The reference exists before deletion is authorized: registration is fenced afterwards.
      await registerArtifactReferenceGrant(connection.db, f.workspaceId, f.owner, {
        artifactId: artifact.id,
        audienceWorkspaceId: audience.workspace.id,
        checksumSha256: CHECKSUM,
        expiresAt: null,
        grantId: `grant-${crypto.randomUUID()}`,
        version: 1,
      })
      await grant(f, artifact.id, 'artifacts')
      const { execution, responses } = await execute(f, artifact.id, { category: 'artifacts' })
      expect(execution).toMatchObject({
        decision: { outcome: 'refused', reason: 'active_reference_retained' },
        status: 'skipped',
      })
      expect(responses).toEqual([])
      expect(await rowCount(f.workspaceId, 'primary_rows', artifact.id)).toBe(1)
    })

    test('an unreachable store records an unreachable delete, stops at once, and never verifies', async () => {
      const f = await fixture('offline')
      const subject = crypto.randomUUID()
      await seed(
        f.workspaceId,
        [subject],
        ['primary_rows', 'index_rows', 'cache_rows', 'replica_rows']
      )
      await grant(f, subject)
      const stores = portsFor('messages', { index: { outcome: 'unreachable' } })
      const { execution, responses } = await execute(f, subject, { stores })
      expect(
        execution.drafts.map((draft) => [draft.coverage, draft.operation, draft.outcome])
      ).toEqual([
        ['primary', 'delete', 'completed'],
        ['primary', 'read_check', 'completed'],
        ['index', 'delete', 'unreachable'],
      ])
      expect(responses.map((response) => response.status)).toEqual([200, 200, 200])
      expect(await rowCount(f.workspaceId, 'index_rows', subject)).toBe(1)
      expect(await rowCount(f.workspaceId, 'cache_rows', subject)).toBe(1)
      expect((await statusOf(f, subject)).outcome).toBe('pending')
      const retry = await execute(f, subject)
      expect(retry.execution.status).toBe('executed')
      expect(await statusOf(f, subject)).toMatchObject({ outcome: 'verified_complete' })
    })

    test('a failed delete remains pending and the same generation can retry after recovery', async () => {
      const f = await fixture('failed')
      const subject = crypto.randomUUID()
      await seed(f.workspaceId, [subject], ['primary_rows', 'index_rows'])
      await grant(f, subject)
      const { execution } = await execute(f, subject, {
        stores: portsFor('messages', { index: { outcome: 'failed' } }),
      })
      expect(execution.drafts.at(-1)).toMatchObject({
        coverage: 'index',
        operation: 'delete',
        outcome: 'failed',
      })
      expect(await statusOf(f, subject)).toMatchObject({ outcome: 'pending' })
      const retry = await execute(f, subject)
      expect(retry.execution.status).toBe('executed')
      expect(await statusOf(f, subject)).toMatchObject({ outcome: 'verified_complete' })
    })

    test('the read-back catches a row that reappears after delete, so no absence is claimed', async () => {
      const f = await fixture('residual')
      const subject = crypto.randomUUID()
      await seed(f.workspaceId, [subject], ['primary_rows', 'index_rows'])
      await grant(f, subject)
      const { execution } = await execute(f, subject, {
        stores: portsFor('messages', { primary: { reinsertAfterDelete: true } }),
      })
      expect(execution.drafts[1]).toMatchObject({
        coverage: 'primary',
        operation: 'read_check',
        residualCount: 1,
      })
      expect(await statusOf(f, subject)).toMatchObject({ outcome: 'pending' })
      const retry = await execute(f, subject)
      expect(retry.execution.status).toBe('executed')
      expect(await statusOf(f, subject)).toMatchObject({ outcome: 'verified_complete' })
    })

    test('a duplicate port for one coverage refuses before any store runs', async () => {
      const f = await fixture('duplicate-port')
      const subject = crypto.randomUUID()
      await seed(
        f.workspaceId,
        [subject],
        ['primary_rows', 'index_rows', 'cache_rows', 'replica_rows']
      )
      await grant(f, subject)
      const duplicate = [
        ...portsFor('messages'),
        replicaPort('primary', TABLE_FOR_COVERAGE.primary),
      ]
      await expect(execute(f, subject, { stores: duplicate })).rejects.toThrow(
        'retention cleanup store port duplicated'
      )
      expect(await rowCount(f.workspaceId, 'primary_rows', subject)).toBe(1)
      expect(await statusOf(f, subject)).toMatchObject({ outcome: 'cleanup_ready' })
    })

    test('a retry after partial receipt submission reuses the same live generation', async () => {
      const f = await fixture('partial-submission-retry')
      const subject = crypto.randomUUID()
      await seed(
        f.workspaceId,
        [subject],
        ['primary_rows', 'index_rows', 'cache_rows', 'replica_rows']
      )
      const authorization = await grant(f, subject)
      let submissions = 0
      await expect(
        execute(f, subject, {
          beforeSubmit: async () => {
            submissions++
            if (submissions === 2) throw new Error('SIMULATED_RECEIPT_SUBMISSION_CRASH')
          },
        })
      ).rejects.toThrow('SIMULATED_RECEIPT_SUBMISSION_CRASH')
      expect(await statusOf(f, subject)).toMatchObject({ outcome: 'pending' })

      const retry = await execute(f, subject)
      expect(retry.execution.status).toBe('executed')
      expect(retry.execution.drafts.length).toBeGreaterThan(0)
      expect(retry.execution.drafts.every((draft) => draft.requestId === authorization.id)).toBe(
        true
      )
      expect(retry.responses.every((response) => response.status === 200)).toBe(true)
      expect(await statusOf(f, subject)).toMatchObject({ outcome: 'verified_complete' })
    })

    test('replay: a completed run is skipped on rerun, and a captured signed receipt replays idempotently', async () => {
      const f = await fixture('replay')
      const subject = crypto.randomUUID()
      await seed(f.workspaceId, [subject], Object.values(TABLE_FOR_COVERAGE).slice(0, 4))
      await grant(f, subject)
      const first = await execute(f, subject)
      expect(first.execution.status).toBe('executed')
      const captured = first.responses[0]!
      expect(captured.body.outcome).toBe('recorded')
      const rerun = await execute(f, subject)
      expect(rerun.execution).toMatchObject({
        decision: { outcome: 'verified_complete' },
        status: 'skipped',
      })
      expect(rerun.responses).toEqual([])
      // The same signed bytes arriving again are a replay, never a second receipt.
      const replayed = await handleRuntimeNodeRetentionReceipt(
        new Request(
          `https://cloud.test/api/v1/workspaces/${f.workspaceId}/runtime-nodes/${f.nodeId}/retention/cleanup-receipts`,
          {
            body: captured.text,
            headers: {
              'content-length': String(Buffer.byteLength(captured.text)),
              'content-type': 'application/json',
            },
            method: 'POST',
          }
        ),
        { runtimeNodeId: f.nodeId, workspaceId: f.workspaceId },
        { database: () => connection.db as AgentHqDatabase }
      )
      expect(replayed.status).toBe(200)
      expect(((await replayed.json()) as { outcome: string }).outcome).toBe('replayed')
    })

    test('concurrent runs on one subject serialize on the gate: no conflict, and the subject verifies', async () => {
      const f = await fixture('concurrent')
      const subject = crypto.randomUUID()
      await seed(f.workspaceId, [subject], Object.values(TABLE_FOR_COVERAGE).slice(0, 4))
      await grant(f, subject)
      const [a, b] = await Promise.all([execute(f, subject), execute(f, subject)])
      const outcomes = [...a.responses, ...b.responses].map(
        (response) => response.body.outcome ?? response.body.code
      )
      expect(outcomes.every((outcome) => outcome === 'recorded' || outcome === 'replayed')).toBe(
        true
      )
      expect(await statusOf(f, subject)).toMatchObject({ outcome: 'verified_complete' })
      expect(await rowCount(f.workspaceId, 'primary_rows', subject)).toBe(0)
    })

    test('a revocation that lands during deletion waits for the commit, and every receipt is then refused', async () => {
      const f = await fixture('revoke-race')
      const subject = crypto.randomUUID()
      await seed(
        f.workspaceId,
        [subject],
        ['primary_rows', 'index_rows', 'cache_rows', 'replica_rows']
      )
      const record = await grant(f, subject)
      const point = pausePoint()
      let revocation!: Promise<'settled' | 'failed'>
      const running = execute(f, subject, {
        beforeSubmit: () => revocation,
        stores: portsFor('messages', { primary: { pause: point.pause } }),
      })
      const runningOutcome = observePromise(running)
      let revocationOutcome: Promise<PromiseOutcome<'settled' | 'failed'>> | undefined
      try {
        const holderPid = await awaitReadiness(
          point.reached,
          runningOutcome,
          'executor delete-pause readiness'
        )
        revocation = revokeRetentionDeletionAuthorization(connection.db, {
          actor: f.owner,
          authorizationId: record.id,
          workspaceId: f.workspaceId,
        }).then(
          () => 'settled' as const,
          () => 'failed' as const
        )
        revocationOutcome = observePromise(revocation)
        await awaitReadiness(
          waitForQueuedOperation(holderPid, 'pg_advisory_xact_lock'),
          runningOutcome,
          'executor revocation-lock wait'
        )
      } finally {
        point.open()
        await settleWithin(runningOutcome, 'cleanup executor run')
        if (revocationOutcome) await settleWithin(revocationOutcome, 'authorization revocation')
      }
      const runOutcome = await runningOutcome
      if (runOutcome.status === 'rejected') throw runOutcome.reason
      const { responses } = runOutcome.value
      const revocationResult = await revocationOutcome!
      expect(revocationResult.status).toBe('fulfilled')
      expect(
        (revocationResult as Extract<typeof revocationResult, { status: 'fulfilled' }>).value
      ).toBe('settled')
      expect(responses.length).toBeGreaterThan(0)
      expect(
        responses.every((response) => response.body.code === 'retention_authorization_not_current')
      ).toBe(true)
      expect(await statusOf(f, subject)).toEqual({
        outcome: 'refused',
        reason: 'authorization_not_current',
      })
    })

    test('a hold placed during deletion waits for the commit, and verification is refused afterwards', async () => {
      const f = await fixture('hold-race')
      const subject = crypto.randomUUID()
      await seed(
        f.workspaceId,
        [subject],
        ['primary_rows', 'index_rows', 'cache_rows', 'replica_rows']
      )
      await grant(f, subject)
      const point = pausePoint()
      const running = execute(f, subject, {
        stores: portsFor('messages', { primary: { pause: point.pause } }),
      })
      const runningOutcome = observePromise(running)
      let holdOutcome: Promise<PromiseOutcome<RetentionHoldResult>> | undefined
      try {
        const holderPid = await awaitReadiness(
          point.reached,
          runningOutcome,
          'executor delete-pause readiness'
        )
        const hold = placeRetentionHold(connection.db, {
          actor: f.owner,
          category: 'messages',
          subjectId: subject,
          workspaceId: f.workspaceId,
        })
        holdOutcome = observePromise(hold)
        await awaitReadiness(
          waitForQueuedOperation(holderPid, 'pg_advisory_xact_lock'),
          runningOutcome,
          'executor hold-lock wait'
        )
      } finally {
        point.open()
        await settleWithin(runningOutcome, 'cleanup executor run')
        if (holdOutcome) await settleWithin(holdOutcome, 'retention hold')
      }
      const runOutcome = await runningOutcome
      if (runOutcome.status === 'rejected') throw runOutcome.reason
      const holdResult = await holdOutcome!
      if (holdResult.status === 'rejected') throw holdResult.reason
      expect(await statusOf(f, subject)).toEqual({ outcome: 'refused', reason: 'hold_active' })
    })

    test('a reference registered during deletion waits for the commit and is then fenced, so no live grant points at deleted data', async () => {
      const f = await fixture('reference-race')
      const audience = await createWorkspaceWithOwner(connection.db, {
        idempotencyKey: `cleanup-audience-${crypto.randomUUID()}`,
        name: 'cleanup executor audience',
        owner: await principal('reference-audience'),
      })
      workspaceIds.push(audience.workspace.id)
      const artifact = await createArtifact(connection.db, f.workspaceId, f.owner, {
        availability: 'available',
        checksumSha256: CHECKSUM,
        filename: 'raced.txt',
        location: { reference: `outputs/${crypto.randomUUID()}`, type: 'object_store' },
        mediaType: 'text/plain',
        sizeBytes: 32,
        sourceArtifactRef: `runtime-output:${crypto.randomUUID()}`,
        sourcePrincipal: { kind: 'system', systemId: 'job-runner' },
      })
      await seed(
        f.workspaceId,
        [artifact.id],
        ['primary_rows', 'object_version_rows', 'cache_rows', 'replica_rows']
      )
      await grant(f, artifact.id, 'artifacts')
      const point = pausePoint()
      const running = execute(f, artifact.id, {
        category: 'artifacts',
        stores: portsFor('artifacts', { primary: { pause: point.pause } }),
      })
      const runningOutcome = observePromise(running)
      let registrationOutcome: Promise<PromiseOutcome<'settled' | 'failed'>> | undefined
      try {
        const holderPid = await awaitReadiness(
          point.reached,
          runningOutcome,
          'executor delete-pause readiness'
        )
        const registration = registerArtifactReferenceGrant(connection.db, f.workspaceId, f.owner, {
          artifactId: artifact.id,
          audienceWorkspaceId: audience.workspace.id,
          checksumSha256: CHECKSUM,
          expiresAt: null,
          grantId: `grant-${crypto.randomUUID()}`,
          version: 1,
        }).then(
          () => 'settled' as const,
          () => 'failed' as const
        )
        registrationOutcome = observePromise(registration)
        // The registration is queued behind the gate's artifact lock: it cannot settle until the commit.
        await awaitReadiness(
          waitForQueuedOperation(holderPid, 'for update'),
          runningOutcome,
          'executor artifact-lock wait'
        )
        const early = await Promise.race([
          registrationOutcome.then(() => 'settled' as const),
          sleep(150).then(() => 'pending' as const),
        ])
        expect(early).toBe('pending')
      } finally {
        point.open()
        await settleWithin(runningOutcome, 'cleanup executor run')
        if (registrationOutcome)
          await settleWithin(registrationOutcome, 'artifact reference registration')
      }
      const runOutcome = await runningOutcome
      if (runOutcome.status === 'rejected') throw runOutcome.reason
      const registrationResult = await registrationOutcome!
      expect(registrationResult.status).toBe('fulfilled')
      // The executor deleted under a live authority, so the queued registration is refused.
      expect(
        (registrationResult as Extract<typeof registrationResult, { status: 'fulfilled' }>).value
      ).toBe('failed')
      expect(
        await connection.db
          .select({ id: artifactReferenceGrants.id })
          .from(artifactReferenceGrants)
          .where(eq(artifactReferenceGrants.artifactId, artifact.id))
      ).toHaveLength(0)
      // Nothing references the deleted data, so the decision is not blocked by a reference.
      expect(await statusOf(f, artifact.id, 'artifacts')).not.toEqual({
        outcome: 'refused',
        reason: 'active_reference_retained',
      })
    })

    test('a deletion whose generation is revoked before any receipt is accepted still fences registration', async () => {
      const f = await fixture('revoked-before-receipt')
      const audience = await audienceWorkspace('revoked-before-receipt')
      const artifact = await seededArtifact(f)
      const record = await grant(f, artifact.id, 'artifacts')
      let revoked = false
      const { execution, responses } = await execute(f, artifact.id, {
        beforeSubmit: async () => {
          // The administrator revokes between the committed deletion and the first accepted receipt.
          if (revoked) return
          revoked = true
          await revokeRetentionDeletionAuthorization(connection.db, {
            actor: f.owner,
            authorizationId: record.id,
            workspaceId: f.workspaceId,
          })
        },
        category: 'artifacts',
        stores: portsFor('artifacts'),
      })
      expect(execution.status).toBe('executed')
      // The data is really gone, and every receipt was refused: the database holds no receipt.
      for (const table of ['primary_rows', 'object_version_rows', 'cache_rows', 'replica_rows'])
        expect(await rowCount(f.workspaceId, table, artifact.id)).toBe(0)
      expect(responses.length).toBeGreaterThan(0)
      expect(
        responses.every((response) => response.body.code === 'retention_authorization_not_current')
      ).toBe(true)
      expect(
        await connection.db
          .select({ id: retentionCleanupReceipts.id })
          .from(retentionCleanupReceipts)
          .where(eq(retentionCleanupReceipts.subjectId, artifact.id))
      ).toHaveLength(0)
      // The dispatch marks were committed with the deletion, so the artifact stays fenced.
      expect(await dispatchedCoverage(artifact.id)).toEqual([
        'cache',
        'object_version',
        'primary',
        'replica',
      ])
      let code: string | undefined
      try {
        await registerReference(f, audience.id, artifact.id)
      } catch (error) {
        code = (error as { code?: string }).code
      }
      expect(code).toBe('grant_artifact_retention_fenced')
      expect(
        await connection.db
          .select({ id: artifactReferenceGrants.id })
          .from(artifactReferenceGrants)
          .where(eq(artifactReferenceGrants.artifactId, artifact.id))
      ).toHaveLength(0)
    })

    test('a registration and a revocation queued behind a deletion in flight both lose to its marks, in either order', async () => {
      const f = await fixture('queued-race')
      const audience = await audienceWorkspace('queued-race')
      const artifact = await seededArtifact(f)
      const record = await grant(f, artifact.id, 'artifacts')
      const point = pausePoint()
      const running = execute(f, artifact.id, {
        beforeSubmit: () => revocation,
        category: 'artifacts',
        stores: portsFor('artifacts', { primary: { pause: point.pause } }),
      })
      const runningOutcome = observePromise(running)
      let revocation!: Promise<'settled' | 'failed'>
      let revocationOutcome: Promise<PromiseOutcome<'settled' | 'failed'>> | undefined
      let registrationOutcome: Promise<PromiseOutcome<'settled' | 'failed'>> | undefined
      try {
        const holderPid = await awaitReadiness(
          point.reached,
          runningOutcome,
          'executor delete-pause readiness'
        )
        // Nothing is visible before the commit: the mark was written in the open transaction.
        expect(await dispatchedCoverage(artifact.id)).toEqual([])
        registrationOutcome = observePromise(
          registerReference(f, audience.id, artifact.id).then(
            () => 'settled' as const,
            () => 'failed' as const
          )
        )
        revocation = revokeRetentionDeletionAuthorization(connection.db, {
          actor: f.owner,
          authorizationId: record.id,
          workspaceId: f.workspaceId,
        }).then(
          () => 'settled' as const,
          () => 'failed' as const
        )
        revocationOutcome = observePromise(revocation)
        await awaitReadiness(
          waitForQueuedOperation(holderPid, 'for update'),
          runningOutcome,
          'executor artifact-lock wait'
        )
        await awaitReadiness(
          waitForQueuedOperation(holderPid, 'pg_advisory_xact_lock'),
          runningOutcome,
          'executor revocation-lock wait'
        )
      } finally {
        point.open()
        await settleWithin(runningOutcome, 'cleanup executor run')
        if (registrationOutcome)
          await settleWithin(registrationOutcome, 'artifact reference registration')
        if (revocationOutcome) await settleWithin(revocationOutcome, 'authorization revocation')
      }
      const runOutcome = await runningOutcome
      if (runOutcome.status === 'rejected') throw runOutcome.reason
      const registrationResult = await registrationOutcome!
      const revocationResult = await revocationOutcome!
      expect(registrationResult).toEqual({ status: 'fulfilled', value: 'failed' })
      expect(revocationResult).toEqual({ status: 'fulfilled', value: 'settled' })
      expect(
        runOutcome.value.responses.every(
          (response) => response.body.code === 'retention_authorization_not_current'
        )
      ).toBe(true)
      expect(await dispatchedCoverage(artifact.id)).toHaveLength(4)
      expect(
        await connection.db
          .select({ id: artifactReferenceGrants.id })
          .from(artifactReferenceGrants)
          .where(eq(artifactReferenceGrants.artifactId, artifact.id))
      ).toHaveLength(0)
    })

    test('a store that throws rolls back its deletion and every dispatch mark, so the artifact is not fenced', async () => {
      const f = await fixture('mark-rollback')
      const audience = await audienceWorkspace('mark-rollback')
      const artifact = await seededArtifact(f)
      const record = await grant(f, artifact.id, 'artifacts')
      const stores = portsFor('artifacts').map((port) =>
        port.coverage === 'cache'
          ? ({
              ...port,
              async deleteSubject() {
                throw new Error('store crashed')
              },
            } satisfies RetentionCleanupStorePort)
          : port
      )
      await expect(execute(f, artifact.id, { category: 'artifacts', stores })).rejects.toThrow(
        'store crashed'
      )
      // The earlier stores deleted and marked inside the same transaction, and all of it rolled back.
      for (const table of ['primary_rows', 'object_version_rows', 'cache_rows', 'replica_rows'])
        expect(await rowCount(f.workspaceId, table, artifact.id)).toBe(1)
      expect(await dispatchedCoverage(artifact.id)).toEqual([])
      // With the generation revoked, nothing was deleted or marked, so a reference registers.
      await revokeRetentionDeletionAuthorization(connection.db, {
        actor: f.owner,
        authorizationId: record.id,
        workspaceId: f.workspaceId,
      })
      expect((await registerReference(f, audience.id, artifact.id)).outcome).toBe('registered')
    })

    test('authority that expires while the first store call is in flight: the call finishes, no later store runs, and nothing further is claimed', async () => {
      const f = await fixture('expiry-in-flight')
      const subject = crypto.randomUUID()
      await seed(
        f.workspaceId,
        [subject],
        ['primary_rows', 'index_rows', 'cache_rows', 'replica_rows']
      )
      const expiresAt = new Date(Date.now() + 4_000).toISOString()
      await grant(f, subject, 'messages', expiresAt)
      const point = pausePoint('delete')
      const running = execute(f, subject, {
        stores: portsFor('messages', { primary: { pause: point.pause } }),
      })
      const runningOutcome = observePromise(running)
      try {
        // The call was reached, so the check before it passed. Expiry then lands while it is held.
        await awaitReadiness(point.reached, runningOutcome, 'executor delete-pause readiness')
        await awaitReadiness(
          waitForDatabaseClockPast(expiresAt),
          runningOutcome,
          'database-clock expiry wait'
        )
      } finally {
        point.open()
        await settleWithin(runningOutcome, 'cleanup executor run')
      }
      const runOutcome = await runningOutcome
      if (runOutcome.status === 'rejected') throw runOutcome.reason
      const { execution, responses } = runOutcome.value
      expect(execution.halt).toEqual({ coverage: 'primary', reason: 'authorization_not_current' })
      expect(
        execution.drafts.map((draft) => [draft.coverage, draft.operation, draft.outcome])
      ).toEqual([['primary', 'delete', 'completed']])
      // The in-flight delete is receipted as what it was, and its receipt is refused: the generation has expired.
      expect(responses.map((response) => response.body.code)).toEqual([
        'retention_authorization_not_current',
      ])
      expect(await rowCount(f.workspaceId, 'primary_rows', subject)).toBe(0)
      for (const table of ['index_rows', 'cache_rows', 'replica_rows']) {
        expect(await rowCount(f.workspaceId, table, subject)).toBe(1)
      }
      expect(await statusOf(f, subject)).toEqual({
        outcome: 'refused',
        reason: 'authorization_not_current',
      })
    }, 30_000)

    test('authority that expires during a read-back claims no completion, and no later store runs', async () => {
      const f = await fixture('expiry-read-back')
      const subject = crypto.randomUUID()
      await seed(
        f.workspaceId,
        [subject],
        ['primary_rows', 'index_rows', 'cache_rows', 'replica_rows']
      )
      const expiresAt = new Date(Date.now() + 4_000).toISOString()
      await grant(f, subject, 'messages', expiresAt)
      const point = pausePoint('residual')
      const running = execute(f, subject, {
        stores: portsFor('messages', { primary: { pause: point.pause } }),
      })
      const runningOutcome = observePromise(running)
      try {
        await awaitReadiness(point.reached, runningOutcome, 'executor read-back pause readiness')
        await awaitReadiness(
          waitForDatabaseClockPast(expiresAt),
          runningOutcome,
          'database-clock expiry wait'
        )
      } finally {
        point.open()
        await settleWithin(runningOutcome, 'cleanup executor run')
      }
      const runOutcome = await runningOutcome
      if (runOutcome.status === 'rejected') throw runOutcome.reason
      const { execution, responses } = runOutcome.value
      expect(execution.halt).toEqual({ coverage: 'primary', reason: 'authorization_not_current' })
      // No read_check is drafted: the read-back finished after expiry and proves no completion.
      expect(
        execution.drafts.map((draft) => [draft.coverage, draft.operation, draft.outcome])
      ).toEqual([['primary', 'delete', 'completed']])
      expect(responses.map((response) => response.body.code)).toEqual([
        'retention_authorization_not_current',
      ])
      for (const table of ['index_rows', 'cache_rows', 'replica_rows']) {
        expect(await rowCount(f.workspaceId, table, subject)).toBe(1)
      }
      expect(await statusOf(f, subject)).toEqual({
        outcome: 'refused',
        reason: 'authorization_not_current',
      })
    }, 30_000)

    test('an invalid read-back count stops before any later store, and no absence is claimed for that store', async () => {
      const f = await fixture('invalid-residual')
      const invalidCounts: unknown[] = [
        -1,
        Number.NaN,
        1.5,
        Number.MAX_SAFE_INTEGER + 2,
        Number.POSITIVE_INFINITY,
        '0',
      ]
      for (const residual of invalidCounts) {
        const subject = crypto.randomUUID()
        await seed(
          f.workspaceId,
          [subject],
          ['primary_rows', 'index_rows', 'cache_rows', 'replica_rows']
        )
        await grant(f, subject)
        const { execution, responses } = await execute(f, subject, {
          stores: portsFor('messages', { primary: { residual } }),
        })
        expect(execution.halt).toEqual({ coverage: 'primary', reason: 'residual_invalid' })
        expect(
          execution.drafts.map((draft) => [draft.coverage, draft.operation, draft.outcome])
        ).toEqual([['primary', 'delete', 'completed']])
        expect(responses.map((response) => response.status)).toEqual([200])
        for (const table of ['index_rows', 'cache_rows', 'replica_rows']) {
          expect(await rowCount(f.workspaceId, table, subject)).toBe(1)
        }
        expect((await statusOf(f, subject)).outcome).toBe('pending')
      }
    }, 60_000)

    test('an unrecognised store result is not a completion: it gets no receipt, and later stores are untouched', async () => {
      const f = await fixture('unknown-outcome')
      const subject = crypto.randomUUID()
      await seed(
        f.workspaceId,
        [subject],
        ['primary_rows', 'index_rows', 'cache_rows', 'replica_rows']
      )
      await grant(f, subject)
      const { execution, responses } = await execute(f, subject, {
        stores: portsFor('messages', { index: { outcome: 'done' } }),
      })
      expect(execution.halt).toEqual({ coverage: 'index', reason: 'store_result_invalid' })
      expect(
        execution.drafts.map((draft) => [draft.coverage, draft.operation, draft.outcome])
      ).toEqual([
        ['primary', 'delete', 'completed'],
        ['primary', 'read_check', 'completed'],
      ])
      expect(responses.map((response) => response.status)).toEqual([200, 200])
      for (const table of ['index_rows', 'cache_rows', 'replica_rows']) {
        expect(await rowCount(f.workspaceId, table, subject)).toBe(1)
      }
      expect((await statusOf(f, subject)).outcome).toBe('pending')
    })
  }
)
