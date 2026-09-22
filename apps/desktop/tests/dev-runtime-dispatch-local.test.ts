// The in-process dispatch seam (`authority.dispatchLocal`, M12): fail-closed
// without the trusted internal-caller marker, and with it the SAME terminal
// admission steps the socket path runs — structural validation
// (`decodeDevCommand`), the freshness/expiry window, scope admission through
// `authorizeCommand`, capability derivation against the registry, and
// registered-provider invocation. The proofs an internal caller satisfies
// structurally (trusted origin, channel identity, replay — the envelope is
// authored in-process and holds no client-supplied bytes) are never re-faked,
// and the lane's audit records carry no channel fields, which is what makes
// an internal dispatch distinguishable from socket traffic.
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { describe, expect, test } from 'bun:test'

import {
  devCommandProofMessage,
  devOperationDefinitions,
  type DevCommand,
  type DevOperation,
  type DevReply,
} from '../../../packages/types/src/dev-runtime'

import {
  ChannelRejection,
  createChannelAuthority,
  INTERNAL_DISPATCH_MARKER,
  type ChannelAuthority,
} from '../shell/src/dev-runtime/channel/authority'
import { scope } from './worktree-fixtures'

type OkReply = Extract<DevReply, { ok: true }>
type RefusedReply = Extract<DevReply, { ok: false }>

function expectOk(reply: DevReply): OkReply {
  if (!reply.ok) throw new Error(`expected an ok reply, got ${reply.error.code}`)
  return reply
}

function expectRefused(reply: DevReply): RefusedReply {
  if (reply.ok) throw new Error('expected a refused reply')
  return reply
}

function authority(options?: {
  authorizeCommand?: (command: DevCommand, identity?: unknown) => void
}): ChannelAuthority {
  return createChannelAuthority({
    shellHost: '127.0.0.1',
    shellOrigin: 'https://127.0.0.1:4789',
    ...(options?.authorizeCommand ? { authorizeCommand: options.authorizeCommand } : {}),
  })
}

function snapshotCommand(overrides: Partial<DevCommand> = {}): DevCommand {
  const definition = devOperationDefinitions['dev.capability.snapshot']
  return {
    schemaVersion: 1,
    operation: 'dev.capability.snapshot',
    requestId: randomUUID(),
    nonce: Buffer.from(randomBytes(16)).toString('base64url'),
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    scope,
    capabilities: [...definition.capabilities],
    body: {},
    ...overrides,
  }
}

describe('dispatchLocal fail-closed', () => {
  test('a wrong, missing, or fabricated marker refuses before any command work', async () => {
    const runtime = authority()
    let providerCalls = 0
    runtime.registerCommandProvider('dev.capability.snapshot', () => {
      providerCalls += 1
      return null
    })
    const command = snapshotCommand()
    await expect(
      runtime.dispatchLocal(Symbol('adea.dev-runtime.internal-dispatch') as never, command)
    ).rejects.toThrow(ChannelRejection)
    await expect(runtime.dispatchLocal(undefined as never, command)).rejects.toThrow(
      ChannelRejection
    )
    await expect(runtime.dispatchLocal('internal-dispatch' as never, command)).rejects.toThrow(
      ChannelRejection
    )
    expect(providerCalls).toBe(0)
    // The refusal is a trust refusal (origin vocabulary), not a command
    // refusal: no command was ever considered.
    expect(runtime.countersSnapshot().originRefused).toBe(3)
    expect(runtime.countersSnapshot().commandsAccepted).toBe(0)
    expect(runtime.auditSnapshot().every((record) => record.kind !== 'command_accepted')).toBe(true)
  })
})

describe('dispatchLocal terminal steps (marker satisfied)', () => {
  test('a valid envelope dispatches the registered provider and audits without channel fields', async () => {
    const runtime = authority()
    runtime.registerCommandProvider('dev.capability.snapshot', () => ({ echoed: true }))
    const reply = expectOk(await runtime.dispatchLocal(INTERNAL_DISPATCH_MARKER, snapshotCommand()))
    expect(reply.value).toEqual({ echoed: true })
    expect(runtime.countersSnapshot().commandsAccepted).toBe(1)
    const accepted = runtime.auditSnapshot().at(-1)
    expect(accepted).toMatchObject({
      kind: 'command_accepted',
      operation: 'dev.capability.snapshot',
    })
    // No channel fields on the internal lane: nothing authenticated a channel.
    expect(accepted?.channelId).toBeUndefined()
    expect(accepted?.clientCredentialId).toBeUndefined()
  })

  test('scope admission runs before dispatch: the hook sees the command and no channel identity', async () => {
    const seen: { accountId: string; identity: unknown }[] = []
    const runtime = authority({
      authorizeCommand: (command, identity) => {
        seen.push({ accountId: command.scope.accountId, identity })
      },
    })
    runtime.registerCommandProvider('dev.capability.snapshot', () => null)
    expectOk(await runtime.dispatchLocal(INTERNAL_DISPATCH_MARKER, snapshotCommand()))
    expect(seen.length).toBe(1)
    expect(seen[0]?.accountId).toBe(scope.accountId)
    expect(seen[0]?.identity).toBeUndefined()
  })

  test('a refusing scope admission rejects the dispatch with no provider call', async () => {
    let providerCalls = 0
    const runtime = authority({
      authorizeCommand: () => {
        throw new Error('workspace mismatch')
      },
    })
    runtime.registerCommandProvider('dev.capability.snapshot', () => {
      providerCalls += 1
      return null
    })
    const refused = expectRefused(
      await runtime.dispatchLocal(INTERNAL_DISPATCH_MARKER, snapshotCommand())
    )
    expect(refused.error.code).toBe('channel_unauthenticated')
    expect(providerCalls).toBe(0)
    expect(runtime.countersSnapshot().commandsRefused).toBe(1)
  })

  test('an expired envelope or an over-long lifetime is refused before dispatch', async () => {
    const runtime = authority()
    let providerCalls = 0
    runtime.registerCommandProvider('dev.capability.snapshot', () => {
      providerCalls += 1
      return null
    })
    const expired = snapshotCommand({
      issuedAt: new Date(Date.now() - 120_000).toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    })
    const expiredReply = expectRefused(
      await runtime.dispatchLocal(INTERNAL_DISPATCH_MARKER, expired)
    )
    expect(expiredReply.error.code).toBe('token_expired')
    const overlong = snapshotCommand({
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 61_000).toISOString(),
    })
    const overlongReply = expectRefused(
      await runtime.dispatchLocal(INTERNAL_DISPATCH_MARKER, overlong)
    )
    expect(overlongReply.error.code).toBe('token_expired')
    expect(providerCalls).toBe(0)
    expect(runtime.countersSnapshot().tokenExpired).toBe(2)
  })

  test('an envelope that violates the registry (capability set, malformed shape) is refused without dispatch', async () => {
    const runtime = authority()
    let providerCalls = 0
    runtime.registerCommandProvider('dev.capability.snapshot', () => {
      providerCalls += 1
      return null
    })
    // A capability set that does not equal the registry's fails the same
    // structural decoder the socket frame path reaches.
    const mismatched = snapshotCommand({ capabilities: ['dev.git.write'] })
    const mismatchReply = expectRefused(
      await runtime.dispatchLocal(INTERNAL_DISPATCH_MARKER, mismatched)
    )
    expect(mismatchReply.error.code).toBe('invalid_state')
    // A non-command object is refused typed, never thrown, never dispatched.
    const garbageReply = expectRefused(
      await runtime.dispatchLocal(INTERNAL_DISPATCH_MARKER, {
        nonsense: true,
      } as unknown as DevCommand)
    )
    expect(garbageReply.error.code).toBe('invalid_state')
    expect(providerCalls).toBe(0)
    expect(runtime.countersSnapshot().commandsRefused).toBe(2)
  })

  test('an operation with no registered provider is typed-unavailable', async () => {
    const runtime = authority()
    // A valid envelope for an operation nobody registered: the decoder accepts
    // it (registry-consistent capabilities, empty body), the gate does not.
    const definition = devOperationDefinitions['dev.group.list']
    const unregistered = snapshotCommand({
      operation: 'dev.group.list' as DevOperation,
      capabilities: [...definition.capabilities],
    })
    const refused = expectRefused(
      await runtime.dispatchLocal(INTERNAL_DISPATCH_MARKER, unregistered)
    )
    expect(refused.error.code).toBe('capability_unavailable')
    expect(refused.error.retryable).toBe(true)
    expect(runtime.registeredOperations()).not.toContain('dev.group.list')
  })

  test('a provider-thrown typed DevError surfaces verbatim as the refusal', async () => {
    const runtime = authority()
    runtime.registerCommandProvider('dev.capability.snapshot', () => {
      throw { code: 'stale_generation', retryable: false, message: 'generation moved' }
    })
    const refused = expectRefused(
      await runtime.dispatchLocal(INTERNAL_DISPATCH_MARKER, snapshotCommand())
    )
    expect(refused.error.code).toBe('stale_generation')
    expect(refused.error.message).toBe('generation moved')
  })
})

describe('dispatchLocal parity with the socket path', () => {
  test('both lanes reach the same registered provider instance', async () => {
    const runtime = authority()
    let providerCalls = 0
    runtime.registerCommandProvider('dev.capability.snapshot', () => {
      providerCalls += 1
      return { calls: providerCalls }
    })
    // The internal lane.
    const localReply = expectOk(
      await runtime.dispatchLocal(INTERNAL_DISPATCH_MARKER, snapshotCommand())
    )
    expect(localReply.value).toEqual({ calls: 1 })
    // The socket lane: full trusted handshake plus a signed authorized frame.
    const bootstrap = runtime.issueLaunchBootstrap()
    const at = Date.now()
    const handshake = runtime.handshake(
      {
        schemaVersion: 1,
        method: 'dev.runtime.handshake.v1',
        requestId: '00000000-0000-4000-8000-0000000000c0',
        bootstrap,
        supportedProtocolVersions: ['1'],
        nonce: 'dGhpcy1ub25jZS1oYXMtYXQtbGVhc3QtMTI4LWJpdHM',
        issuedAt: new Date(at - 1000).toISOString(),
        expiresAt: new Date(at + 30_000).toISOString(),
      },
      { trusted: true }
    )
    if (!handshake.ok) throw new Error('handshake refused')
    const secret = Buffer.from(handshake.clientSecret, 'base64url')
    const command = snapshotCommand()
    const proof = createHmac('sha256', secret)
      .update(
        devCommandProofMessage({
          channelId: handshake.channelId,
          clientCredentialId: handshake.clientCredentialId,
          command,
        }),
        'utf8'
      )
      .digest('base64url')
    const socketReply = expectOk(
      await runtime.execute(
        {
          channelId: handshake.channelId,
          clientCredentialId: handshake.clientCredentialId,
          command,
          proof,
        },
        { trusted: true }
      )
    )
    expect(socketReply.value).toEqual({ calls: 2 })
    // One handler, two lanes.
    expect(providerCalls).toBe(2)
    expect(runtime.countersSnapshot().commandsAccepted).toBe(2)
    // The socket record carries its channel; the internal record carries none.
    const accepted = runtime.auditSnapshot().filter((record) => record.kind === 'command_accepted')
    expect(accepted.length).toBe(2)
    expect(accepted.some((record) => record.channelId === undefined)).toBe(true)
    expect(accepted.some((record) => typeof record.channelId === 'string')).toBe(true)
  })
})
