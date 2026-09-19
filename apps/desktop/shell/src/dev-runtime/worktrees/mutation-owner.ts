// Per-repository mutation ownership: a cross-process filesystem lock with
// stale-owner recovery plus a durable idempotency ledger.
//
// An in-process promise queue is not sufficient: app, sidecar, recovery, and
// remote command workers can overlap on one repository common dir. The lock
// file records owner process identity, runtime-node ID, nonce, operation,
// heartbeat, and acquisition time; creation is exclusive; stale recovery
// requires proving the owner process is gone (same-host PID) or abandoning it
// after the stale-consideration window (different node). Idempotency keys make
// an acquire-timeout-plus-retry safe: a completed mutation replays its recorded
// result instead of repeating side effects, so a timeout can never produce
// duplicate worktrees.
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  closeSync,
  fsyncSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { createDurableJsonStore } from '../host-store'
import { WorktreeError } from './errors'

export const LOCK_ACQUIRE_TIMEOUT_MS = 30_000
export const LOCK_HEARTBEAT_MS = 5_000
export const LOCK_STALE_AFTER_MS = 30_000
const LOCK_POLL_MS = 100

// `key 1..128 printable ASCII`, completed-mutation retention 24 hours to 7 days.
export const IDEMPOTENCY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export type MutationOwnerRecord = Readonly<{
  pid: number
  runtimeNodeId: string
  nonce: string
  operation: string
  acquiredAt: string
  heartbeatAt: string
}>

export type IdempotencyRecord<T = unknown> = Readonly<{
  key: string
  scopeKey: string
  resultDigest: string
  result: T
  completedAt: string
  expiresAt: string
}>

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Rename-aside then re-claim exclusively. Two stealers race on the rename;
 *  only one rename succeeds, and the loser re-reads before retrying. */
function stealStaleLock(file: string): boolean {
  const aside = `${file}.stale-${process.pid}-${Date.now()}`
  try {
    renameSync(file, aside)
  } catch {
    return false
  }
  try {
    unlinkSync(aside)
  } catch {
    // Another stealer unlinked first; harmless.
  }
  return true
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function writeLockFile(file: string, record: MutationOwnerRecord & { commonDir: string }): void {
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
  const handle = openSync(temporary, 'wx', 0o600)
  try {
    writeSync(handle, JSON.stringify(record))
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
  renameSync(temporary, file)
}

export type RepoMutationOwner = ReturnType<typeof createRepoMutationOwner>

export function createRepoMutationOwner(options: {
  dataDir: string
  runtimeNodeId: string
  heartbeatIntervalMs?: number
  staleAfterMs?: number
  acquireTimeoutMs?: number
  pollIntervalMs?: number
  clock?: () => Date
}) {
  const {
    dataDir,
    runtimeNodeId,
    heartbeatIntervalMs = LOCK_HEARTBEAT_MS,
    staleAfterMs = LOCK_STALE_AFTER_MS,
    acquireTimeoutMs = LOCK_ACQUIRE_TIMEOUT_MS,
    pollIntervalMs = LOCK_POLL_MS,
    clock = () => new Date(),
  } = options

  const lockDir = join(dataDir, 'dev-runtime', 'worktrees', 'locks')
  const idempotencyStore = createDurableJsonStore<IdempotencyRecord>({
    file: join(dataDir, 'dev-runtime', 'worktrees', 'idempotency.json'),
    schemaVersion: 1,
    label: 'worktree idempotency',
  })
  mkdirSync(lockDir, { recursive: true, mode: 0o700 })

  function lockPath(repoCommonDir: string): string {
    return join(lockDir, `${sha256(repoCommonDir)}.lock`)
  }

  function scopeKey(repoCommonDir: string, operation: string): string {
    return sha256(`${sha256(repoCommonDir)}\n${operation}`)
  }

  function readLockRecord(file: string): (MutationOwnerRecord & { commonDir: string }) | null {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as
        | (MutationOwnerRecord & { commonDir: string })
        | null
      if (!parsed || typeof parsed !== 'object' || typeof parsed.nonce !== 'string') return null
      return parsed
    } catch {
      return null
    }
  }

  /** Exclusive-create the lock file. Only `wx` makes acquisition atomic:
   *  a tmp+rename publish would silently replace an existing owner's lock. */
  function claim(file: string, operation: string, repoCommonDir: string): boolean {
    const at = clock().toISOString()
    const record: MutationOwnerRecord & { commonDir: string } = {
      pid: process.pid,
      runtimeNodeId,
      nonce: sha256(`${process.pid}:${Date.now()}:${Math.random()}`).slice(0, 32),
      operation,
      acquiredAt: at,
      heartbeatAt: at,
      commonDir: repoCommonDir,
    }
    let handle: number
    try {
      handle = openSync(file, 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    }
    try {
      writeSync(handle, JSON.stringify(record))
      fsyncSync(handle)
    } finally {
      closeSync(handle)
    }
    return true
  }

  /** True only when the recorded owner is provably gone or provably abandoned:
   *  a same-host PID that no longer exists, or a heartbeat older than the
   *  stale-consideration window (the only proof available across nodes). */
  function lockIsStale(record: MutationOwnerRecord, at: Date): boolean {
    const heartbeatAge = at.getTime() - new Date(record.heartbeatAt).getTime()
    if (record.runtimeNodeId === runtimeNodeId && !processAlive(record.pid)) return true
    return heartbeatAge > staleAfterMs
  }

  async function acquire(
    repoCommonDir: string,
    operation: string,
    timeoutMs = acquireTimeoutMs
  ): Promise<() => void> {
    const file = lockPath(repoCommonDir)
    const deadline = clock().getTime() + timeoutMs
    while (true) {
      if (claim(file, operation, repoCommonDir)) {
        const ours = readLockRecord(file)
        const ourNonce = ours?.nonce ?? ''
        const heartbeat = setInterval(() => {
          const record = readLockRecord(file)
          // Only refresh a lock this process still owns (never a replacement
          // owner's file).
          if (!record || record.pid !== process.pid || record.nonce !== ourNonce) return
          try {
            writeLockFile(file, { ...record, heartbeatAt: clock().toISOString() })
          } catch {
            // A transient heartbeat failure must not drop the lock; the stale
            // window (30s) is far wider than the heartbeat interval (5s).
          }
        }, heartbeatIntervalMs)
        heartbeat.unref?.()
        let released = false
        return () => {
          if (released) return
          released = true
          clearInterval(heartbeat)
          const record = readLockRecord(file)
          // Never delete a lock we do not own (a stolen-then-reclaimed file).
          if (record && record.pid === process.pid) unlinkSync(file)
        }
      }

      const record = readLockRecord(file)
      const at = clock()
      if (!record) {
        // Malformed or vanished between the claim and the read: retry immediately.
        continue
      }
      if (lockIsStale(record, at) && stealStaleLock(file)) {
        continue
      }
      if (at.getTime() >= deadline) {
        throw new WorktreeError(
          'lock_timeout',
          `another process owns the ${operation} mutation for this repository`,
          { action: 'retry', parameters: { operation } }
        )
      }
      await sleep(pollIntervalMs)
    }
  }

  function completedResult<T>(
    repoCommonDir: string,
    operation: string,
    key: string
  ): T | undefined {
    const records = idempotencyStore.load().records
    const at = clock()
    const record = records.find(
      (entry) =>
        entry.key === key &&
        entry.scopeKey === scopeKey(repoCommonDir, operation) &&
        new Date(entry.expiresAt).getTime() > at.getTime()
    )
    return record ? (record.result as T) : undefined
  }

  function recordCompletion<T>(
    repoCommonDir: string,
    operation: string,
    key: string,
    result: T
  ): void {
    if (!key) return
    const at = clock()
    const serialized = JSON.stringify(result ?? null)
    const record: IdempotencyRecord = {
      key,
      scopeKey: scopeKey(repoCommonDir, operation),
      resultDigest: sha256(serialized),
      result: JSON.parse(serialized) as T,
      completedAt: at.toISOString(),
      expiresAt: new Date(at.getTime() + IDEMPOTENCY_RETENTION_MS).toISOString(),
    }
    const current = idempotencyStore.load().records
    const next = current.filter(
      (entry) =>
        !(entry.key === key && entry.scopeKey === record.scopeKey) &&
        new Date(entry.expiresAt).getTime() > at.getTime()
    )
    next.push(record)
    idempotencyStore.save(next)
  }

  /** Serialize one repository mutation across processes, deduplicating by
   *  idempotency key. The callback runs while an exclusive lock is held and a
   *  heartbeat is live; its result must be JSON-serializable when a key is
   *  supplied, because a retried key replays the recorded result. */
  async function withMutation<T>(
    input: {
      repoCommonDir: string
      operation: string
      idempotencyKey?: string
      timeoutMs?: number
      signal?: AbortSignal
    },
    fn: () => Promise<T>
  ): Promise<T> {
    if (input.idempotencyKey !== undefined) {
      if (!/^[\x20-\x7e]{1,128}$/.test(input.idempotencyKey)) {
        throw new WorktreeError('invalid_state', 'idempotency key must be 1..128 printable ASCII')
      }
    }
    const prior = input.idempotencyKey
      ? completedResult<T>(input.repoCommonDir, input.operation, input.idempotencyKey)
      : undefined
    if (prior !== undefined) return prior
    if (input.signal?.aborted) {
      throw new WorktreeError('cancelled', 'mutation was cancelled before it started')
    }

    const release = await acquire(input.repoCommonDir, input.operation, input.timeoutMs)
    try {
      // Re-check under the lock: a peer may have completed the same logical
      // mutation while this caller waited for the lock.
      const raced = input.idempotencyKey
        ? completedResult<T>(input.repoCommonDir, input.operation, input.idempotencyKey)
        : undefined
      if (raced !== undefined) return raced
      const result = await fn()
      if (input.idempotencyKey) {
        recordCompletion(input.repoCommonDir, input.operation, input.idempotencyKey, result)
      }
      return result
    } finally {
      release()
    }
  }

  /** Direct lock hold for callers that must span several await points with
   *  their own idempotency handling (cleanup commits). */
  async function holdLock(
    repoCommonDir: string,
    operation: string,
    timeoutMs?: number
  ): Promise<() => void> {
    return acquire(repoCommonDir, operation, timeoutMs)
  }

  function lockOwner(repoCommonDir: string): (MutationOwnerRecord & { commonDir: string }) | null {
    return readLockRecord(lockPath(repoCommonDir))
  }

  function lockFileExists(repoCommonDir: string): boolean {
    return existsSync(lockPath(repoCommonDir))
  }

  return Object.freeze({
    withMutation,
    holdLock,
    lockOwner,
    lockFileExists,
    scopeKey,
  })
}
