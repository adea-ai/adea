// M10 #34 substrate: the credential vault. Secrets live only behind sealed
// storage and are handed to authorized runtime drivers; every other surface
// (list, replies, audit, errors) sees CredentialRef records without secret
// material, and accidental serialization of a resolved secret fails loudly.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DevAuthorityError } from '../shell/src/dev-runtime/authority'
import { createAuthorityAudit } from '../shell/src/dev-runtime/audit'
import { createCredentialVault, type VaultKeyStore } from '../shell/src/dev-runtime/vault'

const scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
} as const
const otherScope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000099',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
} as const
const approval = { method: 'owner_dialog', reference: 'consent-2' } as const
const SECRET = 'canary-secret-value-阅读'

function vault(dataDir: string, audit?: ReturnType<typeof createAuthorityAudit>) {
  const keys = new Map<string, Buffer>()
  const credentialStore: VaultKeyStore = {
    get: (_service, account) => keys.get(account),
    set: (_service, account, key) => keys.set(account, Buffer.from(key)),
    delete: (_service, account) => keys.delete(account),
  }
  return createCredentialVault({ dataDir, audit, credentialStore })
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

function enroll(vaultInstance: ReturnType<typeof createCredentialVault>, label = 'GitHub token') {
  return vaultInstance.enroll({
    scope,
    label,
    host: 'github.com',
    kind: 'github_token',
    secret: SECRET,
    approval,
  })
}

describe('credential vault', () => {
  test('enrolls only with owner approval evidence', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-vault-'))
    try {
      const instance = vault(dataDir)
      expectCode(
        () =>
          instance.enroll({
            scope,
            label: 'GitHub token',
            host: 'github.com',
            kind: 'github_token',
            secret: SECRET,
          }),
        'unauthorized'
      )
      const ref = enroll(instance)
      expect(ref.state).toBe('ready')
      expect(ref.version).toBe(1)
      expect(Object.keys(ref)).not.toContain('secret')
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('returns references without secret material from every listing surface', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-vault-'))
    try {
      const instance = vault(dataDir)
      const ref = enroll(instance)
      const listed = instance.list({ scope }).items
      expect(listed).toHaveLength(1)
      expect(JSON.stringify(listed)).not.toContain(SECRET)
      const described = instance.get({ scope, credentialRefId: ref.id })
      expect(described.label).toBe('GitHub token')
      expect(JSON.stringify(described)).not.toContain(SECRET)
      expect(
        readFileSync(join(dataDir, 'dev-runtime', 'vault', 'credentials.json'), 'utf8')
      ).not.toContain(SECRET)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('is idempotent per scope, host, and label and validates inputs', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-vault-'))
    try {
      const instance = vault(dataDir)
      const first = enroll(instance)
      const second = enroll(instance)
      expect(second.id).toBe(first.id)
      expectCode(
        () =>
          instance.enroll({
            scope,
            label: 'x'.repeat(129),
            host: 'github.com',
            kind: 'other',
            secret: 's',
            approval,
          }),
        'invalid_state'
      )
      expectCode(
        () =>
          instance.enroll({
            scope,
            label: 'Bad host',
            host: 'not a host',
            kind: 'other',
            secret: 's',
            approval,
          }),
        'invalid_state'
      )
      expectCode(
        () =>
          instance.enroll({
            scope,
            label: 'Empty',
            host: 'github.com',
            kind: 'other',
            secret: '',
            approval,
          }),
        'invalid_state'
      )
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('hands secrets only to the runtime-driver audience and refuses serialization', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-vault-'))
    try {
      const instance = vault(dataDir)
      const ref = enroll(instance)
      expectCode(
        () => instance.resolve({ scope, credentialRefId: ref.id, audience: 'web_client' }),
        'unauthorized'
      )
      const sealedPath = join(dataDir, 'dev-runtime', 'vault', `${ref.id}.sealed`)
      expect(existsSync(sealedPath)).toBe(true)
      const resolved = instance.resolve({
        scope,
        credentialRefId: ref.id,
        audience: 'runtime_driver',
      })
      expect(resolved.reveal()).toBe(SECRET)
      expect(() => JSON.stringify({ value: resolved })).toThrow()
      expect(() => String(resolved)).toThrow()
      expect(readFileSync(sealedPath, 'utf8')).not.toContain(SECRET)
      expect(readFileSync(sealedPath, 'utf8')).not.toContain('canary')
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('rotates with version checks and replaces the sealed material', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-vault-'))
    try {
      const instance = vault(dataDir)
      const ref = enroll(instance)
      const next = 'rotated-secret-value'
      expectCode(
        () =>
          instance.rotate({ scope, credentialRefId: ref.id, secret: next, expectedVersion: 99 }),
        'stale_version'
      )
      const rotated = instance.rotate({
        scope,
        credentialRefId: ref.id,
        secret: next,
        expectedVersion: ref.version,
      })
      expect(rotated.version).toBe(2)
      const resolved = instance.resolve({
        scope,
        credentialRefId: ref.id,
        audience: 'runtime_driver',
      })
      expect(resolved.reveal()).toBe(next)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('revocation is terminal, idempotent, and destroys the sealed material', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-vault-'))
    try {
      const instance = vault(dataDir)
      const ref = enroll(instance)
      expectCode(
        () => instance.revoke({ scope, credentialRefId: ref.id, expectedVersion: 99 }),
        'stale_version'
      )
      const revoked = instance.revoke({
        scope,
        credentialRefId: ref.id,
        expectedVersion: ref.version,
      })
      expect(revoked.state).toBe('revoked')
      expect(existsSync(join(dataDir, 'dev-runtime', 'vault', `${ref.id}.sealed`))).toBe(false)
      expectCode(
        () => instance.resolve({ scope, credentialRefId: ref.id, audience: 'runtime_driver' }),
        'unauthorized'
      )
      const repeated = instance.revoke({
        scope,
        credentialRefId: ref.id,
        expectedVersion: revoked.version,
      })
      expect(repeated.version).toBe(revoked.version)
      expectCode(
        () =>
          instance.rotate({
            scope,
            credentialRefId: ref.id,
            secret: 'x',
            expectedVersion: revoked.version,
          }),
        'invalid_state'
      )
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('fails closed on corrupt sealed material without leaking it', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-vault-'))
    try {
      const instance = vault(dataDir)
      const ref = enroll(instance)
      const sealedPath = join(dataDir, 'dev-runtime', 'vault', `${ref.id}.sealed`)
      writeFileSync(sealedPath, 'tampered-ciphertext', { mode: 0o600 })
      expectCode(
        () => instance.resolve({ scope, credentialRefId: ref.id, audience: 'runtime_driver' }),
        'corrupt_state'
      )
      expect(instance.get({ scope, credentialRefId: ref.id }).state).toBe('unknown')
      // Re-enrollment of the same identity repairs the record and reseals.
      const repaired = instance.enroll({
        scope,
        label: 'GitHub token',
        host: 'github.com',
        kind: 'github_token',
        secret: 'fresh-secret',
        approval,
      })
      expect(repaired.id).toBe(ref.id)
      expect(repaired.state).toBe('ready')
      expect(
        instance.resolve({ scope, credentialRefId: ref.id, audience: 'runtime_driver' }).reveal()
      ).toBe('fresh-secret')
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('reads cross-scope access as not found', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-vault-'))
    try {
      const instance = vault(dataDir)
      const ref = enroll(instance)
      expectCode(() => instance.get({ scope: otherScope, credentialRefId: ref.id }), 'not_found')
      expect(instance.list({ scope: otherScope }).items).toHaveLength(0)
      expectCode(
        () =>
          instance.resolve({
            scope: otherScope,
            credentialRefId: ref.id,
            audience: 'runtime_driver',
          }),
        'not_found'
      )
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('keeps the canary secret out of storage, audit, and records', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-vault-'))
    try {
      const audit = createAuthorityAudit({ file: join(dataDir, 'audit.jsonl') })
      const instance = vault(dataDir, audit)
      const ref = enroll(instance)
      instance.revoke({ scope, credentialRefId: ref.id, expectedVersion: ref.version })
      const trail = readFileSync(join(dataDir, 'audit.jsonl'), 'utf8')
      expect(trail).toContain('vault.enrolled')
      expect(trail).toContain('vault.revoked')
      expect(trail.includes(SECRET)).toBe(false)
      expect(trail.includes('canary')).toBe(false)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
