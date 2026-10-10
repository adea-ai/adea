import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

import type {
  MigrationSnapshotDocument,
  MigrationSnapshotRecord,
  MigrationSnapshotSection,
  UserPrincipalRef,
} from '@adea-ai/types'
import type { RuntimeSession } from '@adea-ai/types/dev-runtime'

import {
  registerArtifactReferenceGrant,
  revokeArtifactReferenceGrant,
} from '../../src/artifact-reference-grants'
import { createArtifact } from '../../src/artifacts'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createTemporaryUserSession } from '../../src/identity'
import {
  MIGRATION_SNAPSHOT_CAPTURE_SUPPORTED_FAMILIES,
  MIGRATION_SNAPSHOT_CAPTURE_TRANSACTION_CONFIG,
  MIGRATION_SNAPSHOT_UNSUPPORTED_DOMAINS,
  captureMigrationSnapshot,
} from '../../src/migration-snapshot-capture'
import { compareMigrationSnapshots } from '../../src/migration-snapshot-comparator'
import { NativeSessionInventoryError } from '../../src/native-session-inventory'
import {
  artifactReferenceGrants,
  contentRefs,
  contentReplicas,
  runtimeNodes,
} from '../../src/schema'
import { createWorkspaceWithOwner } from '../../src/workspaces'

/**
 * #1219 proof lane: the capture domains added on top of #1231/#1208 are
 * exercised against database state this file owns — a scratch database
 * created on the provisioning instance and dropped afterwards — so the
 * whole-schema capture sees exactly the fixture rows. The proofs cover
 * identity/link collisions, digest drift, active-attempt ownership, lost read
 * state, absent and unsupported domains, repeat-read idempotency and exact
 * source/profile/time provenance. Capture stays read-only: the only writes
 * are the fixtures and the deliberate mutations the comparator must catch.
 *
 * Native sessions and the execution-attempt/read-state contract cases are
 * deliberately split: the former is runtime-owned and must stay an explicit
 * `unsupported_family`; the latter are proven at the pinned document-contract
 * level because their task/agent/command graphs belong to other domains and
 * this lane must not fabricate them.
 */

const provisioningUrl = process.env.MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL
/** Every scratch database this file creates or drops must carry this prefix. */
const DISPOSABLE_SCRATCH_PREFIX = 'capture_test_'
const CHECKSUM = 'c'.repeat(64)
const OTHER_CHECKSUM = 'd'.repeat(64)

let scratchDatabase: string | null = null
let connection: DatabaseConnection | null = null

function database() {
  return connection!.db
}

function identity(snapshotId: string, capturedAt = new Date('2026-02-01T00:00:00.000Z')) {
  return { capturedAt, rehearsalId: 'rehearsal-domains', snapshotId, source: 'integration' }
}

function section(records: MigrationSnapshotRecord[]): MigrationSnapshotSection {
  return { limit: records.length + 1, records, truncated: false }
}

function runtimeSession(overrides: Partial<RuntimeSession> = {}): RuntimeSession {
  return {
    archived: false,
    generation: 1,
    id: 'sess-1',
    lifecycle: 'ready',
    projectId: 'prj-1',
    repoId: 'repo-1',
    scope: { accountId: 'acct-1', runtimeNodeId: 'node-1', workspaceId: 'wsp-1' },
    version: 1,
    worktreeId: 'wt-1',
    ...overrides,
  }
}

function grantRecordOf(document: MigrationSnapshotDocument, grantId: string) {
  return document.sections.artifactReferenceGrants?.records.find(
    (record) => record.family === 'artifactReferenceGrants' && record.grantId === grantId
  )
}

async function temporaryUser(name: string): Promise<UserPrincipalRef> {
  const session = await createTemporaryUserSession(database(), {
    credentialDigest: `snapshot-domains-${name}-${crypto.randomUUID()}`,
    expiresAt: new Date(Date.now() + 60_000),
  })
  return session.principal
}

async function seedGrant() {
  const owner = await temporaryUser('owner')
  const audienceOwner = await temporaryUser('audience')
  const { workspace: source } = await createWorkspaceWithOwner(database(), {
    idempotencyKey: `snapshot-domains-source-${crypto.randomUUID()}`,
    name: 'Snapshot domains source',
    owner,
  })
  const { workspace: destination } = await createWorkspaceWithOwner(database(), {
    idempotencyKey: `snapshot-domains-destination-${crypto.randomUUID()}`,
    name: 'Snapshot domains destination',
    owner: audienceOwner,
  })
  const artifact = await createArtifact(database(), source.id, owner, {
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
  await registerArtifactReferenceGrant(database(), source.id, owner, {
    artifactId: artifact.id,
    audienceWorkspaceId: destination.id,
    checksumSha256: CHECKSUM,
    expiresAt: null,
    grantId,
    version: 1,
  })
  return { artifact, destination, grantId, owner, source }
}

async function seedRuntimeNode(workspaceId: string, ownerUserId: string) {
  const [node] = await database()
    .insert(runtimeNodes)
    .values({
      displayName: 'Snapshot node',
      kind: 'local_device',
      ownerUserId,
      platform: 'darwin',
      softwareVersion: '1.0.0',
      workspaceId,
    })
    .returning()
  return node
}

async function seedReplica(workspaceId: string) {
  // Unpadded base64url with canonical tail bits; the sealed bytes never
  // travel in a snapshot.
  const nonce = crypto.randomUUID().replaceAll('-', '').slice(0, 16)
  const ciphertext = 'A'.repeat(24)
  const [contentRef] = await database()
    .insert(contentRefs)
    .values({
      availability: 'available',
      contentType: 'private_field',
      digestSha256: CHECKSUM,
      keyVersion: 1,
      schemaVersion: 1,
      sensitivity: 'sensitive',
      storagePolicy: 'local_authority',
      synchronizationPolicy: 'agent_hq_e2ee_sync',
      workspaceId,
    })
    .returning()
  const [replica] = await database()
    .insert(contentReplicas)
    .values({
      availability: 'available',
      ciphertext,
      contentRefId: contentRef.id,
      digestSha256: CHECKSUM,
      keyEpochId: crypto.randomUUID(),
      nonce,
      replicaKind: 'agent_hq_e2ee_sync',
      revision: 1,
      schemaVersion: 1,
      workspaceId,
    })
    .returning()
  return { ciphertext, nonce, replica }
}

function attempt(attemptNo: number, runtimeNodeId: string): MigrationSnapshotRecord {
  return {
    attempt: attemptNo,
    family: 'executionAttempts',
    locationKind: 'local_device',
    runtimeNodeId,
    taskId: '11111111-1111-4111-8111-111111111111',
    workspaceId: '22222222-2222-4222-8222-222222222222',
  }
}

function readState(lastReadSequence: number, manuallyUnread = false): MigrationSnapshotRecord {
  return {
    channelId: '33333333-3333-4333-8333-333333333333',
    family: 'readState',
    lastReadSequence,
    manuallyUnread,
    threadRootMessageId: null,
    userId: '44444444-4444-4444-8444-444444444444',
    workspaceId: '22222222-2222-4222-8222-222222222222',
  }
}

/** The same connection settings as the provisioning URL, against another database. */
function urlForDatabase(databaseName: string): string {
  const url = new URL(provisioningUrl!)
  url.pathname = `/${databaseName}`
  return url.toString()
}

function assertDisposableScratch(databaseName: string): void {
  if (!provisioningUrl) {
    throw new Error(
      'MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL is required: the capture proofs never create or drop databases on the shared DATABASE_URL instance'
    )
  }
  if (!databaseName.startsWith(DISPOSABLE_SCRATCH_PREFIX)) {
    throw new Error(
      `Refusing to create or drop "${databaseName}": capture scratch databases must carry the "${DISPOSABLE_SCRATCH_PREFIX}" prefix`
    )
  }
}

async function dropScratchDatabase(): Promise<void> {
  if (!scratchDatabase) return
  assertDisposableScratch(scratchDatabase)
  const admin = postgres(urlForDatabase('postgres'), { max: 1, onnotice: () => {} })
  try {
    await admin.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  } finally {
    await admin.end()
  }
}

describe.skipIf(!provisioningUrl)('migration snapshot capture domains', () => {
  beforeAll(async () => {
    scratchDatabase = `capture_test_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`
    assertDisposableScratch(scratchDatabase)
    const admin = postgres(urlForDatabase('postgres'), { max: 1, onnotice: () => {} })
    try {
      await admin.unsafe(`create database "${scratchDatabase}"`)
    } finally {
      await admin.end()
    }
    connection = createDatabase(urlForDatabase(scratchDatabase))
    await migrate(connection.db, {
      migrationsFolder: `${import.meta.dir}/../../drizzle`,
    })
  }, 120_000)

  afterAll(async () => {
    try {
      await connection?.close()
    } catch {
      // Setup never opened a connection; the scratch drop below still runs.
    }
    await dropScratchDatabase()
  })

  test('inventories the added families from owned rows; unsupported and absent domains stay explicit', async () => {
    const { artifact, destination, grantId, owner, source } = await seedGrant()
    const node = await seedRuntimeNode(source.id, owner.userId)
    const { ciphertext, nonce, replica } = await seedReplica(source.id)

    const result = await captureMigrationSnapshot(database(), {
      identity: identity('snapshot-domains'),
      requestedDomains: [
        'artifactReferenceGrants',
        'contentReplicas',
        'leadTurnRuntime',
        'nativeSessions',
        'runtimeNodes',
        'taskSubmissions',
      ],
    })

    // Exact captured facts for the rows this file owns.
    expect(grantRecordOf(result.document, grantId)).toEqual({
      artifactId: artifact.id,
      audienceWorkspaceId: destination.id,
      checksumSha256: CHECKSUM,
      family: 'artifactReferenceGrants',
      grantId,
      revoked: false,
      revision: 1,
      sourceWorkspaceId: source.id,
      version: 1,
    })
    expect(result.document.sections.runtimeNodes?.records).toContainEqual({
      family: 'runtimeNodes',
      kind: 'local_device',
      pairingState: 'paired',
      platform: 'darwin',
      revoked: false,
      runtimeNodeId: node.id,
      softwareVersion: '1.0.0',
      workspaceId: source.id,
    })
    expect(result.document.sections.contentReplicas?.records).toContainEqual({
      availability: 'available',
      contentRefId: replica.contentRefId,
      deleted: false,
      digestSha256: CHECKSUM,
      family: 'contentReplicas',
      replicaId: replica.id,
      replicaKind: 'agent_hq_e2ee_sync',
      revision: 1,
      schemaVersion: 1,
      workspaceId: source.id,
    })
    // Retained replicas travel as metadata only: the sealed bytes and nonce
    // are never part of the snapshot document.
    const serialized = JSON.stringify(result.document)
    expect(serialized).not.toContain(ciphertext)
    expect(serialized).not.toContain(nonce)

    // Supported durable families are present even when the owned database has
    // no rows for them; native sessions are not owned here and stay unknown.
    for (const family of ['leadTurnRuntime', 'taskSubmissions'] as const) {
      expect(result.document.sections[family]?.records).toEqual([])
    }
    expect(result.domains).toContainEqual({
      domain: 'nativeSessions',
      status: 'unknown',
      unknownReason: 'unsupported_family',
    })
    expect(result.document.sections.nativeSessions).toBeUndefined()
    expect(MIGRATION_SNAPSHOT_CAPTURE_SUPPORTED_FAMILIES).toContain('nativeSessions')
    expect(MIGRATION_SNAPSHOT_UNSUPPORTED_DOMAINS).toContain('nativeSessions')

    // Capture is bounded and read-only by construction.
    expect(MIGRATION_SNAPSHOT_CAPTURE_TRANSACTION_CONFIG).toEqual({
      accessMode: 'read only',
      isolationLevel: 'repeatable read',
    })
    for (const capturedSection of Object.values(result.document.sections)) {
      expect(capturedSection.truncated).toBe(false)
      expect(capturedSection.records.length).toBeLessThanOrEqual(capturedSection.limit)
    }

    // An unrequested family is absent, not empty, and the comparator must say
    // so rather than call the partial document complete.
    const partial = await captureMigrationSnapshot(database(), {
      identity: identity('snapshot-domains-partial'),
      requestedDomains: ['artifactReferenceGrants'],
    })
    expect(Object.keys(partial.document.sections)).toEqual(['artifactReferenceGrants'])
    const partialComparison = compareMigrationSnapshots({
      after: result.document,
      before: partial.document,
    })
    expect(partialComparison.verdict).not.toBe('identical')
    expect(partialComparison.counts.byClass?.unknown_domain).toBeGreaterThan(0)
  })

  test('repeat reads are byte-identical and the wall clock is never emitted', async () => {
    await seedGrant()
    const first = await captureMigrationSnapshot(database(), {
      identity: identity('snapshot-repeat'),
      requestedDomains: ['artifactReferenceGrants', 'runtimeNodes'],
    })
    const second = await captureMigrationSnapshot(database(), {
      identity: identity('snapshot-repeat'),
      requestedDomains: ['artifactReferenceGrants', 'runtimeNodes'],
    })
    expect(JSON.stringify(second.document)).toBe(JSON.stringify(first.document))

    // The decision clock is an input, never an output: a different wall clock
    // over unchanged rows serializes identically.
    const laterClock = await captureMigrationSnapshot(database(), {
      identity: identity('snapshot-repeat', new Date('2030-12-31T23:59:59.000Z')),
      requestedDomains: ['artifactReferenceGrants', 'runtimeNodes'],
    })
    expect(JSON.stringify(laterClock.document)).toBe(JSON.stringify(first.document))

    // Exact source/profile/time provenance: identity carries exactly the
    // pinned profile version, rehearsal/source and snapshot id.
    expect(first.document.identity).toEqual({
      formatVersion: 1,
      rehearsalId: 'rehearsal-domains',
      snapshotId: 'snapshot-repeat',
      source: 'integration',
    })
    expect(JSON.stringify(first.document)).not.toContain('2026-02-01T00:00:00.000Z')
  })

  test('comparator resolves added families by stable identity: remap, duplicate collision, digest drift, revocation', async () => {
    const { grantId, owner, source } = await seedGrant()
    const thirdOwner = await temporaryUser('third-audience')
    const { workspace: thirdAudience } = await createWorkspaceWithOwner(database(), {
      idempotencyKey: `snapshot-domains-third-${crypto.randomUUID()}`,
      name: 'Snapshot domains third audience',
      owner: thirdOwner,
    })
    const { replica } = await seedReplica(source.id)
    const domains = ['artifactReferenceGrants', 'contentReplicas'] as const
    const before = await captureMigrationSnapshot(database(), {
      identity: identity('snapshot-mutations'),
      requestedDomains: [...domains],
    })
    const grantRecord = grantRecordOf(before.document, grantId)!

    // A duplicate stable identity is reported as such, never silently merged.
    const duplicatedSection: MigrationSnapshotSection = {
      limit: before.document.sections.artifactReferenceGrants!.limit,
      records: [...before.document.sections.artifactReferenceGrants!.records, grantRecord],
      truncated: false,
    }
    const duplicateComparison = compareMigrationSnapshots({
      after: {
        identity: before.document.identity,
        sections: { artifactReferenceGrants: duplicatedSection },
      },
      before: before.document,
    })
    expect(
      duplicateComparison.findings.some(
        (finding) =>
          finding.family === 'artifactReferenceGrants' &&
          finding.findingClass === 'duplicated_record'
      )
    ).toBe(true)

    // A conflicting duplicate (same id, different content) is quarantined as a
    // whole: no copy may win by input order.
    const conflictingSection: MigrationSnapshotSection = {
      limit: before.document.sections.artifactReferenceGrants!.limit,
      records: [
        ...before.document.sections.artifactReferenceGrants!.records,
        { ...grantRecord, version: 2 },
      ],
      truncated: false,
    }
    const conflictingComparison = compareMigrationSnapshots({
      after: {
        identity: before.document.identity,
        sections: { artifactReferenceGrants: conflictingSection },
      },
      before: before.document,
    })
    expect(
      conflictingComparison.findings.some(
        (finding) =>
          finding.family === 'artifactReferenceGrants' &&
          finding.findingClass === 'quarantined_record' &&
          finding.detail.reason === 'conflicting_duplicate'
      )
    ).toBe(true)

    // Digest drift: the content checksum is a digest field, not an attribute.
    await database()
      .update(artifactReferenceGrants)
      .set({ checksumSha256: OTHER_CHECKSUM })
      .where(eq(artifactReferenceGrants.grantId, grantId))
    const digestAfter = await captureMigrationSnapshot(database(), {
      identity: identity('snapshot-mutations'),
      requestedDomains: [...domains],
    })
    const digestComparison = compareMigrationSnapshots({
      after: digestAfter.document,
      before: before.document,
    })
    expect(digestComparison.verdict).toBe('divergent')
    expect(digestComparison.findings).toContainEqual(
      expect.objectContaining({
        detail: expect.objectContaining({ field: 'checksumSha256' }),
        family: 'artifactReferenceGrants',
        findingClass: 'digest_drift',
        stableId: grantId,
      })
    )

    // Link collision: a moved audience is a remap of the same identity.
    await database()
      .update(artifactReferenceGrants)
      .set({ audienceWorkspaceId: thirdAudience.id, checksumSha256: CHECKSUM })
      .where(eq(artifactReferenceGrants.grantId, grantId))
    const remapAfter = await captureMigrationSnapshot(database(), {
      identity: identity('snapshot-mutations'),
      requestedDomains: [...domains],
    })
    const remapComparison = compareMigrationSnapshots({
      after: remapAfter.document,
      before: before.document,
    })
    expect(remapComparison.findings).toContainEqual(
      expect.objectContaining({
        detail: expect.objectContaining({ field: 'audienceWorkspaceId' }),
        family: 'artifactReferenceGrants',
        findingClass: 'remapped_record',
        stableId: grantId,
      })
    )
    expect(remapAfter.document.sections.artifactReferenceGrants?.records).toContainEqual(
      expect.objectContaining({ audienceWorkspaceId: thirdAudience.id, grantId })
    )

    // Revocation is the grant's own state: an attribute change, not a digest.
    await revokeArtifactReferenceGrant(database(), source.id, owner, grantId)
    const revokedAfter = await captureMigrationSnapshot(database(), {
      identity: identity('snapshot-mutations'),
      requestedDomains: [...domains],
    })
    expect(grantRecordOf(revokedAfter.document, grantId)?.revoked).toBe(true)
    const revokedComparison = compareMigrationSnapshots({
      after: revokedAfter.document,
      before: before.document,
    })
    expect(revokedComparison.findings).toContainEqual(
      expect.objectContaining({
        detail: expect.objectContaining({ field: 'revoked' }),
        family: 'artifactReferenceGrants',
        findingClass: 'changed_attribute',
        stableId: grantId,
      })
    )

    // Retained replicas drift by digest the same way.
    await database()
      .update(contentReplicas)
      .set({ digestSha256: OTHER_CHECKSUM })
      .where(eq(contentReplicas.id, replica.id))
    const replicaAfter = await captureMigrationSnapshot(database(), {
      identity: identity('snapshot-mutations'),
      requestedDomains: [...domains],
    })
    const replicaComparison = compareMigrationSnapshots({
      after: replicaAfter.document,
      before: before.document,
    })
    expect(replicaComparison.findings).toContainEqual(
      expect.objectContaining({
        detail: expect.objectContaining({ field: 'digestSha256' }),
        family: 'contentReplicas',
        findingClass: 'digest_drift',
        stableId: replica.id,
      })
    )
  })

  test('the pinned contract still reports active-attempt ownership conflicts and lost read state', async () => {
    const base = {
      formatVersion: 1 as const,
      rehearsalId: 'rehearsal-domains',
      snapshotId: 'snapshot-contract',
      source: 'integration',
    }

    // Attempt 2 is the active attempt on both sides; its owner move is an
    // ownership conflict, not a plain remap.
    const ownership = compareMigrationSnapshots({
      after: {
        identity: base,
        sections: { executionAttempts: section([attempt(1, 'node-a'), attempt(2, 'node-b')]) },
      },
      before: {
        identity: base,
        sections: { executionAttempts: section([attempt(1, 'node-a'), attempt(2, 'node-a')]) },
      },
    })
    expect(ownership.findings).toContainEqual(
      expect.objectContaining({
        family: 'executionAttempts',
        findingClass: 'conflicting_attempt_owner',
      })
    )

    // A denied-user view is a regression of the read frontier.
    const readStateComparison = compareMigrationSnapshots({
      after: {
        identity: base,
        sections: { readState: section([readState(4)]) },
      },
      before: {
        identity: base,
        sections: { readState: section([readState(10)]) },
      },
    })
    expect(readStateComparison.findings).toContainEqual(
      expect.objectContaining({ family: 'readState', findingClass: 'lost_read_state' })
    )
  })

  test('composes the runtime-owned session inventory through the injected canonical source', async () => {
    const captured = await captureMigrationSnapshot(database(), {
      identity: identity('snapshot-native'),
      nativeSessionInventory: {
        listRuntimeSessions: async () => ({
          items: [
            runtimeSession({
              agentProfileId: 'prf-1',
              agentProfileVersion: 2,
              id: 'sess-z',
              lifecycle: 'active',
            }),
            runtimeSession({ id: 'sess-a' }),
          ],
        }),
      },
      requestedDomains: ['nativeSessions'],
    })
    expect(captured.domains).toEqual([
      { domain: 'nativeSessions', status: 'captured', unknownReason: null },
    ])
    expect(
      captured.document.sections.nativeSessions?.records.map((record) => record.sessionRef)
    ).toEqual(['sess-a', 'sess-z'])
    expect(captured.document.sections.nativeSessions?.records).toContainEqual(
      expect.objectContaining({
        agentProfileId: 'prf-1',
        agentProfileVersion: 2,
        lifecycle: 'active',
        sessionRef: 'sess-z',
      })
    )

    // An authoritative empty page is a captured zero, not an unknown.
    const empty = await captureMigrationSnapshot(database(), {
      identity: identity('snapshot-native-empty'),
      nativeSessionInventory: { listRuntimeSessions: async () => ({ items: [] }) },
      requestedDomains: ['nativeSessions'],
    })
    expect(empty.domains).toEqual([
      { domain: 'nativeSessions', status: 'captured', unknownReason: null },
    ])
    expect(empty.document.sections.nativeSessions?.records).toEqual([])

    // A denied read stays an explicit unknown with no section.
    const denied = await captureMigrationSnapshot(database(), {
      identity: identity('snapshot-native-denied'),
      nativeSessionInventory: {
        listRuntimeSessions: async () => {
          throw new NativeSessionInventoryError('denied', 'capability refused')
        },
      },
      requestedDomains: ['nativeSessions'],
    })
    expect(denied.domains).toEqual([
      { domain: 'nativeSessions', status: 'unknown', unknownReason: 'inventory_error' },
    ])
    expect(denied.document.sections.nativeSessions).toBeUndefined()

    // A payload outside the canonical contract is refused, never captured.
    const invalid = await captureMigrationSnapshot(database(), {
      identity: identity('snapshot-native-invalid'),
      nativeSessionInventory: {
        listRuntimeSessions: async () => ({
          items: [runtimeSession({ lifecycle: 'bogus' as RuntimeSession['lifecycle'] })],
        }),
      },
      requestedDomains: ['nativeSessions'],
    })
    expect(invalid.domains).toEqual([
      { domain: 'nativeSessions', status: 'unknown', unknownReason: 'inventory_error' },
    ])
    expect(invalid.document.sections.nativeSessions).toBeUndefined()
  })
})
