// The boot-time credential store's decision.
//
// Nothing here reaches a credential store: the decision takes its legacy store
// and its Bun secrets port from injected dependencies, and every case here
// injects fakes. No macOS `security` CLI, no Keychain API, no real account,
// no credential and no application is involved.
//
// The decision under test is the shell's boot contract: an OS credential store
// that cannot answer must not take the application down, and the fallback
// must fail CLOSED — it may never answer "absent" for a key it could not read,
// because an absent answer lets the vault generate a replacement key and
// strand the sealed content behind the real one.
import { describe, expect, test } from 'bun:test'

import { DevAuthorityError } from '../shell/src/dev-runtime/authority'
import {
  createUnavailableVaultKeyStore,
  resolveBootCredentialStore,
  UNAVAILABLE_CREDENTIAL_STORE_REASON,
} from '../shell/src/bun/boot-credential-store'
import type { BunSecretsApi, VaultKeyStore } from '../shell/src/dev-runtime/vault'

/** A legacy store that retains what it is given. */
function emptyLegacyStore(): VaultKeyStore {
  const keys = new Map<string, Buffer>()
  return {
    get: (service, account) => keys.get(`${service}\u0000${account}`),
    set: (service, account, key) => void keys.set(`${service}\u0000${account}`, key),
    delete: (service, account) => void keys.delete(`${service}\u0000${account}`),
  }
}

/** A legacy store whose write always refuses, the way a refused store does. */
function refusingLegacyStore(): VaultKeyStore {
  return {
    get: () => undefined,
    set: () => {
      throw new Error('the OS credential store did not answer in time')
    },
    delete: () => {},
  }
}

/** A Bun secrets port that answers with a key. */
function workingSecrets(key: string): BunSecretsApi {
  return {
    get: async () => key,
    set: async () => {},
  }
}

describe('the unavailable credential store fails closed', () => {
  test('a read throws instead of answering that the key is absent', () => {
    const store = createUnavailableVaultKeyStore()
    expect(() => store.get('com.adea.desktop.dev-runtime', 'master-key-v1')).toThrow(
      DevAuthorityError
    )
  })

  test('a write throws, so no replacement key can be planted', () => {
    const store = createUnavailableVaultKeyStore()
    expect(() =>
      store.set('com.adea.desktop.dev-runtime', 'master-key-v1', Buffer.alloc(32))
    ).toThrow(DevAuthorityError)
  })

  test('a delete throws, so a failed read cannot be followed by a wipe', () => {
    const store = createUnavailableVaultKeyStore()
    expect(() => store.delete('com.adea.desktop.dev-runtime', 'master-key-v1')).toThrow(
      DevAuthorityError
    )
  })

  test('the failure is typed auth_required, not an unclassified error', () => {
    const store = createUnavailableVaultKeyStore()
    try {
      store.get('com.adea.desktop.dev-runtime', 'master-key-v1')
      throw new Error('the read was expected to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(DevAuthorityError)
      expect((error as DevAuthorityError).code).toBe('auth_required')
    }
  })
})

describe('the boot credential store decision', () => {
  test('a store that answers is used and the boot is not degraded', async () => {
    const key = Buffer.alloc(32, 7).toString('base64')
    const resolved = await resolveBootCredentialStore({
      legacyStore: emptyLegacyStore(),
      secrets: workingSecrets(key),
      runtimeVersion: '1.4.3',
    })
    expect(resolved.degraded).toBe(false)
    expect(resolved.reason).toBeNull()
    expect(resolved.store.get('com.adea.desktop.dev-runtime', 'master-key-v1')).toBeInstanceOf(
      Buffer
    )
  })

  test('a store that refuses leaves the boot degraded and the store failing closed', async () => {
    const resolved = await resolveBootCredentialStore({
      legacyStore: refusingLegacyStore(),
      secrets: {
        get: async () => null,
        set: async () => {},
      },
      runtimeVersion: '1.4.3',
    })
    expect(resolved.degraded).toBe(true)
    expect(resolved.reason).toBe(UNAVAILABLE_CREDENTIAL_STORE_REASON)
    expect(() => resolved.store.get('com.adea.desktop.dev-runtime', 'master-key-v1')).toThrow(
      DevAuthorityError
    )
  })

  test('the reported reason is fixed and carries no store detail', async () => {
    const resolved = await resolveBootCredentialStore({
      legacyStore: refusingLegacyStore(),
      secrets: {
        get: async () => null,
        set: async () => {},
      },
      runtimeVersion: '1.4.3',
    })
    expect(resolved.reason).toBe(UNAVAILABLE_CREDENTIAL_STORE_REASON)
    expect(resolved.reason).not.toContain('master-key-v1')
    expect(resolved.reason).not.toContain('com.adea')
    expect(resolved.reason).not.toContain('/')
  })
})
