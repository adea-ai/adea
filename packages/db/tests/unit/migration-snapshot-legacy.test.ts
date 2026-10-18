import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { AgentHqDatabase, AgentHqTransaction } from '../../src/connection'

import { migrationSnapshotFamilies } from '@adea-ai/types'

import { captureMigrationSnapshot } from '../../src/migration-snapshot-capture'
import {
  captureLegacyMigrationSnapshot,
  legacyCatalogFingerprint,
  LEGACY_MIGRATION_SNAPSHOT_VERSIONS,
  LegacySnapshotRefusal,
} from '../../src/migration-snapshot-legacy'

const version = LEGACY_MIGRATION_SNAPSHOT_VERSIONS['pre-0046']!
const identity = {
  capturedAt: new Date('2026-01-05T00:00:00.000Z'),
  rehearsalId: 'unit',
  snapshotId: 'unit',
  source: 'integration',
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error
  )
}

describe('registered legacy snapshot versions', () => {
  test('every contract family is captured, absent by schema, or not read, and never two of them', () => {
    const partition = [
      ...version.capturedFamilies,
      ...Object.keys(version.absentBySchema),
      ...Object.keys(version.notInLegacyRegistry),
    ]
    expect(new Set(partition).size).toBe(partition.length)
    expect(partition.toSorted()).toEqual([...migrationSnapshotFamilies].toSorted())
  })

  test('the registry pins a sha256 for the migration digest and the catalog fingerprint', () => {
    expect(version.migrations.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(version.catalogFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(version.migrations.count).toBe(46)
    expect(version.absentBySchema.legacyAudienceQuarantine).toEqual({
      reason: expect.stringContaining('0058_legacy_audience_quarantine'),
      table: 'legacy_audience_quarantine',
    })
  })

  test('every verified table and column is a plain identifier, so it can be checked and quoted safely', () => {
    for (const [table, columns] of Object.entries(version.requiredColumns)) {
      expect(table).toMatch(/^[a-z][a-z0-9_]*$/)
      expect(columns.length).toBeGreaterThan(0)
      for (const column of columns) expect(column).toMatch(/^[a-z][a-z0-9_]*$/)
    }
  })
})

describe('legacy capture input is validated as the canonical capture validates it (no database read)', () => {
  test('an unregistered version is refused with its typed code', async () => {
    const error = await rejectionOf(
      captureLegacyMigrationSnapshot(undefined as never, { identity, versionId: 'pre-0040' })
    )
    expect(error).toBeInstanceOf(LegacySnapshotRefusal)
    expect((error as LegacySnapshotRefusal).code).toBe('unknown_version')
  })

  test('an invalid capturedAt is an input error with the canonical message, not a refusal', async () => {
    const bad = { ...identity, capturedAt: new Date('not a date') }
    const legacy = await rejectionOf(
      captureLegacyMigrationSnapshot(undefined as never, { identity: bad, versionId: 'pre-0046' })
    )
    const canonical = await rejectionOf(
      captureMigrationSnapshot(undefined as never, { identity: bad })
    )
    expect(legacy).not.toBeInstanceOf(LegacySnapshotRefusal)
    expect((legacy as Error).name).toBe('MigrationSnapshotCaptureInputError')
    expect((legacy as Error).message).toBe((canonical as Error).message)
  })

  test('an empty identity field is an input error with the canonical message', async () => {
    const bad = { ...identity, rehearsalId: ' ' }
    const legacy = await rejectionOf(
      captureLegacyMigrationSnapshot(undefined as never, { identity: bad, versionId: 'pre-0046' })
    )
    const canonical = await rejectionOf(
      captureMigrationSnapshot(undefined as never, { identity: bad })
    )
    expect((legacy as Error).message).toBe((canonical as Error).message)
  })

  test('an out-of-range limit is an input error with the canonical message', async () => {
    for (const limitPerFamily of [0, 10_001, 1.5]) {
      const legacy = await rejectionOf(
        captureLegacyMigrationSnapshot(undefined as never, {
          identity,
          limitPerFamily,
          versionId: 'pre-0046',
        })
      )
      const canonical = await rejectionOf(
        captureMigrationSnapshot(undefined as never, { identity, limitPerFamily })
      )
      expect(legacy).not.toBeInstanceOf(LegacySnapshotRefusal)
      expect((legacy as Error).message).toBe((canonical as Error).message)
    }
  })
})

// Derive historical metadata from committed local SQL and the generated schema
// snapshot. This is a query-boundary fixture; it does not run migrations or
// claim PostgreSQL catalog/transaction qualification.
function historicalCatalog() {
  const snapshot = JSON.parse(
    readFileSync(new URL('../../drizzle/meta/0045_snapshot.json', import.meta.url), 'utf8')
  ) as {
    tables: Record<
      string,
      {
        name: string
        columns: Record<
          string,
          { name: string; type: string; typeSchema?: string; notNull: boolean }
        >
      }
    >
  }
  const driverTypes: Record<string, string> = {
    bigint: 'int8',
    integer: 'int4',
    boolean: 'bool',
    'timestamp with time zone': 'timestamptz',
    'text[]': '_text',
  }
  return Object.values(snapshot.tables)
    .flatMap((table) =>
      Object.values(table.columns).map((column) => ({
        table_name: table.name,
        column_name: column.name,
        data_type: column.typeSchema
          ? 'USER-DEFINED'
          : column.type.endsWith('[]')
            ? 'ARRAY'
            : column.type,
        udt_name: driverTypes[column.type] ?? column.type,
        is_nullable: column.notNull ? 'NO' : 'YES',
      }))
    )
    .toSorted((left, right) =>
      left.table_name < right.table_name
        ? -1
        : left.table_name > right.table_name
          ? 1
          : left.column_name < right.column_name
            ? -1
            : left.column_name > right.column_name
              ? 1
              : 0
    )
}

function historicalMigrations() {
  const journal = JSON.parse(
    readFileSync(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8')
  ) as { entries: { tag: string }[] }
  const cut = journal.entries.findIndex((entry) => entry.tag === version.before)
  expect(cut).toBe(version.migrations.count)
  return journal.entries.slice(0, cut).map((entry) => ({
    hash: createHash('sha256')
      .update(readFileSync(new URL(`../../drizzle/${entry.tag}.sql`, import.meta.url)))
      .digest('hex'),
  }))
}

function legacyRecordingDatabase(
  options: {
    hashes?: { hash: string }[]
    missingColumn?: string
    extraTable?: string
    catalogDrift?: boolean
  } = {}
) {
  const catalog = historicalCatalog()
  const reads: string[] = []
  const tx = {
    execute: async (query: Parameters<PgDialect['sqlToQuery']>[0]) => {
      const compiled = new PgDialect().sqlToQuery(query)
      reads.push(compiled.sql)
      expect(compiled.sql.trimStart().startsWith('select')).toBe(true)
      if (compiled.sql.includes('select hash')) return options.hashes ?? historicalMigrations()
      if (compiled.sql.includes('select table_name, column_name from'))
        return catalog.filter(
          (row) => `${row.table_name}.${row.column_name}` !== options.missingColumn
        )
      if (compiled.sql.includes('information_schema.tables'))
        return [
          ...new Set(catalog.map((row) => row.table_name)),
          ...(options.extraTable ? [options.extraTable] : []),
        ].map((table_name) => ({ table_name }))
      if (compiled.sql.includes('data_type, udt_name'))
        return options.catalogDrift ? catalog.slice(1) : catalog
      expect(compiled.sql).toContain('frontiers')
      return []
    },
    select: () => ({
      from: () => ({ orderBy: () => ({ limit: () => ({ offset: async () => [] }) }) }),
    }),
  } as unknown as AgentHqTransaction
  const configurations: unknown[] = []
  const database = {
    transaction: async (
      operation: (transaction: AgentHqTransaction) => Promise<unknown>,
      config: unknown
    ) => {
      configurations.push(config)
      return operation(tx)
    },
  } as unknown as AgentHqDatabase
  return { database, tx, reads, configurations }
}

describe('legacy verification with committed historical metadata and recording queries', () => {
  test('matching metadata captures explicit empty sections with exact immutable provenance', async () => {
    const fixture = legacyRecordingDatabase()
    expect(await legacyCatalogFingerprint(fixture.tx)).toBe(version.catalogFingerprint)
    const result = await captureLegacyMigrationSnapshot(fixture.database, {
      identity,
      versionId: version.id,
      limitPerFamily: 2,
    })
    expect(fixture.configurations).toEqual([
      { accessMode: 'read only', isolationLevel: 'repeatable read' },
    ])
    expect(Object.keys(result.document.sections).toSorted()).toEqual(
      [...version.capturedFamilies].toSorted()
    )
    for (const family of version.capturedFamilies)
      expect(result.document.sections[family]).toEqual({ records: [], truncated: false, limit: 2 })
    for (const family of [
      ...Object.keys(version.absentBySchema),
      ...Object.keys(version.notInLegacyRegistry),
    ])
      expect(result.document.sections).not.toHaveProperty(family)
    expect(result.provenance).toEqual({
      versionId: version.id,
      migrations: version.migrations,
      catalogFingerprint: version.catalogFingerprint,
      captured: version.capturedFamilies,
      absentBySchema: version.absentBySchema,
      notInLegacyRegistry: version.notInLegacyRegistry,
      limit: 2,
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.provenance)).toBe(true)
    expect(Object.isFrozen(result.provenance.migrations)).toBe(true)
  })

  test('missing or changed migration metadata refuses before catalog or record reads', async () => {
    for (const hashes of [
      [],
      historicalMigrations().map((row, index) => (index === 0 ? { hash: 'changed' } : row)),
    ]) {
      const fixture = legacyRecordingDatabase({ hashes })
      const error = await rejectionOf(
        captureLegacyMigrationSnapshot(fixture.database, { identity, versionId: version.id })
      )
      expect(error).toBeInstanceOf(LegacySnapshotRefusal)
      expect((error as LegacySnapshotRefusal).code).toBe('migration_metadata_mismatch')
      expect(fixture.reads).toHaveLength(1)
    }
  })

  test('a missing required column refuses before later schema and product reads', async () => {
    const fixture = legacyRecordingDatabase({ missingColumn: 'projects.visibility' })
    const error = await rejectionOf(
      captureLegacyMigrationSnapshot(fixture.database, { identity, versionId: version.id })
    )
    expect(error).toBeInstanceOf(LegacySnapshotRefusal)
    expect((error as LegacySnapshotRefusal).code).toBe('missing_required_column')
    expect((error as Error).message).toContain('app.projects.visibility')
    expect(fixture.reads).toHaveLength(2)
  })

  test('newer family tables and catalog drift refuse the historical schema claim', async () => {
    for (const options of [{ extraTable: 'artifact_reference_grants' }, { catalogDrift: true }]) {
      const fixture = legacyRecordingDatabase(options)
      const error = await rejectionOf(
        captureLegacyMigrationSnapshot(fixture.database, { identity, versionId: version.id })
      )
      expect(error).toBeInstanceOf(LegacySnapshotRefusal)
      expect((error as LegacySnapshotRefusal).code).toBe('unknown_schema_version')
      expect(fixture.reads).toHaveLength('extraTable' in options ? 3 : 4)
    }
  })

  test('inherited registry names are never historical versions', async () => {
    for (const versionId of ['__proto__', 'constructor', 'toString']) {
      const error = await rejectionOf(
        captureLegacyMigrationSnapshot(undefined as never, { identity, versionId })
      )
      expect((error as LegacySnapshotRefusal).code).toBe('unknown_version')
    }
  })
})
