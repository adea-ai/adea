// M10 #33 packaged application-level vault evidence.
//
// This entrypoint is bundled with Bun and then executed by the Bun runtime
// from an Electrobun app bundle. It imports the production Bun.secrets adapter
// and opens the production credential vault against disposable Keychain slots.
// The probe emits only redacted booleans and error codes; synthetic key and
// credential material never appears in output.
import { randomBytes, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createOwnerApprovalVerifier, type OwnerApproval } from '../src/dev-runtime/authority'
import {
  createBunSecretsVaultKeyStore,
  createCredentialVault,
  type BunSecretsApi,
  type VaultKeyStore,
} from '../src/dev-runtime/vault'

const LEGACY_ACCOUNT = 'master-key-v1'
const LEGACY_SERVICE = 'com.adea.desktop.dev-runtime'
const SECURITY_TIMEOUT_MS = 10_000
const NATIVE_TIMEOUT_MS = 5_000

const scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
} as const

type SecurityKeyStore = VaultKeyStore & { readonly service: string }

function securityStore(service: string): SecurityKeyStore {
  const run = (args: string[], input?: Buffer) => {
    const result = spawnSync('/usr/bin/security', args, {
      encoding: 'buffer',
      input,
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: SECURITY_TIMEOUT_MS,
      maxBuffer: 128 * 1024,
    })
    if (result.error || result.signal) throw new Error('security command failed')
    return result
  }

  return {
    service,
    get: () => {
      const result = run(['find-generic-password', '-s', service, '-a', LEGACY_ACCOUNT, '-w'])
      if (result.status === 44) return undefined
      if (result.status !== 0) throw new Error('security read refused')
      const value = Buffer.from(result.stdout).toString('utf8').trim()
      if (!value) throw new Error('security read was empty')
      return Buffer.from(value, 'base64')
    },
    set: (_ignoredService, _ignoredAccount, key) => {
      const result = run([
        'add-generic-password',
        '-U',
        '-s',
        service,
        '-a',
        LEGACY_ACCOUNT,
        '-w',
        key.toString('base64'),
      ])
      if (result.status !== 0) throw new Error('security write refused')
    },
    delete: () => {
      const result = run(['delete-generic-password', '-s', service, '-a', LEGACY_ACCOUNT])
      if (result.status !== 0 && result.status !== 44) throw new Error('security delete refused')
    },
  }
}

function nativeSecrets(service: string): BunSecretsApi {
  const native = Bun.secrets
  if (!native || typeof native.get !== 'function' || typeof native.set !== 'function') {
    throw new Error('Bun.secrets unavailable')
  }
  if (typeof native.delete !== 'function') throw new Error('Bun.secrets delete unavailable')
  // Keep the Bun slot separate from the legacy `/usr/bin/security` generic
  // password slot. Bun's native implementation owns its own Keychain item
  // class, while this suffix makes the disposable probe's cleanup explicit.
  const nativeService = `${service}.bun`
  const bounded = <T>(operation: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    return Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('native credential operation timed out')),
          NATIVE_TIMEOUT_MS
        )
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer)
    })
  }
  return {
    get: () => bounded(native.get({ service: nativeService, name: LEGACY_ACCOUNT })),
    set: ({ value }) =>
      bounded(native.set({ service: nativeService, name: LEGACY_ACCOUNT, value })),
    delete: () => bounded(native.delete!({ service: nativeService, name: LEGACY_ACCOUNT })),
  }
}

function approval(
  verifier: ReturnType<typeof createOwnerApprovalVerifier>,
  action: string
): OwnerApproval {
  const evidence: OwnerApproval = {
    method: 'owner_dialog',
    reference: `packaged-vault-${randomUUID()}`,
    scope,
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }
  verifier.recordIssuance(evidence, scope, action)
  return evidence
}

function errorCode(error: unknown): string {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
  ) {
    return (error as { code: string }).code
  }
  return 'unknown'
}

async function upgradeDowngrade(service: string) {
  const legacy = securityStore(service)
  const native = nativeSecrets(service)
  const legacyKey = randomBytes(32)
  const dataDir = mkdtempSync(join(tmpdir(), 'adea-m10-33-vault-data-'))
  const syntheticSecret = `synthetic-${randomUUID()}`
  try {
    // Seed the legacy slot exactly as the pre-upgrade application did.
    legacy.set(LEGACY_SERVICE, LEGACY_ACCOUNT, legacyKey)
    const migrated = await createBunSecretsVaultKeyStore({
      legacyStore: legacy,
      secrets: native,
      runtimeVersion: Bun.version,
    })
    const migratedKey = migrated.get(LEGACY_SERVICE, LEGACY_ACCOUNT)
    const retainedLegacyKey = legacy.get(LEGACY_SERVICE, LEGACY_ACCOUNT)
    const verifier = createOwnerApprovalVerifier({ dataDir })
    const currentVault = createCredentialVault({
      dataDir,
      approvalVerifier: verifier,
      credentialStore: migrated,
    })
    const record = currentVault.enroll({
      scope,
      label: 'packaged synthetic vault',
      host: 'github.com',
      kind: 'github_token',
      secret: syntheticSecret,
      approval: approval(verifier, 'enroll a credential'),
    })
    const upgradedValue = currentVault
      .resolve({ scope, credentialRefId: record.id, audience: 'runtime_driver' })
      .reveal()

    // A runtime below the Bun.secrets floor uses only the retained legacy slot.
    const downgradedVault = createCredentialVault({
      dataDir,
      approvalVerifier: verifier,
      credentialStore: legacy,
    })
    const downgradedValue = downgradedVault
      .resolve({ scope, credentialRefId: record.id, audience: 'runtime_driver' })
      .reveal()

    return {
      bunVersion: Bun.version,
      bunSecretsSupported: typeof Bun.secrets?.get === 'function',
      legacyKeyRetained: retainedLegacyKey?.equals(legacyKey) === true,
      migratedKeyMatches: migratedKey?.equals(legacyKey) === true,
      upgradedVaultOpened: upgradedValue === syntheticSecret,
      downgradedVaultOpened: downgradedValue === syntheticSecret,
    }
  } finally {
    try {
      await native.delete?.({ service, name: LEGACY_ACCOUNT })
    } finally {
      try {
        legacy.delete(LEGACY_SERVICE, LEGACY_ACCOUNT)
      } finally {
        rmSync(dataDir, { recursive: true, force: true })
      }
    }
  }
}

async function refusesNativeFailure(service: string, reason: 'denied' | 'locked') {
  const legacy = securityStore(service)
  const legacyKey = randomBytes(32)
  legacy.set(LEGACY_SERVICE, LEGACY_ACCOUNT, legacyKey)
  let writes = 0
  const native: BunSecretsApi = {
    get: async () => {
      throw new Error(`synthetic ${reason}`)
    },
    set: async () => {
      writes += 1
    },
  }
  try {
    await createBunSecretsVaultKeyStore({
      legacyStore: legacy,
      secrets: native,
      runtimeVersion: Bun.version,
    })
    return { code: 'accepted', writes }
  } catch (error) {
    return { code: errorCode(error), writes }
  } finally {
    legacy.delete(LEGACY_SERVICE, LEGACY_ACCOUNT)
  }
}

async function refusesMismatch(service: string) {
  const legacy = securityStore(service)
  const legacyKey = randomBytes(32)
  legacy.set(LEGACY_SERVICE, LEGACY_ACCOUNT, legacyKey)
  const native: BunSecretsApi = {
    get: async () => Buffer.alloc(32, 0x5a).toString('base64'),
    set: async () => undefined,
  }
  try {
    await createBunSecretsVaultKeyStore({
      legacyStore: legacy,
      secrets: native,
      runtimeVersion: Bun.version,
    })
    return { code: 'accepted' }
  } catch (error) {
    return { code: errorCode(error) }
  } finally {
    legacy.delete(LEGACY_SERVICE, LEGACY_ACCOUNT)
  }
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('packaged vault evidence requires macOS')
  const base = process.env.ADEA_M10_VAULT_SERVICE_ID
  if (!base) throw new Error('missing packaged vault service id')
  const journey = await upgradeDowngrade(`${base}.journey`)
  const denied = await refusesNativeFailure(`${base}.denied`, 'denied')
  const locked = await refusesNativeFailure(`${base}.locked`, 'locked')
  const mismatch = await refusesMismatch(`${base}.mismatch`)
  console.log(
    JSON.stringify({
      bunVersion: Bun.version,
      adapter: 'apps/desktop/shell/src/dev-runtime/vault.ts',
      journey,
      refused: { denied, locked, mismatch },
      cleanup: 'child-finally',
    })
  )
}

main().catch(() => {
  // Keep native diagnostics and any accidental secret material out of the
  // evidence stream. The parent reports only a bounded process failure.
  process.exitCode = 1
})
