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
  isUnavailableCredentialStoreError,
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

/** A legacy store that refuses the way the OS credential store refuses. */
function refusingTypedLegacyStore(): VaultKeyStore {
  const refuse = (): never => {
    throw new DevAuthorityError(
      'auth_required',
      'the OS credential store refused: the OS credential store did not answer in time'
    )
  }
  return { get: refuse, set: refuse, delete: refuse }
}

/** A legacy store that answers with one key. */
function legacyStoreWithKey(encoded: string): VaultKeyStore {
  return {
    get: () => Buffer.from(encoded, 'base64'),
    set: () => {},
    delete: () => {},
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

describe('a refusal that arrives after the store is resolved', () => {
  test("it is the boot's own failure, so the boot degrades instead of dying", async () => {
    // The legacy path resolves the store without reading the key: the key is
    // read later, while the Dev Runtime host composes. A refusal that arrives
    // then must be the same failure the boot already knows how to degrade on,
    // or the shell takes the application down with it.
    const resolved = await resolveBootCredentialStore({
      legacyStore: refusingTypedLegacyStore(),
      runtimeVersion: '1.3.0',
    })
    expect(resolved.degraded).toBe(false)
    expect(resolved.reason).toBeNull()
    let thrown: unknown
    try {
      resolved.store.get('com.adea.desktop.dev-runtime', 'master-key-v1')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(DevAuthorityError)
    expect((thrown as DevAuthorityError).message).toBe(UNAVAILABLE_CREDENTIAL_STORE_REASON)
    expect(isUnavailableCredentialStoreError(thrown)).toBe(true)
  })

  test('the fixed reason carries no store detail, and the refusal is kept as the cause', async () => {
    const resolved = await resolveBootCredentialStore({
      legacyStore: refusingTypedLegacyStore(),
      runtimeVersion: '1.3.0',
    })
    let thrown: unknown
    try {
      resolved.store.get('com.adea.desktop.dev-runtime', 'master-key-v1')
    } catch (error) {
      thrown = error
    }
    const message = (thrown as DevAuthorityError).message
    expect(message).not.toContain('did not answer in time')
    expect(message).not.toContain('master-key-v1')
    expect(message).not.toContain('com.adea')
    // The vault's own diagnosis is not lost: it is the failure's cause.
    expect((thrown as DevAuthorityError).cause).toBeInstanceOf(DevAuthorityError)
    expect(((thrown as DevAuthorityError).cause as DevAuthorityError).message).toContain(
      'did not answer in time'
    )
  })

  test('a store that answers still answers through the reported store', async () => {
    const key = Buffer.alloc(32, 7).toString('base64')
    const resolved = await resolveBootCredentialStore({
      legacyStore: legacyStoreWithKey(key),
      runtimeVersion: '1.3.0',
    })
    expect(resolved.degraded).toBe(false)
    expect(resolved.store.get('com.adea.desktop.dev-runtime', 'master-key-v1')).toBeInstanceOf(
      Buffer
    )
  })
})

describe('an integrity fault is not the store being unable to answer', () => {
  test("two key stores that disagree fail loudly, with the vault's own diagnosis", async () => {
    // The stores disagreeing is an integrity condition, not an absent store.
    // The boot must not relabel it as one: the operator has to see it.
    const bunKey = Buffer.alloc(32, 7).toString('base64')
    const legacyKey = Buffer.alloc(32, 9).toString('base64')
    let thrown: unknown
    try {
      await resolveBootCredentialStore({
        legacyStore: legacyStoreWithKey(legacyKey),
        secrets: workingSecrets(bunKey),
        runtimeVersion: '1.4.3',
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(DevAuthorityError)
    expect((thrown as DevAuthorityError).code).toBe('corrupt_state')
    expect((thrown as DevAuthorityError).message).toBe('vault key stores disagree')
    // It is not the boot's own unavailability, so the boot does not degrade on
    // it and the shell keeps failing loudly.
    expect(isUnavailableCredentialStoreError(thrown)).toBe(false)
  })
})
