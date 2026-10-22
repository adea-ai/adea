import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { createDatabase } from './connection'
import { migrationConnection } from './migration-target'
import { assertDatabaseMigrationHistoryCompatible } from './migration-history-preflight'

const target = migrationConnection()
const connection = createDatabase(target.connectionUrl, target.options)
const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))

async function migrationState() {
  const rows = await connection.client<
    Array<{ created_at: string; hash: string; id: number }>
  >`SELECT id, hash, created_at FROM app.__drizzle_migrations ORDER BY id`
  return {
    count: rows.length,
    fingerprint: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
  }
}

try {
  await assertDatabaseMigrationHistoryCompatible(connection, migrationsFolder)

  await migrate(connection.db, {
    migrationsFolder,
    migrationsSchema: 'app',
    migrationsTable: '__drizzle_migrations',
  })
  const first = await migrationState()

  await migrate(connection.db, {
    migrationsFolder,
    migrationsSchema: 'app',
    migrationsTable: '__drizzle_migrations',
  })
  const second = await migrationState()

  if (first.count === 0 || first.fingerprint !== second.fingerprint) {
    throw new Error('Migration history changed after a deterministic rerun')
  }

  console.log(`Migration verification passed (${second.count} applied migration(s))`)
} finally {
  await connection.close()
}
