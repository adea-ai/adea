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
  type OwnerApprovalVerifier,
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

/** Why a `security` CLI invocation failed. Only `item_not_found` may permit
 * first-time key generation; every other class fails closed. */
export type KeychainFailureReason =
  | 'item_not_found'
  | 'keychain_locked'
  | 'access_denied'
  | 'malformed_output'
  | 'process_failure'
  | 'timeout'
  | 'unavailable_executable'

export class KeychainAccessError extends Error {
  constructor(
    readonly reason: KeychainFailureReason,
    message: string,
    readonly exitCode?: number
  ) {
    super(message)
    this.name = 'KeychainAccessError'
  }
}

/** The exact `security` invocation contract, injectable for deterministic
 * tests. Resolves with stdout on exit 0; throws a classified
 * `KeychainAccessError` otherwise. */
export type SecurityCommandRunner = (args: string[], input?: Buffer) => Buffer

/** Result of one classified `security` process run. */
type SecurityRun =
  | { ok: true; stdout: Buffer }
  | { ok: false; reason: KeychainFailureReason; message: string; exitCode?: number }

const ITEM_NOT_FOUND_PATTERN =
  /could not be found|item not found|errSecItemNotFound|The specified item could not be found/i
const LOCKED_PATTERN =
  /locked|errSecInteractionNotAllowed|User interaction is not allowed|-25308|unlock/i
const DENIED_PATTERN =
  /access denied|permission denied|errSecAuthFailed|not authorized|user authorization|denied/i
const SECURITY_TIMEOUT_MS = 10_000

/**
 * Pure failure classification for one `security` process outcome. Exported
 * so the taxonomy is deterministically testable without touching a real
 * keychain: `security` exits 44 for errSecItemNotFound, and the stderr text
 * is the secondary signal across platform versions.
 */
export function classifySecurityFailure(input: {
  exitCode?: number
  stderr: string
  killed?: boolean
  signal?: string
  code?: string
}): { reason: KeychainFailureReason; message: string } {
  if (input.code === 'ENOENT') {
    return {
      reason: 'unavailable_executable',
      message: 'the OS credential store executable is unavailable',
    }
  }
  if (input.killed || input.signal === 'SIGTERM') {
    return {
      reason: 'timeout',
      message: 'the OS credential store did not answer in time',
    }
  }
  const stderr = input.stderr
  if (
    (input.exitCode === 44 || input.exitCode === 0x1002c) &&
    ITEM_NOT_FOUND_PATTERN.test(stderr)
  ) {
    return { reason: 'item_not_found', message: 'keychain item not found' }
  }
  if (ITEM_NOT_FOUND_PATTERN.test(stderr)) {
    return { reason: 'item_not_found', message: 'keychain item not found' }
  }
  if (LOCKED_PATTERN.test(stderr)) {
    return {
      reason: 'keychain_locked',
      message: 'the OS keychain is locked or does not allow interaction',
    }
  }
  if (DENIED_PATTERN.test(stderr)) {
    return {
      reason: 'access_denied',
      message: 'access to the OS keychain item was denied',
    }
  }
  return {
    reason: 'process_failure',
    message: `the OS credential store failed (exit ${input.exitCode ?? 'unknown'})`,
  }
}

/**
 * Runs `/usr/bin/security` once and classifies every failure mode. A nonzero
 * exit or stderr text maps onto the failure taxonomy; only the authoritative
 * item-not-found outcome is distinguishable from "cannot read the store".
 */
function classifySecurityRun(args: string[], input?: Buffer): SecurityRun {
  let stdout: Buffer
  try {
    stdout = execFileSync('/usr/bin/security', args, {
      input,
      encoding: 'buffer',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: SECURITY_TIMEOUT_MS,
    }) as Buffer
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      status?: number
      stderr?: Buffer | string
      killed?: boolean
      signal?: string
    }
    const classified = classifySecurityFailure({
      exitCode: typeof err?.status === 'number' ? err.status : undefined,
      stderr: String(err?.stderr ?? ''),
      killed: err?.killed,
      signal: err?.signal,
      code: err?.code,
    })
    return { ok: false, ...classified }
  }
  if (stdout === undefined || stdout === null) {
    return {
      ok: false,
      reason: 'malformed_output',
      message: 'the OS credential store returned no output',
    }
  }
  return { ok: true, stdout }
}

function keychainFailure(error: KeychainAccessError): DevAuthorityError {
  // Fail closed with the contract's auth_required code; the reason text keeps
  // the distinction actionable for diagnostics without leaking secret data.
  return new DevAuthorityError('auth_required', `the OS credential store refused: ${error.message}`)
}

/**
 * The production adapter keeps the vault master key in macOS Keychain. A
 * file-backed fallback is deliberately not provided: a local file is not an
 * OS credential store and would turn a stolen app-data directory into the
 * ability to decrypt every credential reference. Tests inject an in-memory
 * adapter, or the `runSecurity` seam for the classification behavior itself.
 */
export function createSystemVaultKeyStore(options?: {
  runSecurity?: SecurityCommandRunner
}): VaultKeyStore {
  if (process.platform !== 'darwin') {
    throw new DevAuthorityError(
      'auth_required',
      'the credential vault requires an OS credential store on this platform'
    )
  }
  const injectedRunner = options?.runSecurity
  const runClassified = (args: string[], input?: Buffer): SecurityRun => {
    if (!injectedRunner) return classifySecurityRun(args, input)
    try {
      return { ok: true, stdout: injectedRunner(args, input) }
    } catch (error) {
      if (error instanceof KeychainAccessError) {
        return { ok: false, reason: error.reason, message: error.message, exitCode: error.exitCode }
      }
      return {
        ok: false,
        reason: 'process_failure',
        message: error instanceof Error ? error.message : 'security command failed',
      }
    }
  }
  return {
    get(service, account) {
      const run = runClassified(['find-generic-password', '-s', service, '-a', account, '-w'])
      if (!run.ok) {
        // An absent item is the only case where initialization may create a
        // key. Locked, denied, malformed, timed-out, and failed stores fail
        // closed without generating or overwriting a key.
        if (run.reason === 'item_not_found') return undefined
        throw keychainFailure(new KeychainAccessError(run.reason, run.message, run.exitCode))
      }
      const encoded = run.stdout.toString('utf8').trim()
      if (encoded.length === 0) {
        throw keychainFailure(
          new KeychainAccessError('malformed_output', 'keychain item returned an empty secret')
        )
      }
      const key = Buffer.from(encoded, 'base64')
      // Node/Bun base64 decoding is lenient: garbage decodes to garbage
      // bytes without error. Re-encoding must reproduce the stored secret
      // exactly, otherwise the item is malformed and the store fails closed.
      if (
        key.byteLength === 0 ||
        key.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')
      ) {
        throw keychainFailure(
          new KeychainAccessError('malformed_output', 'keychain item is not readable base64')
        )
      }
      return key
    },
    set(service, account, key) {
      if (key.byteLength !== 32) throw new DevAuthorityError('corrupt_state', 'invalid vault key')
      const run = runClassified([
        'add-generic-password',
        '-U',
        '-s',
        service,
        '-a',
        account,
        '-w',
        key.toString('base64'),
      ])
      if (!run.ok)
        throw keychainFailure(new KeychainAccessError(run.reason, run.message, run.exitCode))
    },
    delete(service, account) {
      const run = runClassified(['delete-generic-password', '-s', service, '-a', account])
      if (!run.ok && run.reason !== 'item_not_found') {
        // Removal is idempotent only for an already-absent item; every other
        // failure must surface rather than silently retain the key.
        throw keychainFailure(new KeychainAccessError(run.reason, run.message, run.exitCode))
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
  /**
   * Required. The durable, scope-bound, single-use owner-approval authority;
   * a vault without one cannot prove owner consent, so construction fails
   * rather than falling back to structural approval checks.
   */
  approvalVerifier: OwnerApprovalVerifier
  /** Injectable only for deterministic tests and approved host adapters. */
  credentialStore?: VaultKeyStore
}) {
  const { dataDir, audit, approvalVerifier } = options
  if (!approvalVerifier) {
    // Startup guard for JavaScript callers that bypass the type.
    throw new DevAuthorityError(
      'auth_required',
      'the credential vault requires an owner approval verifier'
    )
  }
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
      if (existing.state === 'ready') {
        // Idempotency does not waive the owner-approval contract. Consume the
        // fresh, action-bound approval even for a durable no-op.
        approvalVerifier.consume(approval, input.scope, 'enroll a credential')
        return existing
      }
      // 'unknown' means the sealed material is unreadable: this explicit
      // re-enrollment repairs the record under the owner's fresh approval.
      approvalVerifier.consume(approval, input.scope, 'enroll a credential')
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

    approvalVerifier.consume(approval, input.scope, 'enroll a credential')
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
