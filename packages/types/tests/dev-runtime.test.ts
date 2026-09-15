import { describe, expect, test } from 'bun:test'

import {
  decodeDevCommand,
  decodeDevReply,
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
    expect(devOperations).toHaveLength(114)
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

  test('accepts paired commits whose immutable plan owns the target binding', () => {
    const value = command('dev.git.discardCommit', {
      planId: 'plan-1',
      planDigest: '0'.repeat(64),
    })
    const paired = {
      ...value,
      resource: { kind: 'worktree', id: 'worktree-1', generation: 7 },
    }
    expect(decodeDevCommand(paired)).toEqual(paired)
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
    expect(decodeRuntimeEvent(event)).toEqual(event)
    expect(() => decodeRuntimeEvent({ ...event, extra: true })).toThrow('unknown key')
    expect(() => decodeRuntimeEvent({ ...event, seq: '01' })).toThrow('uint64')
    expect(() => decodeRuntimeEvent({ ...event, payload: { text: 'x'.repeat(65_537) } })).toThrow(
      'string length'
    )
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
