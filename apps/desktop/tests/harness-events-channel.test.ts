// runtime-events-v1 end-to-end over the real channel gateway (#400 residue).
//
// The stream provider + grant minting were proven unit-level in
// dev-runtime-harness-events.test.ts; this file proves the full websocket
// attach those shell-channel patterns pin but never exercised against the
// harness stream: grant mint → WS attach → bounded CBOR replay → live push →
// ack → single-use attach replay refusal → generation-fenced close. Real Bun
// server, real gateway, real composition graph; fake drivers only (no harness
// process is ever spawned).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createCipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  decodeCbor,
  decodeRuntimeEvent,
  devCommandProofMessage,
  devOperationDefinitions,
  devStreamAttachProofMessage,
  type DevCommand,
  type DevOperation,
  type DevReply,
  type RuntimeEvent,
  type Scope,
} from '../../../packages/types/src/dev-runtime'
import { createOwnerApprovalVerifier } from '../shell/src/dev-runtime/authority'
import { createInMemoryVaultKeyStore } from '../shell/src/dev-runtime/vault'
import { createChannelAuthority } from '../shell/src/dev-runtime/channel/authority'
import {
  createDesktopIdentityAuthority,
  type DesktopIdentityVerifier,
} from '../shell/src/dev-runtime/channel/identity'
import { createChannelGateway } from '../shell/src/dev-runtime/channel/server'
import { encodeStreamFrame, parseStreamFrame } from '../shell/src/dev-runtime/channel/wire'
import { createDevRuntimeHost, type DevRuntimeHost } from '../shell/src/dev-runtime'
import { createManagedPiDriver } from '../shell/src/dev-runtime/harness/managed-pi-driver'
import type { WorktreeService } from '../shell/src/dev-runtime/worktrees/service'

const SHELL_HOST = '127.0.0.1'
const SCOPE_A: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const SESSION = {
  credential: 'c'.repeat(43),
  sessionId: 'sess-channel-0000-0000-01',
  expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
}
const PROJECT_ID = '00000000-0000-4000-8000-0000000000aa'
const REPO_ID = '00000000-0000-4000-8000-0000000000ab'
const PINNED_ARCHIVE = new TextEncoder().encode('adea-managed-pi-placeholder-archive-v1')

function fakeCloudVerifier(): DesktopIdentityVerifier {
  return {
    async verifySession() {
      return [SCOPE_A.workspaceId]
    },
    async verifyNodeEligibility() {
      return
    },
  }
}

const fakeWorktreeService = {
  getWorktree: (scope: Scope, worktreeId: string) => ({
    id: worktreeId,
    scope,
    projectId: PROJECT_ID,
    repoId: REPO_ID,
  }),
} as unknown as WorktreeService

let server: ReturnType<typeof Bun.serve> | undefined
let authority: ReturnType<typeof createChannelAuthority> | undefined
let gateway: ReturnType<typeof createChannelGateway> | undefined
let host: DevRuntimeHost | undefined
let dataDir = ''
let origin = ''

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'adea-events-channel-'))
  const stateDir = join(dataDir, 'desktop-state')
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const deviceKey = randomBytes(32)
  writeFileSync(join(stateDir, 'device.key'), deviceKey, { mode: 0o600 })
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', deviceKey, iv)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(SESSION), 'utf8'), cipher.final()])
  const sealed = Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
  writeFileSync(join(stateDir, 'session.sealed'), sealed.toString('base64'), { mode: 0o600 })

  // Bun picks the port at bind time; the delegating handlers read the
  // authority/gateway late so they can pin the real host:port.
  server = Bun.serve({
    hostname: SHELL_HOST,
    port: 0,
    fetch: (request, bunServer) =>
      gateway!.handle(request, (req, data) => bunServer.upgrade(req, { data })),
    websocket: {
      open: (socket) => gateway?.websockets.open(socket),
      message: (socket, message) => gateway?.websockets.message(socket, message),
      close: (socket) => gateway?.websockets.close(socket),
    },
  })
  const shellHost = `${SHELL_HOST}:${server.port}`
  const shellOrigin = `http://${shellHost}`
  origin = shellOrigin
  const identity = createDesktopIdentityAuthority({ dataDir, verifier: fakeCloudVerifier() })
  await identity.bind({ session: SESSION, claimed: SCOPE_A })
  authority = createChannelAuthority({
    shellHost,
    shellOrigin,
    authorizeCommand: async (command) => {
      identity.assertCommandScope(command.scope)
      await identity.ensureNodeEligible()
    },
  })
  gateway = createChannelGateway({
    authority,
    invoke: async () => ({ ok: true, value: null }),
    shellOrigin,
  })
  host = createDevRuntimeHost({
    credentialStore: createInMemoryVaultKeyStore(),
    authority,
    gateway,
    dataDir,
    scope: identity.currentScope(),
    identity,
    approvalVerifier: createOwnerApprovalVerifier({ dataDir }),
    runtimeRoot: join(dataDir, 'dev-runtime', 'runtime'),
    runLsof: () => Promise.resolve(''),
    resolveDns: () => Promise.resolve([]),
    worktreeService: fakeWorktreeService,
    managedPi: createManagedPiDriver({
      scope: SCOPE_A,
      dataDir,
      installRoot: join(dataDir, 'managed-pi-install'),
      resolvePinnedArchive: () => Promise.resolve(PINNED_ARCHIVE),
    }),
  })
  mkdirSync(join(dataDir, 'dev-runtime', 'runtime'), { recursive: true })
})

afterAll(() => {
  server?.stop(true)
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
})

function commandFor(
  operation: DevOperation,
  scope: Scope,
  body: Record<string, unknown> = {},
  overrides: Partial<DevCommand> = {}
): DevCommand {
  return {
    schemaVersion: 1,
    operation,
    requestId: randomUUID(),
    nonce: randomBytes(24).toString('base64url'),
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    scope,
    capabilities: [...devOperationDefinitions[operation].capabilities].toSorted(),
    body,
    ...overrides,
  } as DevCommand
}

function sessionResource(session: { id: string; generation: number }) {
  return { kind: 'runtime_session', id: session.id, generation: session.generation }
}

type Inbound = { text?: string; frame?: ReturnType<typeof parseStreamFrame> }

/** One authenticated full-duplex channel client over a real WebSocket. */
type WsChannel = {
  next(): Promise<Inbound>
  execute(command: DevCommand): Promise<DevReply>
  sendSigned(command: DevCommand): void
  signAttach(grantId: string): Record<string, unknown>
  sendText(value: unknown): void
  sendFrame(frame: Parameters<typeof encodeStreamFrame>[0]): void
  waitForClose(): Promise<number>
  close(): void
}

async function openChannel(): Promise<WsChannel> {
  const ws = new WebSocket(`ws://${SHELL_HOST}:${server!.port}/__adea/channel`, {
    headers: { Origin: origin },
  })
  // One FIFO of inbound messages; stream frames that overtake an awaited
  // command reply (the server streams push events before answering the
  // command that caused them) are buffered here so `execute` only ever
  // resolves on the text reply, and `next` drains the buffered frames in
  // order afterwards.
  const messages: Inbound[] = []
  const bufferedFrames: Inbound[] = []
  const waiters: ((message: Inbound) => void)[] = []
  const closeWaiters: ((code: number) => void)[] = []
  let closeCode: number | undefined
  ws.binaryType = 'arraybuffer'
  ws.addEventListener('message', (event) => {
    const raw = event.data as string | ArrayBuffer
    const entry =
      typeof raw === 'string' ? { text: raw } : { frame: parseStreamFrame(new Uint8Array(raw)) }
    const waiter = waiters.shift()
    if (waiter) waiter(entry)
    else messages.push(entry)
  })
  const awaitMessage = async (): Promise<Inbound> => {
    const pending = messages.shift()
    if (pending) return pending
    return new Promise<Inbound>((resolve) => waiters.push(resolve))
  }
  ws.addEventListener('close', (event) => {
    closeCode = event.code
    for (const waiter of closeWaiters.splice(0)) waiter(event.code)
  })
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', () => reject(new Error('websocket failed')))
  })
  ws.send(
    JSON.stringify({
      schemaVersion: 1,
      method: 'dev.runtime.handshake.v1',
      requestId: randomUUID(),
      bootstrap: authority!.issueLaunchBootstrap(),
      supportedProtocolVersions: ['1'],
      nonce: randomBytes(24).toString('base64url'),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    })
  )
  const next = async (): Promise<Inbound> => {
    const buffered = bufferedFrames.shift()
    if (buffered) return buffered
    return await awaitMessage()
  }
  const handshakeReply = JSON.parse((await next()).text!).reply as Record<string, unknown> & {
    ok: boolean
    channelId: string
    clientCredentialId: string
    clientSecret: string
  }
  if (!handshakeReply.ok) throw new Error('handshake failed over the websocket')
  const identity = {
    channelId: handshakeReply.channelId,
    clientCredentialId: handshakeReply.clientCredentialId,
  }
  const secret = Buffer.from(handshakeReply.clientSecret, 'base64url')
  return {
    next,
    async execute(command: DevCommand) {
      ws.send(
        JSON.stringify({
          method: 'dev.runtime.execute.v1',
          frame: {
            ...identity,
            command,
            proof: createHmac('sha256', secret)
              .update(devCommandProofMessage({ ...identity, command }))
              .digest('base64url'),
          },
        })
      )
      // Resolve on the command's text reply; stream frames that raced ahead
      // are buffered for `next`.
      for (;;) {
        const message = await awaitMessage()
        if (message.text !== undefined) return JSON.parse(message.text).reply as DevReply
        bufferedFrames.push(message)
      }
    },
    sendSigned(command: DevCommand) {
      ws.send(
        JSON.stringify({
          method: 'dev.runtime.execute.v1',
          frame: {
            ...identity,
            command,
            proof: createHmac('sha256', secret)
              .update(devCommandProofMessage({ ...identity, command }))
              .digest('base64url'),
          },
        })
      )
    },
    signAttach(grantId: string) {
      const attach = {
        schemaVersion: 1,
        grantId,
        requestId: randomUUID(),
        nonce: randomBytes(16).toString('base64url'),
        fromSequence: '0',
        proof: '',
      }
      attach.proof = createHmac('sha256', secret)
        .update(devStreamAttachProofMessage({ channelId: identity.channelId, attach }))
        .digest('base64url')
      return attach
    },
    sendText(value: unknown) {
      ws.send(JSON.stringify(value))
    },
    sendFrame(frame: Parameters<typeof encodeStreamFrame>[0]) {
      ws.send(encodeStreamFrame(frame), true)
    },
    waitForClose() {
      if (closeCode !== undefined) return Promise.resolve(closeCode)
      return new Promise<number>((resolve) => closeWaiters.push(resolve))
    },
    close() {
      ws.close()
    },
  }
}

function okValue(reply: DevReply): Record<string, unknown> {
  if (!reply.ok) throw new Error(`expected ok reply: ${JSON.stringify(reply.error)}`)
  return reply.value as Record<string, unknown>
}

describe('runtime-events-v1 over the channel gateway (#400 residue)', () => {
  test('grant → attach → bounded replay → live push → ack → generation-fenced close', async () => {
    const channel = await openChannel()

    // Seed the project, create the session, install managed Pi, launch.
    host!.projectSession?.upsertProject({
      id: PROJECT_ID,
      scope: SCOPE_A,
      name: 'Channel Project',
      groupIds: [],
      repoIds: [REPO_ID],
      lifecycle: 'ready',
      version: 1,
    })
    const created = okValue(
      await channel.execute(
        commandFor('dev.session.create', SCOPE_A, {
          projectId: PROJECT_ID,
          repoId: REPO_ID,
          worktreeId: randomUUID(),
        })
      )
    ) as unknown as { id: string; generation: number }
    okValue(await channel.execute(commandFor('dev.harness.managedPiInstall', SCOPE_A, {})))
    const run = okValue(
      await channel.execute(
        commandFor(
          'dev.session.launchDefault',
          SCOPE_A,
          {
            runtimeSessionId: created.id,
            expectedGeneration: created.generation,
            agentProfileId: 'profile-1',
            agentProfileVersion: 1,
          },
          { resource: sessionResource(created) }
        )
      )
    )
    const liveGeneration = created.generation + 1

    // Seed beyond the 500-frame replay bound so the stream must disclose the
    // actual retained floor before sending data. The requested attach cursor
    // remains zero, while the newest retained window starts later.
    for (let index = 0; index < 501; index += 1)
      host!.harness!.events.append({
        runtimeSessionId: created.id,
        generation: liveGeneration,
        kind: 'capability.restored',
        sourceEventId: `bounded-replay-${index}`,
      })
    const replayLatest = host!.harness!.events.latestSequence(created.id, liveGeneration)
    const replayFloor = (BigInt(replayLatest) - 500n + 1n).toString()

    // Mint the stream grant through the caller's authenticated identity.
    const grant = okValue(
      await channel.execute(
        commandFor(
          'dev.session.events',
          SCOPE_A,
          {
            runtimeSessionId: created.id,
            expectedGeneration: liveGeneration,
            direction: 'read',
          },
          { resource: sessionResource({ ...created, generation: liveGeneration }) }
        )
      )
    ) as unknown as { grantId: string; protocol: string }
    expect(grant.protocol).toBe('runtime-events-v1')

    // Attach over the socket with the signed proof: the binary `opened` frame
    // names the protocol and the granted generation.
    channel.sendText({
      method: 'dev.runtime.stream.attach.v1',
      attach: channel.signAttach(grant.grantId),
    })
    const opened = await channel.next()
    expect(opened.frame).toMatchObject({
      type: 'opened',
      protocol: 'runtime-events-v1',
      generation: liveGeneration,
      nextSequence: '0',
    })

    const checkpoint = await channel.next()
    expect(checkpoint.frame).toEqual({
      type: 'resync',
      reason: 'checkpoint_required',
      checkpointSequence: replayFloor,
    })

    // Bounded replay: the launch facts arrive as CBOR data frames carrying
    // strict wire events with host provenance, in append order.
    const replay = await Promise.all(Array.from({ length: 500 }, () => channel.next()))
    const replayKinds = replay.map((message, index) => {
      const frame = message.frame as { type: string; sequence: string; bytes: Uint8Array }
      expect(frame.type).toBe('data')
      expect(frame.sequence).toBe((BigInt(replayFloor) + BigInt(index)).toString())
      const decoded = decodeCbor(frame.bytes).value as RuntimeEvent
      expect(decoded.runtimeSessionId).toBe(created.id)
      expect(decoded.generation).toBe(liveGeneration)
      expect(decodeRuntimeEvent(decoded, { source: 'host' }).seq).toBe(frame.sequence)
      return decoded.kind
    })
    expect(replayKinds.slice(0, 3)).toEqual([
      'capability.restored',
      'capability.restored',
      'capability.restored',
    ])

    // Live push: an observed transition appends events and the stream carries
    // them without any re-attach.
    okValue(
      await channel.execute(
        commandFor(
          'dev.harness.runStatus',
          SCOPE_A,
          {
            runtimeSessionId: created.id,
            expectedGeneration: liveGeneration,
            harnessRunId: run.id,
            state: 'working',
            source: 'host',
          },
          { resource: sessionResource({ ...created, generation: liveGeneration }) }
        )
      )
    )
    const live = [await channel.next(), await channel.next()]
    const liveKinds = live.map((message) => {
      const frame = message.frame as { type: string; bytes: Uint8Array }
      expect(frame.type).toBe('data')
      return (decodeCbor(frame.bytes).value as RuntimeEvent).kind
    })
    expect(liveKinds).toEqual(['run.ready', 'session.ready'])

    // Ack control frames are accepted on the read stream; the channel stays
    // open (proven by another command round-trip and no close frame).
    channel.sendFrame({ type: 'ack', throughSequence: replayLatest, availableCreditBytes: 4096 })
    okValue(await channel.execute(commandFor('dev.harness.runs', SCOPE_A, {})))

    // A newer generation fences the stream: cancel bumps the session
    // generation; the grant minted under the old generation is inert. The
    // close frame races the command reply (the stream dies inside the
    // command that fenced it), so the command is sent without awaiting.
    channel.sendSigned(
      commandFor(
        'dev.session.cancelHarness',
        SCOPE_A,
        {
          runtimeSessionId: created.id,
          expectedGeneration: liveGeneration,
          harnessRunId: run.id,
        },
        { resource: sessionResource({ ...created, generation: liveGeneration }) }
      )
    )
    const closeFrame = await channel.next()
    expect(closeFrame.frame).toMatchObject({ type: 'close', code: 'stale_generation' })
    expect(await channel.waitForClose()).toBe(1008)

    // Single-use at attach over the wire: replaying the spent grant's attach
    // is refused with the typed code — even on a fresh channel, the consumed
    // grant never re-attaches.
    const stranger = await openChannel()
    stranger.sendText({
      method: 'dev.runtime.stream.attach.v1',
      attach: channel.signAttach(grant.grantId),
    })
    const refused = JSON.parse((await stranger.next()).text!) as {
      reply: { ok: boolean; error: { code: string } }
    }
    expect(refused.reply.ok).toBe(false)
    expect(refused.reply.error.code).toBe('replay_rejected')
    stranger.close()
  }, 60_000)
})
