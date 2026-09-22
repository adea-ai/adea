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
import { createDurableSqliteStore } from './host-store'

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
const CREDENTIAL_KINDS = new Set<CredentialRefKind>([
  'git_https',
  'github_token',
  'ssh_key',
  'other',
])
const CREDENTIAL_STATES = new Set<CredentialRefState>(['ready', 'expired', 'revoked', 'unknown'])
const CREDENTIAL_RECORD_KEYS = new Set([
  'id',
  'scope',
  'label',
  'host',
  'kind',
  'state',
  'version',
  'createdAt',
  'updatedAt',
  'revokedAt',
  'revokedReason',
])

function invalidCredentialMetadata(): DevAuthorityError {
  return new DevAuthorityError('corrupt_state', 'credential vault metadata failed to decode')
}

function isBoundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

/** Strictly decode metadata before it reaches the vault authority. Unknown
 * fields are refused so a legacy envelope cannot smuggle plaintext, sealed
 * bytes, or key material into the SQLite metadata payload. */
function decodeCredentialRecord(value: unknown): CredentialRefRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw invalidCredentialMetadata()
  const candidate = value as Record<string, unknown>
  if (Object.keys(candidate).some((key) => !CREDENTIAL_RECORD_KEYS.has(key)))
    throw invalidCredentialMetadata()
  const candidateScope = candidate.scope
  if (
    typeof candidateScope !== 'object' ||
    candidateScope === null ||
    Array.isArray(candidateScope) ||
    !isBoundedText((candidateScope as Record<string, unknown>).accountId, 256) ||
    !isBoundedText((candidateScope as Record<string, unknown>).workspaceId, 256) ||
    !isBoundedText((candidateScope as Record<string, unknown>).runtimeNodeId, 256) ||
    !isUuid(candidate.id) ||
    !isBoundedText(candidate.label, 128) ||
    !isBoundedText(candidate.host, 253) ||
    !HOST_PATTERN.test(candidate.host) ||
    !CREDENTIAL_KINDS.has(candidate.kind as CredentialRefKind) ||
    !CREDENTIAL_STATES.has(candidate.state as CredentialRefState) ||
    !Number.isSafeInteger(candidate.version) ||
    (candidate.version as number) < 1 ||
    !isBoundedText(candidate.createdAt, 64) ||
    !Number.isFinite(Date.parse(candidate.createdAt)) ||
    !isBoundedText(candidate.updatedAt, 64) ||
    !Number.isFinite(Date.parse(candidate.updatedAt))
  )
    throw invalidCredentialMetadata()
  if (
    candidate.revokedAt !== undefined &&
    (!isBoundedText(candidate.revokedAt, 64) || !Number.isFinite(Date.parse(candidate.revokedAt)))
  )
    throw invalidCredentialMetadata()
  if (candidate.revokedReason !== undefined && !isBoundedText(candidate.revokedReason, 256))
    throw invalidCredentialMetadata()
  const decodedScope = candidateScope as {
    accountId: string
    workspaceId: string
    runtimeNodeId: string
  }
  const version = candidate.version as number
  return {
    id: candidate.id,
    scope: {
      accountId: decodedScope.accountId,
      workspaceId: decodedScope.workspaceId,
      runtimeNodeId: decodedScope.runtimeNodeId,
    },
    label: candidate.label,
    host: candidate.host,
    kind: candidate.kind as CredentialRefKind,
    state: candidate.state as CredentialRefState,
    version,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
    ...(candidate.revokedAt !== undefined ? { revokedAt: candidate.revokedAt } : {}),
    ...(candidate.revokedReason !== undefined ? { revokedReason: candidate.revokedReason } : {}),
  }
}

function decodeCredentialRecords(value: unknown): CredentialRefRecord[] {
  if (!Array.isArray(value)) throw invalidCredentialMetadata()
  const ids = new Set<string>()
  return value.map((candidate) => {
    const record = decodeCredentialRecord(candidate)
    if (ids.has(record.id)) throw invalidCredentialMetadata()
    ids.add(record.id)
    return record
  })
}

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

/** Deterministic in-memory key store for tests and non-darwin CI: same
 *  VaultKeyStore contract as the OS keychain adapter, no durability. */
export function createInMemoryVaultKeyStore(): VaultKeyStore {
  const keys = new Map<string, Buffer>()
  return {
    get: (service, account) => keys.get(`${service}\u0000${account}`),
    set: (service, account, key) => void keys.set(`${service}\u0000${account}`, key),
    delete: (service, account) => void keys.delete(`${service}\u0000${account}`),
  }
}

const VAULT_KEY_SERVICE = 'com.adea.desktop.dev-runtime'
const VAULT_KEY_ACCOUNT = 'master-key-v1'
const BUN_SECRETS_MIN_VERSION = '1.4.0'

export type BunSecretsApi = Readonly<{
  get(options: { service: string; name: string }): Promise<string | null>
  set(options: { service: string; name: string; value: string }): Promise<void>
  delete?(options: { service: string; name: string }): Promise<boolean>
}>

type BunRuntime = Readonly<{
  version?: string
  secrets?: BunSecretsApi
}>

function currentBunRuntime(): BunRuntime | undefined {
  return (globalThis as typeof globalThis & { Bun?: BunRuntime }).Bun
}

function supportsBunSecrets(version: string): boolean {
  const current = version.match(/^(\d+)\.(\d+)\.(\d+)/)
  const minimum = BUN_SECRETS_MIN_VERSION.match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!current || !minimum) return false
  for (let index = 1; index <= 3; index += 1) {
    const currentPart = Number(current[index])
    const minimumPart = Number(minimum[index])
    if (currentPart !== minimumPart) return currentPart > minimumPart
  }
  return true
}

function decodeVaultKey(encoded: string, source: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
    throw new DevAuthorityError('corrupt_state', `${source} vault key is malformed`)
  }
  const key = Buffer.from(encoded, 'base64')
  if (key.byteLength !== 32 || key.toString('base64') !== encoded) {
    throw new DevAuthorityError('corrupt_state', `${source} vault key has an unexpected size`)
  }
  return key
}

function assertVaultKey(key: Buffer, source: string): Buffer {
  if (key.byteLength !== 32) {
    throw new DevAuthorityError('corrupt_state', `${source} vault key has an unexpected size`)
  }
  return Buffer.from(key)
}

function bunSecretsFailure(action: 'read' | 'write' | 'verify'): DevAuthorityError {
  // Bun's native errors can include account names or platform diagnostics.
  // Keep them out of the authority surface and logs.
  return new DevAuthorityError('auth_required', `the Bun credential store refused to ${action}`)
}

function createLoadedVaultKeyStore(key: Buffer): VaultKeyStore {
  const loaded = assertVaultKey(key, 'loaded')
  return {
    get: (service, account) =>
      service === VAULT_KEY_SERVICE && account === VAULT_KEY_ACCOUNT
        ? Buffer.from(loaded)
        : undefined,
    set: (service, account, next) => {
      if (service !== VAULT_KEY_SERVICE || account !== VAULT_KEY_ACCOUNT) {
        throw new DevAuthorityError('not_found', 'unknown vault key slot')
      }
      if (next.byteLength !== 32) throw new DevAuthorityError('corrupt_state', 'invalid vault key')
      if (!Buffer.from(next).equals(loaded)) {
        throw new DevAuthorityError('corrupt_state', 'vault key replacement is refused')
      }
    },
    delete: (service, account) => {
      if (service === VAULT_KEY_SERVICE && account === VAULT_KEY_ACCOUNT) {
        throw new DevAuthorityError('unauthorized', 'vault key deletion is refused')
      }
    },
  }
}

function seedLegacyVaultKey(legacyStore: VaultKeyStore, key: Buffer): void {
  const current = legacyStore.get(VAULT_KEY_SERVICE, VAULT_KEY_ACCOUNT)
  if (current !== undefined) {
    if (!assertVaultKey(current, 'legacy').equals(key)) {
      throw new DevAuthorityError('corrupt_state', 'vault key stores disagree')
    }
    return
  }

  try {
    legacyStore.set(VAULT_KEY_SERVICE, VAULT_KEY_ACCOUNT, key)
    const written = legacyStore.get(VAULT_KEY_SERVICE, VAULT_KEY_ACCOUNT)
    if (written === undefined)
      throw new DevAuthorityError('auth_required', 'legacy vault key was not retained')
    if (!assertVaultKey(written, 'legacy').equals(key)) {
      throw new DevAuthorityError('corrupt_state', 'legacy vault key read-back differs')
    }
  } catch (error) {
    if (error instanceof DevAuthorityError) throw error
    throw new DevAuthorityError('auth_required', 'the legacy credential store refused to write')
  }
}

/**
 * Resolve the vault master key through Bun's native credential store during
 * application startup. The returned store keeps the existing synchronous
 * `VaultKeyStore` contract for the authority graph while the async Bun API is
 * used only during this bounded bootstrap step.
 *
 * The legacy `/usr/bin/security` slot is read before migration and is never
 * deleted. A Bun read/write/read-back failure refuses startup rather than
 * falling through to a new key, so an upgrade cannot strand existing sealed
 * credentials behind a fabricated replacement key. If the packaged runtime
 * lacks a supported Bun.secrets API, the legacy adapter is returned unchanged.
 */
export async function createBunSecretsVaultKeyStore(options?: {
  legacyStore?: VaultKeyStore
  secrets?: BunSecretsApi
  runtimeVersion?: string
}): Promise<VaultKeyStore> {
  const legacyStore = options?.legacyStore ?? createSystemVaultKeyStore()
  const runtime = currentBunRuntime()
  const secrets = options?.secrets ?? runtime?.secrets
  const runtimeVersion = options?.runtimeVersion ?? runtime?.version

  // The app-level caller supplies Bun.version. An injected backend without a
  // runtime version is deliberately allowed for deterministic tests.
  if (!secrets || (runtimeVersion !== undefined && !supportsBunSecrets(runtimeVersion))) {
    return legacyStore
  }

  const slot = { service: VAULT_KEY_SERVICE, name: VAULT_KEY_ACCOUNT }
  let bunKey: Buffer | undefined
  try {
    const encoded = await secrets.get(slot)
    if (encoded !== null) bunKey = decodeVaultKey(encoded, 'Bun.secrets')
  } catch (error) {
    if (error instanceof DevAuthorityError) throw error
    throw bunSecretsFailure('read')
  }

  // Do not attempt a Bun write when the old slot cannot be read. The old
  // adapter's classified failure is the source of truth for compatibility.
  let legacyKey: Buffer | undefined
  const candidate = legacyStore.get(VAULT_KEY_SERVICE, VAULT_KEY_ACCOUNT)
  if (candidate !== undefined) legacyKey = assertVaultKey(candidate, 'legacy')

  if (bunKey && legacyKey && !bunKey.equals(legacyKey)) {
    throw new DevAuthorityError('corrupt_state', 'vault key stores disagree')
  }
  if (bunKey) {
    // A Bun-only key may have been created by an interrupted/older rollout.
    // Repair the legacy slot before returning so a downgrade cannot generate a
    // different key and strand the sealed vault.
    if (!legacyKey) seedLegacyVaultKey(legacyStore, bunKey)
    return createLoadedVaultKeyStore(bunKey)
  }

  const key = legacyKey ?? assertVaultKey(randomBytes(32), 'generated')
  // Fresh installs must seed both stores before either runtime is allowed to
  // open the vault. If the legacy store cannot retain the key, no Bun-only
  // state is created that an older runtime could replace with a new key.
  if (!legacyKey) seedLegacyVaultKey(legacyStore, key)
  try {
    await secrets.set({ ...slot, value: key.toString('base64') })
  } catch {
    // The legacy key remains intact and the next startup can retry safely.
    throw bunSecretsFailure('write')
  }

  let verified: string | null
  try {
    verified = await secrets.get(slot)
  } catch {
    throw bunSecretsFailure('verify')
  }
  if (verified === null) throw bunSecretsFailure('verify')
  const verifiedKey = decodeVaultKey(verified, 'Bun.secrets')
  if (!verifiedKey.equals(key)) {
    throw new DevAuthorityError('corrupt_state', 'Bun.secrets returned a different vault key')
  }
  return createLoadedVaultKeyStore(key)
}

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
 * is the secondary signal across platform versions. Lock and denial signals
 * take precedence over absence so ambiguous diagnostics cannot create a key.
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
  if (ITEM_NOT_FOUND_PATTERN.test(stderr)) {
    return { reason: 'item_not_found', message: 'keychain item not found' }
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
  const injectedRunner = options?.runSecurity
  // A scripted runner is platform-independent by design (deterministic tests
  // and approved host adapters); only the production path, which shells out
  // to the macOS `security` CLI, requires darwin.
  if (!injectedRunner && process.platform !== 'darwin') {
    throw new DevAuthorityError(
      'auth_required',
      'the credential vault requires an OS credential store on this platform'
    )
  }
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
  /** Test-only seam for proving transactional metadata migration rollback. */
  onMigrationStage?: (stage: 'before_commit') => void
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
  const store = createDurableSqliteStore<CredentialRefRecord>({
    file: join(vaultDir, 'credentials.sqlite3'),
    schemaVersion: 1,
    label: 'credential vault',
    legacyFile: join(vaultDir, 'credentials.json'),
    migrateLegacy: (value) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw invalidCredentialMetadata()
      return decodeCredentialRecords((value as { records?: unknown }).records)
    },
    validateRecords: decodeCredentialRecords,
    onMigrationStage: options.onMigrationStage,
  })

  function load(): CredentialRefRecord[] {
    return decodeCredentialRecords(store.load().records)
  }

  function save(records: ReadonlyArray<CredentialRefRecord>): void {
    store.save(decodeCredentialRecords(records))
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
