import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

import { createDatabase, type DatabaseConnection } from '../../src/connection'
import {
  captureLegacyMigrationSnapshot,
  LEGACY_MIGRATION_SNAPSHOT_VERSIONS,
  LegacySnapshotRefusal,
} from '../../src/migration-snapshot-legacy'
import {
  canonicalUrl,
  createCanonicalDatabase,
  MIGRATION_ROLE,
} from '../fixtures/canonical-boundary'
import { CUTOVER_TAG, DRIZZLE_DIR, migrationsFolderBefore } from '../fixtures/cutover-rehearsal'

// The registered pre-0046 legacy capture, proved against owned disposable databases on the canonical
// role boundary (each case has its own database). The positive case captures an empty pre-0046 schema
// and checks the provenance; the negative cases each break exactly one verified property and must be
// refused, with no document. Populated before/after proofs live in migration-cutover-rehearsal.test.ts.

const provisioningUrl = process.env.MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL
const inCi = process.env.CI === 'true' || process.env.CI === '1'
const provisioned = !!provisioningUrl || inCi
const SCRATCH_PREFIX = 'rehearsal_1222L_'
const IDENTITY = {
  capturedAt: new Date('2026-01-05T00:00:00.000Z'),
  rehearsalId: 'legacy-snapshot-proof',
  snapshotId: 'legacy-snapshot',
  source: 'integration',
}

function adminUrl(database: string): string {
  if (!provisioningUrl) throw new Error('MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL is not set')
  const url = new URL(provisioningUrl)
  url.pathname = `/${database}`
  return url.toString()
}

describe.skipIf(!provisioned)('registered legacy snapshot capture (#1222)', () => {
  let admin: postgres.Sql
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 12)
  const databases: string[] = []
  const folders: string[] = []
  const connections: DatabaseConnection[] = []

  /** An owned database migrated to the registered prefix, read through the migration role. */
  async function preDatabase(label: string): Promise<DatabaseConnection> {
    const name = `${SCRATCH_PREFIX}${label}_${suffix}`
    databases.push(name)
    await createCanonicalDatabase(admin, adminUrl, name)
    const connection = createDatabase(canonicalUrl(adminUrl(name), name, MIGRATION_ROLE))
    connections.push(connection)
    const folder = migrationsFolderBefore(CUTOVER_TAG)
    folders.push(folder)
    await migrate(connection.db, { migrationsFolder: folder })
    return connection
  }

  /** The same database, migrated past the registered prefix (the full journal). */
  async function fullDatabase(label: string): Promise<DatabaseConnection> {
    const connection = await preDatabase(label)
    await migrate(connection.db, { migrationsFolder: DRIZZLE_DIR })
    return connection
  }

  beforeAll(() => {
    admin = postgres(adminUrl('postgres'), { max: 1, onnotice: () => {} })
  })

  afterAll(async () => {
    for (const connection of connections) await connection.close()
    for (const name of databases) {
      await admin.unsafe(`drop database if exists "${name}" with (force)`)
    }
    await admin.end()
    for (const folder of folders) rmSync(folder, { force: true, recursive: true })
  })

  test('an empty pre-0046 schema captures every registered family with provenance and no invented records', async () => {
    const connection = await preDatabase('empty')
    const result = await captureLegacyMigrationSnapshot(connection.db, {
      identity: IDENTITY,
      versionId: 'pre-0046',
    })
    const families = [...LEGACY_MIGRATION_SNAPSHOT_VERSIONS['pre-0046']!.capturedFamilies]
    expect(Object.keys(result.document.sections).toSorted()).toEqual(families.toSorted())
    for (const family of families) {
      const section = result.document.sections[family]!
      expect(section.records).toEqual([])
      expect(section.truncated).toBe(false)
    }
    expect(result.provenance.versionId).toBe('pre-0046')
    expect(result.provenance.migrations.count).toBe(46)
    expect(result.provenance.absentBySchema).toEqual({
      artifactReferenceGrants: {
        reason: expect.any(String),
        table: 'artifact_reference_grants',
      },
    })
    expect(Object.keys(result.provenance.notInLegacyRegistry)).toEqual(['nativeSessions'])
    expect(result.document.identity).toEqual({
      formatVersion: 1,
      rehearsalId: IDENTITY.rehearsalId,
      snapshotId: IDENTITY.snapshotId,
      source: IDENTITY.source,
    })
  })

  test('an unregistered version id is refused before any database read', async () => {
    const error = await captureLegacyMigrationSnapshot(undefined as never, {
      identity: IDENTITY,
      versionId: 'post-0046',
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(LegacySnapshotRefusal)
    expect((error as LegacySnapshotRefusal).code).toBe('unknown_version')
  })

  test('a database past the registered prefix is refused on its migration metadata', async () => {
    const connection = await fullDatabase('post')
    const error = await captureLegacyMigrationSnapshot(connection.db, {
      identity: IDENTITY,
      versionId: 'pre-0046',
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(LegacySnapshotRefusal)
    expect((error as LegacySnapshotRefusal).code).toBe('migration_metadata_mismatch')
  })

  test('a missing required column is refused by name, with no document', async () => {
    const connection = await preDatabase('missing-column')
    await connection.db.execute(sql`alter table app.projects drop column visibility`)
    const error = await captureLegacyMigrationSnapshot(connection.db, {
      identity: IDENTITY,
      versionId: 'pre-0046',
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(LegacySnapshotRefusal)
    expect((error as LegacySnapshotRefusal).code).toBe('missing_required_column')
    expect((error as LegacySnapshotRefusal).message).toContain('app.projects.visibility')
  })

  test('catalog drift from the registered version is refused as an unknown schema version', async () => {
    const connection = await preDatabase('drift')
    await connection.db.execute(sql`alter table app.projects add column drift_probe integer`)
    const error = await captureLegacyMigrationSnapshot(connection.db, {
      identity: IDENTITY,
      versionId: 'pre-0046',
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(LegacySnapshotRefusal)
    expect((error as LegacySnapshotRefusal).code).toBe('unknown_schema_version')
  })

  test('altered applied-migration metadata is refused on its digest', async () => {
    const connection = await preDatabase('tampered')
    await connection.db.execute(
      sql`update drizzle.__drizzle_migrations set hash = 'tampered' where id = (select max(id) from drizzle.__drizzle_migrations)`
    )
    const error = await captureLegacyMigrationSnapshot(connection.db, {
      identity: IDENTITY,
      versionId: 'pre-0046',
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(LegacySnapshotRefusal)
    expect((error as LegacySnapshotRefusal).code).toBe('migration_metadata_mismatch')
  })
})
