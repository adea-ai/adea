// M10 #34: the credential vault authority.
//
// Secrets live only behind sealed storage (AES-256-GCM with a dedicated vault
// key, distinct from the local-content key class) and are handed out solely to
// authorized runtime drivers through `resolve`. Every other surface — list,
// get, replies, errors, audit — sees CredentialRef records without secret
// material, and the sealed holder refuses JSON/string coercion so a resolved
// secret cannot silently enter ordinary client state or a log line.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

import {
  DevAuthorityError,
  isUuid,
  newRecordId,
  nowIso,
  requireApproval,
  requireLabel,
  sameScope,
  type DevScope,
  type OwnerApproval,
} from './authority'
import type { AuthorityAudit } from './audit'
import { createDurableJsonStore } from './host-store'

export type CredentialRefKind = 'git_https' | 'github_token' | 'ssh_key' | 'other'
export type CredentialRefState = 'ready' | 'expired' | 'revoked' | 'unknown'

export type CredentialRefRecord = Readonly<{
  id: string
  scope: DevScope
  label: string
  host: string
  kind: CredentialRefKind
  state: CredentialRefState
  version: number
  createdAt: string
  updatedAt: string
  revokedAt?: string
  revokedReason?: string
}>

export type CredentialRefPage = Readonly<{
  items: ReadonlyArray<CredentialRefRecord>
  nextCursor?: string
  observedAt: string
}>

/** Holder for unsealed secret material. Coercion through JSON, string
 * templates, or concatenation throws: only `reveal()` at a driver seam does. */
export class VaultSecret {
  constructor(private readonly plaintext: string) {}

  reveal(): string {
    return this.plaintext
  }

  toJSON(): never {
    throw new DevAuthorityError('unauthorized', 'credential material refuses serialization')
  }

  toString(): string {
    throw new DevAuthorityError('unauthorized', 'credential material refuses serialization')
  }

  valueOf(): never {
    throw new DevAuthorityError('unauthorized', 'credential material refuses serialization')
  }

  [Symbol.toPrimitive](): never {
    throw new DevAuthorityError('unauthorized', 'credential material refuses serialization')
  }
}

const HOST_PATTERN = /^[A-Za-z0-9.-]+(?::\d+)?$/
const SECRET_MAX_CHARS = 8192
const MAX_PAGE_LIMIT = 500
const DEFAULT_PAGE_LIMIT = 100

/** A malformed id and a foreign-scope id read identically: not found. */
function findRef(
  records: ReadonlyArray<CredentialRefRecord>,
  scope: DevScope,
  credentialRefId: string
): CredentialRefRecord | undefined {
  const record = records.find((entry) => entry.id === credentialRefId)
  if (!record || !isUuid(credentialRefId) || !sameScope(record.scope, scope)) return undefined
  return record
}

export type VaultKeyStore = Readonly<{
  get(service: string, account: string): Buffer | undefined
  set(service: string, account: string, key: Buffer): void
  delete(service: string, account: string): void
}>

const VAULT_KEY_SERVICE = 'com.adea.desktop.dev-runtime'
const VAULT_KEY_ACCOUNT = 'master-key-v1'

/**
 * The production adapter keeps the vault master key in macOS Keychain. A
 * file-backed fallback is deliberately not provided: a local file is not an
 * OS credential store and would turn a stolen app-data directory into the
 * ability to decrypt every credential reference. Tests inject an in-memory
 * adapter instead.
 */
export function createSystemVaultKeyStore(): VaultKeyStore {
  if (process.platform !== 'darwin') {
    throw new DevAuthorityError(
      'auth_required',
      'the credential vault requires an OS credential store on this platform'
    )
  }
  const security = (args: string[], input?: Buffer): Buffer => {
    try {
      return execFileSync('/usr/bin/security', args, {
        input,
        encoding: 'buffer',
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as Buffer
    } catch {
      throw new DevAuthorityError('auth_required', 'the OS credential store is unavailable')
    }
  }
  return {
    get(service, account) {
      try {
        const encoded = security(['find-generic-password', '-s', service, '-a', account, '-w'])
          .toString('utf8')
          .trim()
        return Buffer.from(encoded, 'base64')
      } catch {
        // An absent item is the only case where initialization may create a
        // key. Locked/denied stores fail closed in `set` below.
        return undefined
      }
    },
    set(service, account, key) {
      if (key.byteLength !== 32) throw new DevAuthorityError('corrupt_state', 'invalid vault key')
      security([
        'add-generic-password',
        '-U',
        '-s',
        service,
        '-a',
        account,
        '-w',
        key.toString('base64'),
      ])
    },
    delete(service, account) {
      try {
        security(['delete-generic-password', '-s', service, '-a', account])
      } catch {
        // Deletion is idempotent when the item was already removed.
      }
    },
  }
}

function loadVaultKey(keyStore: VaultKeyStore): Buffer {
  const existing = keyStore.get(VAULT_KEY_SERVICE, VAULT_KEY_ACCOUNT)
  if (existing) {
    if (existing.byteLength !== 32)
      throw new DevAuthorityError('corrupt_state', 'vault key has an unexpected size')
    return existing
  }
  const key = randomBytes(32)
  keyStore.set(VAULT_KEY_SERVICE, VAULT_KEY_ACCOUNT, key)
  return key
}

export function createCredentialVault(options: {
  dataDir: string
  audit?: AuthorityAudit
  /** Injectable only for deterministic tests and approved host adapters. */
  credentialStore?: VaultKeyStore
}) {
  const { dataDir, audit } = options
  const vaultDir = join(dataDir, 'dev-runtime', 'vault')
  mkdirSync(vaultDir, { recursive: true, mode: 0o700 })
  const vaultKeyStore = options.credentialStore ?? createSystemVaultKeyStore()
  const vaultKey = loadVaultKey(vaultKeyStore)
  const store = createDurableJsonStore<CredentialRefRecord>({
    file: join(vaultDir, 'credentials.json'),
    schemaVersion: 1,
    label: 'credential vault',
  })

  function load(): CredentialRefRecord[] {
    return [...store.load().records]
  }

  function save(records: ReadonlyArray<CredentialRefRecord>): void {
    store.save(records)
  }

  function seal(refId: string, secret: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', vaultKey, iv, { authTagLength: 16 })
    // AAD binds each ciphertext to its reference id: sealed bytes cannot be
    // swapped between credential records.
    cipher.setAAD(Buffer.from(refId, 'utf8'))
    const sealed = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString('base64')
  }

  function unseal(refId: string, sealedBase64: string): string {
    const raw = Buffer.from(sealedBase64, 'base64')
    if (raw.byteLength < 28 + 1) {
      throw new DevAuthorityError('corrupt_state', 'sealed credential material is truncated')
    }
    const iv = raw.subarray(0, 12)
    const tag = raw.subarray(12, 28)
    const body = raw.subarray(28)
    const decipher = createDecipheriv('aes-256-gcm', vaultKey, iv, { authTagLength: 16 })
    decipher.setAAD(Buffer.from(refId, 'utf8'))
    decipher.setAuthTag(tag)
    try {
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
    } catch {
      throw new DevAuthorityError(
        'corrupt_state',
        'sealed credential material failed authentication'
      )
    }
  }

  function sealedPath(refId: string): string {
    return join(vaultDir, `${refId}.sealed`)
  }

  function writeSealed(refId: string, secret: string): void {
    writeFileSync(sealedPath(refId), seal(refId, secret), { mode: 0o600 })
  }

  function log(
    action: string,
    subjectId: string,
    outcome: 'granted' | 'denied' | 'revoked' | 'failed' | 'recovered',
    detail?: Record<string, string>
  ): void {
    audit?.append({ action, subjectId, outcome, ...(detail ? { detail } : {}) })
  }

  function assertHost(host: unknown): string {
    if (
      typeof host !== 'string' ||
      host.length < 1 ||
      host.length > 253 ||
      !HOST_PATTERN.test(host)
    ) {
      throw new DevAuthorityError('invalid_state', 'credential host must be a bare hostname')
    }
    return host
  }

  function assertSecret(secret: unknown): string {
    if (typeof secret !== 'string' || secret.length < 1 || secret.length > SECRET_MAX_CHARS) {
      throw new DevAuthorityError('invalid_state', 'credential secret must be 1..8192 characters')
    }
    return secret
  }

  function enroll(input: {
    scope: DevScope
    label: string
    host: string
    kind: CredentialRefKind
    secret: string
    approval?: OwnerApproval
  }): CredentialRefRecord {
    const approval = requireApproval(input.approval, 'enroll a credential')
    const label = requireLabel(input.label, 'credential')
    const host = assertHost(input.host)
    const secret = assertSecret(input.secret)
    if (!['git_https', 'github_token', 'ssh_key', 'other'].includes(input.kind)) {
      throw new DevAuthorityError('invalid_state', 'credential kind is unknown')
    }

    const all = load()
    const existing = all.find(
      (entry) =>
        sameScope(entry.scope, input.scope) &&
        entry.host === host &&
        entry.label === label &&
        entry.state !== 'revoked'
    )
    if (existing) {
      if (existing.state === 'ready') return existing
      // 'unknown' means the sealed material is unreadable: this explicit
      // re-enrollment repairs the record under the owner's fresh approval.
      writeSealed(existing.id, secret)
      const repaired: CredentialRefRecord = {
        ...existing,
        state: 'ready',
        version: existing.version + 1,
        updatedAt: nowIso(),
      }
      save(all.map((entry) => (entry.id === existing.id ? repaired : entry)))
      log('vault.repaired', existing.id, 'recovered', { host, kind: input.kind })
      return repaired
    }

    const record: CredentialRefRecord = {
      id: newRecordId(),
      scope: { ...input.scope },
      label,
      host,
      kind: input.kind,
      state: 'ready',
      version: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    all.push(record)
    writeSealed(record.id, secret)
    save(all)
    log('vault.enrolled', record.id, 'granted', {
      host,
      kind: input.kind,
      approvalMethod: approval.method,
    })
    return record
  }

  function get(input: { scope: DevScope; credentialRefId: string }): CredentialRefRecord {
    const record = findRef(load(), input.scope, input.credentialRefId)
    if (!record) throw new DevAuthorityError('not_found', 'credential reference not found')
    return record
  }

  function rotate(input: {
    scope: DevScope
    credentialRefId: string
    secret: string
    expectedVersion: number
  }): CredentialRefRecord {
    const secret = assertSecret(input.secret)
    const all = load()
    const record = findRef(all, input.scope, input.credentialRefId)
    if (!record) throw new DevAuthorityError('not_found', 'credential reference not found')
    if (record.state === 'revoked') {
      throw new DevAuthorityError('invalid_state', 'revoked credential references cannot rotate')
    }
    if (record.version !== input.expectedVersion) {
      throw new DevAuthorityError('stale_version', 'credential version conflict', record.version)
    }
    writeSealed(record.id, secret)
    const rotated: CredentialRefRecord = {
      ...record,
      state: 'ready',
      version: record.version + 1,
      updatedAt: nowIso(),
    }
    save(all.map((entry) => (entry.id === record.id ? rotated : entry)))
    log('vault.rotated', record.id, 'recovered')
    return rotated
  }

  function revoke(input: {
    scope: DevScope
    credentialRefId: string
    expectedVersion: number
    reason?: string
  }): CredentialRefRecord {
    const all = load()
    const record = findRef(all, input.scope, input.credentialRefId)
    if (!record) throw new DevAuthorityError('not_found', 'credential reference not found')
    if (record.state === 'revoked') return record
    if (record.version !== input.expectedVersion) {
      throw new DevAuthorityError('stale_version', 'credential version conflict', record.version)
    }
    const revoked: CredentialRefRecord = {
      ...record,
      state: 'revoked',
      version: record.version + 1,
      updatedAt: nowIso(),
      revokedAt: nowIso(),
      ...(input.reason ? { revokedReason: input.reason.slice(0, 256) } : {}),
    }
    save(all.map((entry) => (entry.id === record.id ? revoked : entry)))
    rmSync(sealedPath(record.id), { force: true })
    // The master key remains in Keychain for other references; revoking one
    // credential must never rotate or export it.
    log('vault.revoked', record.id, 'revoked')
    return revoked
  }

  /** The only secret-returning seam. `audience` is structural: ordinary
   * client/web callers can never authenticate as a runtime driver. */
  function resolve(input: {
    scope: DevScope
    credentialRefId: string
    audience: 'runtime_driver'
  }): VaultSecret {
    if (input.audience !== 'runtime_driver') {
      log('vault.resolve_denied', input.credentialRefId, 'denied')
      throw new DevAuthorityError(
        'unauthorized',
        'credential material is restricted to runtime drivers'
      )
    }
    const record = get(input)
    if (record.state === 'revoked') {
      log('vault.resolve_denied', record.id, 'denied')
      throw new DevAuthorityError('unauthorized', 'credential reference has been revoked')
    }
    if (record.state === 'expired') {
      throw new DevAuthorityError('auth_required', 'credential reference has expired')
    }
    const sealedFile = sealedPath(record.id)
    if (!existsSync(sealedFile)) {
      markUnknown(record)
      throw new DevAuthorityError('corrupt_state', 'sealed credential material is missing')
    }
    let plaintext: string
    try {
      plaintext = unseal(record.id, readFileSync(sealedFile, 'utf8'))
    } catch (error) {
      if (error instanceof DevAuthorityError && error.code === 'corrupt_state') {
        markUnknown(record)
        log('vault.resolve_failed', record.id, 'failed')
      }
      throw error
    }
    return new VaultSecret(plaintext)
  }

  function markUnknown(record: CredentialRefRecord): void {
    const all = load()
    const index = all.findIndex((entry) => entry.id === record.id)
    if (index < 0) return
    all[index] = {
      ...record,
      state: 'unknown',
      version: record.version + 1,
      updatedAt: nowIso(),
    }
    save(all)
  }

  function list(input: {
    scope: DevScope
    host?: string
    cursor?: string
    limit?: number
  }): CredentialRefPage {
    if (
      input.limit !== undefined &&
      (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_PAGE_LIMIT)
    ) {
      throw new DevAuthorityError('limit_exceeded', `limit must be an integer 1..${MAX_PAGE_LIMIT}`)
    }
    const pageSize = input.limit ?? DEFAULT_PAGE_LIMIT
    let start = 0
    if (input.cursor !== undefined) {
      const decoded = Number(Buffer.from(input.cursor, 'base64url').toString('utf8'))
      if (!Number.isSafeInteger(decoded) || decoded < 0) {
        throw new DevAuthorityError('not_found', 'unknown listing cursor')
      }
      start = decoded
    }
    const filtered = load().filter(
      (entry) =>
        sameScope(entry.scope, input.scope) &&
        (input.host === undefined || entry.host === input.host)
    )
    const items = filtered.slice(start, start + pageSize)
    const nextCursor =
      start + pageSize < filtered.length
        ? Buffer.from(String(start + pageSize)).toString('base64url')
        : undefined
    return { items, ...(nextCursor ? { nextCursor } : {}), observedAt: nowIso() }
  }

  return Object.freeze({ enroll, get, rotate, revoke, resolve, list })
}

export type CredentialVault = ReturnType<typeof createCredentialVault>
