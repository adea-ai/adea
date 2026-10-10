import { describe, expect, test } from 'bun:test'

import { migrationSnapshotFamilies } from '@adea-ai/types'

import {
  captureLegacyMigrationSnapshot,
  LEGACY_MIGRATION_SNAPSHOT_VERSIONS,
  legacyCapturedFamilies,
  LegacySnapshotRefusal,
} from '../../src/migration-snapshot-legacy'

const version = LEGACY_MIGRATION_SNAPSHOT_VERSIONS['pre-0046']!
const identity = {
  capturedAt: new Date('2026-01-05T00:00:00.000Z'),
  rehearsalId: 'unit',
  snapshotId: 'unit',
  source: 'integration',
}

describe('registered legacy snapshot versions', () => {
  test('every contract family is captured, absent by schema, or not read, and never two of them', () => {
    const captured = legacyCapturedFamilies(version)
    const absent = Object.keys(version.absentBySchema)
    const unread = Object.keys(version.notInLegacyRegistry)
    const partition = [...captured, ...absent, ...unread]
    expect(new Set(partition).size).toBe(partition.length)
    expect(partition.toSorted()).toEqual([...migrationSnapshotFamilies].toSorted())
  })

  test('the registry pins a sha256 for the migration digest and the catalog fingerprint', () => {
    expect(version.migrations.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(version.catalogFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(version.migrations.count).toBe(46)
  })

  test('every column a reader names is a plain snake_case identifier, so it can be quoted safely', () => {
    for (const family of legacyCapturedFamilies(version)) {
      for (const [table, columns] of Object.entries(version.readers[family]!.reads)) {
        expect(table).toMatch(/^[a-z][a-z0-9_]*$/)
        expect(columns.length).toBeGreaterThan(0)
        for (const column of columns) expect(column).toMatch(/^[a-z][a-z0-9_]*$/)
      }
    }
  })
})

describe('legacy capture refusals (no database read)', () => {
  test('an unregistered version is refused with its typed code', async () => {
    const error = await captureLegacyMigrationSnapshot(undefined as never, {
      identity,
      versionId: 'pre-0040',
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(LegacySnapshotRefusal)
    expect((error as LegacySnapshotRefusal).code).toBe('unknown_version')
  })

  test('an empty identity field is an input error, not a silent default', async () => {
    const error = await captureLegacyMigrationSnapshot(undefined as never, {
      identity: { ...identity, rehearsalId: ' ' },
      versionId: 'pre-0046',
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(LegacySnapshotRefusal)
    expect((error as Error).message).toContain('identity.rehearsalId')
  })
})

describe('historical invitation state derivation', () => {
  const invitation = version.readers.invitations!
  const now = new Date('2026-01-05T00:00:00.000Z')
  const base = {
    accepted_at: null,
    id: 'inv',
    invited_by_user_id: 'u',
    revoked_at: null,
    role: 'member',
    workspace_id: 'w',
  }

  test('a pending invitation is pending until its expiry instant, from driver text timestamps', () => {
    const record = invitation.toRecord(
      { ...base, expires_at: '2026-01-06T00:00:00.000Z' },
      now
    ) as { state: string }
    expect(record.state).toBe('pending')
  })

  test('an expired invitation is expired at and after its expiry instant', () => {
    const record = invitation.toRecord(
      { ...base, expires_at: '2026-01-05T00:00:00.000Z' },
      now
    ) as { state: string }
    expect(record.state).toBe('expired')
  })

  test('acceptance outranks revocation and expiry', () => {
    const record = invitation.toRecord(
      {
        ...base,
        accepted_at: '2026-01-02T00:00:00.000Z',
        expires_at: '2025-01-01T00:00:00.000Z',
        revoked_at: '2026-01-03T00:00:00.000Z',
      },
      now
    ) as { state: string }
    expect(record.state).toBe('accepted')
  })
})
