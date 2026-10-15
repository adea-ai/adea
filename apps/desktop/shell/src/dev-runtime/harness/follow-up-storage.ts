// #1393: sealed bounded queue records, serialized through the existing host
// cross-process mutation owner. No prompt text enters the lock/idempotency log.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Scope } from '../../../../../../packages/types/src/dev-runtime'
import { createDurableJsonStore } from '../host-store'
import { createRepoMutationOwner } from '../worktrees/mutation-owner'

type SealedQueue = {
  runtimeSessionId: string
  generation: number
  nonce: string
  tag: string
  ciphertext: string
}
export function followUpQueueDataFile(dataDir: string, scope: Scope): string {
  const key = JSON.stringify([scope.accountId, scope.workspaceId, scope.runtimeNodeId])
  const digest = createHash('sha256').update(key).digest('hex')
  return join(dataDir, 'dev-runtime', 'harness', 'follow-ups', `${digest}.json`)
}
/** Read-only ownership/recovery checks shared with authorized workspace purge. */
export function assertFollowUpQueueStoragePath(dataDir: string, scope: Scope): string {
  const file = followUpQueueDataFile(dataDir, scope)
  for (const directory of [
    join(dataDir, 'dev-runtime'),
    join(dataDir, 'dev-runtime', 'harness'),
    dirname(file),
  ]) {
    const info = lstatSync(directory, { throwIfNoEntry: false })
    if (info && !info.isDirectory())
      throw {
        code: 'corrupt_state',
        retryable: false,
        message: 'follow-up queue directory identity is not valid',
      }
  }
  if (lstatSync(dirname(file), { throwIfNoEntry: false })) {
    const name = basename(file)
    if (
      readdirSync(dirname(file)).some(
        (entry) => entry.startsWith(`${name}.corrupt-`) || entry.startsWith(`${name}.tmp-`)
      )
    )
      throw {
        code: 'recovery_required',
        retryable: false,
        message: 'retained follow-up queue data requires recovery',
      }
  }
  return file
}
export function createFollowUpStorage(input: {
  dataDir: string
  scope: Scope
  key?: () => Buffer
}) {
  const scopeKey = JSON.stringify([
    input.scope.accountId,
    input.scope.workspaceId,
    input.scope.runtimeNodeId,
  ])
  const storageFile = followUpQueueDataFile(input.dataDir, input.scope)
  const store = createDurableJsonStore<SealedQueue>({
    file: storageFile,
    schemaVersion: 1,
    label: 'sealed follow-up queues',
  })
  let owner: ReturnType<typeof createRepoMutationOwner> | undefined
  const mutationOwner = () =>
    (owner ??= createRepoMutationOwner({
      dataDir: input.dataDir,
      runtimeNodeId: input.scope.runtimeNodeId,
      acquireTimeoutMs: 5_000,
      pollIntervalMs: 5,
    }))
  let deliveryOwner: ReturnType<typeof createRepoMutationOwner> | undefined
  const deliveryMutationOwner = () =>
    (deliveryOwner ??= createRepoMutationOwner({
      dataDir: input.dataDir,
      runtimeNodeId: input.scope.runtimeNodeId,
      // A live, paused transport may already have sent bytes. Heartbeat age
      // alone cannot prove it abandoned: reclaim only a dead same-node PID.
      staleAfterMs: Number.POSITIVE_INFINITY,
      acquireTimeoutMs: 0,
    }))
  const key = () => {
    if (input.key) return Buffer.from(input.key())
    // Borrow the already-established local-content key. This authority never
    // creates, rotates, chmods or overwrites existing credential/key material.
    const file = join(input.dataDir, 'desktop-state', 'device.key')
    try {
      if (!lstatSync(join(input.dataDir, 'desktop-state')).isDirectory()) throw new Error()
      if (!lstatSync(file).isFile()) throw new Error()
      const secret = readFileSync(file)
      if (secret.byteLength !== 32) throw new Error()
      return secret
    } catch {
      throw {
        code: 'capability_unavailable',
        retryable: false,
        message: 'existing local-content key is unavailable for follow-up storage',
      }
    }
  }
  const aad = (sessionId: string, generation: number) =>
    Buffer.from(JSON.stringify(['adea-follow-ups', 1, scopeKey, sessionId, generation]))
  function load(sessionId: string): unknown {
    assertFollowUpQueueStoragePath(input.dataDir, input.scope)
    const records = store.load().records
    if (records.length > 128)
      throw {
        code: 'corrupt_state',
        retryable: false,
        message: 'follow-up queue store exceeds its bound',
      }
    const matches = records.filter((row) => row.runtimeSessionId === sessionId)
    if (matches.length > 1)
      throw {
        code: 'corrupt_state',
        retryable: false,
        message: 'duplicate follow-up queue identity',
      }
    const row = matches[0]
    if (!row) return undefined
    const secret = key()
    try {
      const decipher = createDecipheriv('aes-256-gcm', secret, Buffer.from(row.nonce, 'base64'))
      decipher.setAAD(aad(sessionId, row.generation))
      decipher.setAuthTag(Buffer.from(row.tag, 'base64'))
      const clear = Buffer.concat([
        decipher.update(Buffer.from(row.ciphertext, 'base64')),
        decipher.final(),
      ])
      try {
        const value = JSON.parse(clear.toString('utf8'))
        if (
          value?.schemaVersion !== 1 ||
          value.runtimeSessionId !== sessionId ||
          value.generation !== row.generation
        )
          throw new Error()
        return value
      } finally {
        clear.fill(0)
      }
    } catch {
      throw {
        code: 'corrupt_state',
        retryable: false,
        message: 'follow-up queue could not be authenticated',
      }
    } finally {
      secret.fill(0)
    }
  }
  function save(sessionId: string, generation: number, value: unknown): void {
    assertFollowUpQueueStoragePath(input.dataDir, input.scope)
    const records = store.load().records.filter((row) => row.runtimeSessionId !== sessionId)
    if (records.length >= 128)
      throw {
        code: 'limit_exceeded',
        retryable: false,
        message: 'follow-up queue session limit reached',
      }
    const secret = key()
    try {
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', secret, nonce)
      cipher.setAAD(aad(sessionId, generation))
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(value), 'utf8'),
        cipher.final(),
      ])
      store.save([
        ...records,
        {
          runtimeSessionId: sessionId,
          generation,
          nonce: nonce.toString('base64'),
          tag: cipher.getAuthTag().toString('base64'),
          ciphertext: ciphertext.toString('base64'),
        },
      ])
    } finally {
      secret.fill(0)
    }
  }
  async function locked<T>(fn: () => Promise<T>): Promise<T> {
    const release = await mutationOwner().holdLock(`follow-ups:${scopeKey}`, 'follow-up queue')
    try {
      return await fn()
    } finally {
      release()
    }
  }
  async function tryDeliveryClaim(sessionId: string): Promise<(() => void) | undefined> {
    const claimOwner = deliveryMutationOwner()
    const claimKey = `follow-up-delivery:${scopeKey}:${sessionId}`
    if (claimOwner.lockFileExists(claimKey)) {
      const record = claimOwner.lockOwner(claimKey)
      // The generic owner tolerates partial lock records while acquiring.
      // Recovery of a possible send requires a positively identified PID;
      // malformed or foreign ownership must never count as a dead process.
      if (
        !record ||
        record.commonDir !== claimKey ||
        record.operation !== 'follow-up delivery' ||
        record.runtimeNodeId !== input.scope.runtimeNodeId ||
        !Number.isSafeInteger(record.pid) ||
        record.pid < 1 ||
        !/^[0-9a-f]{32}$/.test(record.nonce)
      )
        return undefined
    }
    try {
      return await claimOwner.holdLock(claimKey, 'follow-up delivery', 0)
    } catch (error) {
      if ((error as { code?: unknown })?.code === 'lock_timeout') return undefined
      throw error
    }
  }
  function validateForPurge(): void {
    assertFollowUpQueueStoragePath(input.dataDir, input.scope)
    if (mutationOwner().lockFileExists(`follow-ups:${scopeKey}`))
      throw new Error('workspace_cleanup_follow_up_busy')
    const records = store.load().records
    if (records.length > 128) throw new Error('workspace_cleanup_follow_up_data_pending')
    for (const row of records) {
      if (
        deliveryMutationOwner().lockFileExists(
          `follow-up-delivery:${scopeKey}:${row.runtimeSessionId}`
        )
      )
        throw new Error('workspace_cleanup_follow_up_busy')
      load(row.runtimeSessionId)
    }
  }
  return { storageFile, load, save, locked, tryDeliveryClaim, validateForPurge }
}
