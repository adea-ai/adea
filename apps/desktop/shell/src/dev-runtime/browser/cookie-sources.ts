// Native cookie source detection and reading (#610).
//
// `cookie-import.ts` is policy and transactional application over a
// host-injected reader; nothing in the repository ever found a browser profile
// or decrypted its store. This is that half, and it follows the discipline the
// #610 acceptance wrote down:
//
//   - detection reports every profile it can see as a TYPED source, including
//     the ones it cannot read (a locked store, a format this lane does not
//     parse yet) — never an empty list that reads as "this browser has no
//     cookies";
//   - decryption failures surface as typed states with guidance, never as a
//     silent empty import;
//   - no cookie VALUE is ever logged, formatted into an error, or written
//     anywhere but the returned array.
//
// The Chromium family obeys the browser's own macOS scheme: the Keychain item
// named "<Vendor> Safe Storage" holds the passphrase, PBKDF2-HMAC-SHA1 with the
// fixed "saltysalt" salt and 1003 iterations derives a 16-byte AES-128-CBC key,
// and each cookie's value carries a "v10"/"v11" prefix (Chrome 24 and later also
// prepend a 32-byte SHA-256 domain hash to the plaintext). Firefox stores
// plaintext SQLite. Safari's `Cookies.binarycookies` is detected and reported as
// unsupported rather than guessed at.
import { Database } from 'bun:sqlite'
import { createDecipheriv, pbkdf2Sync } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type { ImportedCookie } from './cookie-import'

export type CookieSourceKind = 'chrome' | 'chromium' | 'brave' | 'edge' | 'firefox' | 'safari'

/**
 * How a detected source can be used right now. `locked` means the store exists
 * and is not readable (a browser holding it, or file permissions);
 * `unsupported_format` means the store is one this lane does not parse yet.
 */
export type CookieSourceAvailability = 'available' | 'locked' | 'unsupported_format' | 'unreadable'

export type DetectedCookieSource = Readonly<{
  /**
   * Stable identity: `<kind>:<profile directory>`. The absolute path stays
   * host-side — a client addresses a source by this id and never learns where
   * the user's browser keeps its data.
   */
  id: string
  kind: CookieSourceKind
  label: string
  /** Host-side absolute store path; never returned to a client. */
  storePath: string
  availability: CookieSourceAvailability
  detail?: string
}>

export type CookieReadErrorCode =
  | 'keychain_denied'
  | 'decryption_failed'
  | 'unsupported_format'
  | 'unreadable'
  | 'limit_exceeded'
  | 'unknown_source'

export type CookieReadResult =
  | Readonly<{ ok: true; cookies: readonly ImportedCookie[] }>
  | Readonly<{
      ok: false
      code: CookieReadErrorCode
      message: string
      remediation?: Readonly<{ action: string }>
    }>

export type CookieSourceDeps = Readonly<{
  /**
   * Reads a browser's Keychain item. The host owns this (it is the only place
   * the passphrase exists); tests script it. Returning null is a refusal.
   */
  keychainSecret?: (service: string) => string | null
  /** Bounds from the spec's cookie-import row; defaults are the production caps. */
  maxCookies?: number
  maxSerializedBytes?: number
}>

/** The spec's cookie-import bounds (docs/specs/dev-runtime.md). */
export const COOKIE_IMPORT_MAX_COOKIES = 10_000
export const COOKIE_IMPORT_MAX_SERIALIZED_BYTES = 16 * 1024 * 1024

/** Chromium-family vendors: profile root under Application Support, Keychain service. */
const CHROMIUM_VENDORS: ReadonlyArray<
  Readonly<{ kind: CookieSourceKind; supportDir: string; service: string; label: string }>
> = [
  {
    kind: 'chrome',
    supportDir: 'Google/Chrome',
    service: 'Chrome Safe Storage',
    label: 'Chrome',
  },
  { kind: 'chromium', supportDir: 'Chromium', service: 'Chromium Safe Storage', label: 'Chromium' },
  {
    kind: 'brave',
    supportDir: 'BraveSoftware/Brave-Browser',
    service: 'Brave Safe Storage',
    label: 'Brave',
  },
  {
    kind: 'edge',
    supportDir: 'Microsoft Edge',
    service: 'Microsoft Edge Safe Storage',
    label: 'Edge',
  },
]

const SAFARI_STORE_CANDIDATES = [
  'Library/Cookies/Cookies.binarycookies',
  'Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies',
] as const

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Detects the browser cookie sources installed for one home directory. Ordered
 * by vendor then profile so two runs on the same machine agree.
 */
export function detectCookieSources(homeDir: string): readonly DetectedCookieSource[] {
  const sources: DetectedCookieSource[] = []
  const support = join(homeDir, 'Library', 'Application Support')

  for (const vendor of CHROMIUM_VENDORS) {
    const root = join(support, vendor.supportDir)
    if (!isDirectory(root)) continue
    let profileNames: string[]
    try {
      profileNames = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => isFile(join(root, name, 'Cookies')))
        .toSorted()
    } catch {
      continue
    }
    for (const profile of profileNames) {
      const storePath = join(root, profile, 'Cookies')
      const readable = (() => {
        try {
          return statSync(storePath).isFile()
        } catch {
          return false
        }
      })()
      sources.push({
        id: `${vendor.kind}:${profile}`,
        kind: vendor.kind,
        label: profile === 'Default' ? vendor.label : `${vendor.label} — ${profile}`,
        storePath,
        availability: readable ? 'available' : 'locked',
        ...(readable ? {} : { detail: 'the store exists but is not readable right now' }),
      })
    }
  }

  // Firefox keeps one directory per profile, each with its own plaintext store.
  const firefoxRoot = join(support, 'Firefox', 'Profiles')
  if (isDirectory(firefoxRoot)) {
    let profiles: string[] = []
    try {
      profiles = readdirSync(firefoxRoot).toSorted()
    } catch {
      profiles = []
    }
    for (const profile of profiles) {
      const storePath = join(firefoxRoot, profile, 'cookies.sqlite')
      if (!isFile(storePath)) continue
      sources.push({
        id: `firefox:${profile}`,
        kind: 'firefox',
        label: `Firefox — ${profile}`,
        storePath,
        availability: 'available',
      })
    }
  }

  // Safari is detected, not parsed: reporting it as unsupported is a typed
  // state, which is what stops "we found nothing" from being ambiguous.
  for (const candidate of SAFARI_STORE_CANDIDATES) {
    const storePath = join(homeDir, candidate)
    if (!isFile(storePath)) continue
    sources.push({
      id: `safari:${candidate.includes('/Containers/') ? 'container' : 'legacy'}`,
      kind: 'safari',
      label: 'Safari',
      storePath,
      availability: 'unsupported_format',
      detail: 'Safari stores cookies in a binary format this lane does not parse yet',
    })
    break
  }

  return sources
}

/** The Keychain read this host performs: fixed argv, no shell, stdio captured. */
export function readKeychainSecretWithSecurity(service: string): string | null {
  try {
    const proc = Bun.spawnSync({
      cmd: ['/usr/bin/security', 'find-generic-password', '-w', '-s', service],
      stdout: 'pipe',
      stderr: 'ignore',
      stdin: 'ignore',
    })
    if (proc.exitCode !== 0) return null
    const secret = new TextDecoder().decode(proc.stdout).trim()
    return secret.length > 0 ? secret : null
  } catch {
    return null
  }
}

/** PBKDF2-HMAC-SHA1, the fixed salt and iteration count the Chromium family uses. */
export function deriveChromiumKey(secret: string): Buffer {
  return pbkdf2Sync(secret, 'saltysalt', 1003, 16, 'sha1')
}

/**
 * Decrypts one Chromium cookie value. Returns null when the bytes are not a
 * value this scheme produced (a legacy plaintext row, a short read) so the
 * caller can report a typed failure instead of inventing a value.
 */
export function decryptChromiumValue(encrypted: Uint8Array, key: Buffer): string | null {
  const bytes = Buffer.from(encrypted)
  if (bytes.length <= 3) return null
  const prefix = bytes.subarray(0, 3).toString('utf8')
  if (prefix !== 'v10' && prefix !== 'v11') return null
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '))
    const plaintext = Buffer.concat([decipher.update(bytes.subarray(3)), decipher.final()])
    // Chrome 24+ prepends a 32-byte SHA-256 of the domain to the plaintext. A
    // value shorter than that is left as-is rather than truncated to nothing.
    return (plaintext.length > 32 ? plaintext.subarray(32) : plaintext).toString('utf8')
  } catch {
    return null
  }
}

/**
 * The `cookies.samesite` column is Chromium's own `net::CookieSameSite` enum:
 * -1 unspecified, 0 no_restriction, 1 lax, 2 strict. A real store never holds
 * 3, so treating 1 as no_restriction (the shape of the extension API's enum
 * instead of the column's) silently promotes Lax to None — a cross-site
 * sendability upgrade — on the majority of rows. Verified against a real
 * Chrome profile: the column's observed values are exactly -1/0/1/2.
 */
export function chromiumSameSiteFromColumn(value: unknown): ImportedCookie['sameSite'] {
  switch (value) {
    case 0:
      return 'no_restriction'
    case 1:
      return 'lax'
    case 2:
      return 'strict'
    default:
      return 'unspecified'
  }
}

/** The inverse, for writing a value back into the same column. */
export function chromiumSameSiteToColumn(sameSite: ImportedCookie['sameSite']): number {
  switch (sameSite) {
    case 'no_restriction':
      return 0
    case 'lax':
      return 1
    case 'strict':
      return 2
    default:
      return -1
  }
}

/**
 * The columns of an existing store. A real Chromium-family profile carries
 * `has_cross_site_ancestor`; older builds and hand-built fixtures use
 * `is_cross_site`. Reading the schema first keeps one column-name difference
 * from turning a readable store into a typed `unreadable`.
 */
function cookieColumns(database: Database): ReadonlySet<string> {
  try {
    const rows = database.query('PRAGMA table_info(cookies)').all() as Array<{ name?: unknown }>
    return new Set(rows.map((row) => String(row.name ?? '')))
  } catch {
    return new Set<string>()
  }
}

/** Chromium's epoch: microseconds since 1601-01-01. */
const CHROMIUM_EPOCH_OFFSET_MS = 11_644_473_600_000

function firefoxSameSite(value: unknown): ImportedCookie['sameSite'] {
  switch (value) {
    case 'None':
    case 0:
      return 'no_restriction'
    case 'Lax':
    case 1:
      return 'lax'
    case 'Strict':
    case 2:
      return 'strict'
    default:
      return 'unspecified'
  }
}

function chromiumExpiry(expiresUtc: unknown): string | undefined {
  // Chromium counts microseconds since 1601-01-01; 0 means a session cookie.
  if (typeof expiresUtc !== 'number' || expiresUtc <= 0) return undefined
  const epochMs = Math.round(expiresUtc / 1000 - CHROMIUM_EPOCH_OFFSET_MS)
  if (epochMs <= 0) return undefined
  return new Date(epochMs).toISOString()
}

function firefoxExpiry(expiry: unknown): string | undefined {
  if (typeof expiry !== 'number' || expiry <= 0) return undefined
  return new Date(expiry * 1000).toISOString()
}

function oversize(
  cookies: readonly ImportedCookie[],
  maxCookies: number,
  maxBytes: number
): CookieReadResult | null {
  if (cookies.length > maxCookies) {
    return {
      ok: false,
      code: 'limit_exceeded',
      message: `the source holds more than ${maxCookies} cookies`,
      remediation: { action: 'cookieImport.narrowDomains' },
    }
  }
  if (JSON.stringify(cookies).length > maxBytes) {
    return {
      ok: false,
      code: 'limit_exceeded',
      message: `the source serializes beyond ${maxBytes} bytes`,
      remediation: { action: 'cookieImport.narrowDomains' },
    }
  }
  return null
}

/** Reads one detected source. Synchronous by design: the shell's file and
 *  Keychain paths already are, and the import service awaits the wrapper. */
export function readCookieSource(
  source: DetectedCookieSource,
  deps: CookieSourceDeps = {}
): CookieReadResult {
  const maxCookies = deps.maxCookies ?? COOKIE_IMPORT_MAX_COOKIES
  const maxBytes = deps.maxSerializedBytes ?? COOKIE_IMPORT_MAX_SERIALIZED_BYTES

  if (source.availability === 'unsupported_format') {
    return {
      ok: false,
      code: 'unsupported_format',
      message: source.detail ?? 'this store format is not supported yet',
      remediation: { action: 'cookieImport.chooseAnotherSource' },
    }
  }
  if (source.availability === 'locked' || !existsSync(source.storePath)) {
    return {
      ok: false,
      code: 'unreadable',
      message: 'the cookie store is not readable right now',
      remediation: { action: 'cookieImport.closeBrowserAndRetry' },
    }
  }

  if (source.kind === 'safari') {
    return {
      ok: false,
      code: 'unsupported_format',
      message: 'Safari stores cookies in a binary format this lane does not parse yet',
      remediation: { action: 'cookieImport.chooseAnotherSource' },
    }
  }

  if (source.kind === 'firefox') return readFirefoxSource(source, maxCookies, maxBytes)

  const vendor = CHROMIUM_VENDORS.find((entry) => entry.kind === source.kind)
  if (!vendor) return { ok: false, code: 'unknown_source', message: 'unknown source kind' }
  return readChromiumSource(source, vendor.service, deps, maxCookies, maxBytes)
}

function readFirefoxSource(
  source: DetectedCookieSource,
  maxCookies: number,
  maxBytes: number
): CookieReadResult {
  let database: Database
  try {
    database = new Database(source.storePath, { readonly: true })
  } catch {
    return { ok: false, code: 'unreadable', message: 'the cookie store could not be opened' }
  }
  try {
    const rows = database
      .query(
        'SELECT host, name, value, path, expiry, isSecure, isHttpOnly, sameSite FROM moz_cookies LIMIT ?'
      )
      .all(maxCookies + 1) as Array<Record<string, unknown>>
    const cookies: ImportedCookie[] = rows.map((row) => ({
      domain: String(row.host ?? ''),
      name: String(row.name ?? ''),
      value: String(row.value ?? ''),
      path: typeof row.path === 'string' && row.path.length > 0 ? row.path : '/',
      secure: row.isSecure === 1,
      httpOnly: row.isHttpOnly === 1,
      sameSite: firefoxSameSite(row.sameSite),
      ...(firefoxExpiry(row.expiry) ? { expiresAt: firefoxExpiry(row.expiry) } : {}),
    }))
    return oversize(cookies, maxCookies, maxBytes) ?? { ok: true, cookies }
  } catch {
    return { ok: false, code: 'unreadable', message: 'the cookie store could not be read' }
  } finally {
    database.close()
  }
}

function readChromiumSource(
  source: DetectedCookieSource,
  service: string,
  deps: CookieSourceDeps,
  maxCookies: number,
  maxBytes: number
): CookieReadResult {
  const keychain = deps.keychainSecret ?? readKeychainSecretWithSecurity
  const secret = keychain(service)
  if (secret === null) {
    return {
      ok: false,
      code: 'keychain_denied',
      message: `the "${service}" Keychain item was not readable`,
      remediation: { action: 'cookieImport.grantKeychainAccess' },
    }
  }
  const key = deriveChromiumKey(secret)

  let database: Database
  try {
    database = new Database(source.storePath, { readonly: true })
  } catch {
    return { ok: false, code: 'unreadable', message: 'the cookie store could not be opened' }
  }
  try {
    const columns = cookieColumns(database)
    // Every column the mapping needs, whether or not this build of the store
    // has it. A missing optional column resolves to NULL and reads as absent;
    // a missing REQUIRED one means this is not a Chromium cookie store at all,
    // which is a format answer, not an I/O failure.
    const required = ['host_key', 'name', 'path', 'is_secure', 'is_httponly', 'samesite']
    if (!required.every((column) => columns.has(column))) {
      return {
        ok: false,
        code: 'unsupported_format',
        message: 'the store is a SQLite database without the Chromium cookie columns',
        remediation: { action: 'cookieImport.chooseAnotherSource' },
      }
    }
    const selection = [
      'host_key',
      'name',
      'path',
      'is_secure',
      'is_httponly',
      'samesite',
      'encrypted_value',
      'value',
      'expires_utc',
      'top_frame_site_key',
      // The partition flag is spelled `has_cross_site_ancestor` in current
      // Chromium and `is_cross_site` in older builds; either name is read and
      // a store carrying neither simply has no partition flag.
      'has_cross_site_ancestor',
      'is_cross_site',
    ]
      .map((column) => (columns.has(column) ? column : `NULL AS ${column}`))
      .join(', ')
    const rows = database
      .query(`SELECT ${selection} FROM cookies LIMIT ?`)
      .all(maxCookies + 1) as Array<Record<string, unknown>>

    const cookies: ImportedCookie[] = []
    let undecryptable = 0
    for (const row of rows) {
      const encrypted = row.encrypted_value as Uint8Array | null
      let value: string | null
      if (encrypted && encrypted.byteLength > 0) {
        value = decryptChromiumValue(encrypted, key)
        if (value === null) {
          undecryptable += 1
          continue
        }
      } else {
        // A row whose value never went through OS encryption (legacy installs,
        // a Linux-built store) keeps it in the plaintext column.
        value = typeof row.value === 'string' ? row.value : ''
      }
      // A cookie is partitioned only when it carries a partition key's
      // top-level site: the stored flag alone is 1 on nearly every row of a
      // real profile (it is the column's migration default) and would mark
      // ordinary cookies as partitioned.
      const partitionTopLevelSite =
        typeof row.top_frame_site_key === 'string' && row.top_frame_site_key.length > 0
          ? row.top_frame_site_key
          : undefined
      const hasCrossSiteAncestor = row.has_cross_site_ancestor === 1 || row.is_cross_site === 1
      cookies.push({
        domain: String(row.host_key ?? ''),
        name: String(row.name ?? ''),
        value,
        path: typeof row.path === 'string' && row.path.length > 0 ? row.path : '/',
        secure: row.is_secure === 1,
        httpOnly: row.is_httponly === 1,
        sameSite: chromiumSameSiteFromColumn(row.samesite),
        ...(partitionTopLevelSite
          ? { partitionKey: { topLevelSite: partitionTopLevelSite, hasCrossSiteAncestor } }
          : {}),
        ...(chromiumExpiry(row.expires_utc) ? { expiresAt: chromiumExpiry(row.expires_utc) } : {}),
      })
    }

    // Every row failing decryption is a decryption failure, not an empty
    // browser: the caller must never read it as "this profile has no cookies".
    if (cookies.length === 0 && undecryptable > 0) {
      return {
        ok: false,
        code: 'decryption_failed',
        message: `${undecryptable} stored values could not be decrypted with this browser's key`,
        remediation: { action: 'cookieImport.lockKeychainAndRetry' },
      }
    }
    const limit = oversize(cookies, maxCookies, maxBytes)
    if (limit) return limit
    // Partially undecryptable sources still import what they can; the typed
    // failure is reserved for a source that yields nothing at all.
    return { ok: true, cookies }
  } catch {
    return { ok: false, code: 'unreadable', message: 'the cookie store could not be read' }
  } finally {
    database.close()
  }
}
