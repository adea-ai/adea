// Bounded M10 #33 adversarial matrix. These tests stay at the shared command
// decoder and channel-origin seams so they do not depend on the vault or the
// keychain adapter changed by PR #567.
import { describe, expect, test } from 'bun:test'

import { devOperationDefinitions, decodeDevCommand } from '../../../packages/types/src/dev-runtime'
import { isTrustedLoopbackRequest } from '../shell/src/dev-runtime/channel/loopback'

const SHELL_HOST = '127.0.0.1:4789'
const SHELL_ORIGIN = `http://${SHELL_HOST}`
const WORKTREE_ID = '00000000-0000-4000-8000-000000000010'
const REPO_ID = '00000000-0000-4000-8000-000000000011'
const SCOPE = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
} as const
const ROOT_IDENTITY = { mtimeNs: '1', size: '0' }

function command(operation: keyof typeof devOperationDefinitions, body: Record<string, unknown>) {
  const definition = devOperationDefinitions[operation]
  return {
    schemaVersion: 1,
    operation,
    requestId: '00000000-0000-4000-8000-000000000004',
    nonce: 'dGhpcy1ub25jZS1oYXMtYXQtbGVhc3QtMTI4LWJpdHM',
    issuedAt: '2026-09-22T12:00:00.000Z',
    expiresAt: '2026-09-22T12:01:00.000Z',
    scope: SCOPE,
    capabilities: definition.capabilities,
    ...(definition.resource
      ? {
          resource: {
            kind: definition.resource.kind,
            id: String(body[definition.resource.idField]),
            generation: Number(body.expectedGeneration ?? 1),
          },
        }
      : {}),
    body,
  }
}

function workspacePath(relativePath: string) {
  return { worktreeId: WORKTREE_ID, rootIdentity: ROOT_IDENTITY, relativePath }
}

describe('M10 privileged command matrix', () => {
  test('accepts only the exact packaged shell origin and rejects rebinding metadata', () => {
    const cases = [
      [{ host: SHELL_HOST, origin: SHELL_ORIGIN }, true],
      [{ host: SHELL_HOST, origin: SHELL_ORIGIN, secFetchSite: 'same-origin' }, true],
      [{ host: SHELL_HOST, origin: SHELL_ORIGIN, secFetchSite: 'none' }, true],
      [{ host: SHELL_HOST }, false],
      [{ host: 'evil.example:4789', origin: SHELL_ORIGIN }, false],
      [{ host: SHELL_HOST, origin: 'http://evil.example', secFetchSite: 'cross-site' }, false],
      [{ host: SHELL_HOST, origin: 'null', secFetchSite: 'cross-site' }, false],
    ] as const

    for (const [request, expected] of cases) {
      expect(
        isTrustedLoopbackRequest(request, { shellHost: SHELL_HOST, shellOrigin: SHELL_ORIGIN })
      ).toBe(expected)
    }
  })

  test('rejects traversal, absolute, backslash, and dot path spellings in command bodies', () => {
    for (const relativePath of [
      '../outside',
      'src/../../outside',
      '/etc/passwd',
      'C:/Windows',
      'src\\secret',
    ]) {
      expect(() =>
        decodeDevCommand(
          command('dev.files.read', {
            worktreeId: WORKTREE_ID,
            path: workspacePath(relativePath),
            length: 1,
          })
        )
      ).toThrow('relative path')
    }
  })

  test('keeps credential references opaque and rejects key-role substitution fields', () => {
    const valid = command('dev.repo.authorize', {
      repoId: REPO_ID,
      credentialRefId: '00000000-0000-4000-8000-000000000012',
      expectedVersion: 1,
    })
    expect(decodeDevCommand(valid)).toBe(valid)

    for (const field of ['secret', 'privateKey', 'commandEncryptionKey', 'localContentMasterKey']) {
      expect(() =>
        decodeDevCommand({ ...valid, body: { ...valid.body, [field]: 'key-material' } })
      ).toThrow(/unknown key|authority field/)
    }
  })

  test('rejects forged capabilities, resource kind/id, and authority fields before dispatch', () => {
    const valid = command('dev.repo.authorize', {
      repoId: REPO_ID,
      credentialRefId: '00000000-0000-4000-8000-000000000012',
      expectedVersion: 1,
    })
    expect(() => decodeDevCommand({ ...valid, capabilities: ['dev.files.read'] })).toThrow(
      'capabilities'
    )
    expect(() =>
      decodeDevCommand({
        ...valid,
        resource: { kind: 'workspace_root', id: REPO_ID, generation: 1 },
      })
    ).toThrow('kind')
    expect(() =>
      decodeDevCommand({
        ...valid,
        resource: { kind: 'repository', id: WORKTREE_ID, generation: 1 },
      })
    ).toThrow('resource id')
    expect(() => decodeDevCommand({ ...valid, body: { ...valid.body, scope: SCOPE } })).toThrow(
      'authority field'
    )
  })
})
