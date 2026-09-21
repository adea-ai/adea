// Key-role-confusion substitutability test (M10 #33): a vault key minted for
// one role cannot validate data under another. Three substitutability
// attacks are proven inert, all fail-closed with `corrupt_state` and no
// plaintext:
//   1. key substitution — the desktop content family's device key (the
//      #184 `device.key` AES class) cannot play the credential-vault master
//      key role, and a second vault's master key cannot play the first's;
//   2. ciphertext transplant — sealed material is AAD-bound to its reference
//      id, so one credential's sealed bytes cannot validate under another;
//   3. keychain slot substitution — the production `security` adapter reads
//      exactly the vault's own (service, account) slot and never a foreign
//      credential class's slot, and refuses foreign-sized keys.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createOwnerApprovalVerifier,
  DevAuthorityError,
  type OwnerApproval,
  type OwnerApprovalVerifier,
} from '../shell/src/dev-runtime/authority'
import { createCredentialVault, type VaultKeyStore } from '../shell/src/dev-runtime/vault'

const scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
} as const
const SECRET = 'vault-role-canary-阅读'

const ENROLL_ACTION = 'enroll a credential'
let verifier: OwnerApprovalVerifier
let consentSequence = 0

function approved(action: string = ENROLL_ACTION): OwnerApproval {
  const approval: OwnerApproval = {
    method: 'owner_dialog',
    reference: `consent-${++consentSequence}`,
    scope,
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }
  verifier.recordIssuance(approval, scope, action)
  return approval
}

/** An in-memory stand-in for one OS keychain (one role's key slot). */
function memoryKeyStore(): VaultKeyStore & { peek: (account: string) => Buffer | undefined } {
  const keys = new Map<string, Buffer>()
  return {
    get: (_service, account) => {
      const key = keys.get(account)
      return key ? Buffer.from(key) : undefined
    },
    set: (_service, account, key) => keys.set(account, Buffer.from(key)),
    delete: (_service, account) => keys.delete(account),
    peek: (account) => {
      const key = keys.get(account)
      return key ? Buffer.from(key) : undefined
    },
  }
}

function vault(dataDir: string, credentialStore: VaultKeyStore) {
  verifier = createOwnerApprovalVerifier({ dataDir })
  return createCredentialVault({ dataDir, credentialStore, approvalVerifier: verifier })
}

function expectCode(run: () => unknown, code: DevAuthorityError['code']) {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(DevAuthorityError)
    expect((error as DevAuthorityError).code).toBe(code)
    return
  }
  throw new Error(`expected DevAuthorityError ${code}`)
}

function enrollGithubToken(instance: ReturnType<typeof createCredentialVault>, label: string) {
  return instance.enroll({
    scope,
    label,
    host: 'github.com',
    kind: 'github_token',
    secret: SECRET,
    approval: approved(),
  })
}

describe('credential vault key roles', () => {
  test('a foreign key class (the desktop device key) cannot validate vault material', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-vault-roles-'))
    try {
      const vaultKeystore = memoryKeyStore()
      const instance = vault(dataDir, vaultKeystore)
      const ref = enrollGithubToken(instance, 'GitHub token')
      const sealedPath = join(dataDir, 'dev-runtime', 'vault', `${ref.id}.sealed`)
      const sealedBytes = readFileSync(sealedPath, 'utf8')
      expect(sealedBytes).not.toContain('canary')

      // The #184 desktop content family holds its own AES key class on disk
      // (`desktop-state/device.key`), distinct from the Keychain-held vault
      // master key. Mint one and put it in the vault key role.
      const deviceKeyClass = Buffer.alloc(32, 0x2c) // stand-in for device.key bytes

      // A vault constructed against a keystore whose vault slot holds the
      // foreign key class sees only unauthenticated ciphertext.
      const foreignRole = vault(dataDir, {
        get: () => Buffer.from(deviceKeyClass),
        set: () => {},
        delete: () => {},
      })
      let leaked = false
      try {
        const resolved = foreignRole.resolve({
          scope,
          credentialRefId: ref.id,
          audience: 'runtime_driver',
        })
        leaked = resolved.reveal() === SECRET
      } catch (error) {
        expect(error).toBeInstanceOf(DevAuthorityError)
        expect((error as DevAuthorityError).code).toBe('corrupt_state')
      }
      expect(leaked).toBe(false)
      // The failed validation is recorded, never silently retried.
      expect(foreignRole.get({ scope, credentialRefId: ref.id }).state).toBe('unknown')
      expect(readFileSync(sealedPath, 'utf8')).toBe(sealedBytes)
      expect(readFileSync(sealedPath, 'utf8')).not.toContain('canary')
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('a second vault instance’s master key cannot decrypt the first vault’s material', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-vault-roles-'))
    try {
      const keysA = memoryKeyStore()
      const keysB = memoryKeyStore()
      const instanceA = vault(dataDir, keysA)
      const ref = enrollGithubToken(instanceA, 'GitHub token')

      // Control: the same key store (same vault master key) re-opens the
      // sealed material, proving the failure below is the key, not the record.
      const reopened = vault(dataDir, keysA)
      expect(
        reopened.resolve({ scope, credentialRefId: ref.id, audience: 'runtime_driver' }).reveal()
      ).toBe(SECRET)

      // A different vault master key (keysB) fails closed on A's material.
      const instanceB = vault(dataDir, keysB)
      expectCode(
        () => instanceB.resolve({ scope, credentialRefId: ref.id, audience: 'runtime_driver' }),
        'corrupt_state'
      )
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('sealed bytes are bound to their reference id: transplanted ciphertext fails under the target id', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-vault-roles-'))
    try {
      const keys = memoryKeyStore()
      const instance = vault(dataDir, keys)
      const refA = enrollGithubToken(instance, 'GitHub token')
      const refB = enrollGithubToken(instance, 'Deploy key')
      expect(refA.id).not.toBe(refB.id)
      const vaultDir = join(dataDir, 'dev-runtime', 'vault')
      const sealedA = readFileSync(join(vaultDir, `${refA.id}.sealed`), 'utf8')
      const sealedB = readFileSync(join(vaultDir, `${refB.id}.sealed`), 'utf8')

      // Swap the sealed files: each record now presents the other's
      // ciphertext under its own id. The AAD binding refuses both.
      const { writeFileSync } = require('node:fs') as typeof import('node:fs')
      writeFileSync(join(vaultDir, `${refA.id}.sealed`), sealedB, { mode: 0o600 })
      writeFileSync(join(vaultDir, `${refB.id}.sealed`), sealedA, { mode: 0o600 })
      for (const ref of [refA, refB]) {
        expectCode(
          () => instance.resolve({ scope, credentialRefId: ref.id, audience: 'runtime_driver' }),
          'corrupt_state'
        )
        expect(instance.get({ scope, credentialRefId: ref.id }).state).toBe('unknown')
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('the production keychain adapter reads exactly the vault slot and refuses foreign-sized keys', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-vault-roles-'))
    try {
      const invocations: string[][] = []
      const slot = new Map<string, string>()
      // Injected `security` runner: records the exact argv and serves the
      // vault slot. No real keychain is touched.
      const store = (() => {
        // Import is inline to keep the construction next to its evidence.
        const { createSystemVaultKeyStore } =
          require('../shell/src/dev-runtime/vault') as typeof import('../shell/src/dev-runtime/vault')
        return createSystemVaultKeyStore({
          runSecurity: (args, input) => {
            invocations.push(args)
            const subcommand = args[0]
            if (subcommand === 'find-generic-password') {
              const account = args[args.indexOf('-a') + 1]
              const value = slot.get(account)
              if (value === undefined) {
                const { KeychainAccessError } =
                  require('../shell/src/dev-runtime/vault') as typeof import('../shell/src/dev-runtime/vault')
                throw new KeychainAccessError('item_not_found', 'keychain item not found', 44)
              }
              return Buffer.from(value, 'utf8')
            }
            if (subcommand === 'add-generic-password') {
              const account = args[args.indexOf('-a') + 1]
              const value = args[args.indexOf('-w') + 1]
              if (typeof value !== 'string') throw new Error('missing -w value')
              slot.set(account, value)
              return Buffer.alloc(0)
            }
            if (input) return Buffer.alloc(0)
            return Buffer.alloc(0)
          },
        })
      })()

      // First load mints and stores a 32-byte key in exactly one slot.
      const dataDirForSlot = join(dataDir, 'slot')
      verifier = createOwnerApprovalVerifier({ dataDir: dataDirForSlot })
      const instance = createCredentialVault({
        dataDir: dataDirForSlot,
        credentialStore: store,
        approvalVerifier: verifier,
      })
      enrollGithubToken(instance, 'GitHub token')
      const slots = [...slot.keys()]
      expect(slots).toEqual(['master-key-v1'])
      const stored = Buffer.from(slot.get('master-key-v1') ?? '', 'base64')
      expect(stored.byteLength).toBe(32)
      // Every read went to the vault's own service+account, never to a
      // foreign credential class's slot (no device.key, no content key, no
      // runtime-node or sync key service appears).
      for (const args of invocations) {
        if (args[0] === 'find-generic-password') {
          expect(args[args.indexOf('-s') + 1]).toBe('com.adea.desktop.dev-runtime')
          expect(args[args.indexOf('-a') + 1]).toBe('master-key-v1')
        }
      }

      // A key of the wrong size can never occupy the vault role: the store
      // refuses it at write time, and a malformed stored item fails load.
      expectCode(() => store.set('svc', 'master-key-v1', Buffer.alloc(16)), 'corrupt_state')
      slot.set('master-key-v1', Buffer.alloc(16, 7).toString('base64'))
      expectCode(
        () =>
          createCredentialVault({
            dataDir: dataDirForSlot,
            credentialStore: store,
            approvalVerifier: verifier,
          }),
        'corrupt_state'
      )
      expect(existsSync(join(dataDirForSlot, 'dev-runtime', 'vault'))).toBe(true)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
