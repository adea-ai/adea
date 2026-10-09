// Workspace memory (ADR 0012, "Memory"): the `memory_entry` content type of
// the desktop local content store. Contract: docs/specs/local-content.md
// ("Workspace memory").
//
// Each entry is one owner-only JSON record under `local-content/memory/`
// whose text is sealed with AES-256-GCM under the device key. The associated
// data binds `schemaVersion || keyVersion || workspaceId || contentId ||
// contentType`, so a record copied or re-labelled into another workspace
// fails authentication instead of opening: reads always authenticate under
// the workspace the caller is authorized for, never the workspace the file
// claims. Metadata (id, workspace, source, status, timestamps, revision) is
// workspace metadata; the text is restricted local content and never leaves
// this module except to the authorized workspace's own callers.
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import {
  workspaceMemoryLimits,
  type WorkspaceMemoryEntry,
  type WorkspaceMemorySnapshot,
} from '../../../../../packages/types/src/index'
import { compileMemoryPreamble, type MemoryPreamble } from './preamble'
import {
  memoryProvenanceRecord,
  requireMemoryPromotion,
  type MemoryProvenanceRefusal,
} from './provenance'

export const MEMORY_CONTENT_TYPE = 'memory_entry'
const SCHEMA_VERSION = 1
const KEY_VERSION = 1
const AAD_SEPARATOR = '\u001f'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export type MemoryErrorCode =
  | 'memory_invalid_input'
  | 'memory_not_found'
  | 'memory_stale_revision'
  | 'memory_limit_exceeded'
  | 'memory_invalid_state'
  | 'memory_unavailable'

/** A typed store refusal. The message is the stable code, never text. */
export class MemoryStoreError extends Error {
  readonly code: MemoryErrorCode
  constructor(code: MemoryErrorCode) {
    super(code)
    this.code = code
    this.name = 'MemoryStoreError'
  }
}

type StoredRecord = {
  schemaVersion: number
  keyVersion: number
  contentType: string
  id: string
  workspaceId: string
  source: WorkspaceMemoryEntry['source']
  status: WorkspaceMemoryEntry['status']
  createdAt: string
  updatedAt: string
  revision: number
  nonce: string
  tag: string
  ciphertext: string
}

type Settings = { version: 1; injection: Record<string, boolean> }

export type MemoryStore = Readonly<{
  list(workspaceId: string): WorkspaceMemorySnapshot
  create(workspaceId: string, input: { text: unknown }): WorkspaceMemoryEntry
  /** An agent proposal: stored `pending` with source `agent`. */
  propose(workspaceId: string, input: { text: unknown }): WorkspaceMemoryEntry
  update(
    workspaceId: string,
    input: { entryId: unknown; expectedRevision: unknown; text: unknown }
  ): WorkspaceMemoryEntry
  remove(workspaceId: string, input: { entryId: unknown; expectedRevision: unknown }): void
  accept(
    workspaceId: string,
    input: { entryId: unknown; expectedRevision: unknown }
  ): WorkspaceMemoryEntry
  reject(workspaceId: string, input: { entryId: unknown; expectedRevision: unknown }): void
  injectionEnabled(workspaceId: string): boolean
  setInjectionEnabled(workspaceId: string, enabled: unknown): boolean
  /** Delete authenticated workspace-owned notes and its injection override.
   * Refuses ambiguous/unreadable ownership before touching any record. */
  validateWorkspacePurge(workspaceId: string): number
  purgeWorkspace(workspaceId: string): number
  /** The launch preamble for the workspace's ACTIVE entries, or undefined
   *  when injection is off or there is nothing to inject. */
  preamble(workspaceId: string): MemoryPreamble | undefined
}>

export function assertMemoryWorkspaceId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new MemoryStoreError('memory_invalid_input')
  }
  return value
}

function entryIdOf(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new MemoryStoreError('memory_invalid_input')
  }
  return value
}

function revisionOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new MemoryStoreError('memory_invalid_input')
  }
  return value
}

/** Entry text: trimmed, non-empty, at most the entry bound, no NUL. */
export function normalizeMemoryText(value: unknown): string {
  if (typeof value !== 'string') throw new MemoryStoreError('memory_invalid_input')
  const text = value.replace(/\r\n?/g, '\n').trim()
  if (text.length < 1 || text.length > workspaceMemoryLimits.entryMaxChars || text.includes('\0')) {
    throw new MemoryStoreError('memory_invalid_input')
  }
  return text
}

function associatedData(workspaceId: string, id: string): Buffer {
  return Buffer.from(
    [String(SCHEMA_VERSION), String(KEY_VERSION), workspaceId, id, MEMORY_CONTENT_TYPE].join(
      AAD_SEPARATOR
    ),
    'utf8'
  )
}

function writeAtomic(file: string, value: unknown): void {
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 })
  renameSync(temp, file)
}

function toEntry(record: StoredRecord, text: string): WorkspaceMemoryEntry {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    text,
    source: record.source,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    revision: record.revision,
  }
}

function newestFirst(left: WorkspaceMemoryEntry, right: WorkspaceMemoryEntry): number {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1
  return left.id < right.id ? 1 : left.id > right.id ? -1 : 0
}

function requireRevision(record: StoredRecord, expected: unknown): void {
  if (record.revision !== revisionOf(expected)) {
    throw new MemoryStoreError('memory_stale_revision')
  }
}

/** Applies the provenance/audience guard, mapping its typed refusal onto the
 *  store's stable codes. A foreign audience is indistinguishable from an
 *  absent entry, and a presented provenance change is invalid input. */
function promoteWithMemoryGuard(
  record: StoredRecord,
  authorizedWorkspaceId: string,
  expectedRevision: unknown
): Readonly<{ to: 'active'; nextRevision: number }> {
  try {
    const plan = requireMemoryPromotion({
      entry: memoryProvenanceRecord(record),
      authorizedWorkspaceId,
      expectedRevision: revisionOf(expectedRevision),
    })
    return { to: plan.to, nextRevision: plan.nextRevision }
  } catch (error) {
    const reason = (error as { reason?: MemoryProvenanceRefusal }).reason
    if (reason === 'memory_audience_mismatch') throw new MemoryStoreError('memory_not_found')
    if (reason === 'memory_provenance_mismatch') throw new MemoryStoreError('memory_invalid_input')
    if (reason === 'memory_stale_revision') throw new MemoryStoreError('memory_stale_revision')
    throw new MemoryStoreError('memory_invalid_state')
  }
}

export function createMemoryStore(options: {
  /** The local content directory; records live in its `memory/` child. */
  contentDir: string
  key: () => Buffer
  now?: () => number
}): MemoryStore {
  const dir = join(options.contentDir, 'memory')
  const settingsFile = join(options.contentDir, 'memory-settings.json')
  const now = options.now ?? Date.now
  mkdirSync(dir, { recursive: true, mode: 0o700 })

  function iso(): string {
    return new Date(now()).toISOString()
  }

  function recordFile(id: string): string {
    return join(dir, `${id}.json`)
  }

  function seal(workspaceId: string, id: string, text: string) {
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', options.key(), nonce)
    cipher.setAAD(associatedData(workspaceId, id))
    const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
    return {
      nonce: nonce.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    }
  }

  /** Opens a record under the AUTHORIZED workspace; any mismatch throws. */
  function open(record: StoredRecord, workspaceId: string): string {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      options.key(),
      Buffer.from(record.nonce, 'base64')
    )
    decipher.setAAD(associatedData(workspaceId, record.id))
    decipher.setAuthTag(Buffer.from(record.tag, 'base64'))
    return Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8')
  }

  function readRecord(id: string): StoredRecord | undefined {
    try {
      const parsed = JSON.parse(readFileSync(recordFile(id), 'utf8')) as StoredRecord
      if (parsed?.contentType !== MEMORY_CONTENT_TYPE || parsed.id !== id) return undefined
      return parsed
    } catch {
      return undefined
    }
  }

  function workspaceRecords(workspaceId: string): StoredRecord[] {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return []
    }
    const records: StoredRecord[] = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const id = name.slice(0, -'.json'.length)
      if (!UUID_PATTERN.test(id)) continue
      const record = readRecord(id)
      if (record && record.workspaceId === workspaceId) records.push(record)
    }
    return records
  }

  function purgeRecords(workspaceId: string) {
    const id = assertMemoryWorkspaceId(workspaceId)
    const records = workspaceRecords(id)
    // Unknown ownership or filesystem indirection must never be silently skipped.
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      const entryId = name.slice(0, -5)
      const stat = lstatSync(join(dir, name))
      const record = UUID_PATTERN.test(entryId) ? readRecord(entryId) : undefined
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        !record ||
        !UUID_PATTERN.test(record.workspaceId)
      )
        throw new MemoryStoreError('memory_unavailable')
    }
    // A relabelled file cannot make deletion consume another workspace's
    // ciphertext. Authenticate the complete set before the first unlink.
    try {
      for (const record of records) open(record, id)
    } catch {
      throw new MemoryStoreError('memory_unavailable')
    }
    const settingsStat = lstatSync(settingsFile, { throwIfNoEntry: false })
    if (settingsStat) {
      if (!settingsStat.isFile() || settingsStat.isSymbolicLink())
        throw new MemoryStoreError('memory_unavailable')
      const settings = JSON.parse(readFileSync(settingsFile, 'utf8')) as Settings
      if (
        settings?.version !== 1 ||
        !settings.injection ||
        typeof settings.injection !== 'object' ||
        Array.isArray(settings.injection) ||
        Object.entries(settings.injection).some(
          ([key, value]) => !UUID_PATTERN.test(key) || typeof value !== 'boolean'
        )
      )
        throw new MemoryStoreError('memory_unavailable')
    }
    return records
  }

  function readEntries(workspaceId: string): {
    entries: WorkspaceMemoryEntry[]
    unreadable: number
  } {
    const entries: WorkspaceMemoryEntry[] = []
    let unreadable = 0
    for (const record of workspaceRecords(workspaceId)) {
      try {
        entries.push(toEntry(record, open(record, workspaceId)))
      } catch {
        unreadable += 1
      }
    }
    return { entries: entries.toSorted(newestFirst), unreadable }
  }

  /** The workspace's record by id; foreign or absent ids read as not found. */
  function requireRecord(workspaceId: string, entryId: unknown): StoredRecord {
    const id = entryIdOf(entryId)
    const record = readRecord(id)
    if (!record || record.workspaceId !== workspaceId) {
      throw new MemoryStoreError('memory_not_found')
    }
    return record
  }

  function insert(
    workspaceId: string,
    text: string,
    source: WorkspaceMemoryEntry['source'],
    status: WorkspaceMemoryEntry['status']
  ): WorkspaceMemoryEntry {
    const existing = workspaceRecords(workspaceId)
    if (existing.length >= workspaceMemoryLimits.entriesPerWorkspace) {
      throw new MemoryStoreError('memory_limit_exceeded')
    }
    if (
      status === 'pending' &&
      existing.filter((record) => record.status === 'pending').length >=
        workspaceMemoryLimits.pendingPerWorkspace
    ) {
      throw new MemoryStoreError('memory_limit_exceeded')
    }
    const id = randomUUID()
    const at = iso()
    const record: StoredRecord = {
      schemaVersion: SCHEMA_VERSION,
      keyVersion: KEY_VERSION,
      contentType: MEMORY_CONTENT_TYPE,
      id,
      workspaceId,
      source,
      status,
      createdAt: at,
      updatedAt: at,
      revision: 1,
      ...seal(workspaceId, id, text),
    }
    writeAtomic(recordFile(id), record)
    return toEntry(record, text)
  }

  function readSettings(): Settings {
    try {
      const parsed = JSON.parse(readFileSync(settingsFile, 'utf8')) as Settings
      if (parsed?.version === 1 && parsed.injection && typeof parsed.injection === 'object') {
        return { version: 1, injection: { ...parsed.injection } }
      }
    } catch {
      /* absent or unreadable: defaults */
    }
    return { version: 1, injection: {} }
  }

  function injectionEnabled(workspaceId: string): boolean {
    // Default on: only an explicit `false` turns injection off.
    return readSettings().injection[assertMemoryWorkspaceId(workspaceId)] !== false
  }

  return Object.freeze({
    list(workspaceId) {
      const id = assertMemoryWorkspaceId(workspaceId)
      const { entries, unreadable } = readEntries(id)
      return { entries, injectionEnabled: injectionEnabled(id), unreadable }
    },
    create(workspaceId, input) {
      const id = assertMemoryWorkspaceId(workspaceId)
      return insert(id, normalizeMemoryText(input.text), 'user', 'active')
    },
    propose(workspaceId, input) {
      const id = assertMemoryWorkspaceId(workspaceId)
      return insert(id, normalizeMemoryText(input.text), 'agent', 'pending')
    },
    update(workspaceId, input) {
      const id = assertMemoryWorkspaceId(workspaceId)
      const record = requireRecord(id, input.entryId)
      requireRevision(record, input.expectedRevision)
      const text = normalizeMemoryText(input.text)
      const next: StoredRecord = {
        ...record,
        updatedAt: iso(),
        revision: record.revision + 1,
        ...seal(id, record.id, text),
      }
      writeAtomic(recordFile(record.id), next)
      return toEntry(next, text)
    },
    remove(workspaceId, input) {
      const id = assertMemoryWorkspaceId(workspaceId)
      const record = requireRecord(id, input.entryId)
      requireRevision(record, input.expectedRevision)
      rmSync(recordFile(record.id), { force: true })
    },
    accept(workspaceId, input) {
      const id = assertMemoryWorkspaceId(workspaceId)
      const record = requireRecord(id, input.entryId)
      // Promotion is explicit and carries the record's own provenance and
      // audience through unchanged; the typed plan pins the revision that
      // becomes active, so a concurrent edit refuses instead of being
      // overwritten.
      const promotion = promoteWithMemoryGuard(record, id, input.expectedRevision)
      // The text must still authenticate under this workspace before the
      // proposal becomes memory; a tampered record never gets promoted.
      const text = open(record, id)
      const next: StoredRecord = {
        ...record,
        status: promotion.to,
        updatedAt: iso(),
        revision: promotion.nextRevision,
      }
      writeAtomic(recordFile(record.id), next)
      return toEntry(next, text)
    },
    reject(workspaceId, input) {
      const id = assertMemoryWorkspaceId(workspaceId)
      const record = requireRecord(id, input.entryId)
      requireRevision(record, input.expectedRevision)
      if (record.status !== 'pending') throw new MemoryStoreError('memory_invalid_state')
      // A rejected proposal is deleted (ADR 0012), never kept as a tombstone.
      rmSync(recordFile(record.id), { force: true })
    },
    injectionEnabled,
    validateWorkspacePurge: (workspaceId) => purgeRecords(workspaceId).length,
    purgeWorkspace(workspaceId) {
      const id = assertMemoryWorkspaceId(workspaceId)
      const records = purgeRecords(id)
      for (const record of records) rmSync(recordFile(record.id), { force: true })
      const settings = readSettings()
      delete settings.injection[id]
      writeAtomic(settingsFile, settings)
      return records.length
    },
    setInjectionEnabled(workspaceId, enabled) {
      const id = assertMemoryWorkspaceId(workspaceId)
      if (typeof enabled !== 'boolean') throw new MemoryStoreError('memory_invalid_input')
      const settings = readSettings()
      settings.injection[id] = enabled
      writeAtomic(settingsFile, settings)
      return enabled
    },
    preamble(workspaceId) {
      const id = assertMemoryWorkspaceId(workspaceId)
      if (!injectionEnabled(id)) return undefined
      const active = readEntries(id).entries.filter((entry) => entry.status === 'active')
      return compileMemoryPreamble(active)
    },
  })
}
