// The lane-side write target for cookie import (#610).
//
// `cookie-import.ts` plans and applies a transaction against a `LaneCookieStore`
// seam and nothing implemented it, so the plan/commit pair answered
// typed-unavailable. This is the store: the lane profile's own Chromium cookie
// database, written with the same OS-keychain scheme the browser reads it with,
// so an imported cookie is encrypted at rest exactly like a browsed one.
//
// Two properties are deliberate:
//
//   - a value is never written in the clear. If the profile's Keychain item
//     cannot be read there is no key, and the store refuses with a typed
//     denial rather than degrading to plaintext;
//   - `list()` is the rollback snapshot's source, so a row it cannot decrypt
//     fails the transaction instead of being silently omitted (an omitted row
//     is a row that would not be restored).
//
// The caller owns the "is the lane stopped" question: a running engine caches
// its cookies in memory and rewrites the file, so a write to a live profile
// would be lost or interleaved. `register.ts` enforces it before commit.
import { Database } from 'bun:sqlite'
import { createCipheriv, createHash } from 'node:crypto'
import { mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type { ImportedCookie, LaneCookieStore } from './cookie-import'
import {
  chromiumSameSiteFromColumn,
  chromiumSameSiteToColumn,
  decryptChromiumValue,
  deriveChromiumKey,
  readKeychainSecretWithSecurity,
} from './cookie-sources'

/** Chromium's epoch: microseconds since 1601-01-01. */
const CHROMIUM_EPOCH_OFFSET_MS = 11_644_473_600_000

/**
 * The Keychain item the lane engine's profiles are encrypted with.
 *
 * The lane WebView is Chromium-backed — the same build writes the Chromium
 * profile schema (partitioned cookies included) and speaks CDP — and on macOS
 * that build names its item from its product name. Verified on the reference
 * machine: an item with service "Chromium Safe Storage" and account "Chromium"
 * exists, created at the runtime's first launch (2026-09-12), and a value
 * written with the key it yields reads back through the same store.
 */
export const CHROMIUM_LANE_KEYCHAIN_SERVICE = 'Chromium Safe Storage'

/** Every lane kind the Chromium-backed engine serves, each with its own profile. */
export const CHROMIUM_LANE_KINDS: readonly ('human_embedded' | 'task_owned' | 'user_context')[] = [
  'human_embedded',
  'task_owned',
  'user_context',
]

export type LaneCookieStoreErrorCode =
  | 'keychain_denied'
  | 'unreadable'
  | 'unsupported_format'
  | 'decryption_failed'

export class LaneCookieStoreError extends Error {
  readonly code: LaneCookieStoreErrorCode
  constructor(code: LaneCookieStoreErrorCode, message: string) {
    super(message)
    this.name = 'LaneCookieStoreError'
    this.code = code
  }
}

/**
 * The DDL a fresh lane profile gets. It is Chromium's own schema (including the
 * unique coordinate index) rather than a minimal one, so the engine that
 * creates the profile later finds the store it expects.
 */
const COOKIE_TABLE_DDL = `CREATE TABLE IF NOT EXISTS cookies(
  creation_utc INTEGER NOT NULL,
  host_key TEXT NOT NULL,
  top_frame_site_key TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  encrypted_value BLOB NOT NULL DEFAULT '',
  path TEXT NOT NULL,
  expires_utc INTEGER NOT NULL,
  is_secure INTEGER NOT NULL,
  is_httponly INTEGER NOT NULL,
  last_access_utc INTEGER NOT NULL,
  has_expires INTEGER NOT NULL DEFAULT 1,
  is_persistent INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 1,
  samesite INTEGER NOT NULL DEFAULT -1,
  source_scheme INTEGER NOT NULL DEFAULT 0,
  source_port INTEGER NOT NULL DEFAULT -1,
  last_update_utc INTEGER NOT NULL DEFAULT 0,
  source_type INTEGER NOT NULL DEFAULT 0,
  has_cross_site_ancestor INTEGER NOT NULL DEFAULT 0)`

const COOKIE_INDEX_DDL =
  'CREATE UNIQUE INDEX IF NOT EXISTS cookies_unique_index ON cookies(host_key, top_frame_site_key, name, path)'

/**
 * Encrypts one cookie value the way the Chromium family stores it: SHA-256 of
 * the host key prepended to the plaintext, AES-128-CBC under the profile's key
 * with a sixteen-space IV, and the "v10" scheme marker. Same shape
 * `decryptChromiumValue` reads, so a value this store writes is a value the
 * engine can use.
 */
export function encryptChromiumValue(value: string, key: Buffer, hostKey: string): Uint8Array {
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '))
  const body = Buffer.concat([createHash('sha256').update(hostKey).digest(), Buffer.from(value)])
  return Buffer.concat([Buffer.from('v10', 'utf8'), cipher.update(body), cipher.final()])
}

/** Where a profile keeps its cookie database: Chromium's `Default`, or the root. */
export function laneCookieStorePath(profileDirectory: string): string | undefined {
  for (const candidate of [
    join(profileDirectory, 'Default', 'Cookies'),
    join(profileDirectory, 'Cookies'),
  ]) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // Not there; try the next layout.
    }
  }
  return undefined
}

function microsFromIso(iso: string | undefined): number {
  if (iso === undefined) return 0
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed) || parsed <= 0) return 0
  return (parsed + CHROMIUM_EPOCH_OFFSET_MS) * 1000
}

function isoFromMicros(micros: unknown): string | undefined {
  if (typeof micros !== 'number' || micros <= 0) return undefined
  const epochMs = Math.round(micros / 1000 - CHROMIUM_EPOCH_OFFSET_MS)
  if (epochMs <= 0) return undefined
  return new Date(epochMs).toISOString()
}

function columnsOf(database: Database): ReadonlySet<string> {
  try {
    const rows = database.query('PRAGMA table_info(cookies)').all() as Array<{ name?: unknown }>
    return new Set(rows.map((row) => String(row.name ?? '')))
  } catch {
    return new Set<string>()
  }
}

export type ChromiumLaneCookieStoreOptions = Readonly<{
  /** The lane's own profile directory (host-side absolute path). */
  profileDirectory: string
  /**
   * The Keychain item this profile's values are encrypted with. It is the
   * engine's own identity — "Chromium Safe Storage" for a CEF/Chromium lane,
   * "<Vendor> Safe Storage" for a lane over a vendor profile — and is required
   * because guessing it would mean reading a value with the wrong key.
   */
  keychainService: string
  keychainSecret?: (service: string) => string | null
  now?: () => number
}>

/**
 * A `LaneCookieStore` over one lane profile's Chromium cookie database.
 * Synchronous work behind an async seam (the shell's SQLite and Keychain paths
 * already are); the import service awaits it either way.
 */
export function createChromiumLaneCookieStore(
  options: ChromiumLaneCookieStoreOptions
): LaneCookieStore {
  const keychain = options.keychainSecret ?? readKeychainSecretWithSecurity
  const now = options.now ?? (() => Date.now())
  let cachedKey: Buffer | null = null

  function key(): Buffer {
    if (cachedKey) return cachedKey
    const secret = keychain(options.keychainService)
    if (secret === null)
      throw new LaneCookieStoreError(
        'keychain_denied',
        `the "${options.keychainService}" Keychain item could not be read; cookies are never written unencrypted`
      )
    cachedKey = deriveChromiumKey(secret)
    return cachedKey
  }

  /** Opens the store, creating a fresh Chromium-shaped one when a lane has
   *  never run (an empty target is the normal first import). */
  function openForWrite(): Database {
    mkdirSync(options.profileDirectory, { recursive: true, mode: 0o700 })
    const path =
      laneCookieStorePath(options.profileDirectory) ??
      join(options.profileDirectory, 'Default', 'Cookies')
    mkdirSync(join(options.profileDirectory, 'Default'), { recursive: true, mode: 0o700 })
    let database: Database
    try {
      database = new Database(path)
    } catch {
      throw new LaneCookieStoreError('unreadable', 'the lane cookie store could not be opened')
    }
    database.exec(COOKIE_TABLE_DDL)
    database.exec(COOKIE_INDEX_DDL)
    return database
  }

  function openForRead(): Database | null {
    const path = laneCookieStorePath(options.profileDirectory)
    if (!path) return null
    try {
      return new Database(path, { readonly: true })
    } catch {
      throw new LaneCookieStoreError('unreadable', 'the lane cookie store could not be opened')
    }
  }

  function assertChromiumShape(database: Database): void {
    const columns = columnsOf(database)
    const required = ['host_key', 'name', 'path', 'samesite', 'encrypted_value']
    if (!required.every((column) => columns.has(column)))
      throw new LaneCookieStoreError(
        'unsupported_format',
        'the lane profile holds a cookie store this lane does not write'
      )
  }

  return {
    async list(): Promise<readonly ImportedCookie[]> {
      const database = openForRead()
      if (!database) return []
      try {
        assertChromiumShape(database)
        const rows = database
          .query(
            `SELECT host_key, name, path, encrypted_value, value, expires_utc, is_secure, is_httponly,
                    samesite, top_frame_site_key, has_cross_site_ancestor
               FROM cookies`
          )
          .all() as Array<Record<string, unknown>>
        const cookies: ImportedCookie[] = []
        for (const row of rows) {
          const encrypted = row.encrypted_value as Uint8Array | null
          let value: string
          if (encrypted && encrypted.byteLength > 0) {
            const decrypted = decryptWithKey(encrypted)
            if (decrypted === null)
              // The snapshot is the rollback truth: a row that cannot be read
              // is a row that could not be restored, so the transaction fails
              // before anything is removed.
              throw new LaneCookieStoreError(
                'decryption_failed',
                'an existing lane cookie could not be decrypted with this profile key'
              )
            value = decrypted
          } else {
            value = typeof row.value === 'string' ? row.value : ''
          }
          const partitionTopLevelSite =
            typeof row.top_frame_site_key === 'string' && row.top_frame_site_key.length > 0
              ? row.top_frame_site_key
              : undefined
          const expiresAt = isoFromMicros(row.expires_utc)
          cookies.push({
            domain: String(row.host_key ?? ''),
            name: String(row.name ?? ''),
            value,
            path: typeof row.path === 'string' && row.path.length > 0 ? row.path : '/',
            secure: row.is_secure === 1,
            httpOnly: row.is_httponly === 1,
            sameSite: chromiumSameSiteFromColumn(row.samesite),
            ...(partitionTopLevelSite
              ? {
                  partitionKey: {
                    topLevelSite: partitionTopLevelSite,
                    hasCrossSiteAncestor: row.has_cross_site_ancestor === 1,
                  },
                }
              : {}),
            ...(expiresAt ? { expiresAt } : {}),
          })
        }
        return cookies
      } finally {
        database.close()
      }
    },

    async remove(cookies: readonly ImportedCookie[]): Promise<void> {
      if (cookies.length === 0) return
      const database = openForWrite()
      try {
        assertChromiumShape(database)
        const statement = database.prepare(
          `DELETE FROM cookies WHERE host_key = $host AND name = $name AND path = $path
             AND top_frame_site_key = $top`
        )
        for (const cookie of cookies)
          statement.run({
            $host: cookie.domain,
            $name: cookie.name,
            $path: cookie.path.length > 0 ? cookie.path : '/',
            $top: cookie.partitionKey?.topLevelSite ?? '',
          })
      } catch (error) {
        if (error instanceof LaneCookieStoreError) throw error
        throw new LaneCookieStoreError('unreadable', 'the lane cookie store could not be written')
      } finally {
        database.close()
      }
    },

    async write(cookies: readonly ImportedCookie[]): Promise<void> {
      if (cookies.length === 0) return
      // Resolve the key BEFORE opening the store: a denied Keychain means no
      // write at all, never a plaintext fallback.
      const profileKey = key()
      const database = openForWrite()
      try {
        assertChromiumShape(database)
        const columns = columnsOf(database)
        const nowMicros = (now() + CHROMIUM_EPOCH_OFFSET_MS) * 1000
        const row: CookieBindings = {
          creation_utc: nowMicros,
          host_key: '',
          top_frame_site_key: '',
          name: '',
          value: '',
          encrypted_value: new Uint8Array(),
          path: '/',
          expires_utc: 0,
          is_secure: 0,
          is_httponly: 0,
          last_access_utc: nowMicros,
          has_expires: 0,
          is_persistent: 0,
          priority: 1,
          samesite: -1,
          source_scheme: 1,
          source_port: -1,
          last_update_utc: nowMicros,
          source_type: 0,
          has_cross_site_ancestor: 0,
        }
        const writable = Object.keys(row).filter((column) => columns.has(column))
        const statement = database.prepare(
          `INSERT OR REPLACE INTO cookies (${writable.join(', ')})
             VALUES (${writable.map((column) => `$${column}`).join(', ')})`
        )
        for (const cookie of cookies) {
          const partition = cookie.partitionKey
          const expiresUtc = microsFromIso(cookie.expiresAt)
          statement.run(
            bindings({
              ...row,
              host_key: cookie.domain,
              top_frame_site_key: partition?.topLevelSite ?? '',
              name: cookie.name,
              value: '',
              encrypted_value: encryptChromiumValue(cookie.value, profileKey, cookie.domain),
              path: cookie.path.length > 0 ? cookie.path : '/',
              expires_utc: expiresUtc,
              is_secure: cookie.secure ? 1 : 0,
              is_httponly: cookie.httpOnly ? 1 : 0,
              has_expires: expiresUtc > 0 ? 1 : 0,
              is_persistent: expiresUtc > 0 ? 1 : 0,
              samesite: chromiumSameSiteToColumn(cookie.sameSite),
              source_scheme: cookie.secure ? 2 : 1,
              has_cross_site_ancestor: partition?.hasCrossSiteAncestor === true ? 1 : 0,
            })
          )
        }
      } catch (error) {
        if (error instanceof LaneCookieStoreError) throw error
        throw new LaneCookieStoreError(
          'unreadable',
          `the lane cookie store could not be written: ${messageOf(error)}`
        )
      } finally {
        database.close()
      }
    },
  }

  function decryptWithKey(encrypted: Uint8Array): string | null {
    return decryptChromiumValue(encrypted, key())
  }
}

/** The underlying failure is the actionable part; SQLite messages carry column
 *  names, never values, so this is safe to surface. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'store error'
}

type CookieBindings = Record<string, string | number | Uint8Array>

/**
 * bun:sqlite binds named parameters by their spelled name, so the object keys
 * have to carry the same `$` prefix as the placeholders.
 */
function bindings(values: CookieBindings): CookieBindings {
  return Object.fromEntries(
    Object.entries(values).map(([column, value]) => [`$${column}`, value])
  ) as CookieBindings
}
