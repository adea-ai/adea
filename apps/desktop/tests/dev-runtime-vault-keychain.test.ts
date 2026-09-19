// Remediation gate: the macOS `security` CLI is not a boolean. Only an
// authoritative item-not-found result may permit first-time vault key
// generation; locked keychains, denied access, malformed output, process
// failures, timeouts, and a missing executable all fail closed without
// generating or overwriting a key. The classification is pure and the store
// adapter is injected, so every outcome is deterministic.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DevAuthorityError } from '../shell/src/dev-runtime/authority'
import {
  classifySecurityFailure,
  createCredentialVault,
  createSystemVaultKeyStore,
  KeychainAccessError,
  type SecurityCommandRunner,
} from '../shell/src/dev-runtime/vault'

/** Runner that throws the given classified failure for every invocation. */
function failingRunner(reason: KeychainAccessError['reason'], message: string): SecurityCommandRunner {
  return () => {
    throw new KeychainAccessError(reason, message)
  }
}

/** Runner with an item-not-found find and a classified write failure. */
function failingWriteRunner(reason: KeychainAccessError['reason'], message: string): SecurityCommandRunner {
  return (args) => {
    if (args[0] === 'find-generic-password') {
      throw new KeychainAccessError('item_not_found', 'absent', 44)
    }
    throw new KeychainAccessError(reason, message)
  }
}

const emptyOutputRunner: SecurityCommandRunner = () => Buffer.alloc(0)
const garbageOutputRunner: SecurityCommandRunner = () => Buffer.from('\x00\x01not-base64!!', 'utf8')

function expectAuthRequired(run: () => unknown, reason: string) {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(DevAuthorityError)
    expect((error as DevAuthorityError).code).toBe('auth_required')
    expect((error as DevAuthorityError).message).toContain(reason)
    return
  }
  throw new Error(`expected DevAuthorityError auth_required (${reason})`)
}

describe('security CLI failure classification (pure)', () => {
  test('maps every failure mode onto the taxonomy', () => {
    // Authoritative item-not-found: exit 44 with the canonical text.
    expect(
      classifySecurityFailure({
        exitCode: 44,
        stderr: 'security: SecKeychainSearchNext: The specified item could not be found.',
      })
    ).toEqual({ reason: 'item_not_found', message: 'keychain item not found' })
    expect(classifySecurityFailure({ exitCode: 1, stderr: 'errSecItemNotFound' })).toMatchObject({
      reason: 'item_not_found',
    })
    expect(classifySecurityFailure({ exitCode: 51, stderr: 'keychain is locked' })).toMatchObject({
      reason: 'keychain_locked',
    })
    expect(
      classifySecurityFailure({
        exitCode: 45,
        stderr: 'User interaction is not allowed. -25308',
      })
    ).toMatchObject({ reason: 'keychain_locked' })
    expect(
      classifySecurityFailure({ exitCode: 45, stderr: 'access denied: ACL not permitted' })
    ).toMatchObject({ reason: 'access_denied' })
    expect(
      classifySecurityFailure({ exitCode: 1, stderr: 'errSecAuthFailed: authentication failed' })
    ).toMatchObject({ reason: 'access_denied' })
    expect(classifySecurityFailure({ exitCode: 70, stderr: 'segmentation fault' })).toMatchObject({
      reason: 'process_failure',
    })
    expect(
      classifySecurityFailure({ exitCode: undefined, stderr: '', killed: true, signal: 'SIGTERM' })
    ).toMatchObject({ reason: 'timeout' })
    expect(
      classifySecurityFailure({ exitCode: undefined, stderr: '', code: 'ENOENT' })
    ).toMatchObject({ reason: 'unavailable_executable' })
  })
})

describe('vault key store adapter (injected runner)', () => {
  test('item-not-found permits first-time generation, exactly once', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-keychain-notfound-'))
    try {
      const written: Buffer[] = []
      const runner: SecurityCommandRunner = (args) => {
        if (args[0] === 'find-generic-password') {
          throw new KeychainAccessError(
            'item_not_found',
            'The specified item could not be found.',
            44
          )
        }
        if (args[0] === 'add-generic-password') {
          const key = Buffer.from(args[args.length - 1], 'base64')
          written.push(key)
          return Buffer.alloc(0)
        }
        throw new KeychainAccessError('process_failure', 'unexpected invocation')
      }
      const store = createSystemVaultKeyStore({ runSecurity: runner })
      const vault = createCredentialVault({
        dataDir,
        approvalVerifier: { recordIssuance: () => undefined, consume: () => undefined },
        credentialStore: store,
      })
      // A resolve of an absent reference touches the keychain path without
      // side effects; constructing the vault generated one 32-byte key.
      expect(store.get('svc', 'acct')).toBeUndefined()
      expect(written).toHaveLength(1)
      expect(written[0]!.byteLength).toBe(32)
      expect(vault).toBeDefined()
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  for (const [reason, message] of [
    ['keychain_locked', 'the keychain is locked'],
    ['access_denied', 'ACL denied the read'],
    ['process_failure', 'security exited 70'],
    ['timeout', 'security hung and was killed'],
    ['unavailable_executable', '/usr/bin/security is missing'],
  ] as const) {
    test(`${reason} fails closed without generating or overwriting a key`, () => {
      const dataDir = mkdtempSync(join(tmpdir(), `adea-keychain-${reason}-`))
      try {
        let generationAttempts = 0
        const runner: SecurityCommandRunner = (args) => {
          if (args[0] === 'find-generic-password') {
            // First lookup of a fresh store would be item-not-found; instead
            // the store is broken in this mode.
            throw new KeychainAccessError(reason, message)
          }
          if (args[0] === 'add-generic-password') {
            generationAttempts += 1
            throw new KeychainAccessError(reason, message)
          }
          throw new KeychainAccessError(reason, message)
        }
        const store = createSystemVaultKeyStore({ runSecurity: runner })
        expectAuthRequired(() => store.get('svc', 'acct'), message)
        expect(generationAttempts).toBe(0)
        expect(() =>
          createCredentialVault({
            dataDir,
            approvalVerifier: { recordIssuance: () => undefined, consume: () => undefined },
            credentialStore: store,
          })
        ).toThrow()
        // No key material was written anywhere.
        expect(generationAttempts).toBe(0)
      } finally {
        rmSync(dataDir, { recursive: true, force: true })
      }
    })
  }

  test('malformed output (empty or non-base64 secret) fails closed', () => {
    for (const runner of [emptyOutputRunner, garbageOutputRunner]) {
      const store = createSystemVaultKeyStore({ runSecurity: runner })
      expectAuthRequired(() => store.get('svc', 'acct'), 'keychain item')
    }
  })

  test('a locked store during set fails the write instead of succeeding silently', () => {
    const store = createSystemVaultKeyStore({
      runSecurity: failingWriteRunner('keychain_locked', 'cannot write while locked'),
    })
    expectAuthRequired(() => store.set('svc', 'acct', Buffer.alloc(32, 1)), 'locked')
  })

  test('delete tolerates only item-not-found; every other failure surfaces', () => {
    expect(() =>
      createSystemVaultKeyStore({
        runSecurity: failingRunner('item_not_found', 'absent'),
      }).delete('svc', 'acct')
    ).not.toThrow()
    expectAuthRequired(
      () =>
        createSystemVaultKeyStore({
          runSecurity: failingRunner('keychain_locked', 'locked'),
        }).delete('svc', 'acct'),
      'locked'
    )
  })

  test('an unreadable store never replaces an existing key', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-keychain-existing-'))
    try {
      const KEY = Buffer.alloc(32, 9)
      let broken = false
      const runner: SecurityCommandRunner = (args) => {
        if (args[0] === 'find-generic-password') {
          if (broken) throw new KeychainAccessError('keychain_locked', 'locked mid-flight')
          return Buffer.from(KEY.toString('base64'))
        }
        throw new KeychainAccessError('keychain_locked', 'writes are refused while locked')
      }
      const store = createSystemVaultKeyStore({ runSecurity: runner })
      expect(store.get('svc', 'acct')!.equals(KEY)).toBe(true)
      broken = true
      // The failing read throws instead of falling through to generation:
      // the keychain write is never attempted, so the existing key cannot
      // be overwritten or replaced by a fresh one.
      expectAuthRequired(() => store.get('svc', 'acct'), 'locked')
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
