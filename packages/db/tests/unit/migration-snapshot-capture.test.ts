import { describe, expect, test } from 'bun:test'

import type { AgentHqDatabase } from '../../src/connection'
import {
  collectBoundedRecords,
  captureMigrationSnapshot,
  migrationSnapshotEventPayloadDigest,
  MigrationSnapshotCaptureInputError,
  MIGRATION_SNAPSHOT_CAPTURE_SUPPORTED_FAMILIES,
  MIGRATION_SNAPSHOT_CAPTURE_TRANSACTION_CONFIG,
  PAYLOAD_CANONICAL_MAX_DEPTH,
  resolveMigrationSnapshotCaptureDomains,
  type MigrationSnapshotRecord,
} from '../../src/migration-snapshot-capture'
import { migrationSnapshotFamilies } from '@adea-ai/types'

// The capture's pure surface, tested without any database: domain resolution,
// bounded pagination, payload digests, and the input validation that must run
// before a database handle is ever touched. The database-backed behavior —
// consistency, determinism against real rows, comparator findings — is proven
// in tests/integration/migration-snapshot-capture.test.ts.

const IDENTITY = {
  capturedAt: new Date('2026-01-15T00:00:00.000Z'),
  rehearsalId: 'rehearsal-unit',
  snapshotId: 'snapshot-unit',
  source: 'unit',
} as const

// ─── Domain resolution ───────────────────────────────────────────────────────

describe('resolveMigrationSnapshotCaptureDomains', () => {
  test('without a request every supported family is captured', () => {
    const domains = resolveMigrationSnapshotCaptureDomains(undefined)
    expect(domains.map((domain) => domain.domain)).toEqual(
      [...MIGRATION_SNAPSHOT_CAPTURE_SUPPORTED_FAMILIES].toSorted()
    )
    expect(domains).toEqual(
      domains.map(() => expect.objectContaining({ status: 'captured', unknownReason: null }))
    )
  })

  test('a name outside the snapshot contract is unrecognized, not captured', () => {
    const domains = resolveMigrationSnapshotCaptureDomains(['workspaces', 'runtimeNodes'])
    expect(domains).toEqual([
      { domain: 'runtimeNodes', status: 'unknown', unknownReason: 'unrecognized_domain' },
      { domain: 'workspaces', status: 'captured', unknownReason: null },
    ])
  })

  test('every contract family name resolves to captured today', () => {
    const domains = resolveMigrationSnapshotCaptureDomains(migrationSnapshotFamilies)
    for (const family of migrationSnapshotFamilies) {
      expect(domains).toContainEqual({
        domain: family,
        status: 'captured',
        unknownReason: null,
      })
    }
  })

  test('duplicate requests collapse to one status and stay sorted', () => {
    const domains = resolveMigrationSnapshotCaptureDomains([
      'workspaces',
      'agents',
      'workspaces',
      'tasks',
    ])
    expect(domains.map((domain) => domain.domain)).toEqual(['agents', 'tasks', 'workspaces'])
  })

  test('an empty request captures nothing explicitly', () => {
    expect(resolveMigrationSnapshotCaptureDomains([])).toEqual([])
  })

  test('a non-string or empty domain name is an input error', () => {
    expect(() => resolveMigrationSnapshotCaptureDomains([''])).toThrow(
      MigrationSnapshotCaptureInputError
    )
    expect(() => resolveMigrationSnapshotCaptureDomains([42 as unknown as string])).toThrow(
      MigrationSnapshotCaptureInputError
    )
  })
})

// ─── Bounded pagination ──────────────────────────────────────────────────────

function workspaceRecord(id: string): MigrationSnapshotRecord {
  return {
    archived: false,
    controlPlaneWorkspaceId: id,
    family: 'workspaces',
    ownerUserId: 'owner',
    workspaceId: id,
  }
}

/** A SQL-shaped page source: ordered rows, limit, offset. */
function pagedRows(rows: readonly string[]) {
  return async (offset: number, rowsBound: number) => rows.slice(offset, offset + rowsBound)
}

describe('collectBoundedRecords', () => {
  test('an exhausted domain is complete, never truncated', async () => {
    const rows = ['wsp-1', 'wsp-2', 'wsp-3']
    const { records, truncated } = await collectBoundedRecords({
      fetchPage: pagedRows(rows),
      limit: 10,
      toRecord: workspaceRecord,
    })
    expect(truncated).toBe(false)
    expect(records.map((record) => record.family === 'workspaces' && record.workspaceId)).toEqual(
      rows
    )
  })

  test('stopping at the bound with rows left over is truncated', async () => {
    const rows = Array.from({ length: 50 }, (_, index) => `wsp-${String(index).padStart(3, '0')}`)
    const { records, truncated } = await collectBoundedRecords({
      fetchPage: pagedRows(rows),
      limit: 10,
      toRecord: workspaceRecord,
    })
    expect(truncated).toBe(true)
    expect(records).toHaveLength(10)
  })

  test('exactly filling the bound is not truncated', async () => {
    const rows = Array.from({ length: 10 }, (_, index) => `wsp-${String(index).padStart(3, '0')}`)
    const { records, truncated } = await collectBoundedRecords({
      fetchPage: pagedRows(rows),
      limit: 10,
      toRecord: workspaceRecord,
    })
    expect(truncated).toBe(false)
    expect(records).toHaveLength(10)
  })

  test('a domain spanning several pages reports truncation only when rows remain', async () => {
    const twoThousand = Array.from(
      { length: 2000 },
      (_, index) => `wsp-${String(index).padStart(4, '0')}`
    )
    const exhausted = await collectBoundedRecords({
      fetchPage: pagedRows(twoThousand.slice(0, 1200)),
      limit: 1200,
      toRecord: workspaceRecord,
    })
    expect(exhausted.truncated).toBe(false)
    expect(exhausted.records).toHaveLength(1200)

    const truncated = await collectBoundedRecords({
      fetchPage: pagedRows(twoThousand),
      limit: 1200,
      toRecord: workspaceRecord,
    })
    expect(truncated.truncated).toBe(true)
    expect(truncated.records).toHaveLength(1200)
  })

  test('records come back ordered by the comparator-style stable id, not page order', async () => {
    const rows = ['wsp-c', 'wsp-a', 'wsp-b']
    const { records } = await collectBoundedRecords({
      fetchPage: pagedRows(rows),
      limit: 10,
      toRecord: workspaceRecord,
    })
    expect(records.map((record) => record.family === 'workspaces' && record.workspaceId)).toEqual([
      'wsp-a',
      'wsp-b',
      'wsp-c',
    ])
  })

  test('an empty domain is a proven empty section, not truncation', async () => {
    const { records, truncated } = await collectBoundedRecords({
      fetchPage: pagedRows([]),
      limit: 10,
      toRecord: workspaceRecord,
    })
    expect(truncated).toBe(false)
    expect(records).toEqual([])
  })

  test('an out-of-range bound is an input error', async () => {
    for (const limit of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(
        collectBoundedRecords({
          fetchPage: pagedRows([]),
          limit,
          toRecord: workspaceRecord,
        })
      ).rejects.toThrow(MigrationSnapshotCaptureInputError)
    }
  })
})

// ─── Event payload digests ───────────────────────────────────────────────────

describe('migrationSnapshotEventPayloadDigest', () => {
  test('is key-order independent and value sensitive', () => {
    const left = migrationSnapshotEventPayloadDigest({ actorUserId: 'u-1', channelId: 'c-1' })
    const right = migrationSnapshotEventPayloadDigest({ channelId: 'c-1', actorUserId: 'u-1' })
    expect(left).toBe(right)
    expect(left).toMatch(/^[0-9a-f]{64}$/)
    expect(migrationSnapshotEventPayloadDigest({ actorUserId: 'u-2', channelId: 'c-1' })).not.toBe(
      left
    )
  })

  test('covers nested structure deterministically', () => {
    const digest = migrationSnapshotEventPayloadDigest({
      nested: { b: 1, a: ['x', { y: null }] },
    })
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
    expect(digest).toBe(
      migrationSnapshotEventPayloadDigest({
        nested: { a: ['x', { y: null }], b: 1 },
      })
    )
  })
})

// ─── Deep payload digests (past the canonical depth cap) ─────────────────────

/**
 * Nest `leaf` under `levels` single-key objects, so everything above the leaf
 * sits at the same depth in every payload built with the same count.
 */
const wrapAtDepth = (leaf: unknown, levels = PAYLOAD_CANONICAL_MAX_DEPTH + 8): unknown => {
  let value = leaf
  for (let depth = 0; depth < levels; depth += 1) value = { layer: value }
  return value
}

/** Nest `leaf` in `levels` single-element arrays: depth without width. */
const nestArraysAtDepth = (leaf: string, levels: number): unknown => {
  let value: unknown = leaf
  for (let depth = 0; depth < levels; depth += 1) value = [value]
  return value
}

describe('migrationSnapshotEventPayloadDigest past the depth cap', () => {
  test('payloads identical above the cap but different below it digest differently', () => {
    const left = migrationSnapshotEventPayloadDigest(wrapAtDepth({ leaf: 'left' }))
    const right = migrationSnapshotEventPayloadDigest(wrapAtDepth({ leaf: 'right' }))
    expect(left).toMatch(/^[0-9a-f]{64}$/)
    expect(right).toMatch(/^[0-9a-f]{64}$/)
    expect(left).not.toBe(right)
  })

  test('a difference exactly one level past the cap still digests differently', () => {
    const levels = PAYLOAD_CANONICAL_MAX_DEPTH + 1
    const left = migrationSnapshotEventPayloadDigest(wrapAtDepth({ leaf: 'left' }, levels))
    const right = migrationSnapshotEventPayloadDigest(wrapAtDepth({ leaf: 'right' }, levels))
    expect(left).not.toBe(right)
  })

  test('deep digests stay deterministic and key-order independent', () => {
    const reference = migrationSnapshotEventPayloadDigest(
      wrapAtDepth({ b: [1, { y: null }], a: 'x' })
    )
    expect(reference).toBe(
      migrationSnapshotEventPayloadDigest(wrapAtDepth({ a: 'x', b: [1, { y: null }] }))
    )
    expect(reference).toBe(
      migrationSnapshotEventPayloadDigest(wrapAtDepth({ b: [1, { y: null }], a: 'x' }))
    )
  })

  test('deep content changes the digest even when the shallow skeleton repeats', () => {
    const variants = [
      migrationSnapshotEventPayloadDigest(wrapAtDepth('same')),
      migrationSnapshotEventPayloadDigest(wrapAtDepth('other')),
      migrationSnapshotEventPayloadDigest(wrapAtDepth({ same: 1 })),
    ]
    expect(new Set(variants).size).toBe(variants.length)
    // A skeleton cut off exactly at the cap is walked in full, with nothing
    // folded — its digest matches none of the deep variants above.
    const atCap = migrationSnapshotEventPayloadDigest(
      wrapAtDepth('same', PAYLOAD_CANONICAL_MAX_DEPTH)
    )
    expect(variants).not.toContain(atCap)
  })

  test('nesting far past the cap cannot overflow the walk and still digests', () => {
    // 100 000 levels: the recursive walk stops at the cap, and the deep fold
    // serializes the rest with an explicit stack, so depth never grows the
    // call stack.
    const left = migrationSnapshotEventPayloadDigest(nestArraysAtDepth('left', 100_000))
    const right = migrationSnapshotEventPayloadDigest(nestArraysAtDepth('right', 100_000))
    expect(left).toMatch(/^[0-9a-f]{64}$/)
    expect(left).toBe(migrationSnapshotEventPayloadDigest(nestArraysAtDepth('left', 100_000)))
    expect(left).not.toBe(right)
  })
})

// ─── Input validation before any database work ───────────────────────────────

function rejectingDatabase(): AgentHqDatabase {
  return {
    transaction: () => {
      throw new Error('database must not be touched for invalid input')
    },
  } as unknown as AgentHqDatabase
}

describe('captureMigrationSnapshot input validation', () => {
  test('blank identity fields are rejected before the database is touched', async () => {
    for (const identity of [
      { ...IDENTITY, rehearsalId: '' },
      { ...IDENTITY, snapshotId: '' },
      { ...IDENTITY, source: '' },
      { ...IDENTITY, capturedAt: new Date(Number.NaN) },
      { ...IDENTITY, capturedAt: 'not-a-date' as unknown as Date },
    ]) {
      await expect(captureMigrationSnapshot(rejectingDatabase(), { identity })).rejects.toThrow(
        MigrationSnapshotCaptureInputError
      )
    }
  })

  test('an out-of-range per-family bound is rejected', async () => {
    for (const limitPerFamily of [0, -3, 10_001, 1.5]) {
      await expect(
        captureMigrationSnapshot(rejectingDatabase(), { identity: IDENTITY, limitPerFamily })
      ).rejects.toThrow(MigrationSnapshotCaptureInputError)
    }
  })

  test('a valid request opens exactly one read-only repeatable-read transaction', async () => {
    const seen: { config?: unknown } = {}
    const database = {
      transaction: (_operation: unknown, config: unknown) => {
        seen.config = config
        throw new Error('stop-inside-transaction')
      },
    } as unknown as AgentHqDatabase
    await expect(captureMigrationSnapshot(database, { identity: IDENTITY })).rejects.toThrow(
      'stop-inside-transaction'
    )
    expect(seen.config).toEqual(MIGRATION_SNAPSHOT_CAPTURE_TRANSACTION_CONFIG)
    expect(seen.config).toEqual({ accessMode: 'read only', isolationLevel: 'repeatable read' })
  })
})
