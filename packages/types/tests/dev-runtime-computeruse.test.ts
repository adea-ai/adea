// #472 computer-use lane DTOs. The decoders are the wire contract for the
// supervised desktop automation lanes: every dev.computeruse.* request body
// and success reply decodes, and authority crossovers (wrong scope, wrong
// resource binding, unknown keys, wrong capability sets) fail closed.
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
const laneId = '00000000-0000-4000-8000-0000000000a1'
const consentId = '00000000-0000-4000-8000-0000000000d1'
const sessionId = '00000000-0000-4000-8000-0000000000b1'
const now = '2026-09-19T12:00:00.000Z'

function command(operation: keyof typeof devOperationDefinitions, body: Record<string, unknown>) {
  const definition = devOperationDefinitions[operation]
  return {
    schemaVersion: 1,
    operation,
    requestId: '00000000-0000-4000-8000-000000000004',
    nonce: 'dGhpcy1ub25jZS1oYXMtYXQtbGVhc3QtMTI4LWJpdHM',
    issuedAt: '2026-09-19T12:00:00.000Z',
    expiresAt: '2026-09-19T12:01:00.000Z',
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

const lane = {
  id: laneId,
  scope,
  runtimeSessionId: sessionId,
  state: 'granted',
  automationOwner: 'agent',
  generation: 2,
}

const consent = {
  consentId,
  computerUseLaneId: laneId,
  runtimeSessionId: sessionId,
  scope,
  generation: 2,
  permissionDigest: 'a'.repeat(64),
  createdAt: now,
  expiresAt: '2026-09-19T12:00:59.000Z',
}

const grant = {
  schemaVersion: 1,
  grantId: '00000000-0000-4000-8000-0000000000e1',
  protocol: 'desktop-frames-v1',
  channelId: '00000000-0000-4000-8000-0000000000c2',
  scope,
  resource: { kind: 'computeruse_lane', id: laneId, generation: 2 },
  direction: 'write',
  fromSequence: '0',
  expiresAt: '2026-09-19T12:00:30.000Z',
  maxFrameBytes: 8_388_608,
}

const capabilityReport = {
  hostPlatform: 'macos',
  capabilities: [
    { id: 'input', state: 'available', permissionId: 'accessibility', probedAt: now },
    {
      id: 'capture',
      state: 'unavailable',
      unavailableReason: 'capability_unavailable',
      missingPiece: 'the native capture helper is deferred',
      probedAt: now,
    },
    {
      id: 'ax_tree',
      state: 'unavailable',
      unavailableReason: 'capability_unavailable',
      missingPiece: 'no authorized AX bridge in this lane',
      probedAt: now,
    },
  ],
  probedAt: now,
}

describe('dev.computeruse.* wire contract', () => {
  test('every request body decodes and unknown keys reject', () => {
    expect(devOperationDecoders['dev.computeruse.capabilities'].request({})).toEqual({})
    expect(() =>
      devOperationDecoders['dev.computeruse.capabilities'].request({ injected: true })
    ).toThrow('unknown key')

    expect(
      devOperationDecoders['dev.computeruse.laneCreate'].request({ runtimeSessionId: sessionId })
    ).toEqual({ runtimeSessionId: sessionId })
    expect(() =>
      devOperationDecoders['dev.computeruse.laneCreate'].request({
        runtimeSessionId: sessionId,
        profilePolicyId: 'nope',
      })
    ).toThrow('unknown key')

    expect(
      devOperationDecoders['dev.computeruse.lanes'].request({
        runtimeSessionId: sessionId,
        state: 'granted',
        limit: 100,
      })
    ).toMatchObject({ state: 'granted' })
    expect(() => devOperationDecoders['dev.computeruse.lanes'].request({ state: 'open' })).toThrow(
      'state'
    )

    expect(
      devOperationDecoders['dev.computeruse.consent'].request({
        computerUseLaneId: laneId,
        expectedGeneration: 1,
        confirmationId: 'owner-says-ok',
      })
    ).toMatchObject({ confirmationId: 'owner-says-ok' })
    expect(() =>
      devOperationDecoders['dev.computeruse.consent'].request({
        computerUseLaneId: laneId,
        expectedGeneration: 1,
      })
    ).toThrow('confirmationId')

    expect(
      devOperationDecoders['dev.computeruse.input'].request({
        computerUseLaneId: laneId,
        expectedGeneration: 2,
        consentId,
        direction: 'write',
      })
    ).toMatchObject({ direction: 'write' })
    expect(() =>
      devOperationDecoders['dev.computeruse.input'].request({
        computerUseLaneId: laneId,
        expectedGeneration: 2,
        consentId,
        direction: 'sideways',
      })
    ).toThrow('direction')
  })

  test('the full command envelope decodes for every operation', () => {
    expect(decodeDevCommand(command('dev.computeruse.capabilities', {}))).toBeTruthy()
    expect(
      decodeDevCommand(command('dev.computeruse.laneCreate', { runtimeSessionId: sessionId }))
    ).toBeTruthy()
    expect(decodeDevCommand(command('dev.computeruse.lanes', { state: 'granted' }))).toBeTruthy()
    expect(
      decodeDevCommand(
        command('dev.computeruse.laneClose', {
          computerUseLaneId: laneId,
          expectedGeneration: 2,
        })
      )
    ).toBeTruthy()
    expect(
      decodeDevCommand(
        command('dev.computeruse.consent', {
          computerUseLaneId: laneId,
          expectedGeneration: 1,
          confirmationId: 'owner-says-ok',
        })
      )
    ).toBeTruthy()
    expect(
      decodeDevCommand(
        command('dev.computeruse.attach', {
          computerUseLaneId: laneId,
          expectedGeneration: 2,
          direction: 'read',
        })
      )
    ).toBeTruthy()
    expect(
      decodeDevCommand(
        command('dev.computeruse.input', {
          computerUseLaneId: laneId,
          expectedGeneration: 2,
          consentId,
          direction: 'write',
        })
      )
    ).toBeTruthy()
    expect(
      decodeDevCommand(
        command('dev.computeruse.takeover', {
          computerUseLaneId: laneId,
          expectedGeneration: 2,
        })
      )
    ).toBeTruthy()
    expect(
      decodeDevCommand(
        command('dev.computeruse.release', {
          computerUseLaneId: laneId,
          expectedGeneration: 2,
        })
      )
    ).toBeTruthy()
  })

  test('authority fields in the body fail closed', () => {
    expect(() =>
      decodeDevCommand(
        command('dev.computeruse.consent', {
          computerUseLaneId: laneId,
          expectedGeneration: 1,
          confirmationId: 'x',
          scope,
        })
      )
    ).toThrow('authority field')
  })

  test('a wrong resource binding fails closed', () => {
    const wrong = command('dev.computeruse.takeover', {
      computerUseLaneId: laneId,
      expectedGeneration: 2,
    })
    const mismatched = {
      ...wrong,
      resource: { kind: 'computeruse_lane', id: laneId, generation: 9 },
    }
    expect(() => decodeDevCommand(mismatched)).toThrow('generation')

    const foreignKind = {
      ...command('dev.computeruse.takeover', {
        computerUseLaneId: laneId,
        expectedGeneration: 2,
      }),
      resource: { kind: 'browser_lane', id: laneId, generation: 2 },
    }
    expect(() => decodeDevCommand(foreignKind)).toThrow('kind')
  })

  test('every success reply decodes through its strict DTO decoder', () => {
    expect(decodeDevReply(reply('dev.computeruse.capabilities', capabilityReport))).toBeTruthy()
    expect(decodeDevReply(reply('dev.computeruse.laneCreate', lane))).toBeTruthy()
    expect(
      decodeDevReply(
        reply('dev.computeruse.lanes', {
          items: [lane],
          nextCursor: '2',
          observedAt: now,
        })
      )
    ).toBeTruthy()
    expect(decodeDevReply(reply('dev.computeruse.laneClose', lane))).toBeTruthy()
    expect(decodeDevReply(reply('dev.computeruse.consent', consent))).toBeTruthy()
    expect(decodeDevReply(reply('dev.computeruse.attach', grant))).toBeTruthy()
    expect(decodeDevReply(reply('dev.computeruse.input', grant))).toBeTruthy()
    expect(decodeDevReply(reply('dev.computeruse.takeover', lane))).toBeTruthy()
    expect(decodeDevReply(reply('dev.computeruse.release', lane))).toBeTruthy()
  })

  test('a capability row cannot carry an unavailable-only field in a non-unavailable state', () => {
    const broken = {
      ...capabilityReport,
      capabilities: [
        {
          id: 'input',
          state: 'available',
          missingPiece: 'not missing at all',
          probedAt: now,
        },
      ],
    }
    expect(() => decodeDevReply(reply('dev.computeruse.capabilities', broken))).toThrow(
      'not unavailable'
    )
  })

  test('duplicate capability rows and unknown permission ids reject', () => {
    const duplicated = {
      ...capabilityReport,
      capabilities: [
        { id: 'input', state: 'available', probedAt: now },
        { id: 'input', state: 'denied', probedAt: now },
      ],
    }
    expect(() => decodeDevReply(reply('dev.computeruse.capabilities', duplicated))).toThrow(
      'duplicate capability row'
    )
    const foreignPermission = {
      ...capabilityReport,
      capabilities: [{ id: 'input', state: 'denied', permissionId: 'camera', probedAt: now }],
    }
    expect(() => decodeDevReply(reply('dev.computeruse.capabilities', foreignPermission))).toThrow(
      'permission id'
    )
  })
})
