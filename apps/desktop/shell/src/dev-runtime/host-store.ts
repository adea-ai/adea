// Durable JSON record store for the M10 #34 grant authorities.
//
// Writes are atomic (temporary file in the same directory, fsync, rename, then
// a directory fsync) and never exceed owner-only file modes. Reads fail closed
// on corruption or an unsupported schema version and retain the unread file
// under a `.corrupt-<time>` name for export/recovery, exactly as the Dev
// Runtime contract requires: unknown state is never coerced into success and
// the input is never silently rewritten or deleted.
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { Database } from 'bun:sqlite'

import { DevAuthorityError } from './authority'

export type StoreEnvelope<T> = Readonly<{
  schemaVersion: number
  savedAt: string
  records: ReadonlyArray<T>
}>

export function createDurableJsonStore<T>(options: {
  file: string
  schemaVersion: number
  label: string
}) {
  const { file, schemaVersion, label } = options

  function retain(raw: string, code: 'corrupt_state' | 'unsupported_version'): never {
    const retainedFile = `${file}.corrupt-${Date.now()}`
    try {
      writeFileSync(retainedFile, raw, { mode: 0o600 })
      unlinkSync(file)
    } catch {
      // Best-effort retention; the load still refuses below.
    }
    throw new DevAuthorityError(code, `${label} store was retained unread (${code})`)
  }

  function ensureOwnerOnly(): void {
    const directory = dirname(file)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
    if (!existsSync(file)) return
    const stats = lstatSync(file)
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new DevAuthorityError('corrupt_state', `${label} store is not a regular file`)
    }
    chmodSync(file, 0o600)
  }

  function load(): StoreEnvelope<T> {
    ensureOwnerOnly()
    if (!existsSync(file)) return { schemaVersion, savedAt: '', records: [] }
    const raw = readFileSync(file, 'utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      retain(raw, 'corrupt_state')
    }
    const candidate = parsed as Partial<StoreEnvelope<T>> | null
    if (!candidate || typeof candidate !== 'object' || !Array.isArray(candidate.records)) {
      retain(raw, 'corrupt_state')
    }
    if (candidate.schemaVersion !== schemaVersion) retain(raw, 'unsupported_version')
    return parsed as StoreEnvelope<T>
  }

  function save(records: ReadonlyArray<T>): void {
    ensureOwnerOnly()
    const envelope: StoreEnvelope<T> = {
      schemaVersion,
      savedAt: new Date().toISOString(),
      records,
    }
    const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
    const handle = openSync(temporary, 'wx', 0o600)
    try {
      writeSync(handle, JSON.stringify(envelope))
      fsyncSync(handle)
    } finally {
      closeSync(handle)
    }
    renameSync(temporary, file)
    // Persist the rename itself so a crash cannot resurrect the old store.
    try {
      const directory = openSync(dirname(file), 'r')
      try {
        fsyncSync(directory)
      } finally {
        closeSync(directory)
      }
    } catch {
      // Directory fsync is unsupported on some platforms; the file fsync above
      // still bounds the loss window to the rename.
    }
  }

  return Object.freeze({ load, save })
}

export type DurableJsonStore<T> = ReturnType<typeof createDurableJsonStore<T>>

const SQLITE_FORMAT_VERSION = 1
const MIGRATION_LEDGER_VERSION = 1
const SQLITE_MIGRATION_STAGES = ['before_commit'] as const

export type DurableStoreScope = Readonly<{
  accountId: string
  workspaceId: string
  runtimeNodeId: string
}>

type DurableSqliteMigrationStage = (typeof SQLITE_MIGRATION_STAGES)[number]

type DurableSqliteOptions<T> = Readonly<{
  file: string
  schemaVersion: number
  label: string
  /** The pre-SQLite envelope remains readable and is never deleted. */
  legacyFile?: string
  /** Optional scope binding prevents a database from crossing host authorities. */
  scope?: DurableStoreScope
  /**
   * Test-only crash seam. Throwing from this callback happens inside the
   * migration transaction; SQLite rolls back and the next open retries from
   * the untouched legacy file.
   */
  onMigrationStage?: (stage: DurableSqliteMigrationStage) => void
  /** Convert legacy JSON into this scope's records; undefined skips a source
   * that belongs to another scope while establishing a native-state guard. */
  migrateLegacy?: (value: unknown) => ReadonlyArray<T> | undefined
  /** Validate decoded records inside the SQLite corruption-retention boundary. */
  validateRecords?: (records: ReadonlyArray<T>) => void
}>

type MigrationLedger = Readonly<{
  formatVersion: number
  schemaVersion: number
  scopeKey: string
  databaseId: string
  sourceDigest: string
  origin: 'legacy' | 'native'
  state: 'pending' | 'complete'
}>

type SqliteRecord = Readonly<{
  id: number
  scopeKey: string
  accountId: string
  workspaceId: string
  runtimeNodeId: string
  schemaVersion: number
  savedAt: string
  payload: string
}>

type OpenDatabase = Readonly<{ db: Database; databaseId: string }>

class MigrationInterruptedError extends Error {
  constructor(readonly cause: unknown) {
    super('durable SQLite migration interrupted')
    this.name = 'MigrationInterruptedError'
  }
}

class RetainedStoreError extends Error {
  constructor(code: 'corrupt_state' | 'unsupported_version', label: string) {
    super(`${label} SQLite store was retained unread (${code})`)
    this.name = 'RetainedStoreError'
    this.code = code
  }

  readonly code: 'corrupt_state' | 'unsupported_version'
}

function scopeParts(scope: DurableStoreScope | undefined): {
  key: string
  accountId: string
  workspaceId: string
  runtimeNodeId: string
} {
  if (!scope) return { key: 'default', accountId: '', workspaceId: '', runtimeNodeId: '' }
  return {
    key: JSON.stringify([scope.accountId, scope.workspaceId, scope.runtimeNodeId]),
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    runtimeNodeId: scope.runtimeNodeId,
  }
}

function migrationLedgerPath(file: string): string {
  return `${file}.migration.json`
}

function migrationDigest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

const EMPTY_SOURCE_DIGEST = migrationDigest(new Uint8Array())

function writeOwnerOnlyAtomic(file: string, value: string): void {
  const directory = dirname(file)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
  const handle = openSync(temporary, 'wx', 0o600)
  try {
    writeSync(handle, value)
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
  renameSync(temporary, file)
  chmodSync(file, 0o600)
  try {
    const directoryHandle = openSync(directory, 'r')
    try {
      fsyncSync(directoryHandle)
    } finally {
      closeSync(directoryHandle)
    }
  } catch {
    // Directory fsync is unsupported on some platforms; the file fsync still
    // bounds the loss window to the atomic rename.
  }
}

function removeOwnerOnlyFile(file: string): void {
  if (!existsSync(file)) return
  unlinkSync(file)
  try {
    const directoryHandle = openSync(dirname(file), 'r')
    try {
      fsyncSync(directoryHandle)
    } finally {
      closeSync(directoryHandle)
    }
  } catch {
    // Best-effort directory durability after an explicit same-process rollback.
  }
}

function sqliteCorruptCopy(file: string, original?: Uint8Array): void {
  const retained = `${file}.corrupt-${Date.now()}-${process.pid}`
  try {
    if (original !== undefined) writeFileSync(retained, original, { mode: 0o600 })
    else if (existsSync(file)) writeFileSync(retained, readFileSync(file), { mode: 0o600 })
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = `${file}${suffix}`
      if (existsSync(sidecar))
        writeFileSync(`${retained}${suffix}`, readFileSync(sidecar), { mode: 0o600 })
    }
  } catch {
    // Best-effort retention; refusal below remains fail-closed.
  }
}

function sqliteFailure(
  file: string,
  label: string,
  code: 'corrupt_state' | 'unsupported_version'
): never {
  sqliteCorruptCopy(file)
  throw new DevAuthorityError(code, `${label} SQLite store was retained unread (${code})`)
}

function ensureSqliteOwnerOnly(file: string): void {
  const directory = dirname(file)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  for (const path of [file, `${file}-wal`, `${file}-shm`]) {
    if (!existsSync(path)) continue
    const stats = lstatSync(path)
    if (stats.isSymbolicLink() || !stats.isFile())
      throw new DevAuthorityError('corrupt_state', 'durable SQLite store is not a regular file')
    chmodSync(path, 0o600)
  }
}

function ensureMigrationLedgerOwnerOnly(file: string): void {
  if (!existsSync(file)) return
  const stats = lstatSync(file)
  if (stats.isSymbolicLink() || !stats.isFile())
    throw new DevAuthorityError('corrupt_state', 'durable migration ledger is not a regular file')
  chmodSync(file, 0o600)
}

function ensureLegacyOwnerOnly(file: string, label: string): boolean {
  let stats
  try {
    stats = lstatSync(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw new DevAuthorityError('corrupt_state', `${label} legacy store cannot be inspected`)
  }
  if (stats.isSymbolicLink() || !stats.isFile())
    throw new DevAuthorityError('corrupt_state', `${label} legacy store is not a regular file`)
  chmodSync(file, 0o600)
  return true
}

function readMigrationLedger(
  file: string,
  options: DurableSqliteOptions<unknown>,
  expectedScopeKey: string
): MigrationLedger | undefined {
  if (!existsSync(file)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new DevAuthorityError('corrupt_state', `${options.label} migration ledger is corrupt`)
  }
  const candidate = parsed as Partial<MigrationLedger> | null
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    candidate.formatVersion !== MIGRATION_LEDGER_VERSION ||
    candidate.schemaVersion !== options.schemaVersion ||
    candidate.scopeKey !== expectedScopeKey ||
    typeof candidate.databaseId !== 'string' ||
    candidate.databaseId.length < 16 ||
    typeof candidate.sourceDigest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(candidate.sourceDigest) ||
    (candidate.origin !== undefined &&
      candidate.origin !== 'legacy' &&
      candidate.origin !== 'native') ||
    (candidate.state !== 'pending' && candidate.state !== 'complete')
  )
    throw new DevAuthorityError('corrupt_state', `${options.label} migration ledger is invalid`)
  return { ...candidate, origin: candidate.origin ?? 'legacy' } as MigrationLedger
}

function writeMigrationLedger(file: string, ledger: MigrationLedger): void {
  writeOwnerOnlyAtomic(file, `${JSON.stringify(ledger)}\n`)
}

function ensureSqliteSchema(db: Database, options: DurableSqliteOptions<unknown>): string {
  const version = (db.query('PRAGMA user_version').get() as { user_version?: unknown } | null)
    ?.user_version
  if (version !== 0 && version !== SQLITE_FORMAT_VERSION)
    throw new DevAuthorityError(
      'unsupported_version',
      `${options.label} SQLite format is unsupported`
    )
  if (version === 0) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS durable_store_metadata (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        format_version INTEGER NOT NULL,
        database_id TEXT,
        migration_state TEXT NOT NULL CHECK (migration_state IN ('native', 'migrating', 'migrated'))
      );
      CREATE TABLE IF NOT EXISTS durable_store_records (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        scope_key TEXT NOT NULL,
        account_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        runtime_node_id TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        saved_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      PRAGMA user_version = 1;
    `)
  }
  const metadataColumns = db.query('PRAGMA table_info(durable_store_metadata)').all() as Array<{
    name?: unknown
  }>
  if (!metadataColumns.some((column) => column.name === 'database_id'))
    db.exec('ALTER TABLE durable_store_metadata ADD COLUMN database_id TEXT')
  const databaseId = randomUUID()
  db.query(
    "INSERT OR IGNORE INTO durable_store_metadata (id, format_version, database_id, migration_state) VALUES (1, ?, ?, 'native')"
  ).run(SQLITE_FORMAT_VERSION, databaseId)
  db.query(
    "UPDATE durable_store_metadata SET database_id = ? WHERE id = 1 AND (database_id IS NULL OR database_id = '')"
  ).run(databaseId)
  const metadata = db
    .query(
      'SELECT format_version, database_id, migration_state FROM durable_store_metadata WHERE id = 1'
    )
    .get() as { format_version?: unknown; database_id?: unknown; migration_state?: unknown } | null
  if (
    !metadata ||
    metadata.format_version !== SQLITE_FORMAT_VERSION ||
    typeof metadata.database_id !== 'string' ||
    metadata.database_id.length < 16 ||
    !['native', 'migrating', 'migrated'].includes(String(metadata.migration_state))
  )
    throw new DevAuthorityError(
      'unsupported_version',
      `${options.label} SQLite schema is unsupported`
    )
  return metadata.database_id
}

/**
 * A WAL-backed durable host store for one Dev Runtime authority boundary.
 *
 * The adapter intentionally stores one versioned JSON payload per database
 * row. SQLite owns atomicity, WAL recovery, and scope binding; the authority
 * still owns the payload decoder and can reject records that do not belong to
 * its account/workspace/runtime-node scope. Legacy JSON is an additive input:
 * migration never removes or rewrites it, and a failed transaction can retry.
 */
export function createDurableSqliteStore<T>(options: DurableSqliteOptions<T>) {
  const expectedScope = scopeParts(options.scope)
  const ledgerFile = migrationLedgerPath(options.file)

  function openDatabase(): OpenDatabase {
    ensureSqliteOwnerOnly(options.file)
    ensureMigrationLedgerOwnerOnly(ledgerFile)
    const original = existsSync(options.file) ? readFileSync(options.file) : undefined
    let db: Database | undefined
    try {
      db = new Database(options.file, { create: true, strict: true })
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('PRAGMA synchronous = FULL')
      db.exec('PRAGMA foreign_keys = ON')
      const journal = db.query('PRAGMA journal_mode').get() as { journal_mode?: unknown } | null
      const synchronous = db.query('PRAGMA synchronous').get() as { synchronous?: unknown } | null
      const foreignKeys = db.query('PRAGMA foreign_keys').get() as { foreign_keys?: unknown } | null
      if (
        journal?.journal_mode !== 'wal' ||
        synchronous?.synchronous !== 2 ||
        foreignKeys?.foreign_keys !== 1
      )
        throw new DevAuthorityError(
          'corrupt_state',
          `${options.label} SQLite pragmas are not fail-closed`
        )
      const databaseId = ensureSqliteSchema(db, options as DurableSqliteOptions<unknown>)
      if (!existsSync(ledgerFile)) {
        const migrationState = (
          db.query('SELECT migration_state FROM durable_store_metadata WHERE id = 1').get() as {
            migration_state?: unknown
          } | null
        )?.migration_state
        const recordCount = (
          db.query('SELECT COUNT(*) AS count FROM durable_store_records').get() as {
            count?: unknown
          } | null
        )?.count
        const hasLegacySource = options.legacyFile
          ? ensureLegacyOwnerOnly(options.legacyFile, options.label)
          : false
        if (!hasLegacySource || migrationState === 'migrated' || Number(recordCount) > 0) {
          const legacyBytes = hasLegacySource ? readFileSync(options.legacyFile!) : undefined
          writeMigrationLedger(ledgerFile, {
            formatVersion: MIGRATION_LEDGER_VERSION,
            schemaVersion: options.schemaVersion,
            scopeKey: expectedScope.key,
            databaseId,
            sourceDigest: legacyBytes ? migrationDigest(legacyBytes) : EMPTY_SOURCE_DIGEST,
            origin: hasLegacySource && migrationState === 'migrated' ? 'legacy' : 'native',
            state: 'complete',
          })
        }
      }
      chmodSync(options.file, 0o600)
      ensureSqliteOwnerOnly(options.file)
      return { db, databaseId }
    } catch (error) {
      db?.close()
      sqliteCorruptCopy(options.file, original)
      if (error instanceof DevAuthorityError) {
        const code = error.code === 'unsupported_version' ? 'unsupported_version' : 'corrupt_state'
        throw new RetainedStoreError(code, options.label)
      }
      throw new RetainedStoreError('corrupt_state', options.label)
    }
  }

  function rows(db: Database): SqliteRecord[] {
    return db
      .query(
        `SELECT id, scope_key AS scopeKey, account_id AS accountId,
                workspace_id AS workspaceId, runtime_node_id AS runtimeNodeId,
                schema_version AS schemaVersion, saved_at AS savedAt, payload
           FROM durable_store_records`
      )
      .all() as SqliteRecord[]
  }

  function readLegacy():
    | { savedAt: string; records: ReadonlyArray<T> | undefined; sourceDigest: string }
    | undefined {
    if (!options.legacyFile || !ensureLegacyOwnerOnly(options.legacyFile, options.label))
      return undefined
    const rawBytes = readFileSync(options.legacyFile)
    let parsed: unknown
    try {
      parsed = JSON.parse(rawBytes.toString('utf8'))
    } catch {
      sqliteCorruptCopy(options.legacyFile)
      throw new DevAuthorityError('corrupt_state', `${options.label} legacy store is corrupt`)
    }
    const candidate = parsed as { schemaVersion?: unknown; savedAt?: unknown; records?: unknown }
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      candidate.schemaVersion !== options.schemaVersion ||
      !Array.isArray(candidate.records)
    ) {
      sqliteCorruptCopy(options.legacyFile)
      throw new DevAuthorityError(
        'unsupported_version',
        `${options.label} legacy schema is unsupported`
      )
    }
    let records: ReadonlyArray<T> | undefined
    try {
      records = options.migrateLegacy
        ? options.migrateLegacy(parsed)
        : (candidate.records as ReadonlyArray<T>)
    } catch (error) {
      if (error instanceof DevAuthorityError) throw error
      sqliteCorruptCopy(options.legacyFile)
      throw new DevAuthorityError(
        'corrupt_state',
        `${options.label} legacy records failed to decode`
      )
    }
    if (records !== undefined && !Array.isArray(records)) {
      sqliteCorruptCopy(options.legacyFile)
      throw new DevAuthorityError(
        'corrupt_state',
        `${options.label} legacy records failed to decode`
      )
    }
    return {
      savedAt: typeof candidate.savedAt === 'string' ? candidate.savedAt : '',
      records,
      sourceDigest: migrationDigest(rawBytes),
    }
  }

  function migrate(db: Database, databaseId: string, ledger: MigrationLedger | undefined): void {
    if (ledger?.origin === 'legacy' && ledger.state === 'complete')
      throw new DevAuthorityError(
        'corrupt_state',
        `${options.label} migration ledger has no authoritative row`
      )
    const legacy = readLegacy()
    if (ledger?.origin === 'native') {
      if (legacy?.records !== undefined)
        throw new DevAuthorityError(
          'corrupt_state',
          `${options.label} native store cannot import a late legacy source`
        )
      return
    }
    if (!legacy) {
      if (ledger?.state === 'pending')
        throw new DevAuthorityError(
          'corrupt_state',
          `${options.label} migration source disappeared before commit`
        )
      return
    }
    if (legacy.records === undefined) {
      if (ledger) {
        if (ledger.databaseId !== databaseId)
          throw new DevAuthorityError(
            'corrupt_state',
            `${options.label} migration ledger belongs to another database`
          )
        if (ledger.state === 'complete')
          throw new DevAuthorityError(
            'corrupt_state',
            `${options.label} migration ledger has no authoritative row`
          )
        if (ledger.sourceDigest !== legacy.sourceDigest)
          throw new DevAuthorityError(
            'corrupt_state',
            `${options.label} migration source changed during recovery`
          )
      }
      writeMigrationLedger(ledgerFile, {
        formatVersion: MIGRATION_LEDGER_VERSION,
        schemaVersion: options.schemaVersion,
        scopeKey: expectedScope.key,
        databaseId,
        sourceDigest: legacy.sourceDigest,
        origin: 'native',
        state: 'complete',
      })
      return
    }
    if (ledger) {
      if (ledger.databaseId !== databaseId)
        throw new DevAuthorityError(
          'corrupt_state',
          `${options.label} migration ledger belongs to another database`
        )
      if (ledger.state === 'complete')
        throw new DevAuthorityError(
          'corrupt_state',
          `${options.label} migration ledger has no authoritative row`
        )
      if (ledger.sourceDigest !== legacy.sourceDigest)
        throw new DevAuthorityError(
          'corrupt_state',
          `${options.label} migration source changed during recovery`
        )
    } else {
      writeMigrationLedger(ledgerFile, {
        formatVersion: MIGRATION_LEDGER_VERSION,
        schemaVersion: options.schemaVersion,
        scopeKey: expectedScope.key,
        databaseId,
        sourceDigest: legacy.sourceDigest,
        origin: 'legacy',
        state: 'pending',
      })
    }
    const payload = JSON.stringify(legacy.records)
    let hookRunning = false
    let committed = false
    try {
      db.transaction(() => {
        db.query(
          "UPDATE durable_store_metadata SET migration_state = 'migrating' WHERE id = 1"
        ).run()
        db.query(
          `INSERT INTO durable_store_records
             (id, scope_key, account_id, workspace_id, runtime_node_id, schema_version, saved_at, payload)
           VALUES (1, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          expectedScope.key,
          expectedScope.accountId,
          expectedScope.workspaceId,
          expectedScope.runtimeNodeId,
          options.schemaVersion,
          legacy.savedAt,
          payload
        )
        hookRunning = true
        options.onMigrationStage?.('before_commit')
        hookRunning = false
        db.query(
          "UPDATE durable_store_metadata SET migration_state = 'migrated' WHERE id = 1"
        ).run()
      })()
      committed = true
      writeMigrationLedger(ledgerFile, {
        formatVersion: MIGRATION_LEDGER_VERSION,
        schemaVersion: options.schemaVersion,
        scopeKey: expectedScope.key,
        databaseId,
        sourceDigest: legacy.sourceDigest,
        origin: 'legacy',
        state: 'complete',
      })
    } catch (error) {
      if (!committed) {
        try {
          removeOwnerOnlyFile(ledgerFile)
        } catch {
          // A failed cleanup leaves the pending ledger as a recovery gate.
        }
      }
      if (hookRunning) throw new MigrationInterruptedError(error)
      if (error instanceof DevAuthorityError) throw error
      throw new DevAuthorityError('corrupt_state', `${options.label} migration failed`)
    }
  }

  function load(): StoreEnvelope<T> {
    let db: Database | undefined
    let failure: unknown
    try {
      const opened = openDatabase()
      db = opened.db
      const ledger = readMigrationLedger(
        ledgerFile,
        options as DurableSqliteOptions<unknown>,
        expectedScope.key
      )
      let records = rows(db)
      if (ledger && ledger.databaseId !== opened.databaseId)
        throw new DevAuthorityError(
          'corrupt_state',
          `${options.label} migration ledger belongs to another database`
        )
      if (ledger?.state === 'pending' && records.length > 0) {
        writeMigrationLedger(ledgerFile, { ...ledger, state: 'complete' })
      }
      if (records.length === 0) {
        migrate(db, opened.databaseId, ledger)
        records = rows(db)
      }
      if (records.length > 1)
        throw new DevAuthorityError('corrupt_state', `${options.label} has multiple authority rows`)
      if (records.length === 0)
        return { schemaVersion: options.schemaVersion, savedAt: '', records: [] }
      const row = records[0]!
      if (row.scopeKey !== expectedScope.key || row.schemaVersion !== options.schemaVersion)
        throw new DevAuthorityError(
          row.scopeKey === expectedScope.key ? 'unsupported_version' : 'corrupt_state',
          `${options.label} row is not bound to this scope or schema`
        )
      let decoded: unknown
      try {
        decoded = JSON.parse(row.payload)
      } catch {
        throw new DevAuthorityError('corrupt_state', `${options.label} payload is not valid JSON`)
      }
      if (!Array.isArray(decoded))
        throw new DevAuthorityError(
          'corrupt_state',
          `${options.label} payload is not a record list`
        )
      options.validateRecords?.(decoded as ReadonlyArray<T>)
      return {
        schemaVersion: row.schemaVersion,
        savedAt: row.savedAt,
        records: decoded as ReadonlyArray<T>,
      }
    } catch (error) {
      failure = error
    } finally {
      db?.close()
    }
    if (failure instanceof MigrationInterruptedError) throw failure.cause
    if (failure instanceof RetainedStoreError)
      throw new DevAuthorityError(failure.code, failure.message)
    if (failure instanceof DevAuthorityError)
      sqliteFailure(
        options.file,
        options.label,
        failure.code === 'unsupported_version' ? 'unsupported_version' : 'corrupt_state'
      )
    sqliteFailure(options.file, options.label, 'corrupt_state')
  }

  function save(records: ReadonlyArray<T>): void {
    let db: Database | undefined
    let failure: unknown
    try {
      options.validateRecords?.(records)
      const opened = openDatabase()
      db = opened.db
      const ledger = readMigrationLedger(
        ledgerFile,
        options as DurableSqliteOptions<unknown>,
        expectedScope.key
      )
      if (ledger && ledger.databaseId !== opened.databaseId)
        throw new DevAuthorityError(
          'corrupt_state',
          `${options.label} migration ledger belongs to another database`
        )
      const existing = rows(db)
      if (ledger && existing.length === 0 && ledger.origin !== 'native')
        throw new DevAuthorityError(
          'corrupt_state',
          `${options.label} migration ledger has no authoritative row`
        )
      if (existing.length > 1 || (existing[0] && existing[0].scopeKey !== expectedScope.key))
        throw new DevAuthorityError(
          'corrupt_state',
          `${options.label} row is not bound to this scope`
        )
      const savedAt = new Date().toISOString()
      db.transaction(() => {
        db!
          .query(
            `INSERT INTO durable_store_records
             (id, scope_key, account_id, workspace_id, runtime_node_id, schema_version, saved_at, payload)
           VALUES (1, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             scope_key = excluded.scope_key,
             account_id = excluded.account_id,
             workspace_id = excluded.workspace_id,
             runtime_node_id = excluded.runtime_node_id,
             schema_version = excluded.schema_version,
             saved_at = excluded.saved_at,
             payload = excluded.payload`
          )
          .run(
            expectedScope.key,
            expectedScope.accountId,
            expectedScope.workspaceId,
            expectedScope.runtimeNodeId,
            options.schemaVersion,
            savedAt,
            JSON.stringify(records)
          )
        db!
          .query(
            "UPDATE durable_store_metadata SET migration_state = CASE WHEN migration_state = 'migrated' THEN 'migrated' ELSE 'native' END WHERE id = 1"
          )
          .run()
      })()
    } catch (error) {
      failure = error
    } finally {
      db?.close()
    }
    if (failure instanceof RetainedStoreError)
      throw new DevAuthorityError(failure.code, failure.message)
    if (failure instanceof DevAuthorityError)
      sqliteFailure(
        options.file,
        options.label,
        failure.code === 'unsupported_version' ? 'unsupported_version' : 'corrupt_state'
      )
    if (failure) sqliteFailure(options.file, options.label, 'corrupt_state')
  }

  return Object.freeze({ load, save })
}

export type DurableSqliteStore<T> = ReturnType<typeof createDurableSqliteStore<T>>
