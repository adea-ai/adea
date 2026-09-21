// #399 residue: the desktop renderer's bulk-stream attach relay. The relay
// must reproduce the gateway's attach contract on the page's own channel —
// real `attachStream` consumption (single-use, channel-bound, proof-verified),
// the inbound frame discipline, and the real `file-bytes-v1` provider byte
// halves — with frames crossing as JSON-safe relay payloads.
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import {
  devCommandProofMessage,
  devOperationDefinitions,
  devStreamAttachProofMessage,
  type DevCommand,
  type DevOperation,
  type DevStreamGrant,
  type Scope,
} from '../../../packages/types/src/dev-runtime'

import { createChannelAuthority } from '../shell/src/dev-runtime/channel/authority'
import { registerFilesRuntime } from '../shell/src/dev-runtime/files/register'
import { directoryIdentity } from '../shell/src/dev-runtime/worktrees/identity'
import {
  createFileStreamRelay,
  FILE_STREAM_RELAY_EVENT,
  type RelayFrame,
} from '../shell/src/dev-runtime/stream-relay'

const scope: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}

const WORKTREE_ID = 'wt-file-relay-001'
let generation = 7
let roots: { root: string; identity: ReturnType<typeof directoryIdentity> } | undefined
const scratch: string[] = []

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), 'adea-file-stream-relay-'))
  scratch.push(base)
  const root = join(base, 'worktree')
  mkdirSync(root)
  roots = { root, identity: directoryIdentity(root) }
})

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

function fixtureRoot(): string {
  if (!roots) throw new Error('fixture missing')
  return roots.root
}

function wsPath(relativePath: string): Record<string, unknown> {
  return {
    worktreeId: WORKTREE_ID,
    rootIdentity: { ...roots!.identity.identity },
    relativePath,
  }
}

function filesResource(expected = generation) {
  return { kind: 'workspace_root', id: WORKTREE_ID, generation: expected }
}

type Published = { streamId: string; frame: RelayFrame }

function harness() {
  const providers = new Map<string, (session: never) => void>()
  const authority = createChannelAuthority({
    shellHost: '127.0.0.1',
    shellOrigin: 'https://127.0.0.1:4789',
  })
  registerFilesRuntime({
    authority,
    scope,
    gateway: {
      registerStreamHandler: (protocol, provider) => {
        providers.set(protocol, provider as unknown as (session: never) => void)
      },
    },
    resolveWorktree: (worktreeId) => {
      if (!roots || worktreeId !== WORKTREE_ID) return undefined
      return {
        canonicalRoot: roots.root,
        rootIdentity: { ...roots.identity.identity },
        generation,
        lifecycle: 'ready',
      }
    },
    rgPath: () => 'rg',
  })
  const published: Published[] = []
  const relay = createFileStreamRelay({
    authority,
    providerFor: (protocol) => providers.get(protocol) as never,
    publish: (event, payload) => {
      if (event !== FILE_STREAM_RELAY_EVENT) throw new Error(`unexpected event ${event}`)
      published.push(payload as Published)
    },
  })

  const bootstrap = authority.issueLaunchBootstrap()
  const at = Date.now()
  const handshake = authority.handshake(
    {
      schemaVersion: 1,
      method: 'dev.runtime.handshake.v1',
      requestId: '00000000-0000-4000-8000-000000000010',
      bootstrap,
      supportedProtocolVersions: ['1'],
      nonce: 'dGhpcy1ub25jZS1oYXMtYXQtbGVhc3QtMTI4LWJpdHM',
      issuedAt: new Date(at - 1000).toISOString(),
      expiresAt: new Date(at + 30_000).toISOString(),
    },
    { trusted: true }
  )
  if (!handshake.ok) throw new Error('handshake refused')
  const identity = {
    channelId: handshake.channelId,
    clientCredentialId: handshake.clientCredentialId,
  }
  const secret = Buffer.from(handshake.clientSecret, 'base64url')

  async function execute(command: DevCommand) {
    const proof = createHmac('sha256', secret)
      .update(
        devCommandProofMessage({
          channelId: identity.channelId,
          clientCredentialId: identity.clientCredentialId,
          command,
        }),
        'utf8'
      )
      .digest('base64url')
    return authority.execute(
      {
        channelId: identity.channelId,
        clientCredentialId: identity.clientCredentialId,
        command,
        proof,
      },
      { trusted: true }
    )
  }

  function makeCommand(operation: DevOperation, body: Record<string, unknown>): DevCommand {
    const definition = devOperationDefinitions[operation]
    return {
      schemaVersion: 1,
      operation,
      requestId: '00000000-0000-4000-8000-000000000011',
      nonce: Buffer.from(randomBytes(16)).toString('base64url'),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      scope,
      capabilities: [...definition.capabilities].toSorted((left, right) =>
        left < right ? -1 : left > right ? 1 : 0
      ),
      resource: filesResource(),
      body,
    }
  }

  /** The bridge-side signing shape: attach proof under the channel secret. */
  function signAttach(grant: DevStreamGrant) {
    const attach = {
      schemaVersion: 1 as const,
      grantId: grant.grantId,
      requestId: randomUUID(),
      nonce: Buffer.from(randomBytes(16)).toString('base64url'),
      fromSequence: grant.fromSequence,
      proof: '',
    }
    attach.proof = createHmac('sha256', secret)
      .update(devStreamAttachProofMessage({ channelId: identity.channelId, attach }))
      .digest('base64url')
    return attach
  }

  async function openRelay(grant: DevStreamGrant, override?: { proof?: string }) {
    const attach = signAttach(grant)
    if (override?.proof !== undefined) attach.proof = override.proof
    return relay.open({ identity, attach })
  }

  function frames(streamId: string): RelayFrame[] {
    return published.filter((entry) => entry.streamId === streamId).map((entry) => entry.frame)
  }

  function dataBytes(streamId: string): Uint8Array {
    const chunks = frames(streamId)
      .filter((frame): frame is Extract<RelayFrame, { type: 'data' }> => frame.type === 'data')
      .map((frame) => Buffer.from(frame.bytes, 'base64'))
    return new Uint8Array(Buffer.concat(chunks))
  }

  async function ackAll(grantId: string): Promise<void> {
    for (;;) {
      const datas = frames(grantId).filter(
        (frame): frame is Extract<RelayFrame, { type: 'data' }> => frame.type === 'data'
      )
      const ackedBytes = frames(grantId)
        .filter((frame): frame is Extract<RelayFrame, { type: 'ack' }> => frame.type === 'ack')
        .reduce((sum, frame) => sum + frame.availableCreditBytes, 0)
      const served = datas.reduce(
        (sum, frame) => sum + Buffer.from(frame.bytes, 'base64').byteLength,
        0
      )
      const outstanding = served - ackedBytes
      if (outstanding <= 0) break
      const last = datas[datas.length - 1]
      if (!last) break
      const verdict = relay.frame({
        identity,
        streamId: grantId,
        frame: {
          type: 'ack',
          throughSequence: last.sequence,
          availableCreditBytes: outstanding,
        },
      })
      if (verdict.status !== 'accepted') return
    }
  }

  return {
    authority,
    relay,
    identity,
    execute,
    makeCommand,
    signAttach,
    openRelay,
    frames,
    dataBytes,
    ackAll,
    mintForeignGrant: () =>
      authority.mintStreamGrant({
        identity,
        protocol: 'terminal-bytes-v1',
        scope,
        resource: { kind: 'terminal', id: 't-1', generation: 1 },
        direction: 'write',
        maxFrameBytes: 1024,
      }),
  }
}

type Harness = ReturnType<typeof harness>

async function grantFor(
  state: Harness,
  operation: 'dev.files.readStream' | 'dev.files.writeStream',
  body: Record<string, unknown>
): Promise<DevStreamGrant> {
  const reply = await state.execute(state.makeCommand(operation, body))
  expect(reply.ok).toBe(true)
  if (!reply.ok) throw new Error(`grant refused: ${JSON.stringify(reply.error)}`)
  return reply.value
}

async function statIdentity(state: Harness, relativePath: string) {
  const reply = await state.execute(
    state.makeCommand('dev.files.stat', { worktreeId: WORKTREE_ID, path: wsPath(relativePath) })
  )
  expect(reply.ok).toBe(true)
  if (!reply.ok) throw new Error('stat failed')
  return reply.value.identity as { mtimeNs: string; size: string }
}

describe('file-stream relay (grant → attach → bytes → ack → close)', () => {
  test('attached read pumps the real provider under ack credit and closes normal', async () => {
    const state = harness()
    const root = fixtureRoot()
    const relativePath = 'assets/bulk-read.bin'
    mkdirSync(join(root, 'assets'))
    // Above the 256 KiB control cap; below the 1 MiB credit high-water so the
    // close only arrives after the client's acks return.
    const content = new Uint8Array(300 * 1024)
    for (let index = 0; index < content.length; index += 1) content[index] = (index * 31 + 7) % 256
    writeFileSync(join(root, relativePath), content)
    const identity = await statIdentity(state, relativePath)

    const grant = await grantFor(state, 'dev.files.readStream', {
      worktreeId: WORKTREE_ID,
      path: wsPath(relativePath),
      expectedIdentity: identity,
      direction: 'read',
    })
    expect(grant.maxFrameBytes).toBe(64 * 1024)

    const opened = await state.openRelay(grant)
    expect(opened.status).toBe('granted')

    const early = state.frames(grant.grantId)
    expect(early[0]).toMatchObject({ type: 'opened', protocol: 'file-bytes-v1', generation })
    expect(state.dataBytes(grant.grantId).byteLength).toBe(content.byteLength)

    await state.ackAll(grant.grantId)
    const closes = state.frames(grant.grantId).filter((frame) => frame.type === 'close')
    expect(closes).toEqual([{ type: 'close', code: 'normal', reason: 'bulk read complete' }])
    expect(new Uint8Array(state.dataBytes(grant.grantId))).toEqual(content)
  })

  test('attached write lands a byte-exact file through offset-stamped input', async () => {
    const state = harness()
    const root = fixtureRoot()
    const relativePath = 'assets/bulk-write.bin'
    const content = new Uint8Array(200 * 1024)
    for (let index = 0; index < content.length; index += 1) content[index] = (index * 17 + 3) % 256
    writeFileSync(join(root, relativePath), Buffer.from([1, 2, 3]))
    const before = await statIdentity(state, relativePath)

    const grant = await grantFor(state, 'dev.files.writeStream', {
      worktreeId: WORKTREE_ID,
      path: wsPath(relativePath),
      expectedIdentity: before,
      byteLength: String(content.byteLength),
      contentSha256: createHash('sha256').update(content).digest('hex'),
      eolPolicy: 'preserve',
      direction: 'write',
    })
    const opened = await state.openRelay(grant)
    expect(opened.status).toBe('granted')

    // Client half: contiguous generation-stamped offset frames, 64 KiB each.
    let offset = 0
    while (offset < content.byteLength) {
      const end = Math.min(offset + grant.maxFrameBytes, content.byteLength)
      const verdict = state.relay.frame({
        identity: state.identity,
        streamId: grant.grantId,
        frame: {
          type: 'input',
          sequence: String(offset),
          generation: grant.resource.generation,
          bytes: Buffer.from(content.slice(offset, end)).toString('base64'),
        },
      })
      expect(verdict.status).toBe('accepted')
      offset = end
    }

    const closes = state.frames(grant.grantId).filter((frame) => frame.type === 'close')
    expect(closes).toEqual([{ type: 'close', code: 'normal', reason: 'bulk write complete' }])
    expect(new Uint8Array(readFileSync(join(root, relativePath)))).toEqual(content)
    const after = await statIdentity(state, relativePath)
    expect(after.mtimeNs).not.toBe(before.mtimeNs)
  })

  test('attach is single-use and proof-verified', async () => {
    const state = harness()
    const root = fixtureRoot()
    writeFileSync(join(root, 'one-use.txt'), 'tiny')
    const identity = await statIdentity(state, 'one-use.txt')
    const grant = await grantFor(state, 'dev.files.readStream', {
      worktreeId: WORKTREE_ID,
      path: wsPath('one-use.txt'),
      expectedIdentity: identity,
      direction: 'read',
    })
    const first = await state.openRelay(grant)
    expect(first.status).toBe('granted')
    // Drain the tiny read so the session settles before the replay attempt.
    await state.ackAll(grant.grantId)

    // Same grant, fresh attach: the authority refuses the spent grant.
    const replay = await state.relay.open({
      identity: state.identity,
      attach: state.signAttach(grant),
    })
    expect(replay.status).toBe('refused')
    if (replay.status === 'refused') expect(replay.code).toBe('replay_rejected')

    // A tampered proof never binds a session.
    const fresh = await grantFor(state, 'dev.files.readStream', {
      worktreeId: WORKTREE_ID,
      path: wsPath('one-use.txt'),
      expectedIdentity: await statIdentity(state, 'one-use.txt'),
      direction: 'read',
    })
    const forged = await state.openRelay(fresh, {
      proof: Buffer.from(randomBytes(32)).toString('base64url'),
    })
    expect(forged.status).toBe('refused')
    if (forged.status === 'refused') expect(forged.code).toBe('identity_mismatch')
  })

  test('frames from another channel and providerless protocols are refused typed', async () => {
    const state = harness()
    // Providerless protocol: the authority's acceptProtocol gate refuses
    // before the single-use grant is consumed.
    const foreign = state.mintForeignGrant()
    const providerless = await state.openRelay(foreign)
    expect(providerless.status).toBe('refused')
    if (providerless.status === 'refused') expect(providerless.code).toBe('capability_unavailable')

    // Frame identity binding: a live read stream refuses frames claiming
    // another channel.
    writeFileSync(join(fixtureRoot(), 'bound.txt'), 'bound')
    const identity = await statIdentity(state, 'bound.txt')
    const grant = await grantFor(state, 'dev.files.readStream', {
      worktreeId: WORKTREE_ID,
      path: wsPath('bound.txt'),
      expectedIdentity: identity,
      direction: 'read',
    })
    expect((await state.openRelay(grant)).status).toBe('granted')
    const impostor = {
      channelId: '00000000-0000-4000-8000-00000000bad1',
      clientCredentialId: state.identity.clientCredentialId,
    }
    const verdict = state.relay.frame({
      identity: impostor,
      streamId: grant.grantId,
      frame: { type: 'ack', throughSequence: '0', availableCreditBytes: 5 },
    })
    expect(verdict.status).toBe('refused')
    if (verdict.status === 'refused') expect(verdict.code).toBe('identity_mismatch')

    // Wrong-direction input on a read grant closes the stream through the
    // gateway's own inbound validator.
    const hostile = state.relay.frame({
      identity: state.identity,
      streamId: grant.grantId,
      frame: {
        type: 'input',
        sequence: '0',
        generation,
        bytes: Buffer.from('x').toString('base64'),
      },
    })
    expect(hostile.status).toBe('closed')
    expect(state.frames(grant.grantId).at(-1)).toMatchObject({ type: 'close' })
  })

  test('dispose tears the session down and the provider cleans up', async () => {
    const state = harness()
    writeFileSync(join(fixtureRoot(), 'dispose.bin'), Buffer.alloc(400 * 1024, 9))
    const identity = await statIdentity(state, 'dispose.bin')
    const grant = await grantFor(state, 'dev.files.readStream', {
      worktreeId: WORKTREE_ID,
      path: wsPath('dispose.bin'),
      expectedIdentity: identity,
      direction: 'read',
    })
    expect((await state.openRelay(grant)).status).toBe('granted')
    expect(state.relay.dispose({ identity: state.identity, streamId: grant.grantId }).status).toBe(
      'accepted'
    )
    // A disposed session no longer accepts frames.
    const after = state.relay.frame({
      identity: state.identity,
      streamId: grant.grantId,
      frame: { type: 'ack', throughSequence: '0', availableCreditBytes: 1 },
    })
    expect(after.status).toBe('refused')
    expect(existsSync(join(fixtureRoot(), 'dispose.bin'))).toBe(true)
  })
})
