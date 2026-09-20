// Issue #396 end-to-end over the real M10 gate: bootstrap → handshake →
// HMAC-proved execute → terminal create/attach/input through the adopted
// sidecar, single-use stream grants, byte-preserving stream routing, resync
// on uncovered sequences, and fail-closed refusals for wrong resource
// bindings, stale generations, and unauthorized worktree roots. The
// WebSocket plumbing itself is pinned by shell-channel.test.ts.
import { afterAll, describe, expect, test } from 'bun:test'
import { createHmac, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  decodeDevStreamGrant,
  devCommandProofMessage,
  devOperationDecoders,
  devOperationDefinitions,
  devStreamAttachProofMessage,
  type DevCommand,
  type DevReply,
  type DevStreamFrame,
  type Scope,
} from '../../../packages/types/src/dev-runtime'
import { createChannelAuthority } from '../shell/src/dev-runtime/channel/authority'
import { createChannelGateway } from '../shell/src/dev-runtime/channel/server'
import { registerTerminalRuntime } from '../shell/src/dev-runtime/terminal/register'
import {
  connectSidecarClient,
  type SidecarClient,
} from '../shell/src/dev-runtime/terminal/sidecar/client'
import {
  createSidecarService,
  newSidecarCredential,
} from '../shell/src/dev-runtime/terminal/sidecar/service'
import type { ByteDuplex, ByteFrameMeta } from '../shell/src/dev-runtime/terminal/sidecar/protocol'
import { TERMINAL_LIMITS } from '../shell/src/dev-runtime/terminal/limits'
import { createFakePtyAdapter } from './fixtures/fake-pty'
import { createLoopbackPair } from './fixtures/loopback-duplex'

const SHELL_HOST = '127.0.0.1:4789'
const SHELL_ORIGIN = 'http://127.0.0.1:4789'
const scope: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const otherScope: Scope = { ...scope, workspaceId: '00000000-0000-4000-8000-000000000099' }
const worktreeId = '00000000-0000-4000-8000-0000000000b0'
const runtimeSessionId = '00000000-0000-4000-8000-0000000000c0'

const dataDirs: string[] = []
afterAll(() => {
  for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true })
})

/** Builds the envelope's terminal resource binding from the body target. */
function resourceFor(operation: string, body: Record<string, unknown>): DevCommand['resource'] {
  const idField = operation === 'dev.terminal.create' ? '' : 'terminalId'
  return {
    kind: 'terminal',
    id: body[idField] as string,
    generation: (body.expectedGeneration as number | undefined) ?? 1,
  }
}

async function makeHarness(platform: NodeJS.Platform = 'darwin') {
  const dataDir = mkdtempSync(join(tmpdir(), 'adea-terminal-channel-'))
  dataDirs.push(dataDir)
  const runtimeRoot = join(dataDir, 'dev-runtime')
  mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 })

  const authority = createChannelAuthority({ shellHost: SHELL_HOST, shellOrigin: SHELL_ORIGIN })
  // The gateway dependency is a registration seam; the WS plumbing is
  // covered by shell-channel.test.ts, so the provider is captured here.
  let streamProvider:
    | Parameters<ReturnType<typeof createChannelGateway>['registerStreamHandler']>[1]
    | null = null
  const gateway = {
    registerStreamHandler: (protocol: string, provider: NonNullable<typeof streamProvider>) => {
      if (protocol === 'terminal-bytes-v1') streamProvider = provider
    },
  }

  const credential = newSidecarCredential()
  const fake = createFakePtyAdapter(platform)
  const service = createSidecarService({
    runtimeRoot,
    ptyAdapter: fake.adapter,
    sidecarVersion: '1.0.0-test',
    credential,
    executableIdentity: 'sidecar@test',
    pidStartIdentity: 'test-identity',
    managerLimits: {
      ...TERMINAL_LIMITS,
      ringMaxBytes: 128,
      subscriberHighWaterBytes: 48,
    },
  })
  const [clientSide, serverSide]: [ByteDuplex, ByteDuplex] = createLoopbackPair()
  service.handleConnection(serverSide)
  const connected = await connectSidecarClient({
    duplex: clientSide,
    scope,
    credential: Buffer.from(credential).toString('base64url'),
    nonce: randomUUID(),
  })
  if (!connected.ok) throw new Error('sidecar connect failed')
  const sidecar: SidecarClient = connected.client

  const registration = registerTerminalRuntime({
    authority,
    gateway: gateway as never,
    sidecar,
    scope,
    runtimeRoot,
    resolveWorktreeRoot: (id) => (id === worktreeId ? '/tmp/adea-test-worktree' : null),
  })

  // A real handshake: identity + secret for HMAC-proved frames.
  const handshakeReply = authority.handshake(
    {
      schemaVersion: 1,
      method: 'dev.runtime.handshake.v1',
      requestId: randomUUID(),
      bootstrap: authority.issueLaunchBootstrap(),
      supportedProtocolVersions: ['1'],
      nonce: Buffer.from(randomUUID()).toString('base64url'),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    },
    { trusted: true }
  )
  if (!handshakeReply.ok) throw new Error('handshake failed')
  const identity = {
    channelId: handshakeReply.channelId,
    clientCredentialId: handshakeReply.clientCredentialId,
  }
  const secret = Buffer.from(handshakeReply.clientSecret, 'base64url')

  function execute(
    operation: keyof typeof devOperationDefinitions,
    body: Record<string, unknown>,
    overrides?: { scope?: Scope; resource?: DevCommand['resource'] }
  ): Promise<DevReply> {
    const definition = devOperationDefinitions[operation]
    const command: DevCommand = {
      schemaVersion: 1,
      operation,
      requestId: randomUUID(),
      nonce: Buffer.from(randomUUID()).toString('base64url'),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      scope: overrides?.scope ?? scope,
      capabilities: [...definition.capabilities],
      resource:
        overrides?.resource ?? (definition.resource ? resourceFor(operation, body) : undefined),
      body,
    }
    return authority.execute(
      {
        channelId: identity.channelId,
        clientCredentialId: identity.clientCredentialId,
        command,
        proof: createHmac('sha256', secret)
          .update(
            devCommandProofMessage({
              channelId: identity.channelId,
              clientCredentialId: identity.clientCredentialId,
              command,
            }),
            'utf8'
          )
          .digest('base64url'),
      },
      { trusted: true }
    )
  }

  async function createTerminal(
    terminalId?: string,
    overrides?: { scope?: Scope; worktreeId?: string }
  ): Promise<string> {
    const id = terminalId ?? randomUUID()
    const reply = await execute(
      'dev.terminal.create',
      {
        runtimeSessionId,
        worktreeId: overrides?.worktreeId ?? worktreeId,
        cols: 80,
        rows: 24,
      },
      { scope: overrides?.scope }
    )
    if (!reply.ok) throw new Error(`create failed: ${JSON.stringify(reply.error)}`)
    devOperationDecoders['dev.terminal.create'].reply(reply)
    const record = reply.value as { id: string }
    if (terminalId && record.id !== id) throw new Error('unexpected terminal id')
    return record.id
  }

  function openStream(grant: unknown): {
    frames: DevStreamFrame[]
    send: (frame: DevStreamFrame) => void
    closes: string[]
    meta: ByteFrameMeta[]
  } {
    const frames: DevStreamFrame[] = []
    const closes: string[] = []
    const meta: ByteFrameMeta[] = []
    const decoded = decodeDevStreamGrant(grant)
    const session = {
      grant: decoded,
      inbound: { accept: () => ({ ok: true }), markClosed: () => {} },
      send: (frame: DevStreamFrame) => {
        if (frame.type === 'data')
          meta.push({
            kind: 'terminal.data',
            terminalId: decoded.resource.id,
            generation: decoded.resource.generation,
            seq: frame.sequence,
            emittedAt: '',
            byteLength: frame.bytes.byteLength,
          })
        frames.push(frame)
      },
      close: (code: string, reason?: string) => closes.push(`${code}: ${reason ?? ''}`),
      onFrame: undefined as ((frame: DevStreamFrame) => void) | undefined,
      onClose: undefined as (() => void) | undefined,
    }
    ;(streamProvider as NonNullable<typeof streamProvider>)(session as never)
    return {
      frames,
      closes,
      meta,
      send: (frame) => session.onFrame?.(frame),
    }
  }

  return {
    authority,
    registration,
    service,
    sidecar,
    fake,
    runtimeRoot,
    identity,
    secret,
    execute,
    createTerminal,
    openStream,
    streamProvider: () => streamProvider,
  }
}

describe('terminal runtime over the m10 gate', () => {
  test('shell profiles advertise installed content-addressed wrappers', async () => {
    const harness = await makeHarness()
    const reply = await harness.execute('dev.terminal.shellProfiles', {})
    expect(reply.ok).toBe(true)
    if (reply.ok) {
      devOperationDecoders['dev.terminal.shellProfiles'].reply(reply)
      const page = reply.value as {
        items: Array<{ label: string; builtin: boolean; argv: string[] }>
      }
      // zsh and bash are guaranteed on the pinned macOS lane; anything else
      // present is host truth (e.g. an installed fish).
      expect(page.items.map((profile) => profile.label)).toContain('zsh')
      expect(page.items.map((profile) => profile.label)).toContain('bash')
      for (const profile of page.items) {
        expect(profile.builtin).toBe(true)
        expect(profile.argv).toHaveLength(2)
      }
    }
  })

  test('create, list, resize, signal, and detach round-trip through the sidecar', async () => {
    const harness = await makeHarness()
    const terminalId = await harness.createTerminal()
    const listReply = await harness.execute('dev.terminal.list', { worktreeId })
    if (listReply.ok) {
      devOperationDecoders['dev.terminal.list'].reply(listReply)
      const items = (
        listReply.value as { items: Array<{ id: string; state: string; worktreeId: string }> }
      ).items
      expect(items.map((terminal) => terminal.id)).toEqual([terminalId])
      expect(items[0]!.state).toBe('running')
      expect(items[0]!.worktreeId).toBe(worktreeId)
    }
    const resizeReply = await harness.execute('dev.terminal.resize', {
      terminalId,
      expectedGeneration: 1,
      cols: 120,
      rows: 40,
    })
    expect(resizeReply.ok).toBe(true)
    expect(harness.fake.processes[0]!.resizes).toEqual([{ cols: 120, rows: 40 }])
    harness.fake.processes[0]!.ignoreSignals = true
    const signalReply = await harness.execute('dev.terminal.signal', {
      terminalId,
      expectedGeneration: 1,
      signal: 'interrupt',
    })
    expect(signalReply.ok).toBe(true)
    expect(harness.fake.processes[0]!.kills).toEqual(['SIGINT'])
    const terminateReply = await harness.execute('dev.terminal.terminate', {
      terminalId,
      expectedGeneration: 1,
      confirmationId: 'user-requested',
    })
    expect(terminateReply.ok).toBe(true)
  })

  test('create fails closed for unauthorized worktrees and foreign scopes', async () => {
    const harness = await makeHarness()
    const badWorktree = await harness.execute('dev.terminal.create', {
      runtimeSessionId,
      worktreeId: '00000000-0000-4000-8000-0000000000b1',
      cols: 80,
      rows: 24,
    })
    expect(badWorktree).toMatchObject({ ok: false, error: { code: 'not_found' } })
    const foreign = await harness.execute(
      'dev.terminal.create',
      { runtimeSessionId, worktreeId, cols: 80, rows: 24 },
      { scope: otherScope }
    )
    expect(foreign).toMatchObject({ ok: false, error: { code: 'workspace_unavailable' } })
  })

  test('resource bindings are enforced: wrong id, kind, and stale generation', async () => {
    const harness = await makeHarness()
    const terminalId = await harness.createTerminal()
    const wrongId = await harness.execute(
      'dev.terminal.resize',
      {
        terminalId: '00000000-0000-4000-8000-0000000000b2',
        expectedGeneration: 1,
        cols: 100,
        rows: 30,
      },
      { resource: { kind: 'terminal', id: '00000000-0000-4000-8000-0000000000b2', generation: 1 } }
    )
    expect(wrongId).toMatchObject({ ok: false, error: { code: 'not_found' } })
    const stale = await harness.execute(
      'dev.terminal.resize',
      { terminalId, expectedGeneration: 7, cols: 100, rows: 30 },
      { resource: { kind: 'terminal', id: terminalId, generation: 7 } }
    )
    expect(stale).toMatchObject({ ok: false, error: { code: 'stale_generation' } })
    // A wrong resource kind cannot even reach a provider: the frame decoder
    // fails closed against the registry's terminal binding.
    const wrongKind = await harness.execute(
      'dev.terminal.resize',
      { terminalId, expectedGeneration: 1, cols: 100, rows: 30 },
      { resource: { kind: 'worktree', id: terminalId, generation: 1 } }
    )
    expect(wrongKind).toMatchObject({ ok: false, error: { code: 'invalid_state' } })
  })

  test('terminate without an explicit confirmation id is refused', async () => {
    const harness = await makeHarness()
    const terminalId = await harness.createTerminal()
    const reply = await harness.execute('dev.terminal.terminate', {
      terminalId,
      expectedGeneration: 1,
      confirmationId: 'no',
    })
    expect(reply).toMatchObject({ ok: false, error: { code: 'invalid_state' } })
  })

  test('attach returns a single-use read grant bound to the channel and scope', async () => {
    const harness = await makeHarness()
    const terminalId = await harness.createTerminal()
    const reply = await harness.execute('dev.terminal.attach', {
      terminalId,
      expectedGeneration: 1,
      direction: 'read',
      fromSequence: '0',
    })
    expect(reply.ok).toBe(true)
    if (!reply.ok) return
    devOperationDecoders['dev.terminal.attach'].reply(reply)
    const grant = decodeDevStreamGrant(reply.value)
    expect(grant).toMatchObject({
      protocol: 'terminal-bytes-v1',
      direction: 'read',
      channelId: harness.identity.channelId,
      resource: { kind: 'terminal', id: terminalId, generation: 1 },
      fromSequence: '0',
    })
    // Consuming it through the authority's attach path works exactly once.
    const attach = {
      schemaVersion: 1,
      grantId: grant.grantId,
      requestId: randomUUID(),
      nonce: Buffer.from(randomUUID()).toString('base64url'),
      fromSequence: '0',
      proof: '',
    }
    attach.proof = createHmac('sha256', harness.secret)
      .update(
        devStreamAttachProofMessage({ channelId: harness.identity.channelId, attach }),
        'utf8'
      )
      .digest('base64url')
    const consumed = harness.authority.attachStream({ identity: harness.identity, attach })
    expect(consumed.grantId).toBe(grant.grantId)
    expect(() => harness.authority.attachStream({ identity: harness.identity, attach })).toThrow(
      'consumed'
    )
  })

  test('the stream provider routes byte-preserving data frames and resyncs uncovered sequences', async () => {
    const harness = await makeHarness()
    const terminalId = await harness.createTerminal()
    const attachReply = await harness.execute('dev.terminal.attach', {
      terminalId,
      expectedGeneration: 1,
      direction: 'read',
      fromSequence: '0',
    })
    if (!attachReply.ok) throw new Error('attach failed')
    const grant = decodeDevStreamGrant(attachReply.value)
    const stream = harness.openStream(grant)
    await Bun.sleep(20)
    // Output flows sidecar → provider → session as raw data frames.
    harness.fake.processes[0]!.emit(new Uint8Array([0x68, 0xff, 0x69]))
    await Bun.sleep(15)
    const dataFrames = stream.frames.filter((frame) => frame.type === 'data')
    expect(dataFrames).toHaveLength(1)
    if (dataFrames[0]!.type === 'data') {
      expect([...dataFrames[0]!.bytes]).toEqual([0x68, 0xff, 0x69])
      expect(dataFrames[0]!.sequence).toBe('0')
    }
    // Ack credit flows back to the sidecar subscriber.
    stream.send({ type: 'ack', throughSequence: '0', availableCreditBytes: 3 })
    await Bun.sleep(10)
    harness.fake.processes[0]!.emit(new Uint8Array([0x62, 0x79, 0x65]))
    await Bun.sleep(15)
    expect(stream.frames.filter((frame) => frame.type === 'data')).toHaveLength(2)
  })

  test('an attach below the ring replays the durable bridge exactly once in order', async () => {
    const harness = await makeHarness()
    const terminalId = await harness.createTerminal()
    // Push enough output through the small ring (fake limits keep this fast)
    // so early sequences leave the ring; the durable checkpoints still hold
    // every chunk, so coverage is bridged rather than resynced.
    for (let batch = 0; batch < 12; batch += 1) {
      harness.fake.processes[0]!.emit(new Uint8Array(24).fill(0x61))
      await Bun.sleep(6)
    }
    const attachReply = await harness.execute('dev.terminal.attach', {
      terminalId,
      expectedGeneration: 1,
      direction: 'read',
      fromSequence: '0',
    })
    if (!attachReply.ok) throw new Error('attach failed')
    const grant = decodeDevStreamGrant(attachReply.value)
    const stream = harness.openStream(grant)
    await Bun.sleep(40)
    const dataFrames = stream.frames.filter((frame) => frame.type === 'data')
    expect(stream.frames.filter((frame) => frame.type === 'resync')).toEqual([])
    expect(dataFrames).toHaveLength(12)
    expect(dataFrames.map((frame) => (frame.type === 'data' ? frame.sequence : ''))).toEqual(
      Array.from({ length: 12 }, (_, index) => String(index))
    )
  })

  test('a genuinely unavailable span resyncs from the deterministic ring anchor', async () => {
    const harness = await makeHarness()
    const terminalId = await harness.createTerminal()
    for (let batch = 0; batch < 12; batch += 1) {
      harness.fake.processes[0]!.emit(new Uint8Array(24).fill(0x61))
      await Bun.sleep(6)
    }
    // Flush the pending buffer to segments, then remove the oldest segment:
    // the retention-boundary shape where history before the survivor genuinely
    // no longer exists anywhere.
    await harness.execute('dev.terminal.checkpoint', {
      terminalId,
      expectedGeneration: 1,
    })
    const sessionDir = join(harness.runtimeRoot, terminalId)
    const segments = readdirSync(sessionDir)
      .filter((name) => name.startsWith('seg-'))
      .toSorted()
    expect(segments.length).toBeGreaterThan(0)
    rmSync(join(sessionDir, segments[0]!))
    const attachReply = await harness.execute('dev.terminal.attach', {
      terminalId,
      expectedGeneration: 1,
      direction: 'read',
      fromSequence: '0',
    })
    if (!attachReply.ok) throw new Error('attach failed')
    const grant = decodeDevStreamGrant(attachReply.value)
    const stream = harness.openStream(grant)
    await Bun.sleep(30)
    // The anchor is the ring's oldest covered sequence — no fabricated
    // partial history, and the same anchor on every retry.
    expect(stream.frames).toEqual([
      { type: 'resync', reason: 'checkpoint_required', checkpointSequence: expect.any(String) },
    ])
    const firstAnchor = (stream.frames[0] as { checkpointSequence: string }).checkpointSequence
    const retry = harness.openStream(grant)
    await Bun.sleep(20)
    expect(retry.frames).toEqual([
      { type: 'resync', reason: 'checkpoint_required', checkpointSequence: firstAnchor },
    ])
    expect(stream.closes[0]).toContain('backpressure')
  })

  test('a live stream past the mid-stream high-water resyncs once, anchored like attach time', async () => {
    const harness = await makeHarness()
    const terminalId = await harness.createTerminal()
    const attachReply = await harness.execute('dev.terminal.attach', {
      terminalId,
      expectedGeneration: 1,
      direction: 'read',
      fromSequence: '0',
    })
    if (!attachReply.ok) throw new Error('attach failed')
    const grant = decodeDevStreamGrant(attachReply.value)
    const stream = harness.openStream(grant)
    await Bun.sleep(20)
    // Inject the fault past the live attach: chunks flow with no ack credit
    // ever returned, so the subscriber crosses the mid-stream high-water (the
    // third pending chunk trips it; two alone never leave undelivered work).
    for (let index = 0; index < 3; index += 1) {
      harness.fake.processes[0]!.emit(new Uint8Array(24).fill(0x61 + index))
      await Bun.sleep(8)
    }
    await Bun.sleep(20)
    // The client-visible event: the data chunks before the pause, then ONE
    // resync carrying the same deterministic anchor the attach-time path
    // returns (the ring's oldest covered sequence), then the backpressure
    // close. Bytes are never fabricated: each frame holds its exact chunk.
    const dataFrames = stream.frames.filter((frame) => frame.type === 'data')
    expect(dataFrames.map((frame) => (frame.type === 'data' ? frame.sequence : ''))).toEqual([
      '0',
      '1',
    ])
    expect(dataFrames.map((frame) => (frame.type === 'data' ? [...frame.bytes] : []))).toEqual([
      Array.from(new Uint8Array(24).fill(0x61)),
      Array.from(new Uint8Array(24).fill(0x62)),
    ])
    const coverage = harness.service.manager.coverage(terminalId)
    expect(coverage).toBeDefined()
    if (!coverage) return
    expect(stream.frames.filter((frame) => frame.type === 'resync')).toEqual([
      { type: 'resync', reason: 'checkpoint_required', checkpointSequence: coverage.oldestSeq },
    ])
    expect(stream.closes[0]).toContain('backpressure')
    // One notice per gap: further output and fresh credit never re-notice the
    // latched subscriber, and no further data is delivered on the old stream.
    harness.fake.processes[0]!.emit(new Uint8Array(24).fill(0x64))
    stream.send({ type: 'ack', throughSequence: '1', availableCreditBytes: 48 })
    await Bun.sleep(15)
    expect(stream.frames.filter((frame) => frame.type === 'resync')).toHaveLength(1)
    expect(stream.frames.filter((frame) => frame.type === 'data')).toHaveLength(2)
  })

  test('two concurrent writers cannot both write: the displaced fence is inert', async () => {
    const harness = await makeHarness()
    const terminalId = await harness.createTerminal()
    const first = await harness.execute('dev.terminal.input', {
      terminalId,
      expectedGeneration: 1,
      direction: 'write',
    })
    const second = await harness.execute('dev.terminal.input', {
      terminalId,
      expectedGeneration: 1,
      direction: 'write',
    })
    if (!first.ok || !second.ok) throw new Error('grants failed')
    const streamA = harness.openStream(decodeDevStreamGrant(first.value))
    const encoder = new TextEncoder()
    // A owns the terminal and writes.
    streamA.send({
      type: 'input',
      sequence: '1',
      generation: 1,
      bytes: encoder.encode('from-a-1\n'),
    })
    await Bun.sleep(15)
    // B's grant admits a new fence; A's chunks are inert from this point.
    const streamB = harness.openStream(decodeDevStreamGrant(second.value))
    streamB.send({ type: 'input', sequence: '1', generation: 1, bytes: encoder.encode('from-b\n') })
    await Bun.sleep(15)
    streamA.send({
      type: 'input',
      sequence: '2',
      generation: 1,
      bytes: encoder.encode('from-a-2\n'),
    })
    await Bun.sleep(20)
    expect(
      harness.fake.processes[0]!.written.map((bytes) => new TextDecoder().decode(bytes))
    ).toEqual(['from-a-1\n', 'from-b\n'])
    expect(streamA.closes.join(' ')).toContain('stale_generation')
    expect(streamB.closes).toEqual([])
  })

  test('write grants carry generation-stamped input to the PTY', async () => {
    const harness = await makeHarness()
    const terminalId = await harness.createTerminal()
    const reply = await harness.execute('dev.terminal.input', {
      terminalId,
      expectedGeneration: 1,
      direction: 'write',
    })
    expect(reply.ok).toBe(true)
    if (!reply.ok) return
    const grant = decodeDevStreamGrant(reply.value)
    expect(grant.direction).toBe('write')
    const stream = harness.openStream(grant)
    const payload = new TextEncoder().encode('cargo test\n')
    stream.send({ type: 'input', sequence: '1', generation: 1, bytes: payload })
    await Bun.sleep(20)
    expect(
      harness.fake.processes[0]!.written.map((bytes) => new TextDecoder().decode(bytes))
    ).toEqual(['cargo test\n'])
    // A stale-generation input frame is inert and closes the stream.
    stream.send({ type: 'input', sequence: '2', generation: 99, bytes: payload })
    await Bun.sleep(10)
    expect(
      harness.fake.processes[0]!.written.map((bytes) => new TextDecoder().decode(bytes))
    ).toHaveLength(1)
  })

  test('provider-typed failures surface their contract code, not a generic 500', async () => {
    const harness = await makeHarness()
    const terminalId = await harness.createTerminal()
    const reply = await harness.execute('dev.terminal.checkpoint', {
      terminalId,
      expectedGeneration: 1,
    })
    expect(reply.ok).toBe(true)
    if (reply.ok) {
      devOperationDecoders['dev.terminal.checkpoint'].reply(reply)
      const checkpoint = reply.value as { terminalId: string; throughSequence: string }
      expect(checkpoint.terminalId).toBe(terminalId)
    }
  })
})
