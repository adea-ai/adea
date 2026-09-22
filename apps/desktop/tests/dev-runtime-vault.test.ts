// M10 #34 substrate: the credential vault. Secrets live only behind sealed
// storage and are handed to authorized runtime drivers; every other surface
// (list, replies, audit, errors) sees CredentialRef records without secret
// material, and accidental serialization of a resolved secret fails loudly.
import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createOwnerApprovalVerifier,
  DevAuthorityError,
  type OwnerApproval,
  type OwnerApprovalVerifier,
} from '../shell/src/dev-runtime/authority'
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
const ENROLL_ACTION = 'enroll a credential'
const SECRET = 'canary-secret-value-阅读'
let verifier: OwnerApprovalVerifier
let consentSequence = 0

/** Issues one durable, scope-bound, single-use owner approval. */
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

function vault(
  dataDir: string,
  audit?: ReturnType<typeof createAuthorityAudit>,
  credentialStore?: VaultKeyStore,
  onMigrationStage?: (stage: 'before_commit') => void
) {
  verifier = createOwnerApprovalVerifier({ dataDir })
  const keys = new Map<string, Buffer>()
  const defaultCredentialStore: VaultKeyStore = {
    get: (_service, account) => keys.get(account),
    set: (_service, account, key) => keys.set(account, Buffer.from(key)),
    delete: (_service, account) => keys.delete(account),
  }
  return createCredentialVault({
    dataDir,
    audit,
    credentialStore: credentialStore ?? defaultCredentialStore,
    approvalVerifier: verifier,
    onMigrationStage,
  })
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
    approval: approved(),
  })
}

describe('credential vault', () => {
  test('migrates metadata to SQLite, retains legacy JSON, and survives restart', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-vault-migration-'))
    try {
      const vaultDir = join(dataDir, 'dev-runtime', 'vault')
      const legacyRecord = {
        id: '00000000-0000-4000-8000-000000000010',
        scope,
        label: 'GitHub token',
        host: 'github.com',
        kind: 'github_token',
        state: 'ready',
        version: 1,
        createdAt: '2026-09-22T12:00:00.000Z',
        updatedAt: '2026-09-22T12:00:00.000Z',
      }
      mkdirSync(vaultDir, { recursive: true, mode: 0o700 })
      writeFileSync(
        join(vaultDir, 'credentials.json'),
        JSON.stringify({
          schemaVersion: 1,
          savedAt: legacyRecord.updatedAt,
          records: [legacyRecord],
        }),
        { mode: 0o600 }
      )

      const instance = vault(dataDir)
      expect(instance.list({ scope }).items).toEqual([legacyRecord])
      const sqliteFile = join(vaultDir, 'credentials.sqlite3')
      expect(existsSync(sqliteFile)).toBe(true)
      expect(existsSync(join(vaultDir, 'credentials.json'))).toBe(true)

      const database = new Database(sqliteFile, { readonly: true })
      const payload = String(
        (
          database.query('SELECT payload FROM durable_store_records WHERE id = 1').get() as {
            payload: string
          }
        ).payload
      )
      expect(payload).not.toContain('secret')
      expect(payload).not.toContain('master-key')
      expect(payload).not.toContain('sealed')
      database.close()

      const restarted = vault(dataDir)
      expect(restarted.list({ scope }).items).toEqual([legacyRecord])
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('rolls back an interrupted migration and retries from retained JSON', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-vault-migration-rollback-'))
    try {
      const vaultDir = join(dataDir, 'dev-runtime', 'vault')
      const legacyRecord = {
        id: '00000000-0000-4000-8000-000000000011',
        scope,
        label: 'GitHub token',
        host: 'github.com',
        kind: 'github_token',
        state: 'ready',
        version: 1,
        createdAt: '2026-09-22T12:00:00.000Z',
        updatedAt: '2026-09-22T12:00:00.000Z',
      }
      mkdirSync(vaultDir, { recursive: true, mode: 0o700 })
      writeFileSync(
        join(vaultDir, 'credentials.json'),
        JSON.stringify({
          schemaVersion: 1,
          savedAt: legacyRecord.updatedAt,
          records: [legacyRecord],
        }),
        { mode: 0o600 }
      )
      const keys = new Map<string, Buffer>()
      const keyStore: VaultKeyStore = {
        get: (_service, account) => keys.get(account),
        set: (_service, account, key) => keys.set(account, Buffer.from(key)),
        delete: (_service, account) => keys.delete(account),
      }
      const interrupted = vault(dataDir, undefined, keyStore, () => {
        throw new Error('simulated vault migration interruption')
      })
      expect(() => interrupted.list({ scope })).toThrow('simulated vault migration interruption')
      expect(readdirSync(vaultDir)).toContain('credentials.json')

      const retried = vault(dataDir, undefined, keyStore)
      expect(retried.list({ scope }).items).toEqual([legacyRecord])
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('fails closed after SQLite metadata loss while retaining the legacy source', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-vault-migration-loss-'))
    try {
      const vaultDir = join(dataDir, 'dev-runtime', 'vault')
      const legacyRecord = {
        id: '00000000-0000-4000-8000-000000000012',
        scope,
        label: 'GitHub token',
        host: 'github.com',
        kind: 'github_token',
        state: 'ready',
        version: 1,
        createdAt: '2026-09-22T12:00:00.000Z',
        updatedAt: '2026-09-22T12:00:00.000Z',
      }
      mkdirSync(vaultDir, { recursive: true, mode: 0o700 })
      writeFileSync(
        join(vaultDir, 'credentials.json'),
        JSON.stringify({
          schemaVersion: 1,
          savedAt: legacyRecord.updatedAt,
          records: [legacyRecord],
        }),
        { mode: 0o600 }
      )
      const keys = new Map<string, Buffer>()
      const keyStore: VaultKeyStore = {
        get: (_service, account) => keys.get(account),
        set: (_service, account, key) => keys.set(account, Buffer.from(key)),
        delete: (_service, account) => keys.delete(account),
      }
      const instance = vault(dataDir, undefined, keyStore)
      expect(instance.list({ scope }).items).toEqual([legacyRecord])
      rmSync(join(vaultDir, 'credentials.sqlite3'))
      expectCode(() => vault(dataDir, undefined, keyStore).list({ scope }), 'corrupt_state')
      expect(existsSync(join(vaultDir, 'credentials.json'))).toBe(true)
      expect(
        readdirSync(vaultDir).some((name) => name.startsWith('credentials.sqlite3.corrupt-'))
      ).toBe(true)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('retains and refuses SQLite metadata that contains secret-shaped fields', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-vault-metadata-corrupt-'))
    try {
      const instance = vault(dataDir)
      enroll(instance)
      const sqliteFile = join(dataDir, 'dev-runtime', 'vault', 'credentials.sqlite3')
      const database = new Database(sqliteFile)
      const row = database
        .query('SELECT payload FROM durable_store_records WHERE id = 1')
        .get() as {
        payload: string
      }
      const records = JSON.parse(row.payload) as Array<Record<string, unknown>>
      records[0]!.secret = SECRET
      database
        .query('UPDATE durable_store_records SET payload = ? WHERE id = 1')
        .run(JSON.stringify(records))
      database.close()

      expectCode(() => vault(dataDir).list({ scope }), 'corrupt_state')
      expect(
        readdirSync(join(dataDir, 'dev-runtime', 'vault')).some((name) =>
          name.startsWith('credentials.sqlite3.corrupt-')
        )
      ).toBe(true)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('owner approval evidence is issued, scope-bound, and single-use', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-approvals-'))
    try {
      let now = Date.parse('2026-09-18T12:00:00.000Z')
      const controlled = createOwnerApprovalVerifier({ dataDir, now: () => new Date(now) })
      const evidence = {
        method: 'owner_dialog' as const,
        reference: 'approval-once',
        scope,
        issuedAt: '2026-09-18T11:59:00.000Z',
        expiresAt: '2026-09-18T12:01:00.000Z',
      }
      // A structural record without an issuance is never consumable.
      expectCode(
        () => controlled.consume(evidence, scope, 'authorize a root bookmark'),
        'unauthorized'
      )
      controlled.recordIssuance(evidence, scope, 'authorize a root bookmark')
      controlled.consume(evidence, scope, 'authorize a root bookmark')
      expectCode(
        () => controlled.consume(evidence, scope, 'authorize a root bookmark'),
        'unauthorized'
      )
      expectCode(
        () =>
          controlled.consume(
            { ...evidence, reference: 'other-reference' },
            scope,
            'authorize a root bookmark'
          ),
        'unauthorized'
      )
      // Expiry is rechecked at consumption time.
      const expiring = {
        method: 'owner_setting' as const,
        reference: 'approval-expiring',
        scope,
        issuedAt: '2026-09-18T11:59:00.000Z',
        expiresAt: '2026-09-18T12:00:30.000Z',
      }
      controlled.recordIssuance(expiring, scope, 'authorize a root bookmark')
      now = Date.parse('2026-09-18T12:00:31.000Z')
      expectCode(
        () => controlled.consume(expiring, scope, 'authorize a root bookmark'),
        'unauthorized'
      )
      // Wrong scope never matches.
      const other = {
        ...evidence,
        reference: 'approval-scope',
        expiresAt: '2026-09-18T12:05:00.000Z',
      }
      controlled.recordIssuance(other, scope, 'authorize a root bookmark')
      expectCode(
        () => controlled.consume(other, otherScope, 'authorize a root bookmark'),
        'unauthorized'
      )
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
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
      const database = new Database(join(dataDir, 'dev-runtime', 'vault', 'credentials.sqlite3'), {
        readonly: true,
      })
      const payload = String(
        (
          database.query('SELECT payload FROM durable_store_records WHERE id = 1').get() as {
            payload: string
          }
        ).payload
      )
      expect(payload).not.toContain(SECRET)
      database.close()
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
            approval: approved(),
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
            approval: approved(),
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
            approval: approved(),
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

  test('writes a downgrade-visible legacy tombstone before revoked metadata can outlive the secret', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-vault-downgrade-'))
    try {
      const keys = new Map<string, Buffer>()
      const keyStore: VaultKeyStore = {
        get: (_service, account) => keys.get(account),
        set: (_service, account, key) => keys.set(account, Buffer.from(key)),
        delete: (_service, account) => keys.delete(account),
      }
      const initial = vault(dataDir, undefined, keyStore)
      const ref = enroll(initial)
      const vaultDir = join(dataDir, 'dev-runtime', 'vault')
      const sqliteFile = join(vaultDir, 'credentials.sqlite3')
      rmSync(sqliteFile, { force: true })
      rmSync(`${sqliteFile}-wal`, { force: true })
      rmSync(`${sqliteFile}-shm`, { force: true })
      rmSync(`${sqliteFile}.migration.json`, { force: true })
      writeFileSync(
        join(vaultDir, 'credentials.json'),
        JSON.stringify({ schemaVersion: 1, savedAt: ref.updatedAt, records: [ref] }),
        { mode: 0o600 }
      )

      const migrated = vault(dataDir, undefined, keyStore)
      expect(migrated.list({ scope }).items[0]?.state).toBe('ready')
      const revoked = migrated.revoke({
        scope,
        credentialRefId: ref.id,
        expectedVersion: ref.version,
      })
      expect(revoked.state).toBe('revoked')
      expect(existsSync(join(vaultDir, `${ref.id}.sealed`))).toBe(false)
      const legacy = JSON.parse(readFileSync(join(vaultDir, 'credentials.json'), 'utf8')) as {
        records: Array<{ id: string; state: string }>
      }
      expect(legacy.records).toContainEqual({
        ...ref,
        state: 'revoked',
        version: revoked.version,
        updatedAt: revoked.updatedAt,
        revokedAt: revoked.revokedAt,
      })
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
        approval: approved(),
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
