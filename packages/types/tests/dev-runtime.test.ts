import { describe, expect, test } from 'bun:test'

import {
  decodeCredentialRef,
  decodeDevCommand,
  decodeDevReply,
  decodeRootBookmark,
  decodeRuntimeEvent,
  devOperationDefinitions,
  devOperationDecoders,
  devOperations,
  devRuntimeTransportMethods,
} from '../src/dev-runtime'

const scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
} as const

function workspacePathRequest(relativePath: string) {
  return devOperationDecoders['dev.files.list'].request({
    worktreeId: 'worktree-1',
    path: {
      worktreeId: 'worktree-1',
      rootIdentity: { mtimeNs: '1', size: '1' },
      relativePath,
    },
    limit: 10,
  })
}

function command(operation: keyof typeof devOperationDefinitions, body: Record<string, unknown>) {
  const definition = devOperationDefinitions[operation]
  return {
    schemaVersion: 1,
    operation,
    requestId: '00000000-0000-4000-8000-000000000004',
    nonce: 'dGhpcy1ub25jZS1oYXMtYXQtbGVhc3QtMTI4LWJpdHM',
    issuedAt: '2026-09-15T12:00:00.000Z',
    expiresAt: '2026-09-15T12:01:00.000Z',
    scope,
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

describe('Dev Runtime operation registry', () => {
  test('pins every normative operation and transport method', () => {
    expect(devOperations).toHaveLength(133)
    expect(devRuntimeTransportMethods).toEqual({
      handshake: 'dev.runtime.handshake.v1',
      execute: 'dev.runtime.execute.v1',
      events: 'dev.runtime.events.v1',
      streamAttach: 'dev.runtime.stream.attach.v1',
    })
    expect(Object.keys(devOperationDecoders)).toEqual([...devOperations])
  })

  test('strictly decodes every empty or representative request body', () => {
    expect(devOperationDecoders['dev.capability.snapshot'].request({})).toEqual({})
    expect(() =>
      devOperationDecoders['dev.capability.snapshot'].request({ injected: true })
    ).toThrow('unknown key')

    expect(
      devOperationDecoders['dev.browser.viewport'].request({
        browserLaneId: 'lane',
        expectedGeneration: 2,
        width: 1280,
        height: 720,
        deviceScaleFactor: 2,
        mobile: false,
      })
    ).toMatchObject({ width: 1280, height: 720 })
    expect(() =>
      devOperationDecoders['dev.browser.viewport'].request({
        browserLaneId: 'lane',
        expectedGeneration: 2,
        width: 5000,
        height: 720,
        deviceScaleFactor: 2,
        mobile: false,
      })
    ).toThrow('width')
  })

  test('decodes new group, stream-grant, and list operation bodies', () => {
    expect(
      devOperationDecoders['dev.group.update'].request({
        groupId: 'group-1',
        expectedVersion: 3,
        patch: { name: 'Platform', colorToken: 'accent' },
      })
    ).toMatchObject({ groupId: 'group-1' })
    expect(() =>
      devOperationDecoders['dev.group.update'].request({
        groupId: 'group-1',
        expectedVersion: 3,
        patch: { name: 'Platform', unknown: true },
      })
    ).toThrow('unknown key')
    expect(
      devOperationDecoders['dev.files.writeStream'].request({
        worktreeId: 'wt-1',
        path: {
          worktreeId: 'wt-1',
          rootIdentity: { mtimeNs: '1', size: '1' },
          relativePath: 'src/index.ts',
        },
        expectedIdentity: { mtimeNs: '1', size: '1' },
        byteLength: '1048576',
        contentSha256: '0'.repeat(64),
        eolPolicy: 'preserve',
        direction: 'write',
      })
    ).toMatchObject({ eolPolicy: 'preserve' })
    expect(
      devOperationDecoders['dev.terminal.list'].request({
        runtimeSessionId: 'session-1',
        state: 'running',
      })
    ).toMatchObject({ state: 'running' })
    expect(() => devOperationDecoders['dev.terminal.list'].request({ state: 'bogus' })).toThrow()
  })

  test('rejects authority fields nested in operation bodies', () => {
    expect(() =>
      devOperationDecoders['dev.project.get'].request({
        projectId: 'project',
        scope,
      })
    ).toThrow('authority field')
  })

  test('rejects backslash and drive-prefixed workspace paths', () => {
    expect(() => workspacePathRequest('..\\secret')).toThrow('normalized relative path')
    expect(() => workspacePathRequest('C:\\secret')).toThrow('normalized relative path')
    expect(workspacePathRequest('src/index.ts')).toMatchObject({ limit: 10 })
  })
})

describe('Dev Runtime command envelope', () => {
  test('accepts an exact capability and resource binding', () => {
    const value = command('dev.browser.viewport', {
      browserLaneId: 'lane-1',
      expectedGeneration: 7,
      width: 1280,
      height: 720,
      deviceScaleFactor: 2,
      mobile: false,
    })
    expect(decodeDevCommand(value)).toEqual(value)
  })

  test('rejects extra, missing, duplicated, or unsorted capabilities', () => {
    const value = command('dev.project.list', { limit: 10 })
    for (const capabilities of [
      [],
      ['dev.project.read', 'dev.project.manage'],
      ['dev.project.read', 'dev.project.read'],
    ]) {
      expect(() => decodeDevCommand({ ...value, capabilities })).toThrow('capabilities')
    }
  })

  test('accepts every paired commit whose immutable plan owns the target binding', () => {
    const pairedCommits = devOperations.filter((operation) => operation.endsWith('Commit'))
    expect(pairedCommits).toHaveLength(9)
    for (const operation of pairedCommits) {
      const value = command(operation, {
        planId: 'plan-1',
        planDigest: '0'.repeat(64),
      })
      const definition = devOperationDefinitions[operation]
      expect(definition.resource).not.toBeNull()
      const paired = {
        ...value,
        resource: { kind: definition.resource!.kind, id: 'plan-target-1', generation: 7 },
      }
      expect(decodeDevCommand(paired)).toEqual(paired)
    }
  })

  test('rejects command control payloads above 256 KiB', () => {
    const value = command('dev.session.create', {
      projectId: 'project-1',
      repoId: 'repo-1',
      worktreeId: 'worktree-1',
      taskId: 'x'.repeat(300_000),
    })
    expect(() => decodeDevCommand(value)).toThrow('control payload exceeds 256 KiB')
  })

  test('rejects stale resource bindings and unknown envelope keys', () => {
    const value = command('dev.browser.viewport', {
      browserLaneId: 'lane-1',
      expectedGeneration: 7,
      width: 1280,
      height: 720,
      deviceScaleFactor: 2,
      mobile: false,
    })
    expect(() =>
      decodeDevCommand({
        ...value,
        resource: { kind: 'browser_lane', id: 'lane-2', generation: 7 },
      })
    ).toThrow('resource id')
    expect(() => decodeDevCommand({ ...value, trusted: true })).toThrow('unknown key')
  })
})

describe('Dev Runtime event envelope', () => {
  const event = {
    schemaVersion: 1,
    eventId: 'event-1',
    runtimeSessionId: 'session-1',
    generation: 1,
    seq: '1',
    occurredAt: '2026-09-15T12:00:00.000Z',
    receivedAt: '2026-09-15T12:00:01.000Z',
    source: 'host',
    sourceEventId: 'source-1',
    confidence: 'authoritative',
    classification: 'workspace_metadata',
    kind: 'session.ready',
    payload: { state: 'ready' },
  } as const

  test('strictly decodes bounded runtime events', () => {
    expect(decodeRuntimeEvent(event, { source: 'host' })).toEqual(event)
    expect(() => decodeRuntimeEvent({ ...event, extra: true }, { source: 'host' })).toThrow(
      'unknown key'
    )
    expect(() => decodeRuntimeEvent({ ...event, seq: '01' }, { source: 'host' })).toThrow('uint64')
    expect(() =>
      decodeRuntimeEvent({ ...event, payload: { text: 'x'.repeat(65_537) } }, { source: 'host' })
    ).toThrow('string length')
  })

  test('binds provenance to the transport and limits terminal fallback projections', () => {
    expect(() => decodeRuntimeEvent(event, { source: 'acp' })).toThrow('transport provenance')
    expect(() =>
      decodeRuntimeEvent(
        {
          ...event,
          source: 'terminal_fallback',
          confidence: 'authoritative',
          kind: 'approval.resolved',
        },
        { source: 'terminal_fallback' }
      )
    ).toThrow('terminal fallback cannot be authoritative')
    expect(
      decodeRuntimeEvent(
        {
          ...event,
          source: 'terminal_fallback',
          confidence: 'bounded_projection',
          kind: 'turn.assistant_delta',
        },
        { source: 'terminal_fallback' }
      )
    ).toMatchObject({ kind: 'turn.assistant_delta' })
  })
})

describe('Dev Runtime reply envelope', () => {
  test('strictly decodes typed errors', () => {
    const value = {
      schemaVersion: 1,
      operation: 'dev.project.get',
      requestId: '00000000-0000-4000-8000-000000000004',
      ok: false,
      error: {
        code: 'unavailable',
        retryable: true,
        message: 'Project data is unavailable',
      },
    }
    expect(decodeDevReply(value)).toEqual(value)
    expect(() =>
      decodeDevReply({ ...value, error: { ...value.error, details: 'private' } })
    ).toThrow('unknown key')
  })

  test('fails closed for success DTOs until their provider-owned decoder lands', () => {
    expect(() =>
      decodeDevReply({
        schemaVersion: 1,
        operation: 'dev.project.get',
        requestId: '00000000-0000-4000-8000-000000000004',
        ok: true,
        value: { extra: true },
        observedAt: '2026-09-15T12:00:00.000Z',
      })
    ).toThrow('success DTO decoder is unavailable')
  })

  test('rejects unknown versions and unknown operations', () => {
    expect(() => decodeDevReply({ schemaVersion: 2 })).toThrow('schemaVersion')
    expect(() =>
      decodeDevReply({
        schemaVersion: 1,
        operation: 'dev.unknown.read',
        requestId: '00000000-0000-4000-8000-000000000004',
        ok: false,
        error: { code: 'unavailable', retryable: true, message: 'Unavailable' },
      })
    ).toThrow('operation')
  })
})

describe('M10 grant DTOs (RootBookmark, CredentialRef)', () => {
  const rootBookmark = {
    id: '00000000-0000-4000-8000-000000000010',
    scope,
    label: 'Primary checkout',
    kind: 'repository',
    canonicalRoot: '/Users/dev/work/adea',
    rootIdentity: { device: '1', inode: '42', mtimeNs: '1700000000000000000', size: '4096' },
    state: 'active',
    generation: 1,
    version: 1,
  } as const

  const credentialRef = {
    id: '00000000-0000-4000-8000-000000000011',
    scope,
    label: 'GitHub token',
    host: 'github.com',
    kind: 'github_token',
    state: 'ready',
    version: 1,
  } as const

  test('strictly decodes root bookmarks', () => {
    expect(decodeRootBookmark(rootBookmark)).toEqual(rootBookmark)
    expect(() => decodeRootBookmark({ ...rootBookmark, extra: true })).toThrow('unknown key')
    expect(() => decodeRootBookmark({ ...rootBookmark, id: 'bookmark-1' })).toThrow('UUID')
    expect(() => decodeRootBookmark({ ...rootBookmark, kind: 'symlink' })).toThrow('repository')
    expect(() => decodeRootBookmark({ ...rootBookmark, state: 'expired' })).toThrow('state')
    expect(() => decodeRootBookmark({ ...rootBookmark, label: '' })).toThrow('string length')
    expect(() => decodeRootBookmark({ ...rootBookmark, label: 'x'.repeat(129) })).toThrow(
      'string length'
    )
    expect(() => decodeRootBookmark({ ...rootBookmark, canonicalRoot: '/bad\0nul' })).toThrow(
      'canonicalRoot'
    )
    expect(() => decodeRootBookmark({ ...rootBookmark, rootIdentity: { mtimeNs: '1' } })).toThrow(
      'size'
    )
    expect(() => decodeRootBookmark({ ...rootBookmark, generation: -1 })).toThrow('integer')
    expect(() => decodeRootBookmark({ ...rootBookmark, version: 0 })).toThrow('integer')
  })

  test('strictly decodes credential references without secret material', () => {
    expect(decodeCredentialRef(credentialRef)).toEqual(credentialRef)
    expect(() => decodeCredentialRef({ ...credentialRef, secret: 'hunter2' })).toThrow(
      'unknown key'
    )
    expect(() => decodeCredentialRef({ ...credentialRef, id: 'ref-1' })).toThrow('UUID')
    expect(() => decodeCredentialRef({ ...credentialRef, kind: 'password' })).toThrow(
      'github_token'
    )
    expect(() => decodeCredentialRef({ ...credentialRef, state: 'active' })).toThrow('state')
    expect(() => decodeCredentialRef({ ...credentialRef, host: '' })).toThrow('string length')
    expect(() => decodeCredentialRef({ ...credentialRef, version: 0 })).toThrow('integer')
  })

  test('installs success page decoders for the grant seam operations', () => {
    const observedAt = '2026-09-18T12:00:00.000Z'
    const requestId = '00000000-0000-4000-8000-000000000004'
    const bookmarksReply = {
      schemaVersion: 1,
      operation: 'dev.project.bookmarks',
      requestId,
      ok: true,
      value: { items: [rootBookmark], nextCursor: 'cursor-1', observedAt },
      observedAt,
    }
    expect(decodeDevReply(bookmarksReply)).toEqual(bookmarksReply)
    expect(devOperationDecoders['dev.project.bookmarks'].reply(bookmarksReply)).toEqual(
      bookmarksReply
    )

    const credentialRefsReply = {
      schemaVersion: 1,
      operation: 'dev.repo.credentialRefs',
      requestId,
      ok: true,
      value: { items: [credentialRef], observedAt },
      observedAt,
    }
    expect(devOperationDecoders['dev.repo.credentialRefs'].reply(credentialRefsReply)).toEqual(
      credentialRefsReply
    )

    expect(() =>
      decodeDevReply({
        ...bookmarksReply,
        value: { items: [{ ...rootBookmark, state: 'bogus' }], observedAt },
      })
    ).toThrow('state')
    expect(() =>
      decodeDevReply({
        ...bookmarksReply,
        value: { items: [rootBookmark], cursor: 'unknown-key', observedAt },
      })
    ).toThrow('unknown key')
    expect(() =>
      decodeDevReply({
        ...bookmarksReply,
        operation: 'dev.repo.authorize',
        value: { items: [rootBookmark], observedAt },
      })
    ).toThrow('success DTO decoder is unavailable')
  })

  test('validates bookmark listing request bodies', () => {
    expect(
      devOperationDecoders['dev.project.bookmarks'].request({ kind: 'directory', limit: 500 })
    ).toMatchObject({ kind: 'directory', limit: 500 })
    expect(() => devOperationDecoders['dev.project.bookmarks'].request({ kind: 'file' })).toThrow(
      'directory'
    )
    expect(() => devOperationDecoders['dev.project.bookmarks'].request({ limit: 0 })).toThrow(
      'integer'
    )
    expect(() => devOperationDecoders['dev.project.bookmarks'].request({ limit: 501 })).toThrow(
      'integer'
    )
    expect(
      devOperationDecoders['dev.repo.credentialRefs'].request({ host: 'github.com', limit: 1 })
    ).toMatchObject({ host: 'github.com', limit: 1 })
  })
})
