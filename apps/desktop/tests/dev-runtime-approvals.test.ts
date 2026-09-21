// Remediation gate: owner approval can never fail open. The verifier is
// mandatory in every production constructor, consumption is bound to an
// authoritative issuance record (scope, action, validity window), and every
// record is single-use. A caller-supplied non-empty string is not approval.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createOwnerApprovalVerifier,
  DevAuthorityError,
  type OwnerApproval,
} from '../shell/src/dev-runtime/authority'
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
const ROOT_ACTION = 'authorize a root bookmark'

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

function issuedApproval(
  verifier: ReturnType<typeof createOwnerApprovalVerifier>,
  overrides: Partial<OwnerApproval> = {}
): OwnerApproval {
  const approval: OwnerApproval = {
    method: 'owner_dialog',
    reference: `consent-${Math.random().toString(36).slice(2, 10)}`,
    scope,
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  }
  verifier.recordIssuance(approval, approval.scope ?? scope, ROOT_ACTION)
  return approval
}

function memoryKeyStore() {
  const keys = new Map<string, Buffer>()
  return {
    get: (_service: string, account: string) => keys.get(account),
    set: (_service: string, account: string, key: Buffer) => keys.set(account, Buffer.from(key)),
    delete: (_service: string, account: string) => keys.delete(account),
  }
}

describe('owner approval fail-closed remediation', () => {
  test('a missing verifier prevents construction of every grant authority', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-approval-missing-'))
    try {
      const root = join(dataDir, 'checkout')
      mkdirSync(root, { recursive: true })
      expectCode(
        () => createCredentialVault({ dataDir, credentialStore: memoryKeyStore() }),
        'auth_required'
      )
      expectCode(() => createRootBookmarkAuthority({ dataDir }), 'auth_required')
      expectCode(
        () =>
          createProjectGrantAuthority({
            dataDir,
            roots: createRootBookmarkAuthority({
              dataDir,
              approvalVerifier: createOwnerApprovalVerifier({ dataDir }),
            }),
            vault: createCredentialVault({
              dataDir,
              credentialStore: memoryKeyStore(),
              approvalVerifier: createOwnerApprovalVerifier({ dataDir }),
            }),
          }),
        'auth_required'
      )
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('a forged structural record (non-empty reference, never issued) is rejected', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-approval-forged-'))
    try {
      const verifier = createOwnerApprovalVerifier({ dataDir })
      const forged: OwnerApproval = {
        method: 'owner_dialog',
        reference: 'the-caller-invented-this-string',
        scope,
        issuedAt: new Date(Date.now() - 1_000).toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }
      expectCode(() => verifier.consume(forged, scope, ROOT_ACTION), 'unauthorized')

      const roots = createRootBookmarkAuthority({ dataDir, approvalVerifier: verifier })
      const dir = join(dataDir, 'checkout')
      mkdirSync(dir, { recursive: true })
      // The authority path rejects the same forgery: structural validity is
      // never sufficient without the issuance record.
      expectCode(
        () =>
          roots.mint({
            scope,
            label: 'Repo',
            kind: 'repository',
            absolutePath: dir,
            approval: forged,
          }),
        'unauthorized'
      )
      expect(roots.list({ scope }).items).toHaveLength(0)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('approval replay is rejected even against a different action', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-approval-replay-'))
    try {
      const verifier = createOwnerApprovalVerifier({ dataDir })
      const approval = issuedApproval(verifier)
      verifier.consume(approval, scope, ROOT_ACTION)
      expectCode(() => verifier.consume(approval, scope, ROOT_ACTION), 'unauthorized')
      // The same reference is single-use across every action.
      expectCode(
        () => verifier.consume(approval, scope, 'grant a project its root'),
        'unauthorized'
      )
      // A second issuance under a consumed reference is refused too.
      expectCode(() => verifier.recordIssuance(approval, scope, ROOT_ACTION), 'unauthorized')
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('an expired approval is rejected at consumption time', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-approval-expiry-'))
    try {
      let now = Date.now()
      const verifier = createOwnerApprovalVerifier({ dataDir, now: () => new Date(now) })
      const approval = issuedApproval(verifier)
      // Consume validity is checked against the injected clock.
      now += 10 * 60_000
      expectCode(() => verifier.consume(approval, scope, ROOT_ACTION), 'unauthorized')
      // An issuance whose window exceeds the maximum lifetime is refused.
      const longWindow: OwnerApproval = {
        method: 'owner_setting',
        reference: 'too-long',
        scope,
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 11 * 60_000).toISOString(),
      }
      expectCode(() => verifier.recordIssuance(longWindow, scope, ROOT_ACTION), 'unauthorized')
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('a wrong-scope approval is rejected before any state changes', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-approval-scope-'))
    try {
      const verifier = createOwnerApprovalVerifier({ dataDir })
      const roots = createRootBookmarkAuthority({ dataDir, approvalVerifier: verifier })
      const dir = join(dataDir, 'checkout')
      mkdirSync(dir, { recursive: true })
      const approval = issuedApproval(verifier)
      expectCode(
        () =>
          roots.mint({
            scope: otherScope,
            label: 'Repo',
            kind: 'repository',
            absolutePath: dir,
            approval,
          }),
        'unauthorized'
      )
      // Nothing was minted under either scope.
      expect(roots.list({ scope }).items).toHaveLength(0)
      expect(roots.list({ scope: otherScope }).items).toHaveLength(0)
      // The unconsumed approval still works for its own scope.
      const minted = roots.mint({
        scope,
        label: 'Repo',
        kind: 'repository',
        absolutePath: dir,
        approval,
      })
      expect(minted.state).toBe('active')
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
