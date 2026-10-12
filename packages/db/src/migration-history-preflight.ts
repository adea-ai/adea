import type { MigrationMeta } from 'drizzle-orm/migrator'
import { readMigrationFiles } from 'drizzle-orm/migrator'

import type { DatabaseConnection } from './connection'

type AppliedMigration = {
  created_at: string | number
  hash: string
  id: number
}

/** Read the existing ledger without mutation, then validate it against Drizzle's parsed files. */
export async function assertDatabaseMigrationHistoryCompatible(
  connection: DatabaseConnection,
  migrationsFolder: string
): Promise<void> {
  const [relation] = await connection.client<Array<{ exists: boolean }>>`
    SELECT to_regclass('app.__drizzle_migrations') IS NOT NULL AS exists
  `
  const applied = relation?.exists
    ? await connection.client<AppliedMigration[]>`
        SELECT id, hash, created_at FROM app.__drizzle_migrations ORDER BY id
      `
    : []
  const candidate = readMigrationFiles({ migrationsFolder })
  assertMigrationHistoryCompatible(applied, candidate)
}

/**
 * Fail before Drizzle migrates when its timestamp-only high-water mark would
 * skip an unapplied migration or when an applied SQL file moved in the journal.
 * Drizzle's ledger has no tag column, so ambiguous hashes fail closed.
 */
function assertMigrationHistoryCompatible(
  applied: readonly AppliedMigration[],
  candidate: readonly Pick<MigrationMeta, 'folderMillis' | 'hash'>[]
): void {
  const candidateByHash = new Map<string, Pick<MigrationMeta, 'folderMillis' | 'hash'>>()
  let previousTimestamp = Number.NEGATIVE_INFINITY

  for (const [index, migration] of candidate.entries()) {
    if (
      !Number.isSafeInteger(migration.folderMillis) ||
      migration.folderMillis <= previousTimestamp
    ) {
      throw new Error(
        `Migration history preflight failed: candidate entry ${index} has an invalid or non-increasing timestamp`
      )
    }
    previousTimestamp = migration.folderMillis
    if (candidateByHash.has(migration.hash)) {
      throw new Error(
        'Migration history preflight failed: candidate contains an ambiguous duplicate SQL hash'
      )
    }
    candidateByHash.set(migration.hash, migration)
  }

  if (applied.length === 0) return

  const appliedTuples = new Set<string>()
  let highWatermark = Number.NEGATIVE_INFINITY
  for (const row of applied) {
    const createdAt =
      typeof row.created_at === 'number'
        ? row.created_at
        : /^[0-9]+$/u.test(row.created_at)
          ? Number(row.created_at)
          : Number.NaN
    if (!Number.isSafeInteger(createdAt)) {
      throw new Error(
        `Migration history preflight failed: ledger row ${row.id} has an invalid timestamp`
      )
    }
    const match = candidateByHash.get(row.hash)
    if (!match) {
      throw new Error(
        `Migration history preflight failed: applied ledger row ${row.id} does not match a candidate migration`
      )
    }
    if (match.folderMillis !== createdAt) {
      throw new Error(
        `Migration history preflight failed: applied ledger row ${row.id} moved from timestamp ${createdAt} to ${match.folderMillis}`
      )
    }
    const tuple = `${row.hash}:${createdAt}`
    if (appliedTuples.has(tuple)) {
      throw new Error(
        `Migration history preflight failed: applied ledger row ${row.id} duplicates an applied migration`
      )
    }
    appliedTuples.add(tuple)
    highWatermark = Math.max(highWatermark, createdAt)
  }

  for (const migration of candidate) {
    const tuple = `${migration.hash}:${migration.folderMillis}`
    if (migration.folderMillis <= highWatermark && !appliedTuples.has(tuple)) {
      throw new Error(
        `Migration history preflight failed: candidate migration at timestamp ${migration.folderMillis} is absent from the ledger and would be skipped below the applied timestamp ${highWatermark}`
      )
    }
  }
}
