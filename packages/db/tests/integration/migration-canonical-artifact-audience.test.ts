import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

import type { ArtifactReferenceTarget, UserPrincipalRef } from '@adea-ai/types'

import {
  registerArtifactReferenceGrant,
  revokeArtifactReferenceGrant,
} from '../../src/artifact-reference-grants'
import {
  publishArtifactReference,
  retrieveArtifactReference,
} from '../../src/artifact-reference-service'
import { createArtifact } from '../../src/artifacts'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createTemporaryUserSession } from '../../src/identity'
import { resolveMigrationSnapshotCaptureDomains } from '../../src/migration-snapshot-capture'
import { createWorkspaceWithOwner } from '../../src/workspaces'
import { canonicalChainFolders } from '../fixtures/canonical-chain'
import { DRIZZLE_DIR } from '../fixtures/cutover-rehearsal'

// Audience-side artifact publication and retrieval after the canonical cutover (#1222 acceptance,
// backed by the #1216 service). The decisions come from the real service and policy on main; the
// fixture below only creates principals, workspaces, artifacts and grants through the product
// functions. No authorization logic is copied here. Source pins are in
// tests/fixtures/artifact-reference-pins.json and are verified before any decision runs.
//
// Not proved here: ambiguous-audience quarantine (no product surface exists) and any audience
// decision beyond the registered grant and audience list. Artifact capture is not a migration
// snapshot family yet: #1219's capture domains are tracked separately and this file reports the
// artifact-grant domain as unknown until that proof lands.

const PINS_PATH = `${import.meta.dir}/../fixtures/artifact-reference-pins.json`
const REPOSITORY_ROOT = `${import.meta.dir}/../../../..`

type Pins = {
  dependency: { pullRequest: number; status: string; mergeCommit: string }
  sourceCommit: string
  files: Record<string, { sha256: string }>
}

const provisioningUrl = process.env.MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL
const inCi = process.env.CI === 'true' || process.env.CI === '1'
const SCRATCH_PREFIX = 'rehearsal_1246_'
const CHECKSUM = 'c'.repeat(64)
const LOCATION_MARKER = 'outputs/'

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

describe('audience-side pins (no database)', () => {
  test('the source is the merged #1246 commit, byte for byte, and the dependency is declared merged', () => {
    const pins = JSON.parse(readFileSync(PINS_PATH, 'utf8')) as Pins
    expect(pins.dependency).toMatchObject({ pullRequest: 1246, status: 'merged' })
    expect(pins.dependency.mergeCommit).toBe(pins.sourceCommit)
    for (const [path, pin] of Object.entries(pins.files)) {
      const digest = sha256(readFileSync(`${REPOSITORY_ROOT}/${path}`))
      expect({ path, digest }).toEqual({ path, digest: pin.sha256 })
    }
  })

  test('the artifact-grant capture domain is reported unknown, never an empty capture, until #1219 lands', () => {
    expect(resolveMigrationSnapshotCaptureDomains(['artifactReferenceGrants'])).toEqual([
      {
        domain: 'artifactReferenceGrants',
        status: 'unknown',
        unknownReason: 'unrecognized_domain',
      },
    ])
  })
})

function adminUrl(database: string): string {
  if (!provisioningUrl) throw new Error('MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL is not set')
  const url = new URL(provisioningUrl)
  url.pathname = `/${database}`
  return url.toString()
}

async function adminExecute(statement: string): Promise<void> {
  const admin = postgres(adminUrl('postgres'), { max: 1, onnotice: () => {} })
  try {
    await admin.unsafe(statement)
  } finally {
    await admin.end()
  }
}

function exactTarget(
  artifactId: string,
  sourceWorkspaceId: string,
  audienceWorkspaceId: string
): ArtifactReferenceTarget {
  return {
    artifactId,
    audienceWorkspaceId,
    checksumSha256: CHECKSUM,
    sourceWorkspaceId,
    version: 1,
  }
}

describe.skipIf(!provisioningUrl && !inCi)(
  'audience-side artifact publication and retrieval after canonical cutover',
  () => {
    let connection: DatabaseConnection
    let scratch: string
    let chainRoot: string | undefined
    let recordedAfterCutover = -1
    let expectedAfterCutover = -1

    beforeAll(async () => {
      scratch = `${SCRATCH_PREFIX}${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`
      await adminExecute(`create database "${scratch}"`)
      connection = createDatabase(adminUrl(scratch))
      // Main through 0046, then the canonical cutover: the pinned #1229, #1230, #1232 chain.
      await migrate(connection.db, { migrationsFolder: DRIZZLE_DIR })
      const chain = canonicalChainFolders()
      chainRoot = chain.root
      expectedAfterCutover = chain.fullEntries.length
      await migrate(connection.db, { migrationsFolder: chain.full })
      const rows = await connection.db.execute<{ count: number }>(
        sql`select count(*)::int as count from drizzle.__drizzle_migrations`
      )
      recordedAfterCutover = rows[0]?.count ?? -1
    })

    afterAll(async () => {
      if (connection) await connection.close()
      if (scratch) await adminExecute(`drop database if exists "${scratch}" with (force)`)
      if (chainRoot) rmSync(chainRoot, { recursive: true, force: true })
    })

    async function principal(name: string): Promise<UserPrincipalRef> {
      const session = await createTemporaryUserSession(connection.db, {
        credentialDigest: `audience-${name}-${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 600_000),
      })
      return session.principal
    }

    async function fixture(name: string) {
      const owner = await principal(`${name}-owner`)
      const destinationOwner = await principal(`${name}-destination`)
      const thirdOwner = await principal(`${name}-third`)
      const { workspace: source } = await createWorkspaceWithOwner(connection.db, {
        idempotencyKey: `audience-${name}-source-${crypto.randomUUID()}`,
        name: `${name} source`,
        owner,
      })
      const { workspace: destination } = await createWorkspaceWithOwner(connection.db, {
        idempotencyKey: `audience-${name}-destination-${crypto.randomUUID()}`,
        name: `${name} destination`,
        owner: destinationOwner,
      })
      const { workspace: third } = await createWorkspaceWithOwner(connection.db, {
        idempotencyKey: `audience-${name}-third-${crypto.randomUUID()}`,
        name: `${name} third`,
        owner: thirdOwner,
      })
      const artifact = await createArtifact(connection.db, source.id, owner, {
        availability: 'available',
        checksumSha256: CHECKSUM,
        filename: 'result.txt',
        location: { reference: `${LOCATION_MARKER}${crypto.randomUUID()}`, type: 'object_store' },
        mediaType: 'text/plain',
        sizeBytes: 32,
        sourceArtifactRef: `runtime-output:${crypto.randomUUID()}`,
        sourcePrincipal: { kind: 'system', systemId: 'job-runner' },
      })
      return { artifact, destination, owner, source, third }
    }

    async function register(
      sourceWorkspaceId: string,
      owner: UserPrincipalRef,
      artifactId: string,
      audienceWorkspaceId: string,
      expiresAt: string | null
    ) {
      const grantId = `audience-grant-${crypto.randomUUID()}`
      await registerArtifactReferenceGrant(connection.db, sourceWorkspaceId, owner, {
        artifactId,
        audienceWorkspaceId,
        checksumSha256: CHECKSUM,
        expiresAt,
        grantId,
        version: 1,
      })
      return { grant: { grantId, revision: 1 } }
    }

    async function artifactRow(artifactId: string): Promise<Record<string, unknown>[]> {
      return (await connection.db.execute<Record<string, unknown>>(
        sql`select * from app.artifacts where id = ${artifactId} order by id`
      )) as unknown as Record<string, unknown>[]
    }

    test('the canonical cutover records every migration exactly once before any audience decision', () => {
      expect(recordedAfterCutover).toBe(expectedAfterCutover)
    })

    test('permitted audience: publication and retrieval deliver the exact target, and the evidence carries no location', async () => {
      const { artifact, destination, owner, source } = await fixture('permitted')
      const { grant } = await register(source.id, owner, artifact.id, destination.id, null)
      const exact = exactTarget(artifact.id, source.id, destination.id)

      const publication = await publishArtifactReference(
        connection.db,
        { grant, target: exact },
        owner
      )
      expect(publication.decision).toEqual({
        action: 'publish',
        ok: true,
        stage: 'publication',
        target: exact,
      })
      expect(Object.keys(publication.evidence ?? {}).toSorted()).toEqual([
        'availability',
        'checksumSha256',
        'deletionState',
        'id',
        'sensitivity',
        'version',
        'workspaceId',
      ])

      const delivery = await retrieveArtifactReference(connection.db, {
        grant,
        requestingWorkspaceId: destination.id,
        target: exact,
      })
      expect(delivery.decision).toEqual({
        action: 'deliver',
        ok: true,
        stage: 'retrieval',
        target: exact,
      })
      expect(JSON.stringify([publication.decision, delivery.decision])).not.toContain(
        LOCATION_MARKER
      )
    })

    test('wrong audience: retrieval by another workspace is denied, and a publication retargeted to it is held', async () => {
      const { artifact, destination, owner, source, third } = await fixture('wrong-audience')
      const { grant } = await register(source.id, owner, artifact.id, destination.id, null)
      const exact = exactTarget(artifact.id, source.id, destination.id)

      const denied = await retrieveArtifactReference(connection.db, {
        grant,
        requestingWorkspaceId: third.id,
        target: exact,
      })
      expect(denied.decision).toEqual({
        action: 'deny',
        ok: false,
        reason: 'audience_not_authorized',
        stage: 'retrieval',
      })

      const retargeted = exactTarget(artifact.id, source.id, third.id)
      const held = await publishArtifactReference(
        connection.db,
        { grant, target: retargeted },
        owner
      )
      expect(held.decision).toEqual({
        action: 'hold',
        ok: false,
        producerEffect: 'unaffected',
        reason: 'audience_not_authorized',
        stage: 'publication',
      })
    })

    test('revoked grant: publication is held and retrieval is denied with grant_revoked', async () => {
      const { artifact, destination, owner, source } = await fixture('revoked')
      const { grant } = await register(source.id, owner, artifact.id, destination.id, null)
      const exact = exactTarget(artifact.id, source.id, destination.id)
      const revoked = await revokeArtifactReferenceGrant(
        connection.db,
        source.id,
        owner,
        grant.grantId
      )
      expect(revoked?.revoked).toBe(true)

      const held = await publishArtifactReference(connection.db, { grant, target: exact }, owner)
      expect(held.decision).toEqual({
        action: 'hold',
        ok: false,
        producerEffect: 'unaffected',
        reason: 'grant_revoked',
        stage: 'publication',
      })
      const denied = await retrieveArtifactReference(connection.db, {
        grant,
        requestingWorkspaceId: destination.id,
        target: exact,
      })
      expect(denied.decision).toEqual({
        action: 'deny',
        ok: false,
        reason: 'grant_revoked',
        stage: 'retrieval',
      })
    })

    test('expired grant: decisions before expiry deliver; the same grant past expiry is held and denied with grant_expired', async () => {
      const { artifact, destination, owner, source } = await fixture('expired')
      const expiresAt = new Date(Date.now() + 2 * 60 * 60_000).toISOString()
      const { grant } = await register(source.id, owner, artifact.id, destination.id, expiresAt)
      const exact = exactTarget(artifact.id, source.id, destination.id)
      const beforeExpiry = () => new Date(Date.parse(expiresAt) - 1_000).toISOString()
      const afterExpiry = () => new Date(Date.parse(expiresAt) + 1_000).toISOString()

      const live = await publishArtifactReference(
        connection.db,
        { grant, target: exact },
        owner,
        beforeExpiry
      )
      expect(live.decision).toEqual({
        action: 'publish',
        ok: true,
        stage: 'publication',
        target: exact,
      })
      const lateHold = await publishArtifactReference(
        connection.db,
        { grant, target: exact },
        owner,
        afterExpiry
      )
      expect(lateHold.decision).toEqual({
        action: 'hold',
        ok: false,
        producerEffect: 'unaffected',
        reason: 'grant_expired',
        stage: 'publication',
      })
      const delivered = await retrieveArtifactReference(
        connection.db,
        { grant, requestingWorkspaceId: destination.id, target: exact },
        beforeExpiry
      )
      expect(delivered.decision).toEqual({
        action: 'deliver',
        ok: true,
        stage: 'retrieval',
        target: exact,
      })
      const expired = await retrieveArtifactReference(
        connection.db,
        { grant, requestingWorkspaceId: destination.id, target: exact },
        afterExpiry
      )
      expect(expired.decision).toEqual({
        action: 'deny',
        ok: false,
        reason: 'grant_expired',
        stage: 'retrieval',
      })
    })

    test('unchanged artifact identity: every decision leaves the artifact row and its evidence identical', async () => {
      const { artifact, destination, owner, source } = await fixture('identity')
      const before = await artifactRow(artifact.id)
      const { grant } = await register(source.id, owner, artifact.id, destination.id, null)
      const exact = exactTarget(artifact.id, source.id, destination.id)
      const publication = await publishArtifactReference(
        connection.db,
        { grant, target: exact },
        owner
      )
      const delivery = await retrieveArtifactReference(connection.db, {
        grant,
        requestingWorkspaceId: destination.id,
        target: exact,
      })
      const after = await artifactRow(artifact.id)

      expect(after).toEqual(before)
      expect(after).toHaveLength(1)
      expect(publication.evidence).toMatchObject({
        checksumSha256: CHECKSUM,
        id: artifact.id,
        version: 1,
        workspaceId: source.id,
      })
      expect(delivery.evidence?.id).toBe(artifact.id)
      expect(publication.decision).toMatchObject({ target: exact })
      expect(delivery.decision).toMatchObject({ target: exact })
    })
  }
)
