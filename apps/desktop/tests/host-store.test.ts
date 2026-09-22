import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createDurableJsonStore,
  createDurableSqliteStore,
} from '../shell/src/dev-runtime/host-store'

describe('durable host store permissions', () => {
  test('tightens an existing store before reading it', () => {
    const root = mkdtempSync(join(tmpdir(), 'adea-host-store-'))
    try {
      const directory = join(root, 'state')
      const file = join(directory, 'records.json')
      mkdirSync(directory, { recursive: true, mode: 0o755 })
      writeFileSync(
        file,
        JSON.stringify({ schemaVersion: 1, savedAt: '', records: [{ value: 'ok' }] }),
        { mode: 0o644 }
      )

      const store = createDurableJsonStore<{ value: string }>({
        file,
        schemaVersion: 1,
        label: 'test',
      })
      expect(store.load().records).toEqual([{ value: 'ok' }])
      expect(statSync(directory).mode & 0o777).toBe(0o700)
      expect(statSync(file).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

const scope = {
  accountId: 'account-a',
  workspaceId: 'workspace-a',
  runtimeNodeId: 'node-a',
} as const

function sqliteStore(root: string, overrides: Record<string, unknown> = {}) {
  return createDurableSqliteStore<{ value: string }>({
    file: join(root, 'state', 'records.sqlite3'),
    schemaVersion: 1,
    label: 'test sqlite',
    scope,
    ...overrides,
  })
}

describe('durable SQLite host store', () => {
  test('uses WAL/full-sync SQLite with owner-only files and survives restart', () => {
    const root = mkdtempSync(join(tmpdir(), 'adea-sqlite-store-'))
    try {
      const file = join(root, 'state', 'records.sqlite3')
      const store = sqliteStore(root)
      store.save([{ value: 'persisted' }])
      expect(store.load().records).toEqual([{ value: 'persisted' }])

      const db = new Database(file)
      expect(db.query('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' })
      db.close()

      const restarted = sqliteStore(root)
      expect(restarted.load().records).toEqual([{ value: 'persisted' }])
      expect(statSync(join(root, 'state')).mode & 0o777).toBe(0o700)
      expect(statSync(file).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('migrates one legacy envelope transactionally and retains the source', () => {
    const root = mkdtempSync(join(tmpdir(), 'adea-sqlite-store-'))
    try {
      const legacyFile = join(root, 'state', 'records.json')
      mkdirSync(join(root, 'state'), { recursive: true, mode: 0o700 })
      writeFileSync(
        legacyFile,
        JSON.stringify({ schemaVersion: 1, savedAt: 'legacy', records: [{ value: 'legacy' }] }),
        { mode: 0o600 }
      )
      const store = sqliteStore(root, { legacyFile })
      expect(store.load()).toEqual({
        schemaVersion: 1,
        savedAt: 'legacy',
        records: [{ value: 'legacy' }],
      })
      expect(statSync(legacyFile).mode & 0o777).toBe(0o600)
      expect(readdirSync(join(root, 'state'))).toContain('records.json')
      const database = new Database(join(root, 'state', 'records.sqlite3'), { readonly: true })
      expect(
        database.query('SELECT migration_state FROM durable_store_metadata WHERE id = 1').get()
      ).toMatchObject({ migration_state: 'migrated' })
      database.close()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('retries an interrupted migration from the untouched legacy source', () => {
    const root = mkdtempSync(join(tmpdir(), 'adea-sqlite-store-'))
    try {
      const legacyFile = join(root, 'state', 'records.json')
      mkdirSync(join(root, 'state'), { recursive: true, mode: 0o700 })
      writeFileSync(
        legacyFile,
        JSON.stringify({ schemaVersion: 1, savedAt: 'legacy', records: [{ value: 'retry' }] }),
        { mode: 0o600 }
      )
      const interrupted = sqliteStore(root, {
        legacyFile,
        onMigrationStage: (stage: string) => {
          if (stage === 'before_commit') throw new Error('simulated interruption')
        },
      })
      expect(() => interrupted.load()).toThrow('simulated interruption')

      const retried = sqliteStore(root, { legacyFile })
      expect(retried.load().records).toEqual([{ value: 'retry' }])
      expect(readdirSync(join(root, 'state'))).toContain('records.json')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('fails closed instead of reimporting stale JSON after SQLite data loss', () => {
    const root = mkdtempSync(join(tmpdir(), 'adea-sqlite-store-'))
    try {
      const file = join(root, 'state', 'records.sqlite3')
      const legacyFile = join(root, 'state', 'records.json')
      mkdirSync(join(root, 'state'), { recursive: true, mode: 0o700 })
      writeFileSync(
        legacyFile,
        JSON.stringify({ schemaVersion: 1, savedAt: 'legacy', records: [{ value: 'A' }] }),
        { mode: 0o600 }
      )
      const store = sqliteStore(root, { legacyFile })
      expect(store.load().records).toEqual([{ value: 'A' }])
      store.save([{ value: 'B' }])

      rmSync(file, { force: true })
      rmSync(`${file}-wal`, { force: true })
      rmSync(`${file}-shm`, { force: true })

      expect(() => sqliteStore(root, { legacyFile }).load()).toThrow('corrupt_state')
      expect(readdirSync(join(root, 'state'))).toContain('records.sqlite3.migration.json')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('retries a persisted pending migration only for the same SQLite identity', () => {
    const root = mkdtempSync(join(tmpdir(), 'adea-sqlite-store-'))
    try {
      const file = join(root, 'state', 'records.sqlite3')
      const legacyFile = join(root, 'state', 'records.json')
      const ledgerFile = `${file}.migration.json`
      mkdirSync(join(root, 'state'), { recursive: true, mode: 0o700 })
      sqliteStore(root).load()
      const db = new Database(file)
      const databaseId = (
        db.query('SELECT database_id FROM durable_store_metadata WHERE id = 1').get() as {
          database_id: string
        }
      ).database_id
      db.close()
      const legacyBytes = Buffer.from(
        JSON.stringify({ schemaVersion: 1, savedAt: 'legacy', records: [{ value: 'retry' }] })
      )
      writeFileSync(legacyFile, legacyBytes, { mode: 0o600 })
      writeFileSync(
        ledgerFile,
        JSON.stringify({
          formatVersion: 1,
          schemaVersion: 1,
          scopeKey: JSON.stringify([scope.accountId, scope.workspaceId, scope.runtimeNodeId]),
          databaseId,
          sourceDigest: createHash('sha256').update(legacyBytes).digest('hex'),
          state: 'pending',
        }),
        { mode: 0o600 }
      )

      expect(sqliteStore(root, { legacyFile }).load().records).toEqual([{ value: 'retry' }])
      expect(JSON.parse(readFileSync(ledgerFile, 'utf8')) as { state: string }).toMatchObject({
        state: 'complete',
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('fails closed and retains a corrupted SQLite payload', () => {
    const root = mkdtempSync(join(tmpdir(), 'adea-sqlite-store-'))
    try {
      const file = join(root, 'state', 'records.sqlite3')
      const store = sqliteStore(root)
      store.save([{ value: 'safe' }])
      const db = new Database(file)
      db.query('UPDATE durable_store_records SET payload = ? WHERE id = 1').run('{bad')
      db.close()

      expect(() => sqliteStore(root).load()).toThrow('corrupt_state')
      expect(
        readdirSync(join(root, 'state')).some((name) => name.startsWith('records.sqlite3.corrupt-'))
      ).toBe(true)
      expect(statSync(file).isFile()).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('rejects a foreign scope before returning records', () => {
    const root = mkdtempSync(join(tmpdir(), 'adea-sqlite-store-'))
    try {
      const file = join(root, 'state', 'records.sqlite3')
      sqliteStore(root).save([{ value: 'private' }])
      expect(() =>
        createDurableSqliteStore({
          file,
          schemaVersion: 1,
          label: 'foreign sqlite',
          scope: { ...scope, workspaceId: 'workspace-b' },
        }).load()
      ).toThrow('corrupt_state')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('rejects an unsupported SQLite format version without replacing the file', () => {
    const root = mkdtempSync(join(tmpdir(), 'adea-sqlite-store-'))
    try {
      const file = join(root, 'state', 'records.sqlite3')
      sqliteStore(root).save([{ value: 'versioned' }])
      const db = new Database(file)
      db.exec('PRAGMA user_version = 99')
      db.close()

      expect(() => sqliteStore(root).load()).toThrow('unsupported_version')
      expect(statSync(file).isFile()).toBe(true)
      expect(
        readdirSync(join(root, 'state')).some((name) => name.startsWith('records.sqlite3.corrupt-'))
      ).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
