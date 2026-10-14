import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq, inArray, sql } from 'drizzle-orm'

import {
  ArtifactReferenceGrantError,
  registerArtifactReferenceGrant,
  regrantArtifactReferenceGrant,
  revokeArtifactReferenceGrant,
  withArtifactReferenceGrantLocks,
  type ArtifactReferenceGrantRegistrationInput,
} from '../../src/artifact-reference-grants'
import { readArtifactRetentionFence } from '../../src/artifact-retention-fence'
import { createArtifact } from '../../src/artifacts'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createTemporaryUserSession } from '../../src/identity'
import {
  evaluateStoredRetentionDeletion,
  grantRetentionDeletionAuthorization,
  placeRetentionHold,
  recordRetentionCleanupReceipt,
  revokeRetentionDeletionAuthorization,
  RetentionCleanupError,
  withRetentionDeletionGate,
  type RetentionAuthorizationRecord,
  type RetentionGateInput,
} from '../../src/retention-cleanup'
import {
  parseRetentionPeriods,
  RETENTION_COVERAGE_RULES,
  UNSET_RETENTION_PERIODS,
} from '../../src/retention-policy'
import { fingerprintOf } from '../../src/runtime-nodes'
import {
  artifactReferenceGrants,
  artifacts,
  retentionCleanupReceipts,
  retentionDeletionAuthorizations,
  retentionDeletionDispatches,
  retentionHolds,
  runtimeNodeKeys,
  runtimeNodes,
  temporaryUserSessions,
  users,
  workspaceMemberships,
  workspaces,
} from '../../src/schema'
import { addWorkspaceMembership, createWorkspaceWithOwner } from '../../src/workspaces'
import type { UserPrincipalRef } from '@adea-ai/types'

/**
 * Retention fence on artifact-reference registration (M18.02 #1221, closing the
 * gap #1243 documented). Registration, replay, and regrant refuse an artifact
 * whose deletion is authorized, dispatched or evidenced, so a grant can never be
 * committed to data that cleanup has deleted or may delete. A deletion's dispatch
 * mark is written in the deleting gate transaction, so it also covers a deletion
 * whose generation is revoked before any receipt is accepted. Everything runs on real rows in the
 * disposable database, and every race is two or more real connections blocked on
 * the real locks. Nothing here deletes anything, schedules anything, or sets a
 * retention period beyond the one-day fixture the gate needs to reach a decision.
 */

const connectionUrl = process.env.DATABASE_URL
const migrationUrl = process.env.DATABASE_MIGRATION_URL
const CHECKSUM = 'e'.repeat(64)
const DAY_MS = 86_400_000
const FENCED = 'grant_artifact_retention_fenced'
const ARTIFACT_COVERAGE = RETENTION_COVERAGE_RULES.artifacts.requiredCoverage

const EXPIRED_ANCHOR = new Date(Date.now() - 3 * DAY_MS).toISOString()
const ONE_DAY = parseRetentionPeriods(
  Object.fromEntries(Object.keys(UNSET_RETENTION_PERIODS).map((category) => [category, 1]))
)

/**
 * Dispatch marks are append-only for the application role, so test cleanup disables the trigger
 * as the table owner inside one transaction. The disable is invisible to other sessions: the
 * same transaction enables it again before it commits.
 */
async function purgeDispatchMarks(owner: DatabaseConnection, workspaceId: string): Promise<void> {
  await owner.db.transaction(async (transaction) => {
    await transaction.execute(
      sql`alter table app.retention_deletion_dispatches disable trigger retention_deletion_dispatches_append_only`
    )
    await transaction
      .delete(retentionDeletionDispatches)
      .where(eq(retentionDeletionDispatches.workspaceId, workspaceId))
    await transaction.execute(
      sql`alter table app.retention_deletion_dispatches enable trigger retention_deletion_dispatches_append_only`
    )
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** `blocked` when the promise has not settled within `ms`, so a lock wait is observable. */
async function stillPending(promise: Promise<unknown>, ms = 400): Promise<boolean> {
  return (
    (await Promise.race([
      promise.then(
        () => 'settled' as const,
        () => 'settled' as const
      ),
      sleep(ms).then(() => 'blocked' as const),
    ])) === 'blocked'
  )
}

async function grantRefusal(operation: () => Promise<unknown>): Promise<string> {
  try {
    await operation()
  } catch (error) {
    if (error instanceof ArtifactReferenceGrantError) return error.code
    throw error
  }
  throw new Error('expected a typed grant refusal')
}

/** Typed refusals are the expected outcome of racing operations; anything else is a failure. */
function tolerated(error: unknown): boolean {
  return error instanceof ArtifactReferenceGrantError || error instanceof RetentionCleanupError
}

/** The SQLSTATE of a driver error, which drizzle may carry on `cause`. */
function sqlState(error: unknown): string | undefined {
  const candidate = error as { cause?: { code?: unknown }; code?: unknown } | null
  const code = candidate?.cause?.code ?? candidate?.code
  return typeof code === 'string' ? code : undefined
}

/** The SQLSTATE a write is refused with, or 'accepted' when it was not refused. */
async function refusalState(statement: () => Promise<unknown>): Promise<string> {
  try {
    await statement()
  } catch (error) {
    return sqlState(error) ?? String(error)
  }
  return 'accepted'
}

describe.skipIf(!connectionUrl || !migrationUrl)('Artifact registration retention fence', () => {
  let connection: DatabaseConnection
  let tableOwner: DatabaseConnection
  const workspaceIds: string[] = []
  const userIds: string[] = []
  const executorByWorkspace = new Map<string, string>()

  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
    tableOwner = createDatabase(migrationUrl!)
  })

  afterAll(async () => {
    for (const workspaceId of workspaceIds) {
      await connection.db
        .delete(retentionCleanupReceipts)
        .where(eq(retentionCleanupReceipts.workspaceId, workspaceId))
      await connection.db.delete(retentionHolds).where(eq(retentionHolds.workspaceId, workspaceId))
      await purgeDispatchMarks(tableOwner, workspaceId)
      await connection.db
        .delete(retentionDeletionAuthorizations)
        .where(eq(retentionDeletionAuthorizations.workspaceId, workspaceId))
      await connection.db
        .delete(artifactReferenceGrants)
        .where(eq(artifactReferenceGrants.sourceWorkspaceId, workspaceId))
      await connection.db.delete(artifacts).where(eq(artifacts.workspaceId, workspaceId))
      await connection.db
        .delete(runtimeNodeKeys)
        .where(
          inArray(
            runtimeNodeKeys.runtimeNodeId,
            connection.db
              .select({ id: runtimeNodes.id })
              .from(runtimeNodes)
              .where(eq(runtimeNodes.workspaceId, workspaceId))
          )
        )
      await connection.db.delete(runtimeNodes).where(eq(runtimeNodes.workspaceId, workspaceId))
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
    await connection.close()
    await tableOwner.close()
  })

  async function temporaryUser(name: string): Promise<UserPrincipalRef> {
    const session = await createTemporaryUserSession(connection.db, {
      credentialDigest: `fence-${name}-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    })
    userIds.push(session.principal.userId)
    return session.principal
  }

  async function newWorkspace(name: string, owner: UserPrincipalRef) {
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `fence-${name}-${crypto.randomUUID()}`,
      name: `${name} fence`,
      owner,
    })
    workspaceIds.push(workspace.id)
    return workspace
  }

  /** A source workspace with owner and member, an audience workspace, a paired executor node, one live artifact. */
  async function fixture(name: string) {
    const owner = await temporaryUser(`${name}-owner`)
    const member = await temporaryUser(`${name}-member`)
    const workspace = await newWorkspace(name, owner)
    await addWorkspaceMembership(connection.db, workspace.id, member, 'member')
    const audienceOwner = await temporaryUser(`${name}-aud`)
    const audience = await newWorkspace(`${name}-audience`, audienceOwner)
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
    const publicKey = `fence-signing-${crypto.randomUUID()}`
    await connection.db.insert(runtimeNodeKeys).values({
      algorithm: 'ed25519',
      fingerprint: fingerprintOf(publicKey),
      keyVersion: 1,
      publicKey,
      role: 'signing',
      runtimeNodeId: node!.id,
      verifiedAt: new Date(),
    })
    executorByWorkspace.set(workspace.id, node!.id)
    const artifact = await newArtifact(workspace.id, owner)
    return { artifact, audience, audienceOwner, member, node: node!, owner, workspace }
  }

  type Fixture = Awaited<ReturnType<typeof fixture>>

  async function newArtifact(workspaceId: string, owner: UserPrincipalRef) {
    return createArtifact(connection.db, workspaceId, owner, {
      availability: 'available',
      checksumSha256: CHECKSUM,
      filename: 'fenced.txt',
      location: { reference: `outputs/${crypto.randomUUID()}`, type: 'object_store' },
      mediaType: 'text/plain',
      sizeBytes: 32,
      sourceArtifactRef: `runtime-output:${crypto.randomUUID()}`,
      sourcePrincipal: { kind: 'system', systemId: 'job-runner' },
    })
  }

  function registrationFor(
    f: Fixture,
    artifactId: string = f.artifact.id,
    overrides: Partial<ArtifactReferenceGrantRegistrationInput> = {}
  ): ArtifactReferenceGrantRegistrationInput {
    return {
      artifactId,
      audienceWorkspaceId: f.audience.id,
      checksumSha256: CHECKSUM,
      expiresAt: null,
      grantId: `grant-${crypto.randomUUID()}`,
      version: 1,
      ...overrides,
    }
  }

  function register(
    f: Fixture,
    input: ArtifactReferenceGrantRegistrationInput,
    principal: UserPrincipalRef = f.owner
  ) {
    return registerArtifactReferenceGrant(connection.db, f.workspace.id, principal, input)
  }

  async function authorize(
    f: Fixture,
    subjectId: string = f.artifact.id,
    options: { category?: 'artifacts' | 'messages'; ttlMs?: number; workspaceId?: string } = {}
  ): Promise<RetentionAuthorizationRecord> {
    const granted = await grantRetentionDeletionAuthorization(connection.db, {
      actor: f.owner,
      category: options.category ?? 'artifacts',
      expiresAt: new Date(Date.now() + (options.ttlMs ?? 60_000)).toISOString(),
      subjectId,
      workspaceId: options.workspaceId ?? f.workspace.id,
    })
    // Receipts are observed a few milliseconds after the grant, never ahead of the database clock.
    await sleep(25)
    return granted
  }

  function revokeAuthority(f: Fixture, authority: RetentionAuthorizationRecord) {
    return revokeRetentionDeletionAuthorization(connection.db, {
      actor: f.owner,
      authorizationId: authority.id,
      workspaceId: f.workspace.id,
    })
  }

  async function recordReceipt(
    f: Fixture,
    authority: RetentionAuthorizationRecord,
    operation: 'delete' | 'read_check',
    outcome: 'completed' | 'failed' | 'in_progress' | 'unreachable',
    coverage: (typeof ARTIFACT_COVERAGE)[number],
    offsetMs: number
  ) {
    return recordRetentionCleanupReceipt(connection.db, {
      category: 'artifacts',
      executor: { kind: 'runtime_node', runtimeNodeId: f.node.id },
      idempotencyKey: `fence-${crypto.randomUUID()}`,
      receipt: {
        category: 'artifacts',
        coverage,
        observedAt: new Date(Date.parse(authority.grantedAt) + offsetMs).toISOString(),
        operation,
        outcome,
        requestId: authority.id,
        residualCount: 0,
        subjectId: authority.subjectId,
      },
      workspaceId: f.workspace.id,
    })
  }

  /** A completed delete and a clean read-back for every coverage the artifact category requires. */
  async function recordVerified(f: Fixture, authority: RetentionAuthorizationRecord) {
    for (const coverage of ARTIFACT_COVERAGE) {
      await recordReceipt(f, authority, 'delete', 'completed', coverage, 5)
      await recordReceipt(f, authority, 'read_check', 'completed', coverage, 6)
    }
  }

  function gateInput(f: Fixture, artifactId: string = f.artifact.id): RetentionGateInput {
    return {
      anchorAt: EXPIRED_ANCHOR,
      category: 'artifacts',
      coverageInventory: Object.fromEntries(
        ARTIFACT_COVERAGE.map((coverage) => [coverage, [executorByWorkspace.get(f.workspace.id)!]])
      ),
      periods: ONE_DAY,
      reconciliationOpen: false,
      subjectId: artifactId,
      workspaceId: f.workspace.id,
    }
  }

  /**
   * A gate pass that deletes: like the cleanup executor, it records the dispatch mark in the gate
   * transaction before it would call a store. Nothing is actually deleted here.
   */
  async function dispatchDeletion(
    f: Fixture,
    artifactId: string = f.artifact.id,
    coverages: readonly (typeof ARTIFACT_COVERAGE)[number][] = [ARTIFACT_COVERAGE[0]!]
  ) {
    return withRetentionDeletionGate(
      connection.db,
      gateInput(f, artifactId),
      async (decision, context) => {
        if (decision.outcome === 'cleanup_ready')
          for (const coverage of coverages) await context.markDeletionDispatched(coverage)
        return decision.outcome
      }
    )
  }

  async function dispatchRows(artifactId: string) {
    return connection.db
      .select()
      .from(retentionDeletionDispatches)
      .where(eq(retentionDeletionDispatches.subjectId, artifactId))
  }

  /** A late receipt is refused with the typed reason, because receipts bind only to a live generation. */
  async function lateReceiptRefusal(f: Fixture, authority: RetentionAuthorizationRecord) {
    try {
      await recordReceipt(f, authority, 'delete', 'completed', ARTIFACT_COVERAGE[0]!, 5)
    } catch (error) {
      if (error instanceof RetentionCleanupError) return error.code
      throw error
    }
    throw new Error('expected the late receipt to be refused')
  }

  async function grantRows(artifactId: string) {
    return connection.db
      .select()
      .from(artifactReferenceGrants)
      .where(eq(artifactReferenceGrants.artifactId, artifactId))
  }

  async function fenceOf(f: Fixture, artifactId: string = f.artifact.id) {
    return connection.db.transaction((transaction) =>
      readArtifactRetentionFence(transaction, f.workspace.id, artifactId)
    )
  }

  /** A transaction held open until released, holding whatever locks `acquire` takes. */
  async function holdTransaction(
    acquire: (
      transaction: Parameters<Parameters<typeof connection.db.transaction>[0]>[0]
    ) => Promise<void>
  ) {
    let release!: (outcome: 'commit' | 'rollback') => void
    const released = new Promise<'commit' | 'rollback'>((resolve) => {
      release = resolve
    })
    let ready!: () => void
    const acquired = new Promise<void>((resolve) => {
      ready = resolve
    })
    let pid!: number
    const finished = connection.db
      .transaction(async (transaction) => {
        await acquire(transaction)
        const [row] = await transaction.execute(sql`select pg_backend_pid() as pid`)
        pid = Number((row as { pid?: unknown }).pid)
        ready()
        if ((await released) === 'rollback') throw new Error('rollback requested')
      })
      .catch((error: unknown) => {
        if (!(error instanceof Error) || error.message !== 'rollback requested') throw error
      })
    await Promise.race([
      acquired,
      finished.then(() => {
        throw new Error('held transaction finished before acquiring its lock')
      }),
    ])
    return { finished, pid, release }
  }

  async function waitUntilBlockedOnLock(queryFragment: string): Promise<void> {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const rows = await connection.db.execute(
        sql`select count(*)::int as waiting from pg_stat_activity
            where wait_event_type = 'Lock' and query ilike ${`%${queryFragment}%`}`
      )
      if (Number((rows[0] as { waiting?: unknown }).waiting) > 0) return
      await sleep(10)
    }
    throw new Error(`no session blocked on a lock for ${queryFragment}`)
  }

  /** Returns the waiter only after PostgreSQL reports it blocked by this exact backend. */
  async function waitUntilBlockedBy(holderPid: number, queryFragment: string): Promise<number> {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const rows = await connection.db.execute(
        sql`select waiter.pid::int as pid
            from pg_stat_activity as waiter
            where waiter.datname = current_database()
              and waiter.wait_event_type = 'Lock'
              and waiter.query ilike ${`%${queryFragment}%`}
              and ${holderPid}::int = any(pg_blocking_pids(waiter.pid))
            limit 1`
      )
      const pid = (rows[0] as { pid?: unknown } | undefined)?.pid
      if (pid !== undefined) return Number(pid)
      await sleep(10)
    }
    throw new Error(`no session blocked by backend ${holderPid} for ${queryFragment}`)
  }

  test('an artifact with no authority or evidence registers, and a live authority fences it until revoked', async () => {
    const f = await fixture('basic')
    expect(await fenceOf(f)).toBe('clear')
    const before = registrationFor(f)
    expect((await register(f, before)).outcome).toBe('registered')

    const authority = await authorize(f)
    expect(await fenceOf(f)).toBe('authority_live')
    const fenced = registrationFor(f)
    expect(await grantRefusal(() => register(f, fenced))).toBe(FENCED)
    expect(await grantRows(f.artifact.id)).toHaveLength(1)

    // Revocation withdraws the authority; no deletion happened, so nothing is fenced any more.
    await revokeAuthority(f, authority)
    expect(await fenceOf(f)).toBe('clear')
    expect((await register(f, fenced)).outcome).toBe('registered')
    expect(await grantRows(f.artifact.id)).toHaveLength(2)
  })

  test('expiry does not lift the fence; only revocation does', async () => {
    const f = await fixture('expiry')
    const authority = await authorize(f, f.artifact.id, { ttlMs: 150 })
    await sleep(250)
    // Expired and unrevoked: the executor can no longer record receipts, so a deletion that
    // committed under this generation could have left no evidence. The fence stays closed.
    const input = registrationFor(f)
    expect(await grantRefusal(() => register(f, input))).toBe(FENCED)
    await revokeAuthority(f, authority)
    expect((await register(f, input)).outcome).toBe('registered')
  })

  test('delete evidence outlives its generation: revoked and superseded generations stay fenced', async () => {
    const f = await fixture('stale')
    const first = await authorize(f)
    // Any outcome counts: a failed or unreachable delete may already have removed part of the data.
    await recordReceipt(f, first, 'delete', 'failed', ARTIFACT_COVERAGE[0]!, 5)
    await revokeAuthority(f, first)
    expect(await fenceOf(f)).toBe('cleanup_evidenced')
    const input = registrationFor(f)
    expect(await grantRefusal(() => register(f, input))).toBe(FENCED)

    // A newer generation is fenced by its own authority, and by the first generation's evidence.
    const second = await authorize(f)
    expect(await grantRefusal(() => register(f, input))).toBe(FENCED)
    await revokeAuthority(f, second)
    expect(await fenceOf(f)).toBe('cleanup_evidenced')
    expect(await grantRefusal(() => register(f, input))).toBe(FENCED)
    expect(await grantRows(f.artifact.id)).toHaveLength(0)
  })

  test('a read-back with no delete, a hold, another category, another workspace, and another artifact do not fence', async () => {
    const f = await fixture('scope')
    const other = await newArtifact(f.workspace.id, f.owner)

    // A hold blocks deletion, not sharing.
    await placeRetentionHold(connection.db, {
      actor: f.owner,
      category: 'artifacts',
      subjectId: f.artifact.id,
      workspaceId: f.workspace.id,
    })
    // The same subject string under another category is another subject.
    await authorize(f, f.artifact.id, { category: 'messages' })
    // The audience workspace's own authority for the same artifact id is another workspace's
    // subject. It is really written (its owner is a member there), and it does not reach the
    // source workspace's artifact.
    const foreign = await grantRetentionDeletionAuthorization(connection.db, {
      actor: f.audienceOwner,
      category: 'artifacts',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      subjectId: f.artifact.id,
      workspaceId: f.audience.id,
    })
    expect(foreign).toMatchObject({ subjectId: f.artifact.id, workspaceId: f.audience.id })
    expect(
      await connection.db
        .select({ id: retentionDeletionAuthorizations.id })
        .from(retentionDeletionAuthorizations)
        .where(eq(retentionDeletionAuthorizations.id, foreign.id))
    ).toHaveLength(1)
    expect(await fenceOf(f)).toBe('clear')
    expect((await register(f, registrationFor(f))).outcome).toBe('registered')

    // Authority on one artifact never reaches an unrelated shared artifact in the same workspace.
    const authority = await authorize(f, other.id)
    expect(await grantRefusal(() => register(f, registrationFor(f, other.id)))).toBe(FENCED)
    expect((await register(f, registrationFor(f))).outcome).toBe('registered')
    // A read-back alone is not a deletion.
    await recordReceipt(f, authority, 'read_check', 'completed', ARTIFACT_COVERAGE[0]!, 5)
    await revokeAuthority(f, authority)
    expect(await fenceOf(f, other.id)).toBe('clear')
    expect((await register(f, registrationFor(f, other.id))).outcome).toBe('registered')
  })

  test('a deletion revoked before any receipt is recorded is still fenced by its dispatch mark', async () => {
    const f = await fixture('revoked-before-receipt')
    const authority = await authorize(f)
    // The gate pass that deletes records its dispatch mark in its own transaction and commits.
    expect(await dispatchDeletion(f)).toBe('cleanup_ready')
    // The administrator revokes the generation before the executor's receipt is accepted, and
    // the late receipt is refused, because receipts bind only to a live generation.
    await revokeAuthority(f, authority)
    expect(await lateReceiptRefusal(f, authority)).toBe('authorization_not_current')
    expect(
      await connection.db
        .select({ id: retentionCleanupReceipts.id })
        .from(retentionCleanupReceipts)
        .where(eq(retentionCleanupReceipts.subjectId, f.artifact.id))
    ).toHaveLength(0)
    // The mark was written with the deletion, so the database still shows it and registration is refused.
    expect(await fenceOf(f)).toBe('deletion_dispatched')
    expect(await grantRefusal(() => register(f, registrationFor(f)))).toBe(FENCED)
    expect(await grantRows(f.artifact.id)).toHaveLength(0)
  })

  test('the dispatch mark is written in the deleting transaction: a rollback leaves nothing and fences nothing', async () => {
    const f = await fixture('mark-atomicity')
    const first = await authorize(f)

    // A deleting pass that fails after marking rolls the mark back with it.
    await expect(
      withRetentionDeletionGate(connection.db, gateInput(f), async (_decision, context) => {
        await context.markDeletionDispatched(ARTIFACT_COVERAGE[0]!)
        throw new Error('store failed')
      })
    ).rejects.toThrow('store failed')
    expect(await dispatchRows(f.artifact.id)).toHaveLength(0)
    await revokeAuthority(f, first)
    expect(await fenceOf(f)).toBe('clear')
    expect((await register(f, registrationFor(f))).outcome).toBe('registered')
  })

  test('the dispatch mark is idempotent per generation and coverage, and outlives every generation', async () => {
    const f = await fixture('mark-generations')
    const first = await authorize(f)
    // Marking the same coverage again under one generation (a retried pass) is still one row.
    await withRetentionDeletionGate(connection.db, gateInput(f), async (_decision, context) => {
      await context.markDeletionDispatched(ARTIFACT_COVERAGE[0]!)
      await context.markDeletionDispatched(ARTIFACT_COVERAGE[0]!)
      await context.markDeletionDispatched(ARTIFACT_COVERAGE[1]!)
    })
    const marks = await dispatchRows(f.artifact.id)
    expect(marks.map((row) => row.coverage).toSorted()).toEqual(
      [ARTIFACT_COVERAGE[0]!, ARTIFACT_COVERAGE[1]!].toSorted()
    )
    expect(new Set(marks.map((row) => row.authorizationId))).toEqual(new Set([first.id]))

    // The same coverage under a newer generation is its own row.
    await revokeAuthority(f, first)
    expect(await fenceOf(f)).toBe('deletion_dispatched')
    const second = await authorize(f)
    await withRetentionDeletionGate(connection.db, gateInput(f), async (_decision, context) => {
      await context.markDeletionDispatched(ARTIFACT_COVERAGE[0]!)
    })
    expect(await dispatchRows(f.artifact.id)).toHaveLength(3)
    await revokeAuthority(f, second)
    // Every generation is revoked and none has a receipt: the marks alone keep the fence closed.
    expect(await fenceOf(f)).toBe('deletion_dispatched')
    expect(await grantRefusal(() => register(f, registrationFor(f)))).toBe(FENCED)
  })

  test('dispatch marks are append-only for the application role: update, delete and truncate are refused and change nothing', async () => {
    const f = await fixture('append-only')
    const authority = await authorize(f)
    expect(await dispatchDeletion(f)).toBe('cleanup_ready')
    await revokeAuthority(f, authority)
    const [mark] = await dispatchRows(f.artifact.id)
    expect(mark).toBeDefined()
    // check_violation, raised by the trigger, never an accepted write.
    expect(
      await refusalState(() =>
        connection.db
          .update(retentionDeletionDispatches)
          .set({ subjectId: crypto.randomUUID() })
          .where(eq(retentionDeletionDispatches.id, mark!.id))
      )
    ).toBe('23514')
    expect(
      await refusalState(() =>
        connection.db
          .delete(retentionDeletionDispatches)
          .where(eq(retentionDeletionDispatches.id, mark!.id))
      )
    ).toBe('23514')
    expect(
      await refusalState(() =>
        connection.db.execute(sql`truncate app.retention_deletion_dispatches`)
      )
    ).not.toBe('accepted')
    expect(await dispatchRows(f.artifact.id)).toEqual([mark!])
    expect(await fenceOf(f)).toBe('deletion_dispatched')
  })

  test('a mark needs a generation that was current at the decision, and writes nothing without one', async () => {
    const f = await fixture('mark-needs-generation')
    let code: string | undefined
    await withRetentionDeletionGate(connection.db, gateInput(f), async (decision, context) => {
      expect(decision).toEqual({ outcome: 'refused', reason: 'authorization_not_current' })
      try {
        await context.markDeletionDispatched(ARTIFACT_COVERAGE[0]!)
      } catch (error) {
        if (!(error instanceof RetentionCleanupError)) throw error
        code = error.code
      }
    })
    expect(code).toBe('authorization_not_current')
    expect(await dispatchRows(f.artifact.id)).toHaveLength(0)
    expect(await fenceOf(f)).toBe('clear')
  })

  test('a dispatch mark reaches only its own artifact: another artifact, category and workspace stay clear', async () => {
    const f = await fixture('mark-scope')
    const other = await newArtifact(f.workspace.id, f.owner)
    // A live reference to an unrelated artifact is left alone by the marked artifact's cleanup.
    const unrelated = registrationFor(f, other.id)
    expect((await register(f, unrelated)).outcome).toBe('registered')

    const authority = await authorize(f)
    expect(await dispatchDeletion(f)).toBe('cleanup_ready')
    await revokeAuthority(f, authority)
    expect(await fenceOf(f)).toBe('deletion_dispatched')

    expect(await fenceOf(f, other.id)).toBe('clear')
    expect((await register(f, registrationFor(f, other.id))).outcome).toBe('registered')
    const [live] = await grantRows(other.id).then((rows) =>
      rows.filter((row) => row.grantId === unrelated.grantId)
    )
    expect(live).toMatchObject({ revision: 1, revokedAt: null })

    // The same subject string under another category, and the audience workspace's own
    // authority and mark for that string, are other subjects.
    const messages = await authorize(f, other.id, { category: 'messages' })
    const foreign = await grantRetentionDeletionAuthorization(connection.db, {
      actor: f.audienceOwner,
      category: 'artifacts',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      subjectId: other.id,
      workspaceId: f.audience.id,
    })
    await connection.db.insert(retentionDeletionDispatches).values([
      {
        authorizationId: messages.id,
        category: 'messages',
        coverage: ARTIFACT_COVERAGE[0]!,
        subjectId: other.id,
        workspaceId: f.workspace.id,
      },
      {
        authorizationId: foreign.id,
        category: 'artifacts',
        coverage: ARTIFACT_COVERAGE[0]!,
        subjectId: other.id,
        workspaceId: f.audience.id,
      },
    ])
    expect(await fenceOf(f, other.id)).toBe('clear')
    expect((await register(f, registrationFor(f, other.id))).outcome).toBe('registered')
  })

  test('regrant is fenced by a dispatch mark after the generation is revoked, and the revoked grant stays as it was', async () => {
    const f = await fixture('mark-regrant')
    const input = registrationFor(f)
    await register(f, input)
    // The gate refuses to delete while a reference is live, so no mark is written for it.
    const authority = await authorize(f)
    expect(await dispatchDeletion(f)).toBe('refused')
    expect(await dispatchRows(f.artifact.id)).toHaveLength(0)
    await revokeArtifactReferenceGrant(connection.db, f.workspace.id, f.owner, input.grantId)
    expect(await dispatchDeletion(f)).toBe('cleanup_ready')
    await revokeAuthority(f, authority)
    expect(
      await grantRefusal(() =>
        regrantArtifactReferenceGrant(connection.db, f.workspace.id, f.owner, input, 1)
      )
    ).toBe(FENCED)
    const [row] = await grantRows(f.artifact.id)
    expect(row).toMatchObject({ revision: 1 })
    expect(row!.revokedAt).not.toBeNull()
  })

  test('only an authoritative issuer learns an artifact is fenced', async () => {
    const f = await fixture('issuer')
    await authorize(f)
    const input = registrationFor(f)
    expect(await grantRefusal(() => register(f, input, f.member))).toBe('grant_issuer_unauthorized')
    expect(await grantRefusal(() => register(f, input))).toBe(FENCED)
    // A divergent target is reported as divergence, not as retention state.
    const divergent = registrationFor(f, f.artifact.id, { version: 99 })
    expect(await grantRefusal(() => register(f, divergent))).toBe('grant_target_divergence')
  })

  test('replay and regrant are fenced; a live grant is neither relabelled nor revoked by the fence', async () => {
    const f = await fixture('replay')
    const input = registrationFor(f)
    const registered = await register(f, input)
    expect(registered.state.revision).toBe(1)

    const authority = await authorize(f)
    // The gate sees the reference and refuses; the replay is refused too, not answered 'existing'.
    expect(await grantRefusal(() => register(f, input))).toBe(FENCED)
    const [row] = await grantRows(f.artifact.id)
    expect(row).toMatchObject({ revision: 1, revokedAt: null })
    await revokeAuthority(f, authority)
    expect((await register(f, input)).outcome).toBe('existing')

    // Regrant after revocation: fenced while the authority is live, and the row stays as it was.
    await revokeArtifactReferenceGrant(connection.db, f.workspace.id, f.owner, input.grantId)
    const second = await authorize(f)
    expect(
      await grantRefusal(() =>
        regrantArtifactReferenceGrant(connection.db, f.workspace.id, f.owner, input, 1)
      )
    ).toBe(FENCED)
    const [stillRevoked] = await grantRows(f.artifact.id)
    expect(stillRevoked).toMatchObject({ revision: 1 })
    expect(stillRevoked!.revokedAt).not.toBeNull()
    // A stale expectation is still a revision conflict, and nothing changes.
    expect(
      await grantRefusal(() =>
        regrantArtifactReferenceGrant(connection.db, f.workspace.id, f.owner, input, 7)
      )
    ).toBe('grant_revision_conflict')

    await revokeAuthority(f, second)
    const regranted = await regrantArtifactReferenceGrant(
      connection.db,
      f.workspace.id,
      f.owner,
      input,
      1
    )
    expect(regranted).toMatchObject({
      outcome: 'registered',
      state: { revision: 2, revoked: false },
    })
  })

  test('cleanup first: a registration queued behind an in-flight gate is fenced by what the gate left', async () => {
    const f = await fixture('cleanup-first')
    const authority = await authorize(f)
    await recordVerified(f, authority)

    let enteredGate!: () => void
    const gateEntered = new Promise<void>((resolve) => {
      enteredGate = resolve
    })
    let releaseGate!: () => void
    const gateReleased = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    const gate = withRetentionDeletionGate(connection.db, gateInput(f), async (decision) => {
      enteredGate()
      await gateReleased
      return decision
    })
    await gateEntered

    const input = registrationFor(f)
    const registration = grantRefusal(() => register(f, input))
    expect(await stillPending(registration)).toBe(true)

    releaseGate()
    expect((await gate).outcome).toBe('verified_complete')
    expect(await registration).toBe(FENCED)
    // No live grant points at the data the gate cleared.
    expect(await grantRows(f.artifact.id)).toHaveLength(0)
  })

  test('registration first: a reference committed after the fence read is seen by the gate and refuses cleanup', async () => {
    const f = await fixture('registration-first')
    // Hold the unique grant id with an uncommitted row, so the registration stalls AFTER its fence
    // read. The row names a different artifact id (no foreign key), so it takes no lock on this one.
    const input = registrationFor(f)
    const holder = await holdTransaction(async (transaction) => {
      await transaction.insert(artifactReferenceGrants).values({
        artifactId: crypto.randomUUID(),
        audienceWorkspaceId: f.audience.id,
        checksumSha256: CHECKSUM,
        grantId: input.grantId,
        revision: 1,
        sourceWorkspaceId: f.workspace.id,
        version: 1,
      })
    })
    const registration = register(f, input)
    await waitUntilBlockedOnLock('artifact_reference_grants')
    expect(await stillPending(registration, 100)).toBe(true)

    // The registration holds the artifact row and has already read the fence as clear. Authority and
    // receipts take only the subject lock, so they land while it waits.
    const authority = await authorize(f)
    await recordVerified(f, authority)
    let gateDecision: string | undefined
    const gate = evaluateStoredRetentionDeletion(connection.db, gateInput(f)).then((decision) => {
      gateDecision = decision.outcome
      return decision
    })
    expect(await stillPending(gate)).toBe(true)
    expect(gateDecision).toBeUndefined()

    holder.release('rollback')
    await holder.finished
    expect((await registration).outcome).toBe('registered')
    // The gate waited for the artifact row, so it decided with the committed reference in view.
    expect(await gate).toEqual({ outcome: 'refused', reason: 'active_reference_retained' })
    expect(await grantRows(f.artifact.id)).toHaveLength(1)
  })

  test('authority granted while a registration waits is seen when it proceeds', async () => {
    const f = await fixture('authority-while-waiting')
    // The artifact row is held by another writer, so the registration queues on it.
    const writer = await holdTransaction(async (transaction) => {
      await transaction
        .select({ id: artifacts.id })
        .from(artifacts)
        .where(eq(artifacts.id, f.artifact.id))
        .for('update')
    })
    const input = registrationFor(f)
    const registration = grantRefusal(() => register(f, input))
    expect(await stillPending(registration, 150)).toBe(true)

    // Authority needs only the subject lock, so it commits while the registration waits.
    await authorize(f)
    writer.release('commit')
    await writer.finished
    expect(await registration).toBe(FENCED)
    expect(await grantRows(f.artifact.id)).toHaveLength(0)
  })

  test('revocation commits while registration waits: retained evidence keeps the artifact fenced', async () => {
    const f = await fixture('revoke-race')
    const authority = await authorize(f)
    await recordReceipt(f, authority, 'delete', 'completed', ARTIFACT_COVERAGE[0]!, 5)
    const writer = await holdTransaction(async (transaction) => {
      await transaction
        .select({ id: artifacts.id })
        .from(artifacts)
        .where(eq(artifacts.id, f.artifact.id))
        .for('update')
    })
    const input = registrationFor(f)
    const registration = grantRefusal(() => register(f, input))
    expect(await stillPending(registration, 150)).toBe(true)
    // The revocation takes the subject lock only and commits first.
    await revokeAuthority(f, authority)
    writer.release('commit')
    await writer.finished
    // The generation is gone, but its delete evidence still fences the artifact.
    expect(await registration).toBe(FENCED)
    expect(await grantRows(f.artifact.id)).toHaveLength(0)
  })

  test('deletion mark commits before queued registration and revocation; both operations stay fenced', async () => {
    const f = await fixture('deletion-in-flight')
    const authority = await authorize(f)

    let enteredGate!: () => void
    const gateEntered = new Promise<void>((resolve) => {
      enteredGate = resolve
    })
    let releaseGate!: () => void
    const gateReleased = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    let gatePid!: number
    // The deleting pass marks first, as the executor does, then holds its locks while the store works.
    const gate = withRetentionDeletionGate(
      connection.db,
      gateInput(f),
      async (decision, context) => {
        await context.markDeletionDispatched(ARTIFACT_COVERAGE[0]!)
        const [row] = await context.transaction.execute(sql`select pg_backend_pid() as pid`)
        gatePid = Number((row as { pid?: unknown }).pid)
        enteredGate()
        await gateReleased
        return decision
      }
    )
    let registration: Promise<string> | undefined
    let revocation: ReturnType<typeof revokeAuthority> | undefined
    try {
      await Promise.race([
        gateEntered,
        gate.then(() => {
          throw new Error('deleting gate returned before reaching its pause')
        }),
      ])

      const input = registrationFor(f)
      registration = grantRefusal(() => register(f, input))
      const registrationPid = await waitUntilBlockedBy(gatePid, 'for update')
      expect(registrationPid).not.toBe(gatePid)
      revocation = revokeAuthority(f, authority)
      const revocationPid = await waitUntilBlockedBy(gatePid, 'pg_advisory_xact_lock')
      expect(revocationPid).not.toBe(gatePid)
      // Neither the mark nor the deletion is visible to anyone until the gate commits.
      expect(await dispatchRows(f.artifact.id)).toHaveLength(0)

      releaseGate()
      expect((await gate).outcome).toBe('cleanup_ready')
      await revocation
      // The post-commit order of registration and revocation is unspecified here; both are fenced.
      expect(await registration).toBe(FENCED)
      expect(await fenceOf(f)).toBe('deletion_dispatched')
      expect(await grantRows(f.artifact.id)).toHaveLength(0)
      expect(await lateReceiptRefusal(f, authority)).toBe('authorization_not_current')
    } finally {
      releaseGate()
      await Promise.allSettled([
        gate,
        ...(registration ? [registration] : []),
        ...(revocation ? [revocation] : []),
      ])
    }
  })

  test('revocation commits while a registration is mid-flight: the mark, not a receipt, keeps the artifact fenced', async () => {
    const f = await fixture('revoke-mid-flight')
    const authority = await authorize(f)
    expect(await dispatchDeletion(f)).toBe('cleanup_ready')
    // No receipt is ever accepted for this deletion. The registration queues on the artifact row.
    const writer = await holdTransaction(async (transaction) => {
      await transaction
        .select({ id: artifacts.id })
        .from(artifacts)
        .where(eq(artifacts.id, f.artifact.id))
        .for('update')
    })
    const input = registrationFor(f)
    let registration: Promise<string> | undefined
    let revocation: ReturnType<typeof revokeAuthority> | undefined
    try {
      registration = grantRefusal(() => register(f, input))
      const registrationPid = await waitUntilBlockedBy(writer.pid, 'for update')
      expect(registrationPid).not.toBe(writer.pid)
      // The revocation takes the subject lock only and commits while the registration waits.
      revocation = revokeAuthority(f, authority)
      await revocation
      expect(await lateReceiptRefusal(f, authority)).toBe('authorization_not_current')
      writer.release('commit')
      await writer.finished
      expect(await registration).toBe(FENCED)
      expect(await grantRows(f.artifact.id)).toHaveLength(0)
    } finally {
      writer.release('rollback')
      await Promise.allSettled([
        writer.finished,
        ...(registration ? [registration] : []),
        ...(revocation ? [revocation] : []),
      ])
    }
  })

  test('registration resolves before a queued revocation, then the committed mark keeps the artifact fenced', async () => {
    const f = await fixture('registration-before-revocation')
    const authority = await authorize(f)
    expect(await dispatchDeletion(f)).toBe('cleanup_ready')

    // Hold the authority row so revocation takes its subject lock, then waits on this writer.
    // Registration does not need that lock and must finish against the already committed mark.
    const writer = await holdTransaction(async (transaction) => {
      await transaction
        .select({ id: retentionDeletionAuthorizations.id })
        .from(retentionDeletionAuthorizations)
        .where(eq(retentionDeletionAuthorizations.id, authority.id))
        .for('update')
    })
    let revocation: ReturnType<typeof revokeAuthority> | undefined
    let registration: Promise<string> | undefined
    try {
      revocation = revokeAuthority(f, authority)
      const revocationPid = await waitUntilBlockedBy(
        writer.pid,
        'retention_deletion_authorizations'
      )
      expect(revocationPid).not.toBe(writer.pid)
      registration = grantRefusal(() => register(f, registrationFor(f)))
      expect(await registration).toBe(FENCED)
      expect(await grantRows(f.artifact.id)).toHaveLength(0)
    } finally {
      writer.release('commit')
      await Promise.allSettled([
        writer.finished,
        ...(registration ? [registration] : []),
        ...(revocation ? [revocation] : []),
      ])
    }

    await revocation
    expect(await fenceOf(f)).toBe('deletion_dispatched')
    expect(await grantRefusal(() => register(f, registrationFor(f)))).toBe(FENCED)
    expect(await grantRows(f.artifact.id)).toHaveLength(0)
  })

  test('registration first: a reference committed ahead of a queued deleting pass refuses the deletion and leaves no mark', async () => {
    const f = await fixture('mark-registration-first')
    const input = registrationFor(f)
    // The uncommitted row holds the unique grant id, so the registration stalls after its fence read.
    const holder = await holdTransaction(async (transaction) => {
      await transaction.insert(artifactReferenceGrants).values({
        artifactId: crypto.randomUUID(),
        audienceWorkspaceId: f.audience.id,
        checksumSha256: CHECKSUM,
        grantId: input.grantId,
        revision: 1,
        sourceWorkspaceId: f.workspace.id,
        version: 1,
      })
    })
    let registration: ReturnType<typeof register> | undefined
    let deleting: ReturnType<typeof dispatchDeletion> | undefined
    try {
      registration = register(f, input)
      const registrationPid = await waitUntilBlockedBy(holder.pid, 'artifact_reference_grants')
      expect(registrationPid).not.toBe(holder.pid)

      await authorize(f)
      deleting = dispatchDeletion(f)
      const deletingPid = await waitUntilBlockedBy(registrationPid, 'for update')
      expect(deletingPid).not.toBe(registrationPid)

      holder.release('rollback')
      await holder.finished
      expect((await registration).outcome).toBe('registered')
      // The deleting pass waited for the artifact row, saw the committed reference, and refused.
      expect(await deleting).toBe('refused')
      expect(await dispatchRows(f.artifact.id)).toHaveLength(0)
      expect(await grantRows(f.artifact.id)).toHaveLength(1)
    } finally {
      holder.release('rollback')
      await Promise.allSettled([
        holder.finished,
        ...(registration ? [registration] : []),
        ...(deleting ? [deleting] : []),
      ])
    }
  })

  test('lock order: registration holds the artifact row while it waits for the grant row; revocation never waits on the artifact', async () => {
    const f = await fixture('lock-order')
    const input = registrationFor(f)
    await register(f, input)

    // 1. Hold only the grant row. A replay must already own the artifact row when it waits.
    const grantHolder = await holdTransaction(async (transaction) => {
      await transaction
        .select({ id: artifactReferenceGrants.id })
        .from(artifactReferenceGrants)
        .where(eq(artifactReferenceGrants.grantId, input.grantId))
        .for('update')
    })
    const replay = register(f, input)
    await waitUntilBlockedOnLock('artifact_reference_grants')
    let probeState: string | undefined
    try {
      await connection.db.transaction(async (transaction) => {
        await transaction.execute(
          sql`select id from ${artifacts} where id = ${f.artifact.id} for update nowait`
        )
      })
    } catch (error) {
      probeState = sqlState(error)
    } finally {
      grantHolder.release('commit')
      await grantHolder.finished
    }
    // 55P03: lock_not_available. The replay owns the artifact row while it waits for the grant row.
    expect(probeState).toBe('55P03')
    expect((await replay).outcome).toBe('existing')

    // 2. Hold only the artifact row. Revocation locks the grant row alone, so it completes.
    const artifactHolder = await holdTransaction(async (transaction) => {
      await transaction
        .select({ id: artifacts.id })
        .from(artifacts)
        .where(eq(artifacts.id, f.artifact.id))
        .for('update')
    })
    const revoked = await Promise.race([
      revokeArtifactReferenceGrant(connection.db, f.workspace.id, f.owner, input.grantId),
      sleep(2_000).then(() => 'waited' as const),
    ])
    expect(revoked).not.toBe('waited')
    artifactHolder.release('commit')
    await artifactHolder.finished

    // 3. The retention gate takes the same artifact row first, so it queues behind a registration too.
    const authority = await authorize(f)
    await recordVerified(f, authority)
    const writer = await holdTransaction(async (transaction) => {
      await transaction
        .select({ id: artifacts.id })
        .from(artifacts)
        .where(eq(artifacts.id, f.artifact.id))
        .for('update')
    })
    const gate = evaluateStoredRetentionDeletion(connection.db, gateInput(f))
    expect(await stillPending(gate)).toBe(true)
    // The subject lock is not taken until the artifact row is owned, so other retention acts proceed.
    await placeRetentionHold(connection.db, {
      actor: f.owner,
      category: 'artifacts',
      subjectId: f.artifact.id,
      workspaceId: f.workspace.id,
    })
    writer.release('commit')
    await writer.finished
    expect(await gate).toEqual({ outcome: 'refused', reason: 'hold_active' })
  })

  test('concurrent registrations, regrants, revocations, gates, authority changes and authorizations never deadlock', async () => {
    const f = await fixture('stress')
    const artifactsUnderTest = [f.artifact, await newArtifact(f.workspace.id, f.owner)]
    const marked = await newArtifact(f.workspace.id, f.owner)
    const failures: unknown[] = []

    const operations: Array<() => Promise<unknown>> = []
    for (const [artifactIndex, artifact] of artifactsUnderTest.entries()) {
      for (let round = 0; round < 4; round++) {
        const input = registrationFor(f, artifact.id, {
          grantId: `stress-${artifactIndex}-${round}-${crypto.randomUUID()}`,
        })
        operations.push(
          () => register(f, input),
          () => register(f, input),
          () => regrantArtifactReferenceGrant(connection.db, f.workspace.id, f.owner, input, 1),
          () => revokeArtifactReferenceGrant(connection.db, f.workspace.id, f.owner, input.grantId),
          () =>
            withArtifactReferenceGrantLocks(
              connection.db,
              {
                artifactId: artifact.id,
                grantId: input.grantId,
                revision: 1,
                sourceWorkspaceId: f.workspace.id,
              },
              async () => sleep(5)
            ),
          () => evaluateStoredRetentionDeletion(connection.db, gateInput(f, artifact.id)),
          async () => {
            const authority = await authorize(f, artifact.id, { ttlMs: 30_000 })
            await revokeAuthority(f, authority)
          }
        )
      }
    }
    // Deleting passes that mark, racing registrations, authority changes and gates on one more artifact.
    for (let round = 0; round < 4; round++) {
      const input = registrationFor(f, marked.id, { grantId: `stress-marked-${round}` })
      operations.push(
        () => register(f, input),
        () => dispatchDeletion(f, marked.id),
        async () => {
          const authority = await authorize(f, marked.id, { ttlMs: 30_000 })
          await revokeAuthority(f, authority)
        }
      )
    }
    await Promise.all(
      operations.map((operation) =>
        operation().catch((error: unknown) => {
          if (!tolerated(error)) failures.push(error)
        })
      )
    )
    expect(failures.map((error) => sqlState(error) ?? String(error))).toEqual([])
  })
})
