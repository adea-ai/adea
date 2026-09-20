import { describe, expect, test } from 'bun:test'

import {
  decodeCredentialRef,
  decodeRepo,
  decodeRepoInspection,
  decodeDevCommand,
  decodeDevReply,
  decodeRootBookmark,
  decodeHarnessInstallation,
  decodeRuntimeConnectionInventoryEntry,
  decodeRuntimeConnectionInventorySnapshot,
  canonicalDevCommandJson,
  decodeAuthorizedDevFrame,
  decodeCapabilitySnapshot,
  decodeCbor,
  decodeDevChannelHandshakeReply,
  decodeDevChannelHandshakeRequest,
  decodeDevStreamAttach,
  decodeDevStreamFrame,
  decodeDevStreamGrant,
  decodeRuntimeEvent,
  devCommandProofMessage,
  devOperationDefinitions,
  devOperationDecoders,
  devOperations,
  devRuntimeTransportMethods,
  devStreamAttachProofMessage,
  devStreamGrantProofMessage,
  encodeCbor,
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
    expect(devOperations).toHaveLength(155)
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
    expect(pairedCommits).toHaveLength(10)
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
        operation: 'dev.project.list',
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

describe('M10 discovery DTOs (HarnessInstallation, RuntimeConnection inventory)', () => {
  const observedAt = '2026-09-18T12:00:00.000Z'

  const harnessInstallation = {
    id: '00000000-0000-5000-8000-0000000000a1',
    scope,
    executableIdentity: '/opt/homebrew/bin/claude',
    executableLabel: 'claude (system)',
    protocol: 'native',
    version: '2.0.1',
    auth: 'ready',
    health: 'healthy',
    capabilities: ['native', 'models', 'resume'],
    models: [{ id: 'claude-sonnet', displayName: 'Claude Sonnet', capabilities: ['tools'] }],
    observedAt,
    generation: 1,
  } as const

  const inventoryEntry = {
    id: harnessInstallation.id,
    scope,
    family: 'claude-code',
    displayName: 'Claude Code',
    driverId: 'local-executable',
    driverVersion: '1',
    provenance: 'user_managed',
    executableIdentity: '/opt/homebrew/bin/claude',
    executableLabel: 'claude (system)',
    protocol: 'native',
    acpAvailability: 'unavailable',
    version: '2.0.1',
    auth: 'ready',
    health: 'healthy',
    capabilities: ['native', 'models', 'resume'],
    sessionOperations: ['session.new', 'session.resume'],
    entitlementHints: ['user_managed'],
    limitations: ['history_is_native_not_adea'],
    eligibility: { eligible: true, blockers: [] },
    transport: 'direct_local',
    models: harnessInstallation.models,
    observedAt,
    generation: 1,
  } as const

  test('strictly decodes harness installations', () => {
    expect(decodeHarnessInstallation(harnessInstallation)).toEqual(harnessInstallation)
    expect(() => decodeHarnessInstallation({ ...harnessInstallation, extra: true })).toThrow(
      'unknown key'
    )
    expect(() => decodeHarnessInstallation({ ...harnessInstallation, protocol: 'grpc' })).toThrow(
      'native'
    )
    expect(() => decodeHarnessInstallation({ ...harnessInstallation, auth: 'granted' })).toThrow(
      'auth'
    )
    expect(() => decodeHarnessInstallation({ ...harnessInstallation, health: 'perfect' })).toThrow(
      'health'
    )
    expect(() => decodeHarnessInstallation({ ...harnessInstallation, id: 'claude' })).toThrow(
      'UUID'
    )
    expect(() =>
      decodeHarnessInstallation({ ...harnessInstallation, executableLabel: 'x'.repeat(257) })
    ).toThrow('string length')
    expect(() =>
      decodeHarnessInstallation({
        ...harnessInstallation,
        models: [{ id: 'm', displayName: 'm', capabilities: [] }, ...harnessInstallation.models],
      })
    ).not.toThrow()
    // freshness is derived on read and never part of the stored DTO
    expect(() => decodeHarnessInstallation({ ...harnessInstallation, freshness: 'stale' })).toThrow(
      'unknown key'
    )
  })

  test('strictly decodes RuntimeConnection inventory entries', () => {
    expect(decodeRuntimeConnectionInventoryEntry(inventoryEntry)).toEqual(inventoryEntry)
    expect(() => decodeRuntimeConnectionInventoryEntry({ ...inventoryEntry, fresh: true })).toThrow(
      'unknown key'
    )
    expect(() =>
      decodeRuntimeConnectionInventoryEntry({ ...inventoryEntry, provenance: 'system' })
    ).toThrow('provenance')
    expect(() =>
      decodeRuntimeConnectionInventoryEntry({ ...inventoryEntry, transport: 'carrier_pigeon' })
    ).toThrow('transport')
    expect(() =>
      decodeRuntimeConnectionInventoryEntry({ ...inventoryEntry, acpAvailability: 'maybe' })
    ).toThrow('acpAvailability')
    expect(() =>
      decodeRuntimeConnectionInventoryEntry({
        ...inventoryEntry,
        eligibility: { eligible: false, blockers: [{ code: 'made_up_code', message: 'x' }] },
      })
    ).toThrow('code')
    expect(() =>
      decodeRuntimeConnectionInventoryEntry({
        ...inventoryEntry,
        eligibility: { eligible: true },
      })
    ).toThrow('blockers')
    expect(() =>
      decodeRuntimeConnectionInventoryEntry({
        ...inventoryEntry,
        acpAvailability: 'available',
        acpVersion: '1.2.0',
      })
    ).not.toThrow()
  })

  test('strictly decodes the inventory snapshot with one freshness per entry', () => {
    const snapshot = {
      scope,
      items: [inventoryEntry],
      freshness: ['fresh'],
      observedAt,
    } as const
    expect(decodeRuntimeConnectionInventorySnapshot(snapshot)).toEqual(snapshot)
    expect(() => decodeRuntimeConnectionInventorySnapshot({ ...snapshot, freshness: [] })).toThrow(
      'one freshness per item'
    )
    expect(() =>
      decodeRuntimeConnectionInventorySnapshot({ ...snapshot, freshness: ['fresh', 'stale'] })
    ).toThrow('one freshness per item')
    expect(() =>
      decodeRuntimeConnectionInventorySnapshot({ ...snapshot, freshness: ['old'] })
    ).toThrow('fresh')
    expect(() =>
      decodeRuntimeConnectionInventorySnapshot({
        ...snapshot,
        items: [
          { ...inventoryEntry, eligibility: { eligible: false, blockers: [] } },
          inventoryEntry,
        ],
        freshness: ['stale', 'fresh'],
      })
    ).not.toThrow()
  })
})

const base64url = (text: string) => Buffer.from(text, 'utf8').toString('base64url')

describe('Dev Runtime authenticated channel (M10 #33)', () => {
  const channelId = '00000000-0000-4000-8000-00000000000a'
  const credentialId = '00000000-0000-4000-8000-00000000000b'

  const handshakeRequest = {
    schemaVersion: 1 as const,
    method: 'dev.runtime.handshake.v1' as const,
    requestId: '00000000-0000-4000-8000-000000000004',
    bootstrap: base64url('bootstrap-secret-at-least-128-bits'),
    supportedProtocolVersions: ['1'],
    nonce: base64url('handshake-nonce-128-bits'),
    issuedAt: '2026-09-15T12:00:00.000Z',
    expiresAt: '2026-09-15T12:00:30.000Z',
  }

  const handshakeReply = {
    schemaVersion: 1 as const,
    method: 'dev.runtime.handshake.v1' as const,
    requestId: handshakeRequest.requestId,
    ok: true as const,
    channelId,
    clientCredentialId: credentialId,
    clientSecret: base64url('channel-client-secret-returned-exactly-once-32-bytes'),
    channelGeneration: 1,
    protocolVersion: '1',
    serverExpiresAt: '2026-09-15T12:30:00.000Z',
    observedAt: '2026-09-15T12:00:00.000Z',
  }

  test('pins the transport method names', () => {
    expect(devRuntimeTransportMethods).toEqual({
      handshake: 'dev.runtime.handshake.v1',
      execute: 'dev.runtime.execute.v1',
      events: 'dev.runtime.events.v1',
      streamAttach: 'dev.runtime.stream.attach.v1',
    })
  })

  test('strictly decodes the channel handshake request and reply', () => {
    expect(decodeDevChannelHandshakeRequest(handshakeRequest)).toEqual(handshakeRequest)
    expect(decodeDevChannelHandshakeReply(handshakeReply)).toEqual(handshakeReply)
    expect(() =>
      decodeDevChannelHandshakeRequest({ ...handshakeRequest, method: 'dev.runtime.execute.v1' })
    ).toThrow('method')
    expect(() =>
      decodeDevChannelHandshakeRequest({ ...handshakeRequest, bootstrap: 'short' })
    ).toThrow('bootstrap')
    expect(() =>
      decodeDevChannelHandshakeRequest({ ...handshakeRequest, nonce: 'bad*nonce*chars' })
    ).toThrow('nonce')
    expect(() =>
      decodeDevChannelHandshakeRequest({ ...handshakeRequest, supportedProtocolVersions: [] })
    ).toThrow('supportedProtocolVersions')
    expect(() => decodeDevChannelHandshakeReply({ ...handshakeReply, extra: 1 })).toThrow(
      'unknown key'
    )
    expect(() =>
      decodeDevChannelHandshakeReply({ ...handshakeReply, channelId: 'not-a-uuid' })
    ).toThrow('UUID')
    const refused = {
      schemaVersion: 1 as const,
      method: 'dev.runtime.handshake.v1' as const,
      requestId: handshakeRequest.requestId,
      ok: false as const,
      error: { code: 'channel_unauthenticated', retryable: false, message: 'Refused' },
    }
    expect(decodeDevChannelHandshakeReply(refused)).toEqual(refused)
  })

  test('strictly decodes an authorized frame around a bare command', () => {
    const snapshotCommand = command('dev.capability.snapshot', {})
    const frame = {
      channelId,
      clientCredentialId: credentialId,
      command: snapshotCommand,
      proof: base64url('proof-over-the-canonical-command-digest-and-channel-binding'),
    }
    expect(decodeAuthorizedDevFrame(frame)).toEqual(frame)
    expect(() =>
      decodeAuthorizedDevFrame({ ...frame, command: { ...snapshotCommand, scope: 1 } })
    ).toThrow()
    expect(() => decodeAuthorizedDevFrame({ ...frame, proof: 'short' })).toThrow('proof')
    expect(() => decodeAuthorizedDevFrame({ ...frame, clientCredentialId: 'not-a-uuid' })).toThrow(
      'UUID'
    )
  })

  test('canonicalizes command JSON and binds every proof field', () => {
    expect(canonicalDevCommandJson({ b: 2, a: { d: 1, c: [true, null] } })).toBe(
      '{"a":{"c":[true,null],"d":1},"b":2}'
    )
    const snapshotCommand = command('dev.capability.snapshot', {})
    const input = { channelId, clientCredentialId: credentialId, command: snapshotCommand }
    expect(devCommandProofMessage(input)).toBe(devCommandProofMessage({ ...input }))
    // Every bound field changes the proof input: scope, capabilities, times,
    // nonce, request id, credential, channel, and the body itself.
    expect(
      devCommandProofMessage({
        ...input,
        command: { ...snapshotCommand, nonce: base64url('a-different-request-nonce-value') },
      })
    ).not.toBe(devCommandProofMessage(input))
    expect(
      devCommandProofMessage({
        ...input,
        command: { ...snapshotCommand, capabilities: [...snapshotCommand.capabilities] },
      })
    ).toBe(devCommandProofMessage(input))
    expect(
      devCommandProofMessage({
        ...input,
        command: { ...snapshotCommand, idempotencyKey: 'logical-retry' },
      })
    ).not.toBe(devCommandProofMessage(input))
  })

  test('strictly decodes stream grants and attaches', () => {
    const grant = {
      schemaVersion: 1 as const,
      grantId: '00000000-0000-4000-8000-00000000000c',
      protocol: 'terminal-bytes-v1' as const,
      channelId,
      scope,
      resource: { kind: 'terminal', id: 'terminal-1', generation: 3 },
      direction: 'read' as const,
      fromSequence: '0',
      expiresAt: '2026-09-15T12:00:45.000Z',
      maxFrameBytes: 65_536,
    }
    expect(decodeDevStreamGrant(grant)).toEqual(grant)
    expect(() => decodeDevStreamGrant({ ...grant, protocol: 'terminal-bytes-v2' })).toThrow(
      'protocol'
    )
    expect(() => decodeDevStreamGrant({ ...grant, direction: 'write' })).not.toThrow()
    expect(() => decodeDevStreamGrant({ ...grant, fromSequence: '01' })).toThrow('uint64')
    expect(() => decodeDevStreamGrant({ ...grant, maxFrameBytes: 0 })).toThrow('maxFrameBytes')

    const attach = {
      schemaVersion: 1 as const,
      grantId: grant.grantId,
      requestId: '00000000-0000-4000-8000-000000000004',
      nonce: base64url('attach-nonce-128-bits-long'),
      fromSequence: '0',
      proof: base64url('attach-proof-bound-to-grant-and-channel'),
    }
    expect(decodeDevStreamAttach(attach)).toEqual(attach)
    expect(() => decodeDevStreamAttach({ ...attach, extra: true })).toThrow('unknown key')

    // The grant proof message binds credential, channel, protocol, scope,
    // resource/generation, direction, sequence, and limits; the attach proof
    // additionally binds the consumed nonce and resume sequence.
    const grantMessage = devStreamGrantProofMessage({
      clientCredentialId: credentialId,
      grant,
    })
    expect(devStreamGrantProofMessage({ clientCredentialId: credentialId, grant })).toBe(
      grantMessage
    )
    expect(
      devStreamGrantProofMessage({
        clientCredentialId: credentialId,
        grant: { ...grant, direction: 'write' },
      })
    ).not.toBe(grantMessage)
    const attachMessage = devStreamAttachProofMessage({
      channelId,
      attach,
    })
    expect(
      devStreamAttachProofMessage({ channelId, attach: { ...attach, fromSequence: '5' } })
    ).not.toBe(attachMessage)
  })

  test('strictly decodes every bulk stream frame variant', () => {
    const frames = [
      { type: 'opened', protocol: 'terminal-bytes-v1', generation: 1, nextSequence: '0' },
      { type: 'data', sequence: '1', bytes: new Uint8Array([1, 2, 3]) },
      { type: 'video', sequence: '2', timestampMs: 12, keyframe: true, bytes: new Uint8Array([9]) },
      { type: 'input', sequence: '3', generation: 1, bytes: new Uint8Array([4]) },
      { type: 'gesture', sequence: '4', generation: 1, gesture: { kind: 'tap', x: 0.5, y: 0.5 } },
      {
        type: 'gesture',
        sequence: '4',
        generation: 1,
        gesture: { kind: 'swipe', fromX: 0.1, fromY: 0.2, toX: 0.3, toY: 0.4, durationMs: 220 },
      },
      { type: 'resize', sequence: '5', generation: 1, cols: 80, rows: 24 },
      { type: 'ack', throughSequence: '6', availableCreditBytes: 1024 },
      { type: 'heartbeat', observedAt: '2026-09-15T12:00:00.000Z', throughSequence: '6' },
      { type: 'resync', reason: 'sequence_gap', checkpointSequence: '7' },
      {
        type: 'error',
        error: { code: 'backpressure', retryable: true, message: 'Slow subscriber' },
      },
      { type: 'close', code: 'stale_generation' },
    ] as const
    for (const frame of frames) expect(decodeDevStreamFrame(frame)).toEqual(frame)

    expect(() => decodeDevStreamFrame({ type: 'data', sequence: '1', bytes: 'AQID' })).toThrow(
      'Uint8Array'
    )
    expect(() =>
      decodeDevStreamFrame({
        type: 'gesture',
        sequence: '4',
        generation: 1,
        gesture: { kind: 'tap', x: 1.5, y: 0.5 },
      })
    ).toThrow('x')
    expect(() =>
      decodeDevStreamFrame({
        type: 'gesture',
        sequence: '4',
        generation: 1,
        gesture: { kind: 'swipe', fromX: 0.1, fromY: 0.2, toX: 0.3, toY: 0.4, durationMs: 5 },
      })
    ).toThrow('durationMs')
    expect(() =>
      decodeDevStreamFrame({
        type: 'gesture',
        sequence: '4',
        generation: 1,
        gesture: { kind: 'text', text: 'x'.repeat(4097) },
      })
    ).toThrow('text')
    expect(() => decodeDevStreamFrame({ type: 'close', code: 'bogus' })).toThrow('close')
    expect(() =>
      decodeDevStreamFrame({ type: 'resync', reason: 'bogus', checkpointSequence: '7' })
    ).toThrow('reason')
    expect(() =>
      decodeDevStreamFrame({ type: 'data', sequence: '1', bytes: new Uint8Array([1]), extra: 1 })
    ).toThrow('unknown key')
  })

  test('strictly decodes the capability snapshot including client-preference grants', () => {
    const snapshot = {
      scope,
      granted: ['dev.appearance.read'] as const,
      unavailable: [
        { capability: 'dev.terminal.attach', reason: 'capability_unavailable' },
        { capability: 'dev.appLibrary.manage', reason: 'capability_unavailable' },
      ],
      channelGeneration: 1,
      observedAt: '2026-09-15T12:00:00.000Z',
    }
    expect(decodeCapabilitySnapshot(snapshot)).toEqual(snapshot)
    expect(() => decodeCapabilitySnapshot({ ...snapshot, granted: ['dev.bogus.read'] })).toThrow(
      'capability'
    )
    expect(() =>
      decodeCapabilitySnapshot({ ...snapshot, unavailable: [{ capability: 'dev.git.read' }] })
    ).toThrow('reason')
    expect(() =>
      decodeCapabilitySnapshot({ ...snapshot, scope: { ...scope, accountId: 'x' } })
    ).toThrow('UUID')
  })

  test('encodes and decodes canonical CBOR per RFC 8949 deterministic rules', () => {
    const vectors: [unknown, string][] = [
      [0, '00'],
      [1, '01'],
      [10, '0a'],
      [23, '17'],
      [24, '1818'],
      [100, '1864'],
      [1000, '1903e8'],
      [1_000_000, '1a000f4240'],
      [1_000_000_000_000, '1b000000e8d4a51000'],
      [18446744073709551615n, '1bffffffffffffffff'],
      [-1, '20'],
      [-10, '29'],
      [-100, '3863'],
      [-1000, '3903e7'],
      [1.5, 'f93e00'],
      [100000.5, 'fa47c35040'],
      [1.1, 'fb3ff199999999999a'],
      [true, 'f5'],
      [false, 'f4'],
      [null, 'f6'],
      ['', '60'],
      ['a', '6161'],
      ['IETF', '6449455446'],
      ['"\\', '62225c'],
      ['ü', '62c3bc'],
      ['水', '63e6b0b4'],
      ['𝄞', '64f09d849e'],
      [new Uint8Array([]), '40'],
      [new Uint8Array([1, 2, 3, 4]), '4401020304'],
      [[], '80'],
      [[1, 2, 3], '83010203'],
      [{}, 'a0'],
      [{ a: 1, b: [2, 3] }, 'a26161016162820203'],
      [['a', { b: 'c' }], '826161a161626163'],
    ]
    for (const [value, encoded] of vectors) {
      expect(Buffer.from(encodeCbor(value)).toString('hex')).toBe(encoded)
      const decoded = decodeCbor(encodeCbor(value))
      expect(decoded.value).toEqual(value)
      expect(decoded.byteLength).toBe(encodeCbor(value).byteLength)
    }
  })

  test('rejects non-canonical CBOR instead of guessing', () => {
    const bad = [
      '190001',
      '7f616161ff',
      'c074323031332d30332d32315432303a30343a30305a',
      '1b0000000000000064',
      'fe',
    ]
    for (const hex of bad) {
      expect(() => decodeCbor(Buffer.from(hex, 'hex'))).toThrow()
    }
    // Map keys are stored by their encoded bytes: two-entry maps decode to the
    // same canonical key order regardless of insertion order.
    expect(decodeCbor(encodeCbor({ b: 1, a: 2 })).value).toEqual({ a: 2, b: 1 })
    expect(decodeCbor(encodeCbor({ b: 1, aa: 2 })).value).toEqual({ aa: 2, b: 1 })
    // Trailing bytes are reported, never silently consumed.
    const encoded = encodeCbor(1)
    const trailing = new Uint8Array(encoded.length + 1)
    trailing.set(encoded)
    expect(decodeCbor(trailing).byteLength).toBe(encoded.length)
    expect(() => encodeCbor(Number.NaN)).toThrow()
    expect(() => encodeCbor(undefined)).toThrow()
  })
})

describe('repository registry DTOs (#398 follow-up)', () => {
  const redactedRemote = {
    provider: 'github',
    host: 'github.com',
    ownerPath: 'adea/adea',
    displayUrl: 'https://github.com/adea/adea',
  } as const

  const repo = {
    id: '00000000-0000-4000-8000-000000000030',
    scope,
    kind: 'git',
    lifecycle: 'ready',
    canonicalRoot: '/Users/dev/work/adea',
    gitCommonDirIdentity: {
      device: '1',
      inode: '42',
      mtimeNs: '1700000000000000000',
      size: '4096',
    },
    remote: redactedRemote,
    defaultRef: 'refs/heads/main',
    projectIds: ['00000000-0000-4000-8000-000000000020'],
    version: 1,
  } as const

  test('strictly decodes the Repo record with an optional redacted remote', () => {
    expect(decodeRepo(repo)).toEqual(repo)
    // Optional fields may be absent (folder workspaces carry neither).
    expect(decodeRepo({ ...repo, remote: undefined, defaultRef: undefined })).toEqual({
      ...repo,
      remote: undefined,
      defaultRef: undefined,
    })
    expect(() => decodeRepo({ ...repo, extra: true })).toThrow('unknown key')
    expect(() => decodeRepo({ ...repo, id: 'repo-1' })).toThrow('UUID')
    expect(() => decodeRepo({ ...repo, kind: 'symlink' })).toThrow('git')
    expect(() => decodeRepo({ ...repo, lifecycle: 'refreshing' })).not.toThrow()
    expect(() => decodeRepo({ ...repo, lifecycle: 'deployed' })).toThrow('lifecycle')
    expect(() => decodeRepo({ ...repo, canonicalRoot: '/bad\0nul' })).toThrow('canonicalRoot')
    expect(() => decodeRepo({ ...repo, version: 0 })).toThrow('integer')
    // A redacted remote can never smuggle secret material: unknown keys and
    // an empty proven host refuse.
    expect(() => decodeRepo({ ...repo, remote: { ...redactedRemote, token: 'x' } })).toThrow(
      'unknown key'
    )
    expect(() => decodeRepo({ ...repo, remote: { ...redactedRemote, host: '' } })).toThrow(
      'string length'
    )
  })

  test('strictly decodes the RepoInspection reply with git facts', () => {
    const inspection = {
      repo,
      rootIdentity: { device: '1', inode: '42', mtimeNs: '1700000000000000000', size: '4096' },
      headRef: 'refs/heads/main',
      headSha: 'a'.repeat(40),
      dirty: false,
      observedAt: '2026-09-20T12:00:00.000Z',
    }
    expect(decodeRepoInspection(inspection)).toEqual(inspection)
    expect(() => decodeRepoInspection({ ...inspection, extra: true })).toThrow('unknown key')
    expect(() => decodeRepoInspection({ ...inspection, headSha: 'ZZZ' })).toThrow('git sha')
    expect(() => decodeRepoInspection({ ...inspection, dirty: 'no' })).toThrow('boolean')
    expect(() => decodeRepoInspection({ ...inspection, observedAt: 'yesterday' })).toThrow(
      'timestamp'
    )
  })

  test('installs reply decoders for the repository registry operations', () => {
    const observedAt = '2026-09-20T12:00:00.000Z'
    const requestId = '00000000-0000-4000-8000-000000000004'
    for (const operation of ['dev.repo.adopt', 'dev.repo.authorize', 'dev.repo.refresh'] as const) {
      const reply = {
        schemaVersion: 1,
        operation,
        requestId,
        ok: true,
        value: repo,
        observedAt,
      }
      expect(devOperationDecoders[operation].reply(reply)).toEqual(reply)
    }
    const inspectReply = {
      schemaVersion: 1,
      operation: 'dev.repo.inspect',
      requestId,
      ok: true,
      value: {
        repo,
        rootIdentity: repo.gitCommonDirIdentity,
        dirty: false,
        observedAt,
      },
      observedAt,
    }
    expect(devOperationDecoders['dev.repo.inspect'].reply(inspectReply)).toEqual(inspectReply)
    const listReply = {
      schemaVersion: 1,
      operation: 'dev.repo.list',
      requestId,
      ok: true,
      value: { items: [repo], observedAt },
      observedAt,
    }
    expect(devOperationDecoders['dev.repo.list'].reply(listReply)).toEqual(listReply)
    // Project archive/update reply with the same strict Project decoder.
    const project = {
      id: '00000000-0000-4000-8000-000000000020',
      scope,
      name: 'Adea',
      groupIds: [] as string[],
      repoIds: [repo.id],
      lifecycle: 'archived',
      version: 2,
    }
    for (const operation of ['dev.project.update', 'dev.project.archive'] as const) {
      const reply = {
        schemaVersion: 1,
        operation,
        requestId,
        ok: true,
        value: project,
        observedAt,
      }
      expect(devOperationDecoders[operation].reply(reply)).toEqual(reply)
    }
    // A stale lifecycle on the wire refuses instead of coercing.
    expect(() =>
      devOperationDecoders['dev.repo.adopt'].reply({
        schemaVersion: 1,
        operation: 'dev.repo.adopt',
        requestId,
        ok: true,
        value: { ...repo, lifecycle: 'deployed' },
        observedAt,
      })
    ).toThrow('lifecycle')
  })

  test('request bodies decode strictly from the registry DSL', () => {
    expect(
      devOperationDecoders['dev.repo.adopt'].request({
        repoId: '00000000-0000-4000-8000-000000000030',
        rootBookmarkId: '00000000-0000-4000-8000-000000000010',
        expectedVersion: 1,
      })
    ).toMatchObject({ expectedVersion: 1 })
    expect(() =>
      devOperationDecoders['dev.repo.adopt'].request({ repoId: 'r', expectedVersion: 1 })
    ).toThrow()
    expect(() => devOperationDecoders['dev.repo.adopt'].request({ expectedVersion: 1 })).toThrow()
    expect(
      devOperationDecoders['dev.project.archive'].request({
        projectId: '00000000-0000-4000-8000-000000000020',
        expectedVersion: 2,
        archived: true,
      })
    ).toMatchObject({ archived: true })
    expect(() =>
      devOperationDecoders['dev.project.archive'].request({
        projectId: '00000000-0000-4000-8000-000000000020',
        expectedVersion: 2,
        archived: 'yes',
      })
    ).toThrow()
  })
})
