// Desktop-authentication credential storage.
//
// The three vault entries named in `docs/specs/desktop-auth.md` ("Vault
// entries") live in the operating-system credential store under the service
// `com.adea.desktop`:
//
//   desktop-authorization-attempt   the pending PKCE attempt (JSON)
//   desktop-user-session            the opaque desktop session (JSON)
//   temporary-workspace-session     the guest credential (`adea_tmp_…`)
//
// macOS `/usr/bin/security` is the single canonical backend. There is no
// implicit Bun.secrets/security slot switching: the two own different Keychain
// item classes, so mixing them would double-write a secret. The port is
// synchronous and injectable; only the production adapter shells out. An
// unavailable, locked, denied, malformed, or failed store fails closed — a
// file is never a fallback (see `docs/specs/local-content.md` rationale).
//
// The transitional `desktop-state/*.sealed` files (AES-256-GCM under
// `desktop-state/device.key`) are migrated on first read: the legacy value is
// decrypted, validated, written to the OS store, read back for exact equality,
// and only then retired. Any failure leaves the legacy file untouched.
import { execFileSync } from 'node:child_process'
import { createDecipheriv } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import {
  decodeDesktopAuthorizationAttempt,
  decodeDesktopSession,
  decodeTemporaryWorkspaceCredential,
  encodeDesktopAuthorizationAttempt,
  encodeDesktopSession,
  encodeTemporaryWorkspaceCredential,
  type DesktopAuthorizationAttempt,
  type DesktopSession,
} from '@adea-ai/auth/desktop'

import { loadDeviceKey } from './device-key'
import {
  classifySecurityFailure,
  KeychainAccessError,
  type KeychainFailureReason,
  type SecurityCommandRunner,
} from './dev-runtime/vault'

/** The OS credential-store service shared by all three entries. */
export const DESKTOP_AUTH_SERVICE = 'com.adea.desktop'

/** The Keychain user names from the spec's vault-entry table. */
export const DESKTOP_AUTH_ACCOUNTS = {
  authorizationAttempt: 'desktop-authorization-attempt',
  temporaryWorkspace: 'temporary-workspace-session',
  userSession: 'desktop-user-session',
} as const

/**
 * The synchronous credential-store port. `get` returns `undefined` only when
 * the item is authoritatively absent; every other failure throws (fail closed).
 */
export interface DesktopAuthKeychainPort {
  get(account: string): string | undefined
  set(account: string, value: string): void
  delete(account: string): void
}

/** Deterministic in-memory port for tests: same contract, no durability. */
export function createMemoryKeychainPort(
  seed?: Readonly<Record<string, string>>
): DesktopAuthKeychainPort {
  const values = new Map<string, string>(Object.entries(seed ?? {}))
  return {
    delete: (account) => void values.delete(account),
    get: (account) => values.get(account),
    set: (account, value) => void values.set(account, value),
  }
}

const SECURITY_TIMEOUT_MS = 10_000

/** Result of one classified `security` process run. */
type SecurityRun =
  | { ok: true; stdout: Buffer }
  | { ok: false; reason: KeychainFailureReason; message: string; exitCode?: number }

function classifySystemRun(args: string[], input?: Buffer): SecurityRun {
  try {
    const stdout = execFileSync('/usr/bin/security', args, {
      encoding: 'buffer',
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: SECURITY_TIMEOUT_MS,
    }) as Buffer
    return { ok: true, stdout }
  } catch (error) {
    const failed = error as NodeJS.ErrnoException & {
      status?: number
      stderr?: Buffer | string
      killed?: boolean
      signal?: string
    }
    return {
      ok: false,
      ...classifySecurityFailure({
        code: failed?.code,
        exitCode: typeof failed?.status === 'number' ? failed.status : undefined,
        killed: failed?.killed,
        signal: failed?.signal,
        stderr: String(failed?.stderr ?? ''),
      }),
    }
  }
}

function storeFailure(error: KeychainAccessError): Error {
  // Fail closed with a stable, secret-free message; the reason keeps the
  // distinction actionable for diagnostics.
  return new Error(`credential store unavailable (${error.reason})`, { cause: error })
}

/**
 * The production macOS adapter. The platform check happens per call, not at
 * construction, so building the command surface on a non-darwin host is inert
 * and only an auth-store access fails closed. Tests inject `runSecurity`.
 */
export function createSystemKeychainPort(options?: {
  runSecurity?: SecurityCommandRunner
  service?: string
}): DesktopAuthKeychainPort {
  const service = options?.service ?? DESKTOP_AUTH_SERVICE
  const injected = options?.runSecurity

  const runClassified = (args: string[], input?: Buffer): SecurityRun => {
    if (!injected) {
      if (process.platform !== 'darwin') {
        return {
          ok: false,
          reason: 'unavailable_executable',
          message: 'the OS credential store is unavailable on this platform',
        }
      }
      return classifySystemRun(args, input)
    }
    try {
      return { ok: true, stdout: injected(args, input) }
    } catch (error) {
      if (error instanceof KeychainAccessError) {
        return { ok: false, exitCode: error.exitCode, message: error.message, reason: error.reason }
      }
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'security command failed',
        reason: 'process_failure',
      }
    }
  }

  return {
    delete(account) {
      const run = runClassified(['delete-generic-password', '-s', service, '-a', account])
      // Removal is idempotent only for an already-absent item; every other
      // failure must surface rather than silently retain the secret.
      if (!run.ok && run.reason !== 'item_not_found') {
        throw storeFailure(new KeychainAccessError(run.reason, run.message, run.exitCode))
      }
    },
    get(account) {
      const run = runClassified(['find-generic-password', '-s', service, '-a', account, '-w'])
      if (!run.ok) {
        if (run.reason === 'item_not_found') return undefined
        throw storeFailure(new KeychainAccessError(run.reason, run.message, run.exitCode))
      }
      // `security -w` prints the secret followed by a single newline.
      const printed = run.stdout.toString('utf8')
      const value = printed.endsWith('\n') ? printed.slice(0, -1) : printed
      if (value.length === 0) {
        throw storeFailure(
          new KeychainAccessError('malformed_output', 'keychain item returned an empty secret')
        )
      }
      return value
    },
    set(account, value) {
      if (value.length === 0) throw new Error('credential store refuses an empty value')
      const run = runClassified([
        'add-generic-password',
        '-U',
        '-s',
        service,
        '-a',
        account,
        '-w',
        value,
      ])
      if (!run.ok)
        throw storeFailure(new KeychainAccessError(run.reason, run.message, run.exitCode))
    },
  }
}

/** Parses a JSON legacy plaintext without throwing. */
function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/**
 * Per-entry codec: `decodeStored`/`decodeLegacy` return `null` for a malformed
 * value (treated as absent) and `encode` refuses a malformed value on write.
 */
type EntryCodec<T> = Readonly<{
  decodeStored(stored: string): T | null
  decodeLegacy(plaintext: string): T | null
  encode(value: unknown): string
}>

type Entry<T> = Readonly<{
  account: string
  codec: EntryCodec<T>
  legacyFile: string
}>

const AUTHORIZATION_ATTEMPT_CODEC: EntryCodec<DesktopAuthorizationAttempt> = {
  decodeStored: (stored) => decodeDesktopAuthorizationAttempt(parseJson(stored)),
  decodeLegacy: (plaintext) => decodeDesktopAuthorizationAttempt(parseJson(plaintext)),
  encode: encodeDesktopAuthorizationAttempt,
}

const USER_SESSION_CODEC: EntryCodec<DesktopSession> = {
  decodeStored: (stored) => decodeDesktopSession(parseJson(stored)),
  decodeLegacy: (plaintext) => decodeDesktopSession(parseJson(plaintext)),
  encode: encodeDesktopSession,
}

const TEMPORARY_WORKSPACE_CODEC: EntryCodec<string> = {
  decodeStored: (stored) => decodeTemporaryWorkspaceCredential(stored),
  decodeLegacy: (plaintext) => decodeTemporaryWorkspaceCredential(parseJson(plaintext)),
  encode: encodeTemporaryWorkspaceCredential,
}

export type DesktopAuthStore = Readonly<{
  clearAuthorizationAttempt(): void
  clearTemporaryWorkspaceCredential(): void
  clearUserSession(): void
  loadAuthorizationAttempt(): DesktopAuthorizationAttempt | null
  loadTemporaryWorkspaceCredential(): string | null
  loadUserSession(): DesktopSession | null
  saveAuthorizationAttempt(value: unknown): void
  saveTemporaryWorkspaceCredential(value: unknown): void
  saveUserSession(value: unknown): void
}>

export function createDesktopAuthStore(options: {
  dataDir: string
  port: DesktopAuthKeychainPort
}): DesktopAuthStore {
  const stateDir = join(options.dataDir, 'desktop-state')
  const { port } = options

  function legacyPath(entry: Entry<unknown>): string {
    return join(stateDir, entry.legacyFile)
  }

  /** Decrypts one legacy sealed file (AES-256-GCM, 12-byte iv + 16-byte tag + body). */
  function openLegacy(path: string): string {
    // The legacy file stores base64 text, exactly as `commands.ts` wrote it.
    const raw = Buffer.from(readFileSync(path, 'utf8'), 'base64')
    const decipher = createDecipheriv(
      'aes-256-gcm',
      loadDeviceKey(join(stateDir, 'device.key')),
      raw.subarray(0, 12)
    )
    decipher.setAuthTag(raw.subarray(12, 28))
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
  }

  /**
   * Migrates one legacy entry when the OS item is authoritatively absent. The
   * legacy file is retired only after a verified, exact read-back. An
   * unreadable or invalid legacy value is treated as absent and left intact;
   * a store failure propagates (fail closed).
   */
  function migrate<T>(entry: Entry<T>): T | null {
    const path = legacyPath(entry as Entry<unknown>)
    if (!existsSync(path)) return null
    let plaintext: string
    try {
      plaintext = openLegacy(path)
    } catch {
      return null
    }
    const decoded = entry.codec.decodeLegacy(plaintext)
    if (decoded === null) return null
    const serialized = entry.codec.encode(decoded)
    port.set(entry.account, serialized)
    if (port.get(entry.account) !== serialized) {
      throw new Error('credential store read-back mismatch')
    }
    rmSync(path, { force: true })
    return decoded
  }

  function createEntry<T>(entry: Entry<T>) {
    return {
      clear(): void {
        port.delete(entry.account)
        // Clear the legacy file too, so an unmigrated value cannot resurrect.
        rmSync(legacyPath(entry as Entry<unknown>), { force: true })
      },
      load(): T | null {
        const stored = port.get(entry.account)
        if (stored !== undefined) return entry.codec.decodeStored(stored)
        return migrate(entry)
      },
      save(value: unknown): void {
        // Validation on write: a malformed value is refused, never stored.
        const serialized = entry.codec.encode(value)
        port.set(entry.account, serialized)
        // A migrated/legacy value must not resurrect after a fresh save.
        rmSync(legacyPath(entry as Entry<unknown>), { force: true })
      },
    }
  }

  const authorizationAttempt = createEntry<DesktopAuthorizationAttempt>({
    account: DESKTOP_AUTH_ACCOUNTS.authorizationAttempt,
    codec: AUTHORIZATION_ATTEMPT_CODEC,
    legacyFile: 'auth-attempt.sealed',
  })
  const userSession = createEntry<DesktopSession>({
    account: DESKTOP_AUTH_ACCOUNTS.userSession,
    codec: USER_SESSION_CODEC,
    legacyFile: 'session.sealed',
  })
  const temporaryWorkspace = createEntry<string>({
    account: DESKTOP_AUTH_ACCOUNTS.temporaryWorkspace,
    codec: TEMPORARY_WORKSPACE_CODEC,
    legacyFile: 'temporary-workspace.sealed',
  })

  return Object.freeze({
    clearAuthorizationAttempt: () => authorizationAttempt.clear(),
    clearTemporaryWorkspaceCredential: () => temporaryWorkspace.clear(),
    clearUserSession: () => userSession.clear(),
    loadAuthorizationAttempt: () => authorizationAttempt.load(),
    loadTemporaryWorkspaceCredential: () => temporaryWorkspace.load(),
    loadUserSession: () => userSession.load(),
    saveAuthorizationAttempt: (value) => authorizationAttempt.save(value),
    saveTemporaryWorkspaceCredential: (value) => temporaryWorkspace.save(value),
    saveUserSession: (value) => userSession.save(value),
  })
}
