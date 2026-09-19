// #31/#32 harness substrate wire contract: every dev.harness.* request body
// and success reply decodes through the strict registry decoders, unknown
// keys and forged capabilities fail closed, and the session-mapped
// launch/resume/cancel replies decode the HarnessRun DTO.
import { describe, expect, test } from 'bun:test'

import {
  decodeDevCommand,
  decodeDevReply,
  devOperationDecoders,
  devOperationDefinitions,
} from '../src/dev-runtime'

const scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
} as const
const sessionId = '00000000-0000-4000-8000-0000000000b1'
const installationId = '00000000-0000-4000-8000-0000000000c1'
const connectionId = '00000000-0000-4000-8000-0000000000d1'
const runId = '00000000-0000-4000-8000-0000000000e1'
const now = '2026-09-19T12:00:00.000Z'

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
    capabilities: [...definition.capabilities],
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

function reply(operation: keyof typeof devOperationDefinitions, value: unknown) {
  return {
    schemaVersion: 1,
    operation,
    requestId: '00000000-0000-4000-8000-000000000004',
    ok: true,
    value,
    observedAt: now,
  }
}

const agentProfile = {
  id: 'profile-1',
  version: 3,
  displayName: 'profile-1',
  capabilityPolicyVersion: 2,
}

const harnessRun = {
  id: runId,
  scope,
  runtimeSessionId: sessionId,
  installationId,
  agentProfile,
  state: 'starting',
  generation: 1,
  startedAt: now,
  version: 1,
}

const managedPiStatus = {
  scope,
  driverId: 'managed-pi',
  driverVersion: '1',
  pinnedVersion: '0.1.42',
  state: 'ready',
  installationId,
  resolvedVersion: '0.1.42',
  executableIdentity: '/managed/pi',
  executableLabel: 'managed Pi 0.1.42',
  observedAt: now,
  generation: 2,
}

const acpConnection = {
  id: connectionId,
  scope,
  runtimeSessionId: sessionId,
  harnessInstallationId: installationId,
  driverId: 'acp-process',
  driverVersion: '1',
  negotiatedProtocolVersion: '1',
  requiredCapabilities: ['session'],
  negotiatedCapabilities: ['session', 'history'],
  missingRequiredCapabilities: [],
  sessionOperations: ['session.new', 'session.resume'],
  limitations: [],
  history: 'available',
  state: 'ready',
  observedAt: now,
  generation: 1,
}

describe('dev.harness command bodies', () => {
  test('managed Pi status/install take an empty body and their registry capabilities', () => {
    expect(() => decodeDevCommand(command('dev.harness.managedPiStatus', {}))).not.toThrow()
    expect(() => decodeDevCommand(command('dev.harness.managedPiInstall', {}))).not.toThrow()
  })

  test('acpConnect requires the runtime_session resource binding', () => {
    const decoded = decodeDevCommand(
      command('dev.harness.acpConnect', {
        runtimeSessionId: sessionId,
        expectedGeneration: 2,
        harnessInstallationId: installationId,
      })
    )
    expect(decoded.resource).toEqual({
      kind: 'runtime_session',
      id: sessionId,
      generation: 2,
    })
  })

  test('acpConnect rejects a resource id that does not match the body target', () => {
    expect(() =>
      decodeDevCommand({
        ...command('dev.harness.acpConnect', {
          runtimeSessionId: sessionId,
          expectedGeneration: 2,
          harnessInstallationId: installationId,
        }),
        resource: { kind: 'runtime_session', id: connectionId, generation: 2 },
      })
    ).toThrow()
  })

  test('acpClose binds the acp_connection resource to the body target', () => {
    const decoded = decodeDevCommand(
      command('dev.harness.acpClose', { acpConnectionId: connectionId, expectedGeneration: 1 })
    )
    expect(decoded.resource).toEqual({
      kind: 'acp_connection',
      id: connectionId,
      generation: 1,
    })
  })

  test('unknown body keys are rejected', () => {
    expect(() => decodeDevCommand(command('dev.harness.managedPiStatus', { version: 2 }))).toThrow()
    expect(() =>
      decodeDevCommand(
        command('dev.harness.acpConnections', {
          runtimeSessionId: sessionId,
          bogus: true,
        })
      )
    ).toThrow()
  })

  test('forged capability sets are rejected', () => {
    const forged = command('dev.harness.managedPiStatus', {})
    expect(() => decodeDevCommand({ ...forged, capabilities: ['dev.session.manage'] })).toThrow()
  })

  test('run/connection filters decode their closed state unions', () => {
    expect(() =>
      decodeDevCommand(command('dev.harness.acpConnections', { state: 'ready', limit: 50 }))
    ).not.toThrow()
    expect(() =>
      decodeDevCommand(command('dev.harness.acpConnections', { state: 'teleported' }))
    ).toThrow()
    expect(() =>
      decodeDevCommand(command('dev.harness.runs', { state: 'awaiting_input' }))
    ).not.toThrow()
    expect(() => decodeDevCommand(command('dev.harness.runs', { state: 'fly' }))).toThrow()
  })

  test('launch/resume/cancel keep their runtime_session bindings', () => {
    expect(() =>
      decodeDevCommand(
        command('dev.session.launchHarness', {
          runtimeSessionId: sessionId,
          expectedGeneration: 1,
          harnessInstallationId: installationId,
          agentProfileId: 'profile-1',
          agentProfileVersion: 3,
        })
      )
    ).not.toThrow()
    expect(() =>
      decodeDevCommand(
        command('dev.session.resumeHarness', {
          runtimeSessionId: sessionId,
          expectedGeneration: 1,
          harnessRunId: runId,
        })
      )
    ).not.toThrow()
    expect(() =>
      decodeDevCommand(
        command('dev.session.cancelHarness', {
          runtimeSessionId: sessionId,
          expectedGeneration: 1,
          harnessRunId: runId,
        })
      )
    ).not.toThrow()
  })
})

describe('dev.harness success replies', () => {
  test('managedPiStatus decodes strictly, including the failed state', () => {
    expect(() =>
      decodeDevReply(reply('dev.harness.managedPiStatus', managedPiStatus))
    ).not.toThrow()
    const failed = decodeDevCommand(command('dev.harness.managedPiInstall', {}))
    expect(failed.operation).toBe('dev.harness.managedPiInstall')
    expect(() =>
      decodeDevReply(
        reply('dev.harness.managedPiInstall', {
          ...managedPiStatus,
          state: 'failed',
          lastErrorCode: 'capability_unavailable',
          lastError: 'no archive on this host',
        })
      )
    ).not.toThrow()
  })

  test('managedPiStatus rejects unknown keys and bogus error codes', () => {
    expect(() =>
      decodeDevReply(reply('dev.harness.managedPiStatus', { ...managedPiStatus, extra: 1 }))
    ).toThrow()
    expect(() =>
      decodeDevReply(
        reply('dev.harness.managedPiStatus', { ...managedPiStatus, lastErrorCode: 'not-a-code' })
      )
    ).toThrow()
  })

  test('acpConnection replies decode and require a UUID id', () => {
    expect(() => decodeDevReply(reply('dev.harness.acpConnect', acpConnection))).not.toThrow()
    expect(() => decodeDevReply(reply('dev.harness.acpClose', acpConnection))).not.toThrow()
    expect(() =>
      decodeDevReply(reply('dev.harness.acpConnect', { ...acpConnection, id: 'not-a-uuid' }))
    ).toThrow()
    // History is a closed capability: it is either negotiated or absent.
    expect(() =>
      decodeDevReply(reply('dev.harness.acpConnect', { ...acpConnection, history: 'fabricated' }))
    ).toThrow()
  })

  test('acpConnections and runs decode as strict pages', () => {
    expect(() =>
      decodeDevReply(
        reply('dev.harness.acpConnections', { items: [acpConnection], observedAt: now })
      )
    ).not.toThrow()
    expect(() =>
      decodeDevReply(reply('dev.harness.runs', { items: [harnessRun], observedAt: now }))
    ).not.toThrow()
    expect(() =>
      decodeDevReply(reply('dev.harness.runs', { items: [], observedAt: now }))
    ).not.toThrow()
    expect(() =>
      decodeDevReply(
        reply('dev.harness.runs', {
          items: [harnessRun, harnessRun],
          observedAt: now,
          nextCursor: 'cursor-1',
        })
      )
    ).not.toThrow()
  })

  test('launch/resume/cancel replies decode the HarnessRun DTO', () => {
    for (const operation of [
      'dev.session.launchHarness',
      'dev.session.resumeHarness',
      'dev.session.cancelHarness',
    ] as const) {
      expect(() => decodeDevReply(reply(operation, harnessRun))).not.toThrow()
    }
    expect(() =>
      decodeDevReply(
        reply('dev.session.cancelHarness', {
          ...harnessRun,
          state: 'cancelled',
          finishedAt: now,
          version: 2,
        })
      )
    ).not.toThrow()
    expect(() =>
      decodeDevReply(
        reply('dev.session.launchHarness', {
          ...harnessRun,
          agentProfile: { ...agentProfile, version: 0 },
        })
      )
    ).toThrow()
  })

  test('run replies reject unknown run states', () => {
    expect(() =>
      decodeDevReply(reply('dev.session.launchHarness', { ...harnessRun, state: 'teleporting' }))
    ).toThrow()
  })
})

describe('dev.harness request decoders', () => {
  test('every registry operation exposes a strict request decoder', () => {
    for (const operation of [
      'dev.harness.acpClose',
      'dev.harness.acpConnect',
      'dev.harness.acpConnections',
      'dev.harness.managedPiInstall',
      'dev.harness.managedPiStatus',
      'dev.harness.runs',
    ] as const) {
      expect(devOperationDecoders[operation]).toBeDefined()
    }
    expect(() =>
      devOperationDecoders['dev.harness.acpConnect'].request({
        runtimeSessionId: sessionId,
        expectedGeneration: 2,
        harnessInstallationId: installationId,
      })
    ).not.toThrow()
    expect(() =>
      devOperationDecoders['dev.harness.acpConnect'].request({
        runtimeSessionId: sessionId,
        expectedGeneration: 2,
        harnessInstallationId: installationId,
        protocolVersion: 'x'.repeat(64),
      })
    ).toThrow()
  })
})
