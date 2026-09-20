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
import { dirname } from 'node:path'

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
