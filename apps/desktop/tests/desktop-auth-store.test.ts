import { describe, expect, test } from 'bun:test'
import { createCipheriv, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createDesktopAuthStore,
  createMemoryKeychainPort,
  createSystemKeychainPort,
  DESKTOP_AUTH_ACCOUNTS,
  DESKTOP_AUTH_SERVICE,
  type DesktopAuthKeychainPort,
} from '../shell/src/desktop-auth-store'
import { KeychainAccessError } from '../shell/src/dev-runtime/vault'

const SESSION_ID = '11111111-1111-4111-8111-111111111111'
const TEMPORARY = `adea_tmp_${'b'.repeat(43)}`

const SESSION = {
  credential: 'a'.repeat(43),
  expiresAt: '2030-01-01T00:00:00.000Z',
  sessionId: SESSION_ID,
} as const

const ATTEMPT = {
  codeChallenge: 'a'.repeat(43),
  codeVerifier: 'b'.repeat(64),
  expiresAt: 1234567890,
  nonce: 'c'.repeat(43),
  redirectUri: 'adea://auth/callback',
  state: 'd'.repeat(43),
  used: false,
} as const

/** Creates a temp data dir with an owner-only device key, runs the body, cleans up. */
function withDataDir(run: (dataDir: string, key: Buffer) => void): void {
  const dataDir = mkdtempSync(join(tmpdir(), 'adea-desktop-auth-store-'))
  try {
    mkdirSync(join(dataDir, 'desktop-state'), { recursive: true, mode: 0o700 })
    const key = randomBytes(32)
    writeFileSync(join(dataDir, 'desktop-state', 'device.key'), key, { mode: 0o600 })
    run(dataDir, key)
  } finally {
    rmSync(dataDir, { force: true, recursive: true })
  }
}

/** Seals a legacy `*.sealed` fixture exactly as the transitional store did. */
function writeLegacy(dataDir: string, name: string, key: Buffer, value: unknown): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const sealed = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  const path = join(dataDir, 'desktop-state', name)
  writeFileSync(path, Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString('base64'), {
    mode: 0o600,
  })
  return path
}

describe('desktop auth store: read and write through the port', () => {
  test('saves and loads each entry through the OS port (no sealed file)', () => {
    withDataDir((dataDir) => {
      const port = createMemoryKeychainPort()
      const store = createDesktopAuthStore({ dataDir, port })

      store.saveUserSession(SESSION)
      store.saveAuthorizationAttempt(ATTEMPT)
      store.saveTemporaryWorkspaceCredential(TEMPORARY)

      expect(store.loadUserSession()).toEqual(SESSION)
      expect(store.loadAuthorizationAttempt()).toEqual(ATTEMPT)
      expect(store.loadTemporaryWorkspaceCredential()).toBe(TEMPORARY)

      expect(port.get(DESKTOP_AUTH_ACCOUNTS.userSession)).toBe(JSON.stringify(SESSION))
      expect(port.get(DESKTOP_AUTH_ACCOUNTS.temporaryWorkspace)).toBe(TEMPORARY)
      expect(existsSync(join(dataDir, 'desktop-state', 'session.sealed'))).toBe(false)
    })
  })

  test('validation on write refuses malformed values and stores nothing', () => {
    withDataDir((dataDir) => {
      const port = createMemoryKeychainPort()
      const store = createDesktopAuthStore({ dataDir, port })

      expect(() => store.saveUserSession({ ...SESSION, sessionId: 'not-a-uuid' })).toThrow()
      expect(() => store.saveAuthorizationAttempt({ ...ATTEMPT, used: true })).toThrow()
      expect(() => store.saveTemporaryWorkspaceCredential('adea_tmp_short')).toThrow()

      expect(port.get(DESKTOP_AUTH_ACCOUNTS.userSession)).toBeUndefined()
      expect(port.get(DESKTOP_AUTH_ACCOUNTS.authorizationAttempt)).toBeUndefined()
      expect(port.get(DESKTOP_AUTH_ACCOUNTS.temporaryWorkspace)).toBeUndefined()
    })
  })

  test('a malformed stored value reads as absent', () => {
    withDataDir((dataDir) => {
      const port = createMemoryKeychainPort({
        [DESKTOP_AUTH_ACCOUNTS.userSession]: '{not json',
        [DESKTOP_AUTH_ACCOUNTS.authorizationAttempt]: JSON.stringify({ ...ATTEMPT, used: true }),
        [DESKTOP_AUTH_ACCOUNTS.temporaryWorkspace]: 'adea_tmp_short',
      })
      const store = createDesktopAuthStore({ dataDir, port })

      expect(store.loadUserSession()).toBeNull()
      expect(store.loadAuthorizationAttempt()).toBeNull()
      expect(store.loadTemporaryWorkspaceCredential()).toBeNull()
    })
  })
})

describe('desktop auth store: fail-closed store errors', () => {
  test('an unavailable store throws and never falls back to a legacy file', () => {
    withDataDir((dataDir, key) => {
      writeLegacy(dataDir, 'session.sealed', key, SESSION)
      const failing: DesktopAuthKeychainPort = {
        delete: () => {},
        get: () => {
          throw new Error('credential store unavailable (keychain_locked)')
        },
        set: () => {},
      }
      const store = createDesktopAuthStore({ dataDir, port: failing })

      expect(() => store.loadUserSession()).toThrow('credential store unavailable')
      // The legacy file is untouched: no silent fallback answered the read.
      expect(existsSync(join(dataDir, 'desktop-state', 'session.sealed'))).toBe(true)
    })
  })

  test('write failure leaves the legacy file intact', () => {
    withDataDir((dataDir, key) => {
      const path = writeLegacy(dataDir, 'session.sealed', key, SESSION)
      const failing: DesktopAuthKeychainPort = {
        delete: () => {},
        get: () => undefined,
        set: () => {
          throw new Error('credential store unavailable (access_denied)')
        },
      }
      const store = createDesktopAuthStore({ dataDir, port: failing })

      expect(() => store.loadUserSession()).toThrow('credential store unavailable')
      expect(existsSync(path)).toBe(true)
    })
  })
})

describe('desktop auth store: legacy migration', () => {
  test('migrates a valid sealed fixture, verifies read-back, and retires it', () => {
    withDataDir((dataDir, key) => {
      const path = writeLegacy(dataDir, 'session.sealed', key, SESSION)
      const port = createMemoryKeychainPort()
      const store = createDesktopAuthStore({ dataDir, port })

      expect(store.loadUserSession()).toEqual(SESSION)
      expect(port.get(DESKTOP_AUTH_ACCOUNTS.userSession)).toBe(JSON.stringify(SESSION))
      expect(existsSync(path)).toBe(false)
    })
  })

  test('is idempotent across restarts and prefers an existing OS item', () => {
    withDataDir((dataDir, key) => {
      const path = writeLegacy(dataDir, 'auth-attempt.sealed', key, ATTEMPT)
      const port = createMemoryKeychainPort()
      const first = createDesktopAuthStore({ dataDir, port })
      expect(first.loadAuthorizationAttempt()).toEqual(ATTEMPT)
      expect(existsSync(path)).toBe(false)

      // A fresh store over the same port (a restart) reads the OS item.
      const second = createDesktopAuthStore({ dataDir, port })
      expect(second.loadAuthorizationAttempt()).toEqual(ATTEMPT)
      expect(second.loadAuthorizationAttempt()).toEqual(ATTEMPT)

      // An existing OS item wins; the legacy fixture is not consulted.
      writeLegacy(dataDir, 'auth-attempt.sealed', key, { ...ATTEMPT, state: 'e'.repeat(43) })
      expect(second.loadAuthorizationAttempt()).toEqual(ATTEMPT)
    })
  })

  test('an invalid legacy value is treated as absent and left intact', () => {
    withDataDir((dataDir, key) => {
      const path = writeLegacy(dataDir, 'session.sealed', key, { ...SESSION, sessionId: 'bad' })
      const port = createMemoryKeychainPort()
      const store = createDesktopAuthStore({ dataDir, port })

      expect(store.loadUserSession()).toBeNull()
      expect(port.get(DESKTOP_AUTH_ACCOUNTS.userSession)).toBeUndefined()
      expect(existsSync(path)).toBe(true)
    })
  })

  test('an unreadable legacy file is treated as absent and left intact', () => {
    withDataDir((dataDir) => {
      const path = join(dataDir, 'desktop-state', 'session.sealed')
      writeFileSync(path, 'not-a-sealed-payload', { mode: 0o600 })
      const store = createDesktopAuthStore({ dataDir, port: createMemoryKeychainPort() })

      expect(store.loadUserSession()).toBeNull()
      expect(existsSync(path)).toBe(true)
    })
  })

  test('a read-back mismatch fails closed and leaves the legacy file intact', () => {
    withDataDir((dataDir, key) => {
      const path = writeLegacy(dataDir, 'session.sealed', key, SESSION)
      let stored: string | undefined
      const tampering: DesktopAuthKeychainPort = {
        delete: () => {
          stored = undefined
        },
        get: () => stored,
        set: (_account, value) => {
          stored = `${value}-tampered`
        },
      }
      const store = createDesktopAuthStore({ dataDir, port: tampering })

      expect(() => store.loadUserSession()).toThrow('read-back mismatch')
      expect(existsSync(path)).toBe(true)
    })
  })
})

describe('desktop auth store: clear prevents resurrection', () => {
  test('clear removes both the OS item and a legacy file', () => {
    withDataDir((dataDir, key) => {
      const path = writeLegacy(dataDir, 'temporary-workspace.sealed', key, TEMPORARY)
      const port = createMemoryKeychainPort()
      const store = createDesktopAuthStore({ dataDir, port })

      store.clearTemporaryWorkspaceCredential()
      expect(port.get(DESKTOP_AUTH_ACCOUNTS.temporaryWorkspace)).toBeUndefined()
      expect(existsSync(path)).toBe(false)

      // A later read cannot resurrect the cleared value.
      expect(store.loadTemporaryWorkspaceCredential()).toBeNull()
    })
  })

  test('clearing the OS item also retires an unmigrated legacy file', () => {
    withDataDir((dataDir, key) => {
      const osFirst = createMemoryKeychainPort({
        [DESKTOP_AUTH_ACCOUNTS.userSession]: JSON.stringify(SESSION),
      })
      const path = writeLegacy(dataDir, 'session.sealed', key, SESSION)
      const store = createDesktopAuthStore({ dataDir, port: osFirst })

      store.clearUserSession()
      expect(existsSync(path)).toBe(false)
      expect(store.loadUserSession()).toBeNull()
    })
  })
})

describe('desktop auth store: system keychain port (injected runner)', () => {
  test('maps an authoritative item-not-found to absent and reads a stored value', () => {
    const port = createSystemKeychainPort({
      runSecurity: (args) => {
        if (args[0] === 'find-generic-password') {
          if (args.includes('missing'))
            throw new KeychainAccessError('item_not_found', 'absent', 44)
          return Buffer.from('stored-value\n', 'utf8')
        }
        return Buffer.alloc(0)
      },
    })

    expect(port.get('present')).toBe('stored-value')
    expect(port.get('missing')).toBeUndefined()
  })

  test('fails closed for locked, denied, and malformed stores', () => {
    const locked = createSystemKeychainPort({
      runSecurity: () => {
        throw new KeychainAccessError('keychain_locked', 'locked')
      },
    })
    expect(() => locked.get('any')).toThrow('credential store unavailable (keychain_locked)')
    expect(() => locked.set('any', 'value')).toThrow('credential store unavailable')

    const empty = createSystemKeychainPort({ runSecurity: () => Buffer.alloc(0) })
    expect(() => empty.get('any')).toThrow('credential store unavailable (malformed_output)')

    const denied = createSystemKeychainPort({
      runSecurity: () => {
        throw new KeychainAccessError('access_denied', 'denied')
      },
    })
    expect(() => denied.delete('any')).toThrow('credential store unavailable (access_denied)')
  })

  test('targets the canonical service and is idempotent on delete', () => {
    const seen: string[][] = []
    const port = createSystemKeychainPort({
      runSecurity: (args) => {
        seen.push(args)
        if (args[0] === 'delete-generic-password') {
          throw new KeychainAccessError('item_not_found', 'absent', 44)
        }
        return Buffer.alloc(0)
      },
    })

    port.delete('desktop-user-session')
    expect(seen.at(-1)).toEqual([
      'delete-generic-password',
      '-s',
      DESKTOP_AUTH_SERVICE,
      '-a',
      'desktop-user-session',
    ])
  })
})
