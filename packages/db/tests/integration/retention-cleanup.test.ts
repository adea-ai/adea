import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import {
  registerArtifactReferenceGrant,
  revokeArtifactReferenceGrant,
} from '../../src/artifact-reference-grants'
import { createArtifact } from '../../src/artifacts'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createTemporaryUserSession } from '../../src/identity'
import { fingerprintOf, revokeRuntimeNode } from '../../src/runtime-nodes'
import {
  grantRetentionDeletionAuthorization,
  placeRetentionHold,
  recordRetentionCleanupReceipt,
  releaseRetentionHold,
  revokeRetentionDeletionAuthorization,
  RetentionCleanupError,
  evaluateStoredRetentionDeletion,
  withRetentionDeletionGate,
  type RetentionGateInput,
} from '../../src/retention-cleanup'
import {
  parseRetentionPeriods,
  RETENTION_COVERAGE_RULES,
  UNSET_RETENTION_PERIODS,
  type CleanupCoverageKind,
  type RetentionCategory,
  type RetentionPeriods,
} from '../../src/retention-policy'
import {
  artifactReferenceGrants,
  artifacts,
  retentionCleanupReceipts,
  retentionDeletionAuthorizations,
  retentionHolds,
  runtimeNodeKeys,
  runtimeNodes,
  temporaryUserSessions,
  users,
  workspaceMemberships,
  workspaces,
} from '../../src/schema'
import {
  addWorkspaceMembership,
  createWorkspaceWithOwner,
  removeWorkspaceMembership,
} from '../../src/workspaces'
import type { UserPrincipalRef } from '@adea-ai/types'

/**
 * PostgreSQL lane for the retention gate (M18.02 #1221). Every case runs
 * against the disposable database the integration lane provides. Authority,
 * executor trust, holds, receipts, expiry, and active references are real
 * rows, and the races are real transactions that block each other on the
 * locks the gate takes.
 */

const connectionUrl = process.env.DATABASE_URL
const CHECKSUM = 'c'.repeat(64)
const DAY_MS = 86_400_000

/** Every category is periodically eligible: an expired anchor, one-day periods. */
const EXPIRED_ANCHOR = new Date(Date.now() - 3 * DAY_MS).toISOString()
const ALL_ONE_DAY: RetentionPeriods = parseRetentionPeriods(
  Object.fromEntries(Object.keys(UNSET_RETENTION_PERIODS).map((category) => [category, 1]))
)

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type Receipt = Readonly<{
  coverage: CleanupCoverageKind
  observedAt: string
  operation: 'delete' | 'read_check'
  outcome: 'completed' | 'in_progress' | 'unreachable' | 'failed'
  residualCount: number
  subjectId: string
}>

function executorOf(node: { id: string }) {
  return { kind: 'runtime_node' as const, runtimeNodeId: node.id }
}

function verified(
  category: RetentionCategory,
  subjectId: string,
  observedAt: Date = new Date()
): Receipt[] {
  const coverage = RETENTION_COVERAGE_RULES[category].requiredCoverage
  const later = new Date(observedAt.getTime() + 1)
  return coverage.flatMap((kind) => [
    {
      coverage: kind,
      observedAt: observedAt.toISOString(),
      operation: 'delete' as const,
      outcome: 'completed' as const,
      residualCount: 0,
      subjectId,
    },
    {
      coverage: kind,
      observedAt: later.toISOString(),
      operation: 'read_check' as const,
      outcome: 'completed' as const,
      residualCount: 0,
      subjectId,
    },
  ])
}

function gateInput(
  workspaceId: string,
  category: RetentionCategory,
  subjectId: string,
  overrides: Partial<RetentionGateInput> = {}
): RetentionGateInput {
  return {
    anchorAt: EXPIRED_ANCHOR,
    category,
    periods: ALL_ONE_DAY,
    reconciliationOpen: false,
    subjectId,
    workspaceId,
    ...overrides,
  }
}

async function refusalCode(operation: () => Promise<unknown>): Promise<string> {
  try {
    await operation()
  } catch (error) {
    if (error instanceof RetentionCleanupError) return error.code
    throw error
  }
  throw new Error('expected a typed refusal')
}

describe.skipIf(!connectionUrl)('Retention cleanup authority', () => {
  let connection: DatabaseConnection
  const workspaceIds: string[] = []
  const userIds: string[] = []

  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })

  afterAll(async () => {
    await cleanup()
    await connection.close()
  })

  async function cleanup() {
    for (const workspaceId of workspaceIds) {
      await connection.db
        .delete(retentionCleanupReceipts)
        .where(eq(retentionCleanupReceipts.workspaceId, workspaceId))
      await connection.db.delete(retentionHolds).where(eq(retentionHolds.workspaceId, workspaceId))
      await connection.db
        .delete(retentionDeletionAuthorizations)
        .where(eq(retentionDeletionAuthorizations.workspaceId, workspaceId))
      await connection.db
        .delete(artifactReferenceGrants)
        .where(eq(artifactReferenceGrants.sourceWorkspaceId, workspaceId))
      await connection.db.delete(artifacts).where(eq(artifacts.workspaceId, workspaceId))
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
    workspaceIds.length = 0
    userIds.length = 0
  }

  async function temporaryUser(name: string): Promise<UserPrincipalRef> {
    const session = await createTemporaryUserSession(connection.db, {
      credentialDigest: `retention-${name}-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    })
    userIds.push(session.principal.userId)
    return session.principal
  }

  /** A workspace with owner, admin and member, and a paired executor node with an active signing key. */
  async function fixture(name: string) {
    const owner = await temporaryUser(`${name}-owner`)
    const admin = await temporaryUser(`${name}-admin`)
    const member = await temporaryUser(`${name}-member`)
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `retention-${name}-${crypto.randomUUID()}`,
      name: `${name} retention`,
      owner,
    })
    workspaceIds.push(workspace.id)
    await addWorkspaceMembership(connection.db, workspace.id, admin, 'admin')
    await addWorkspaceMembership(connection.db, workspace.id, member, 'member')
    const node = await makeNode(workspace.id, owner, name)
    return { admin, member, node, owner, workspace }
  }

  async function makeNode(workspaceId: string, owner: UserPrincipalRef, name: string) {
    const [node] = await connection.db
      .insert(runtimeNodes)
      .values({
        displayName: `${name} executor`,
        kind: 'local_device',
        ownerUserId: owner.userId,
        platform: 'darwin',
        softwareVersion: '1.0.0',
        workspaceId,
      })
      .returning()
    const publicKey = `fixture-signing-${crypto.randomUUID()}`
    await connection.db.insert(runtimeNodeKeys).values({
      algorithm: 'ed25519',
      fingerprint: fingerprintOf(publicKey),
      keyVersion: 1,
      publicKey,
      role: 'signing',
      runtimeNodeId: node!.id,
      verifiedAt: new Date(),
    })
    return { id: node!.id, workspaceId }
  }

  /** Full verified coverage for one subject: a completed delete and a clean read after it. */

  async function recordAll(
    workspaceId: string,
    node: { id: string },
    category: RetentionCategory,
    receipts: readonly Receipt[],
    keyPrefix: string
  ) {
    const results = []
    for (const [index, receipt] of receipts.entries()) {
      results.push(
        await recordRetentionCleanupReceipt(connection.db, {
          category,
          executor: executorOf(node),
          idempotencyKey: `${keyPrefix}-${index}`,
          receipt,
          workspaceId,
        })
      )
    }
    return results
  }

  test('unset periods refuse deletion through stored authority and verified receipts', async () => {
    const { node, owner, workspace } = await fixture('unset')
    const subject = crypto.randomUUID()
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    await grantRetentionDeletionAuthorization(connection.db, {
      actor: owner,
      category: 'messages',
      expiresAt,
      subjectId: subject,
      workspaceId: workspace.id,
    })
    await recordAll(workspace.id, node, 'messages', verified('messages', subject), 'unset')
    const decision = await evaluateStoredRetentionDeletion(
      connection.db,
      gateInput(workspace.id, 'messages', subject, { periods: UNSET_RETENTION_PERIODS })
    )
    expect(decision).toEqual({ outcome: 'refused', reason: 'policy_unset' })
  })

  test('only a current owner or admin grants, revokes, holds, or releases; removal ends authority', async () => {
    const { admin, member, owner, workspace } = await fixture('authority')
    const subject = crypto.randomUUID()
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    const grant = (actor: UserPrincipalRef) =>
      grantRetentionDeletionAuthorization(connection.db, {
        actor,
        category: 'messages',
        expiresAt,
        subjectId: subject,
        workspaceId: workspace.id,
      })

    expect(await refusalCode(() => grant(member))).toBe('authority_unavailable')
    const authorized = await grant(admin)
    expect(authorized.revokedAt).toBeNull()

    const hold = (actor: UserPrincipalRef) =>
      placeRetentionHold(connection.db, {
        actor,
        category: 'messages',
        subjectId: subject,
        workspaceId: workspace.id,
      })
    expect(await refusalCode(() => hold(member))).toBe('authority_unavailable')
    const placed = await hold(owner)

    expect(
      await refusalCode(() =>
        releaseRetentionHold(connection.db, {
          actor: member,
          holdId: placed.id,
          workspaceId: workspace.id,
        })
      )
    ).toBe('authority_unavailable')
    await releaseRetentionHold(connection.db, {
      actor: admin,
      holdId: placed.id,
      workspaceId: workspace.id,
    })
    expect(
      await refusalCode(() =>
        releaseRetentionHold(connection.db, {
          actor: admin,
          holdId: placed.id,
          workspaceId: workspace.id,
        })
      )
    ).toBe('hold_not_found')

    // Authority is checked against the membership at the moment of the act.
    await removeWorkspaceMembership(connection.db, workspace.id, admin)
    expect(
      await refusalCode(() =>
        revokeRetentionDeletionAuthorization(connection.db, {
          actor: admin,
          authorizationId: authorized.id,
          workspaceId: workspace.id,
        })
      )
    ).toBe('authority_unavailable')
  })

  test('a second live grant conflicts; revocation is absolute and a regrant starts a new row', async () => {
    const { node, owner, workspace } = await fixture('revocation')
    const subject = crypto.randomUUID()
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    const first = await grantRetentionDeletionAuthorization(connection.db, {
      actor: owner,
      category: 'messages',
      expiresAt,
      subjectId: subject,
      workspaceId: workspace.id,
    })
    expect(
      await refusalCode(() =>
        grantRetentionDeletionAuthorization(connection.db, {
          actor: owner,
          category: 'messages',
          expiresAt,
          subjectId: subject,
          workspaceId: workspace.id,
        })
      )
    ).toBe('authorization_conflict')

    await recordAll(workspace.id, node, 'messages', verified('messages', subject), 'rev')
    expect(
      (
        await evaluateStoredRetentionDeletion(
          connection.db,
          gateInput(workspace.id, 'messages', subject)
        )
      ).outcome
    ).toBe('verified_complete')

    const revoked = await revokeRetentionDeletionAuthorization(connection.db, {
      actor: owner,
      authorizationId: first.id,
      workspaceId: workspace.id,
    })
    expect(revoked.revokedAt).not.toBeNull()
    expect(
      await evaluateStoredRetentionDeletion(
        connection.db,
        gateInput(workspace.id, 'messages', subject)
      )
    ).toEqual({ outcome: 'refused', reason: 'authorization_not_current' })
    expect(
      await refusalCode(() =>
        revokeRetentionDeletionAuthorization(connection.db, {
          actor: owner,
          authorizationId: first.id,
          workspaceId: workspace.id,
        })
      )
    ).toBe('authorization_not_found')

    const regranted = await grantRetentionDeletionAuthorization(connection.db, {
      actor: owner,
      category: 'messages',
      expiresAt,
      subjectId: subject,
      workspaceId: workspace.id,
    })
    expect(regranted.id).not.toBe(first.id)
    expect(
      (
        await evaluateStoredRetentionDeletion(
          connection.db,
          gateInput(workspace.id, 'messages', subject)
        )
      ).outcome
    ).toBe('verified_complete')
  })

  test('repeated receipts replay by idempotency key, conflict on a different payload, and never duplicate', async () => {
    const { node, owner, workspace } = await fixture('replay')
    const subject = crypto.randomUUID()
    await grantRetentionDeletionAuthorization(connection.db, {
      actor: owner,
      category: 'messages',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      subjectId: subject,
      workspaceId: workspace.id,
    })
    const payload = {
      coverage: 'primary' as const,
      observedAt: new Date().toISOString(),
      operation: 'delete' as const,
      outcome: 'completed' as const,
      residualCount: 0,
      subjectId: subject,
    }
    const submit = (receipt: object, key = 'replay-key') =>
      recordRetentionCleanupReceipt(connection.db, {
        category: 'messages',
        executor: executorOf(node),
        idempotencyKey: key,
        receipt,
        workspaceId: workspace.id,
      })

    const first = await submit(payload)
    const replay = await submit(payload)
    expect(first.outcome).toBe('recorded')
    expect(replay.outcome).toBe('replayed')
    expect(replay.receipt.id).toBe(first.receipt.id)

    expect(await refusalCode(() => submit({ ...payload, outcome: 'failed' }))).toBe(
      'receipt_conflict'
    )
    // A deliberate retry under a new key is a second, distinct receipt.
    expect((await submit(payload, 'replay-retry')).outcome).toBe('recorded')

    const rows = await connection.db
      .select({ id: retentionCleanupReceipts.id })
      .from(retentionCleanupReceipts)
      .where(eq(retentionCleanupReceipts.workspaceId, workspace.id))
    expect(rows).toHaveLength(2)
  })

  test('concurrent deliveries of one receipt store exactly one row', async () => {
    const { node, owner, workspace } = await fixture('concurrent')
    const subject = crypto.randomUUID()
    await grantRetentionDeletionAuthorization(connection.db, {
      actor: owner,
      category: 'messages',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      subjectId: subject,
      workspaceId: workspace.id,
    })
    const receipt = {
      coverage: 'index' as const,
      observedAt: new Date().toISOString(),
      operation: 'delete' as const,
      outcome: 'completed' as const,
      residualCount: 0,
      subjectId: subject,
    }
    const outcomes = await Promise.all(
      [1, 2, 3].map(() =>
        recordRetentionCleanupReceipt(connection.db, {
          category: 'messages',
          executor: executorOf(node),
          idempotencyKey: 'concurrent-key',
          receipt,
          workspaceId: workspace.id,
        })
      )
    )
    expect(outcomes.map((item) => item.outcome).toSorted()).toEqual([
      'recorded',
      'replayed',
      'replayed',
    ])
    expect(new Set(outcomes.map((item) => item.receipt.id)).size).toBe(1)
  })

  test('a revoked executor stops counting, is refused on new receipts, and a forged executor id is refused', async () => {
    const { node, owner, workspace } = await fixture('executor')
    const subject = crypto.randomUUID()
    await grantRetentionDeletionAuthorization(connection.db, {
      actor: owner,
      category: 'messages',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      subjectId: subject,
      workspaceId: workspace.id,
    })
    await recordAll(workspace.id, node, 'messages', verified('messages', subject), 'executor')
    expect(
      (
        await evaluateStoredRetentionDeletion(
          connection.db,
          gateInput(workspace.id, 'messages', subject)
        )
      ).outcome
    ).toBe('verified_complete')

    const other = await makeNode(workspace.id, owner, 'impostor')
    expect(
      await refusalCode(() =>
        recordRetentionCleanupReceipt(connection.db, {
          category: 'messages',
          executor: executorOf(node),
          idempotencyKey: 'forged-executor',
          receipt: { ...verified('messages', subject)[0], executorId: other.id },
          workspaceId: workspace.id,
        })
      )
    ).toBe('receipt_untrusted')

    await revokeRuntimeNode(connection.db, {
      actorUserId: owner.userId,
      reason: 'fixture revocation',
      runtimeNodeId: node.id,
      workspaceId: workspace.id,
    })
    expect(
      await evaluateStoredRetentionDeletion(
        connection.db,
        gateInput(workspace.id, 'messages', subject)
      )
    ).toEqual({ outcome: 'cleanup_ready' })
    expect(
      await refusalCode(() =>
        recordRetentionCleanupReceipt(connection.db, {
          category: 'messages',
          executor: executorOf(node),
          idempotencyKey: 'after-revocation',
          receipt: verified('messages', subject)[0],
          workspaceId: workspace.id,
        })
      )
    ).toBe('receipt_untrusted')
  })

  test('expiry is judged on the database clock: authority and receipts stop counting', async () => {
    const { node, owner, workspace } = await fixture('expiry')
    const subject = crypto.randomUUID()
    const expiresAt = new Date(Date.now() + 1_500).toISOString()
    await grantRetentionDeletionAuthorization(connection.db, {
      actor: owner,
      category: 'messages',
      expiresAt,
      subjectId: subject,
      workspaceId: workspace.id,
    })
    expect(
      await refusalCode(() =>
        grantRetentionDeletionAuthorization(connection.db, {
          actor: owner,
          category: 'messages',
          expiresAt: new Date(Date.now() - 1_000).toISOString(),
          subjectId: crypto.randomUUID(),
          workspaceId: workspace.id,
        })
      )
    ).toBe('invalid_input')

    await recordAll(workspace.id, node, 'messages', verified('messages', subject), 'expiry')
    expect(
      (
        await evaluateStoredRetentionDeletion(
          connection.db,
          gateInput(workspace.id, 'messages', subject)
        )
      ).outcome
    ).toBe('verified_complete')

    await sleep(1_800)
    expect(
      await evaluateStoredRetentionDeletion(
        connection.db,
        gateInput(workspace.id, 'messages', subject)
      )
    ).toEqual({ outcome: 'refused', reason: 'authorization_not_current' })
    expect(
      await refusalCode(() =>
        recordRetentionCleanupReceipt(connection.db, {
          category: 'messages',
          executor: executorOf(node),
          idempotencyKey: 'after-expiry',
          receipt: verified('messages', subject)[0],
          workspaceId: workspace.id,
        })
      )
    ).toBe('authorization_not_current')
  })

  test('a hold blocks verified cleanup until an admin releases it', async () => {
    const { admin, node, owner, workspace } = await fixture('hold')
    const subject = crypto.randomUUID()
    await grantRetentionDeletionAuthorization(connection.db, {
      actor: owner,
      category: 'messages',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      subjectId: subject,
      workspaceId: workspace.id,
    })
    await recordAll(workspace.id, node, 'messages', verified('messages', subject), 'hold')
    const hold = await placeRetentionHold(connection.db, {
      actor: owner,
      category: 'messages',
      subjectId: subject,
      workspaceId: workspace.id,
    })
    expect(
      await evaluateStoredRetentionDeletion(
        connection.db,
        gateInput(workspace.id, 'messages', subject)
      )
    ).toEqual({ outcome: 'refused', reason: 'hold_active' })
    await releaseRetentionHold(connection.db, {
      actor: admin,
      holdId: hold.id,
      workspaceId: workspace.id,
    })
    expect(
      (
        await evaluateStoredRetentionDeletion(
          connection.db,
          gateInput(workspace.id, 'messages', subject)
        )
      ).outcome
    ).toBe('verified_complete')
  })

  test('a live artifact reference from another workspace refuses cleanup until it is revoked', async () => {
    const { node, owner, workspace } = await fixture('artifact-reference')
    const { workspace: audience } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `retention-audience-${crypto.randomUUID()}`,
      name: 'retention audience',
      owner: await temporaryUser('artifact-reference-audience'),
    })
    workspaceIds.push(audience.id)
    const artifact = await createArtifact(connection.db, workspace.id, owner, {
      availability: 'available',
      checksumSha256: CHECKSUM,
      filename: 'retained.txt',
      location: { reference: `outputs/${crypto.randomUUID()}`, type: 'object_store' },
      mediaType: 'text/plain',
      sizeBytes: 32,
      sourceArtifactRef: `runtime-output:${crypto.randomUUID()}`,
      sourcePrincipal: { kind: 'system', systemId: 'job-runner' },
    })
    await grantRetentionDeletionAuthorization(connection.db, {
      actor: owner,
      category: 'artifacts',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      subjectId: artifact.id,
      workspaceId: workspace.id,
    })
    await recordAll(workspace.id, node, 'artifacts', verified('artifacts', artifact.id), 'artifact')

    const grantId = `grant-${crypto.randomUUID()}`
    const registered = await registerArtifactReferenceGrant(connection.db, workspace.id, owner, {
      artifactId: artifact.id,
      audienceWorkspaceId: audience.id,
      checksumSha256: CHECKSUM,
      expiresAt: null,
      grantId,
      version: 1,
    })
    expect(
      await evaluateStoredRetentionDeletion(
        connection.db,
        gateInput(workspace.id, 'artifacts', artifact.id)
      )
    ).toEqual({ outcome: 'refused', reason: 'active_reference_retained' })

    await revokeArtifactReferenceGrant(connection.db, workspace.id, owner, grantId)
    expect(
      (
        await evaluateStoredRetentionDeletion(
          connection.db,
          gateInput(workspace.id, 'artifacts', artifact.id)
        )
      ).outcome
    ).toBe('verified_complete')
    expect(registered.outcome).toBe('registered')
  })

  test('a reference registration waits for an in-flight gate, so the gate decides on the pre-registration state', async () => {
    const { node, owner, workspace } = await fixture('race-reference')
    const { workspace: audience } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `retention-race-audience-${crypto.randomUUID()}`,
      name: 'retention race audience',
      owner: await temporaryUser('race-reference-audience'),
    })
    workspaceIds.push(audience.id)
    const artifact = await createArtifact(connection.db, workspace.id, owner, {
      availability: 'available',
      checksumSha256: CHECKSUM,
      filename: 'raced.txt',
      location: { reference: `outputs/${crypto.randomUUID()}`, type: 'object_store' },
      mediaType: 'text/plain',
      sizeBytes: 32,
      sourceArtifactRef: `runtime-output:${crypto.randomUUID()}`,
      sourcePrincipal: { kind: 'system', systemId: 'job-runner' },
    })
    await grantRetentionDeletionAuthorization(connection.db, {
      actor: owner,
      category: 'artifacts',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      subjectId: artifact.id,
      workspaceId: workspace.id,
    })
    await recordAll(workspace.id, node, 'artifacts', verified('artifacts', artifact.id), 'race')

    let enteredGate!: () => void
    const gateEntered = new Promise<void>((resolve) => {
      enteredGate = resolve
    })
    let releaseGate!: () => void
    const gateReleased = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    const gate = withRetentionDeletionGate(
      connection.db,
      gateInput(workspace.id, 'artifacts', artifact.id),
      async (decision) => {
        enteredGate()
        await gateReleased
        return decision
      }
    )
    await gateEntered

    const grantId = `grant-${crypto.randomUUID()}`
    const registration = registerArtifactReferenceGrant(connection.db, workspace.id, owner, {
      artifactId: artifact.id,
      audienceWorkspaceId: audience.id,
      checksumSha256: CHECKSUM,
      expiresAt: null,
      grantId,
      version: 1,
    })
    const blocked = await Promise.race([
      registration.then(() => 'settled' as const),
      sleep(400).then(() => 'blocked' as const),
    ])
    expect(blocked).toBe('blocked')

    releaseGate()
    const decision = await gate
    expect(decision.outcome).toBe('verified_complete')
    await registration

    expect(
      await evaluateStoredRetentionDeletion(
        connection.db,
        gateInput(workspace.id, 'artifacts', artifact.id)
      )
    ).toEqual({ outcome: 'refused', reason: 'active_reference_retained' })
  })

  test('a revocation waits for an in-flight gate; the gate decides on the authority it saw', async () => {
    const { node, owner, workspace } = await fixture('race-revoke')
    const subject = crypto.randomUUID()
    const authority = await grantRetentionDeletionAuthorization(connection.db, {
      actor: owner,
      category: 'messages',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      subjectId: subject,
      workspaceId: workspace.id,
    })
    await recordAll(workspace.id, node, 'messages', verified('messages', subject), 'race-revoke')

    let enteredGate!: () => void
    const gateEntered = new Promise<void>((resolve) => {
      enteredGate = resolve
    })
    let releaseGate!: () => void
    const gateReleased = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    const gate = withRetentionDeletionGate(
      connection.db,
      gateInput(workspace.id, 'messages', subject),
      async (decision) => {
        enteredGate()
        await gateReleased
        return decision
      }
    )
    await gateEntered

    const revocation = revokeRetentionDeletionAuthorization(connection.db, {
      actor: owner,
      authorizationId: authority.id,
      workspaceId: workspace.id,
    })
    const blocked = await Promise.race([
      revocation.then(() => 'settled' as const),
      sleep(400).then(() => 'blocked' as const),
    ])
    expect(blocked).toBe('blocked')

    releaseGate()
    expect((await gate).outcome).toBe('verified_complete')
    await revocation

    expect(
      await evaluateStoredRetentionDeletion(
        connection.db,
        gateInput(workspace.id, 'messages', subject)
      )
    ).toEqual({ outcome: 'refused', reason: 'authorization_not_current' })
  })
})
