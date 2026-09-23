// Native cookie source detection and reading (#610). The import service had a
// host-injected reader and nothing behind it; these pin the reader's contract:
// typed detection (never an empty list that reads as "no cookies"), both store
// formats, and every failure as a typed state carrying guidance — with the
// decryption path proven against a real SQLite store and a scripted Keychain.
import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  COOKIE_IMPORT_MAX_COOKIES,
  decryptChromiumValue,
  deriveChromiumKey,
  detectCookieSources,
  readCookieSource,
} from '../shell/src/dev-runtime/browser/cookie-sources'

const SALT = 'saltysalt'

function scratch(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'adea-cookie-sources-'))
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

/** A Chrome-shaped store with `rows` in it, encrypted the way Chrome 24+ does. */
function chromiumStore(
  path: string,
  rows: ReadonlyArray<{ domain: string; name: string; value: string }>,
  options: { secret?: string; prefix?: string } = {}
): void {
  const secret = options.secret ?? 'test-secret'
  const key = deriveChromiumKey(secret)
  const database = new Database(path)
  database.exec(`CREATE TABLE cookies (
    host_key TEXT, name TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER,
    is_secure INTEGER, is_httponly INTEGER, samesite INTEGER,
    top_frame_site_key TEXT, is_cross_site INTEGER
  )`)
  const insert = database.prepare(
    'INSERT INTO cookies VALUES ($host, $name, $value, $path, $expires, $secure, $httpOnly, $sameSite, $top, $cross)'
  )
  for (const row of rows) {
    const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '))
    // Chrome 24+ prepends the SHA-256 of the domain to the plaintext.
    const body = Buffer.concat([
      createHash('sha256').update(row.domain).digest(),
      Buffer.from(row.value),
    ])
    const encrypted = Buffer.concat([
      Buffer.from(options.prefix ?? 'v10', 'utf8'),
      cipher.update(body),
      cipher.final(),
    ])
    insert.run({
      $host: row.domain,
      $name: row.name,
      $value: encrypted,
      $path: '/',
      $expires: 13_400_000_000_000_000,
      $secure: 1,
      $httpOnly: 1,
      $sameSite: 2,
      $top: 'https://embed.example',
      $cross: 1,
    })
  }
  database.close()
}

function firefoxStore(
  path: string,
  rows: ReadonlyArray<{ domain: string; name: string; value: string }>
): void {
  const database = new Database(path)
  database.exec(`CREATE TABLE moz_cookies (
    host TEXT, name TEXT, value TEXT, path TEXT, expiry INTEGER,
    isSecure INTEGER, isHttpOnly INTEGER, sameSite TEXT
  )`)
  const insert = database.prepare(
    'INSERT INTO moz_cookies VALUES ($host, $name, $value, $path, $expiry, $secure, $httpOnly, $sameSite)'
  )
  for (const row of rows) {
    insert.run({
      $host: row.domain,
      $name: row.name,
      $value: row.value,
      $path: '/',
      $expiry: 1_800_000_000,
      $secure: 1,
      $httpOnly: 0,
      $sameSite: 'Lax',
    })
  }
  database.close()
}

describe('cookie source detection (#610)', () => {
  test('reports every installed profile as a typed source, including the ones it cannot read', () => {
    const { home, cleanup } = scratch()
    try {
      const chromeRoot = join(home, 'Library/Application Support/Google/Chrome')
      mkdirSync(join(chromeRoot, 'Default'), { recursive: true })
      mkdirSync(join(chromeRoot, 'Profile 1'), { recursive: true })
      chromiumStore(join(chromeRoot, 'Default/Cookies'), [])
      chromiumStore(join(chromeRoot, 'Profile 1/Cookies'), [])
      mkdirSync(join(home, 'Library/Application Support/Firefox/Profiles/abc.default'), {
        recursive: true,
      })
      firefoxStore(
        join(home, 'Library/Application Support/Firefox/Profiles/abc.default/cookies.sqlite'),
        []
      )
      mkdirSync(join(home, 'Library/Cookies'), { recursive: true })
      writeFileSync(join(home, 'Library/Cookies/Cookies.binarycookies'), 'cook')

      const sources = detectCookieSources(home)
      const byId = Object.fromEntries(sources.map((source) => [source.id, source]))

      expect(byId['chrome:Default']).toMatchObject({ kind: 'chrome', availability: 'available' })
      expect(byId['chrome:Profile 1']).toMatchObject({
        kind: 'chrome',
        label: 'Chrome — Profile 1',
        availability: 'available',
      })
      expect(byId['firefox:abc.default']).toMatchObject({
        kind: 'firefox',
        availability: 'available',
      })
      // Detection never hides a browser it cannot parse: Safari appears as a
      // typed `unsupported_format` source, which is what stops an empty result
      // from being ambiguous with "this browser has no cookies".
      expect(byId['safari:legacy']).toMatchObject({
        kind: 'safari',
        availability: 'unsupported_format',
      })
      // The client-facing identity carries no absolute path.
      for (const source of sources) {
        expect(source.id).not.toContain(home)
        expect(source.label).not.toContain(home)
      }
    } finally {
      cleanup()
    }
  })

  test('a machine with no supported browser reports no sources rather than failing', () => {
    const { home, cleanup } = scratch()
    try {
      expect(detectCookieSources(home)).toEqual([])
    } finally {
      cleanup()
    }
  })
})

describe('cookie source reading (#610)', () => {
  test('a Firefox store reads its plaintext cookies with fields mapped', () => {
    const { home, cleanup } = scratch()
    try {
      const path = join(home, 'cookies.sqlite')
      firefoxStore(path, [{ domain: '.example.com', name: 'session', value: 'plain-value' }])
      const source = {
        id: 'firefox:test',
        kind: 'firefox' as const,
        label: 'Firefox',
        storePath: path,
        availability: 'available' as const,
      }
      const result = readCookieSource(source)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.cookies).toEqual([
        {
          domain: '.example.com',
          name: 'session',
          value: 'plain-value',
          path: '/',
          secure: true,
          httpOnly: false,
          sameSite: 'lax',
          expiresAt: new Date(1_800_000_000 * 1000).toISOString(),
        },
      ])
    } finally {
      cleanup()
    }
  })

  test('a Chromium store decrypts with the Keychain secret and keeps partitions', () => {
    const { home, cleanup } = scratch()
    try {
      const path = join(home, 'Cookies')
      chromiumStore(path, [{ domain: '.example.com', name: 'session', value: 'decrypted-value' }])
      const source = {
        id: 'chrome:Default',
        kind: 'chrome' as const,
        label: 'Chrome',
        storePath: path,
        availability: 'available' as const,
      }
      const result = readCookieSource(source, { keychainSecret: () => 'test-secret' })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.cookies).toHaveLength(1)
      expect(result.cookies[0]).toMatchObject({
        domain: '.example.com',
        name: 'session',
        value: 'decrypted-value',
        sameSite: 'lax',
        secure: true,
        httpOnly: true,
        // top_frame_site_key + is_cross_site travel as the partition key.
        partitionKey: {
          topLevelSite: 'https://embed.example',
          hasCrossSiteAncestor: true,
        },
      })
    } finally {
      cleanup()
    }
  })

  test('a refused Keychain item is typed with guidance, never a silent empty import', () => {
    const { home, cleanup } = scratch()
    try {
      const path = join(home, 'Cookies')
      chromiumStore(path, [{ domain: '.example.com', name: 'session', value: 'decrypted-value' }])
      const source = {
        id: 'chrome:Default',
        kind: 'chrome' as const,
        label: 'Chrome',
        storePath: path,
        availability: 'available' as const,
      }
      const refused = readCookieSource(source, { keychainSecret: () => null })
      expect(refused).toMatchObject({
        ok: false,
        code: 'keychain_denied',
        remediation: { action: 'cookieImport.grantKeychainAccess' },
      })
    } finally {
      cleanup()
    }
  })

  test('values encrypted with another key are a typed decryption failure, not an empty profile', () => {
    const { home, cleanup } = scratch()
    try {
      const path = join(home, 'Cookies')
      chromiumStore(path, [{ domain: '.example.com', name: 'session', value: 'secret-value' }], {
        secret: 'the-browser-key',
      })
      const source = {
        id: 'chrome:Default',
        kind: 'chrome' as const,
        label: 'Chrome',
        storePath: path,
        availability: 'available' as const,
      }
      const result = readCookieSource(source, { keychainSecret: () => 'a-different-key' })
      expect(result).toMatchObject({ ok: false, code: 'decryption_failed' })
      // The refusal must not carry the value it could not decrypt.
      expect(JSON.stringify(result)).not.toContain('secret-value')
    } finally {
      cleanup()
    }
  })

  test('an unsupported format and an unreadable store are distinct typed states', () => {
    const safari = readCookieSource({
      id: 'safari:legacy',
      kind: 'safari',
      label: 'Safari',
      storePath: '/nonexistent/Cookies.binarycookies',
      availability: 'unsupported_format',
      detail: 'binary format',
    })
    expect(safari).toMatchObject({ ok: false, code: 'unsupported_format' })

    const missing = readCookieSource({
      id: 'chrome:Default',
      kind: 'chrome',
      label: 'Chrome',
      storePath: '/nonexistent/Cookies',
      availability: 'locked',
    })
    expect(missing).toMatchObject({ ok: false, code: 'unreadable' })
  })

  test('the spec bounds are enforced as typed limits', () => {
    const { home, cleanup } = scratch()
    try {
      const path = join(home, 'Cookies')
      chromiumStore(path, [
        { domain: '.a.example', name: 'one', value: 'v1' },
        { domain: '.b.example', name: 'two', value: 'v2' },
        { domain: '.c.example', name: 'three', value: 'v3' },
      ])
      const source = {
        id: 'chrome:Default',
        kind: 'chrome' as const,
        label: 'Chrome',
        storePath: path,
        availability: 'available' as const,
      }
      const result = readCookieSource(source, {
        keychainSecret: () => 'test-secret',
        maxCookies: 2,
      })
      expect(result).toMatchObject({ ok: false, code: 'limit_exceeded' })
      // The production cap is the spec's 10,000, not a smaller default.
      expect(COOKIE_IMPORT_MAX_COOKIES).toBe(10_000)
    } finally {
      cleanup()
    }
  })

  test('an undecryptable prefix is refused rather than returned as plaintext', () => {
    const key = deriveChromiumKey('test-secret')
    expect(decryptChromiumValue(new TextEncoder().encode('v10xx'), key)).toBeNull()
    expect(decryptChromiumValue(Buffer.from('legacy-plaintext'), key)).toBeNull()
    expect(decryptChromiumValue(new Uint8Array(), key)).toBeNull()
    // A round-trip against the real scheme still works, so the refusal above is
    // about the prefix, not a broken decryptor.
    const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '))
    const body = Buffer.concat([randomBytes(32), Buffer.from('value', 'utf8')])
    const sealed = Buffer.concat([Buffer.from('v10'), cipher.update(body), cipher.final()])
    expect(decryptChromiumValue(sealed, key)).toBe('value')
    expect(SALT).toBe('saltysalt')
  })
})
