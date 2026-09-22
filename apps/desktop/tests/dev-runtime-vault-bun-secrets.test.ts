// M10 #33: the application-level Bun.secrets migration keeps the existing
// `/usr/bin/security` key usable and refuses ambiguous native-store results.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DevAuthorityError } from '../shell/src/dev-runtime/authority'
import {
  createBunSecretsVaultKeyStore,
  createCredentialVault,
  type BunSecretsApi,
  type VaultKeyStore,
} from '../shell/src/dev-runtime/vault'

const SERVICE = 'com.adea.desktop.dev-runtime'
const ACCOUNT = 'master-key-v1'

function legacyStore(initial?: Buffer): VaultKeyStore & {
  deleted: () => boolean
  value: () => Buffer | undefined
} {
  let value = initial ? Buffer.from(initial) : undefined
  let didDelete = false
  return {
    get: () => (value ? Buffer.from(value) : undefined),
    set: (_service, _account, key) => {
      value = Buffer.from(key)
    },
    delete: () => {
      didDelete = true
      value = undefined
    },
    deleted: () => didDelete,
    value: () => (value ? Buffer.from(value) : undefined),
  }
}

function nativeStore(initial: string | null = null): BunSecretsApi & { writes: string[] } {
  let value = initial
  const writes: string[] = []
  return {
    writes,
    get: async () => value,
    set: async ({ value: next }) => {
      writes.push(next)
      value = next
    },
  }
}

function expectAuthorityError(run: () => Promise<unknown>, code: DevAuthorityError['code']) {
  return expect(run()).rejects.toMatchObject({ code })
}

describe('Bun.secrets vault key-store migration', () => {
  test('migrates the legacy key, verifies the write, and retains the legacy slot', async () => {
    const legacyKey = Buffer.alloc(32, 0x2a)
    const legacy = legacyStore(legacyKey)
    const native = nativeStore()

    const migrated = await createBunSecretsVaultKeyStore({
      legacyStore: legacy,
      secrets: native,
      runtimeVersion: '1.4.0',
    })

    expect(migrated.get(SERVICE, ACCOUNT)?.equals(legacyKey)).toBe(true)
    expect(native.writes).toEqual([legacyKey.toString('base64')])
    expect(legacy.deleted()).toBe(false)
    expect(legacy.value()?.equals(legacyKey)).toBe(true)
  })

  test('uses an already migrated Bun key without fabricating or replacing it', async () => {
    const nativeKey = Buffer.alloc(32, 0x3b)
    const legacy = legacyStore()
    const native = nativeStore(nativeKey.toString('base64'))

    const migrated = await createBunSecretsVaultKeyStore({
      legacyStore: legacy,
      secrets: native,
      runtimeVersion: '1.4.2',
    })

    expect(migrated.get(SERVICE, ACCOUNT)?.equals(nativeKey)).toBe(true)
    expect(native.writes).toHaveLength(0)
    expect(legacy.deleted()).toBe(false)
    expect(legacy.value()?.equals(nativeKey)).toBe(true)
  })

  test('fresh Bun installs preserve sealed-vault access after a runtime downgrade', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-bun-secrets-downgrade-'))
    try {
      const legacy = legacyStore()
      const native = nativeStore()
      const migrated = await createBunSecretsVaultKeyStore({
        legacyStore: legacy,
        secrets: native,
        runtimeVersion: '1.4.0',
      })
      const approvalVerifier = { recordIssuance: () => undefined, consume: () => undefined }
      const scope = {
        accountId: '00000000-0000-4000-8000-000000000001',
        workspaceId: '00000000-0000-4000-8000-000000000002',
        runtimeNodeId: '00000000-0000-4000-8000-000000000003',
      } as const
      const currentVault = createCredentialVault({
        dataDir,
        approvalVerifier,
        credentialStore: migrated,
      })
      const record = currentVault.enroll({
        scope,
        label: 'downgrade test',
        host: 'github.com',
        kind: 'github_token',
        secret: 'downgrade-canary',
        approval: { method: 'owner_dialog', reference: 'downgrade-approval' },
      })

      // An older runtime uses only the legacy security-backed slot.
      const downgradedVault = createCredentialVault({
        dataDir,
        approvalVerifier,
        credentialStore: legacy,
      })
      expect(
        downgradedVault
          .resolve({
            scope,
            credentialRefId: record.id,
            audience: 'runtime_driver',
          })
          .reveal()
      ).toBe('downgrade-canary')
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('refuses a Bun and legacy key mismatch before the vault can open', async () => {
    const legacy = legacyStore(Buffer.alloc(32, 0x11))
    const native = nativeStore(Buffer.alloc(32, 0x22).toString('base64'))

    await expectAuthorityError(
      () =>
        createBunSecretsVaultKeyStore({
          legacyStore: legacy,
          secrets: native,
          runtimeVersion: '1.4.0',
        }),
      'corrupt_state'
    )
    expect(native.writes).toHaveLength(0)
    expect(legacy.deleted()).toBe(false)
  })

  for (const reason of ['locked', 'denied', 'unavailable'] as const) {
    test(`fails closed when Bun.secrets is ${reason}`, async () => {
      const legacyKey = Buffer.alloc(32, 0x4c)
      const legacy = legacyStore(legacyKey)
      let writes = 0
      const native: BunSecretsApi = {
        get: async () => {
          throw new Error(`credential store ${reason}`)
        },
        set: async () => {
          writes += 1
        },
      }

      await expectAuthorityError(
        () =>
          createBunSecretsVaultKeyStore({
            legacyStore: legacy,
            secrets: native,
            runtimeVersion: '1.4.0',
          }),
        'auth_required'
      )
      expect(writes).toBe(0)
      expect(legacy.value()?.equals(legacyKey)).toBe(true)
      expect(legacy.deleted()).toBe(false)
    })
  }

  test('keeps the legacy key when Bun write is denied', async () => {
    const legacyKey = Buffer.alloc(32, 0x5d)
    const legacy = legacyStore(legacyKey)
    const native: BunSecretsApi = {
      get: async () => null,
      set: async () => {
        throw new Error('keychain locked')
      },
    }

    await expectAuthorityError(
      () =>
        createBunSecretsVaultKeyStore({
          legacyStore: legacy,
          secrets: native,
          runtimeVersion: '1.4.0',
        }),
      'auth_required'
    )
    expect(legacy.value()?.equals(legacyKey)).toBe(true)
    expect(legacy.deleted()).toBe(false)
  })

  test('refuses a fresh install when the legacy compatibility seed cannot be retained', async () => {
    const legacy: VaultKeyStore = {
      get: () => undefined,
      set: () => {
        throw new DevAuthorityError('auth_required', 'legacy store unavailable')
      },
      delete: () => undefined,
    }
    const native = nativeStore()

    await expectAuthorityError(
      () =>
        createBunSecretsVaultKeyStore({
          legacyStore: legacy,
          secrets: native,
          runtimeVersion: '1.4.0',
        }),
      'auth_required'
    )
    expect(native.writes).toHaveLength(0)
  })

  test('falls back to the legacy adapter when the packaged Bun runtime is below the floor', async () => {
    const legacy = legacyStore(Buffer.alloc(32, 0x6e))
    let called = false
    const native: BunSecretsApi = {
      get: async () => {
        called = true
        return null
      },
      set: async () => {
        called = true
      },
    }

    const selected = await createBunSecretsVaultKeyStore({
      legacyStore: legacy,
      secrets: native,
      runtimeVersion: '1.3.99',
    })

    expect(selected).toBe(legacy)
    expect(called).toBe(false)
  })

  test('refuses a successful write whose read-back does not match', async () => {
    const legacy = legacyStore()
    const native: BunSecretsApi = {
      get: async () => null,
      set: async () => undefined,
    }

    await expectAuthorityError(
      () =>
        createBunSecretsVaultKeyStore({
          legacyStore: legacy,
          secrets: native,
          runtimeVersion: '1.4.0',
        }),
      'auth_required'
    )
    expect(legacy.deleted()).toBe(false)
  })
})
