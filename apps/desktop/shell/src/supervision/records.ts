// Durable launch/exit records for the supervision engine. ADR 0009's
// persistence table assigns "launch/exit/lease records" to the execution-host
// supervisor; this store is that journal. Writes are append-only JSON lines
// under an owner-only directory; a torn or corrupt line is quarantined with
// its raw bytes retained (never silently dropped), and retention is bounded.
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import type { ComponentId } from './component-manifest'

export const RECORDS_FILE = 'records.jsonl'
const CORRUPT_FILE = 'records.corrupt.jsonl'
/** The production retention cap. Inject a smaller `maxRecords` in tests so
 *  prune semantics are provable without a four-thousand-append wall-clock
 *  dependency (the real-I/O volume used to trip the runner timeout under
 *  load); production behavior is unchanged. */
export const DEFAULT_MAX_RECORDS = 1_000

export type ProcessIdentity = {
  pid: number
  /** OS start identity (e.g. macOS `psc` / proc start time); a reused PID gets a new one. */
  pidStartIdentity: string
  /** Expected executable identity of the launched artifact. */
  executableIdentity: string
}

export type LaunchedRecord = {
  kind: 'launched'
  at: string
  componentId: ComponentId
  generation: number
  processRecordId: string
  identity: ProcessIdentity
  processGroup: string
}

export type ExitedRecord = {
  kind: 'exited'
  at: string
  componentId: ComponentId
  generation: number
  processRecordId: string
  /** Expected (operator/upgrade stop) or unexpected (crash) exit. */
  expected: boolean
  exitDetail: string
}

export type SupervisionRecord = LaunchedRecord | ExitedRecord

export type RecordStore = {
  append(record: SupervisionRecord): void
  list(): SupervisionRecord[]
  corruptCount(): number
}

function decodeRecord(value: unknown): SupervisionRecord | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (!isKnownKind(record.kind)) return null
  if (typeof record.at !== 'string') return null
  if (typeof record.componentId !== 'string') return null
  if (typeof record.generation !== 'number') return null
  if (typeof record.processRecordId !== 'string') return null
  if (record.kind === 'launched') {
    const identity = record.identity
    if (typeof identity !== 'object' || identity === null) return null
    const { pid, pidStartIdentity, executableIdentity } = identity as Record<string, unknown>
    if (typeof pid !== 'number') return null
    if (typeof pidStartIdentity !== 'string' || typeof executableIdentity !== 'string') return null
    if (typeof record.processGroup !== 'string') return null
  } else {
    if (typeof record.expected !== 'boolean') return null
    if (typeof record.exitDetail !== 'string') return null
  }
  return record as unknown as SupervisionRecord
}

function isKnownKind(kind: unknown): kind is SupervisionRecord['kind'] {
  return kind === 'launched' || kind === 'exited'
}

function loadRecords(path: string): { records: SupervisionRecord[]; corrupt: string[] } {
  if (!existsSync(path)) return { records: [], corrupt: [] }
  const raw = readFileSync(path, 'utf8')
  const records: SupervisionRecord[] = []
  const corrupt: string[] = []
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue
    try {
      const record = decodeRecord(JSON.parse(line))
      if (record) records.push(record)
      else corrupt.push(line)
    } catch {
      // A torn final line from a crash mid-write lands here.
      corrupt.push(line)
    }
  }
  return { records, corrupt }
}

function persistRecords(path: string, records: SupervisionRecord[]): void {
  const body = records.map((record) => JSON.stringify(record)).join('\n')
  // Atomic replacement so a reader never observes a half-pruned file.
  const tempPath = `${path}.tmp`
  writeFileSync(tempPath, body.length > 0 ? `${body}\n` : '', { mode: 0o600 })
  renameSync(tempPath, path)
}

/**
 * Create (or reopen) the durable record journal under `dir`. The directory
 * and journal are owner-only from creation. Corrupt lines found on load are
 * moved to the quarantine file and counted; they never block recovery.
 */
export function createRecordStore(dir: string, options?: { maxRecords?: number }): RecordStore {
  const maxRecords = options?.maxRecords ?? DEFAULT_MAX_RECORDS
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // Creation modes do not tighten permissions on an existing journal. Reassert
  // the owner-only contract before reading or appending any launch identity.
  chmodSync(dir, 0o700)
  const path = join(dir, RECORDS_FILE)
  if (!existsSync(path)) writeFileSync(path, '', { mode: 0o600 })
  chmodSync(path, 0o600)

  const { records: loaded, corrupt } = loadRecords(path)
  let records = loaded

  if (corrupt.length > 0) {
    const quarantinePath = join(dir, CORRUPT_FILE)
    const existing = existsSync(quarantinePath) ? readFileSync(quarantinePath, 'utf8') : ''
    writeFileSync(
      quarantinePath,
      `${existing}${corrupt.map((line) => (line.endsWith('\n') ? line : `${line}\n`)).join('')}`,
      { mode: 0o600 }
    )
    chmodSync(quarantinePath, 0o600)
    persistRecords(path, records)
  }

  return {
    append(record: SupervisionRecord): void {
      records.push(record)
      if (records.length > maxRecords) {
        records = records.slice(records.length - maxRecords)
        persistRecords(path, records)
        return
      }
      appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 })
    },
    list(): SupervisionRecord[] {
      return [...records]
    },
    corruptCount(): number {
      return corrupt.length
    },
  }
}

/** Owner-only mode assertions used by tests and the packaged diagnostics. */
export function recordFileModes(dir: string): { dirMode: number; fileMode: number } {
  return {
    dirMode: statSync(dir).mode & 0o777,
    fileMode: statSync(join(dir, RECORDS_FILE)).mode & 0o777,
  }
}
