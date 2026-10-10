import { describe, expect, test } from 'bun:test'

import { migrationSnapshotFamilies } from '@adea-ai/types'

import { captureMigrationSnapshot } from '../../src/migration-snapshot-capture'
import {
  captureLegacyMigrationSnapshot,
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
