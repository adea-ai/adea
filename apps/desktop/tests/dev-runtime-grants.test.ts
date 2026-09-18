// M10 #34 substrate: scoped project grants. A grant binds one project to one
// authorized root (and optionally one vault credential reference) inside one
// account/workspace/node scope, and every creation revalidates the referenced
// authorities fail-closed at grant time.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DevAuthorityError } from '../shell/src/dev-runtime/authority'
import { createProjectGrantAuthority } from '../shell/src/dev-runtime/grants'
import { createRootBookmarkAuthority } from '../shell/src/dev-runtime/roots'
import { createCredentialVault } from '../shell/src/dev-runtime/vault'

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
const approval = { method: 'owner_dialog', reference: 'consent-3' } as const
const projectId = '00000000-0000-4000-8000-000000000020'

function grantAuthority(dataDir: string) {
  return createProjectGrantAuthority({
    dataDir,
    roots: createRootBookmarkAuthority({ dataDir }),
    vault: createCredentialVault({ dataDir }),
  })
}

function mintRoot(dataDir: string, name: string) {
  const dir = join(dataDir, name)
  mkdirSync(dir, { recursive: true })
  return createRootBookmarkAuthority({ dataDir }).mint({
    scope,
    label: name,
    kind: 'repository',
    absolutePath: dir,
    approval,
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

describe('project grant authority', () => {
  test('creates grants only with owner approval evidence', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-grants-'))
    try {
      const root = mintRoot(dataDir, 'checkout')
      const grants = grantAuthority(dataDir)
      expectCode(() => grants.create({ scope, projectId, rootBookmarkId: root.id }), 'unauthorized')
      const grant = grants.create({ scope, projectId, rootBookmarkId: root.id, approval })
      expect(grant.state).toBe('active')
      expect(grant.generation).toBe(1)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('revalidates the referenced root fail-closed at grant time', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-grants-'))
    try {
      const grants = grantAuthority(dataDir)
      expectCode(
        () =>
          grants.create({
            scope,
            projectId,
            rootBookmarkId: '00000000-0000-4000-8000-0000000000ff',
            approval,
          }),
        'not_found'
      )
      const root = mintRoot(dataDir, 'checkout')
      const revoked = createRootBookmarkAuthority({ dataDir }).revoke({
        scope,
        bookmarkId: root.id,
        expectedVersion: root.version,
      })
      expectCode(
        () => grants.create({ scope, projectId, rootBookmarkId: root.id, approval }),
        'unauthorized_root'
      )
      expectCode(
        () => grants.create({ scope: otherScope, projectId, rootBookmarkId: root.id, approval }),
        'not_found'
      )
      expect(revoked.state).toBe('revoked')
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('binds only ready credential references from the same scope', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-grants-'))
    try {
      const vault = createCredentialVault({ dataDir })
      const root = mintRoot(dataDir, 'checkout')
      const grants = grantAuthority(dataDir)
      expectCode(
        () =>
          grants.create({
            scope,
            projectId,
            rootBookmarkId: root.id,
            credentialRefId: '00000000-0000-4000-8000-0000000000fe',
            approval,
          }),
        'not_found'
      )
      const ref = vault.enroll({
        scope,
        label: 'GitHub token',
        host: 'github.com',
        kind: 'github_token',
        secret: 'canary',
        approval,
      })
      const grant = grants.create({
        scope,
        projectId,
        rootBookmarkId: root.id,
        credentialRefId: ref.id,
        approval,
      })
      expect(grant.credentialRefId).toBe(ref.id)
      vault.revoke({ scope, credentialRefId: ref.id, expectedVersion: ref.version })
      expectCode(
        () =>
          grants.create({
            scope,
            projectId: '00000000-0000-4000-8000-000000000021',
            rootBookmarkId: root.id,
            credentialRefId: ref.id,
            approval,
          }),
        'unauthorized'
      )
      expectCode(
        () =>
          grants.create({
            scope: otherScope,
            projectId,
            rootBookmarkId: root.id,
            credentialRefId: ref.id,
            approval,
          }),
        'not_found'
      )
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('treats duplicate active grants idempotently and revokes terminally', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-grants-'))
    try {
      const root = mintRoot(dataDir, 'checkout')
      const grants = grantAuthority(dataDir)
      const first = grants.create({ scope, projectId, rootBookmarkId: root.id, approval })
      const duplicate = grants.create({ scope, projectId, rootBookmarkId: root.id, approval })
      expect(duplicate.id).toBe(first.id)
      expect(duplicate.version).toBe(first.version)

      expectCode(
        () => grants.revoke({ scope, grantId: first.id, expectedVersion: 99 }),
        'stale_version'
      )
      const revoked = grants.revoke({ scope, grantId: first.id, expectedVersion: first.version })
      expect(revoked.state).toBe('revoked')
      const repeated = grants.revoke({ scope, grantId: first.id, expectedVersion: revoked.version })
      expect(repeated.version).toBe(revoked.version)
      // A revoked grant does not satisfy the duplicate check; but regranting
      // after revocation is the owner's explicit new decision.
      const regranted = grants.create({ scope, projectId, rootBookmarkId: root.id, approval })
      expect(regranted.id).not.toBe(first.id)
      expect(regranted.state).toBe('active')
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('lists per scope and project with paging', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-grants-'))
    try {
      const rootA = mintRoot(dataDir, 'a')
      const rootB = mintRoot(dataDir, 'b')
      const grants = grantAuthority(dataDir)
      grants.create({ scope, projectId, rootBookmarkId: rootA.id, approval })
      grants.create({ scope, projectId, rootBookmarkId: rootB.id, approval })
      const otherProject = '00000000-0000-4000-8000-000000000022'
      grants.create({ scope, projectId: otherProject, rootBookmarkId: rootA.id, approval })

      expect(grants.list({ scope }).items).toHaveLength(3)
      expect(grants.list({ scope, projectId }).items).toHaveLength(2)
      const page = grants.list({ scope, limit: 2 })
      expect(page.items).toHaveLength(2)
      expect(page.nextCursor).toBeDefined()
      expect(grants.list({ scope, limit: 2, cursor: page.nextCursor }).items).toHaveLength(1)
      expect(grants.list({ scope: otherScope }).items).toHaveLength(0)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
