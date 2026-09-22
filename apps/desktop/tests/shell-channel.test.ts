// The M10 channel boundary (issue #33): no loopback or browsed-page privilege.
// The gateway must refuse unauthenticated, cross-origin, rebinding, replayed,
// and tampered traffic before it reaches the command surface, and the
// authenticated paths must round-trip the pinned desktop command families
// without changing their observable contracts.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  devCommandProofMessage,
  devStreamAttachProofMessage,
  type DevCommand,
  type Scope,
} from '../../../packages/types/src/dev-runtime'
import {
  createChannelAuthority,
  LEGACY_INVOKE_PROOF_CONTEXT,
} from '../shell/src/dev-runtime/channel/authority'
import { isTrustedLoopbackRequest } from '../shell/src/dev-runtime/channel/loopback'
import { createChannelGateway, type BridgeResult } from '../shell/src/dev-runtime/channel/server'
import { createStreamInbound, encodeStreamFrame } from '../shell/src/dev-runtime/channel/wire'
import { createCommandSurface } from '../shell/src/commands'

const SHELL_HOST = '127.0.0.1'
const SHELL_ORIGIN = `http://${SHELL_HOST}:4789`
const SCOPE: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}

function handshakePayload(bootstrap: string, at = Date.now()) {
  return {
    schemaVersion: 1,
    method: 'dev.runtime.handshake.v1',
    requestId: randomUUID(),
    bootstrap,
    supportedProtocolVersions: ['1'],
    nonce: Buffer.from(randomUUID()).toString('base64url'),
    issuedAt: new Date(at).toISOString(),
    expiresAt: new Date(at + 30_000).toISOString(),
  }
}

describe('trusted loopback gate', () => {
  const policy = { shellHost: `${SHELL_HOST}:4789`, shellOrigin: SHELL_ORIGIN }

  test('accepts only the app window origin, including requests without fetch metadata', () => {
    expect(
      isTrustedLoopbackRequest(
        { host: `${SHELL_HOST}:4789`, origin: SHELL_ORIGIN, secFetchSite: 'same-origin' },
        policy
      )
    ).toBe(true)
    expect(
      isTrustedLoopbackRequest(
        { host: `${SHELL_HOST}:4789`, origin: SHELL_ORIGIN, secFetchSite: 'none' },
        policy
      )
    ).toBe(true)
    expect(isTrustedLoopbackRequest({ host: `${SHELL_HOST}:4789` }, policy)).toBe(false)
  })

  test('refuses rebinding, cross-origin pages, and hostile fetch metadata', () => {
    // DNS rebinding: the page's origin resolves to loopback but says so.
    expect(isTrustedLoopbackRequest({ host: 'evil.example:4789' }, policy)).toBe(false)
    // A cross-origin page in any browser context.
    expect(
      isTrustedLoopbackRequest(
        { host: `${SHELL_HOST}:4789`, origin: 'http://evil.example', secFetchSite: 'cross-site' },
        policy
      )
    ).toBe(false)
    expect(
      isTrustedLoopbackRequest(
        { host: `${SHELL_HOST}:4789`, origin: 'null', secFetchSite: 'cross-site' },
        policy
      )
    ).toBe(false)
  })
})

describe('channel authority', () => {
  test('mints a channel once per bootstrap and refuses replays', () => {
    const authority = createChannelAuthority({ shellHost: SHELL_HOST, shellOrigin: SHELL_ORIGIN })
    const bootstrap = authority.issueLaunchBootstrap()
    const reply = authority.handshake(handshakePayload(bootstrap), { trusted: true })
    expect(reply.ok).toBe(true)
    if (!reply.ok) return
    expect(reply.protocolVersion).toBe('1')
    // The secret is exactly one 256-bit value, returned once.
    expect(Buffer.from(reply.clientSecret, 'base64url').byteLength).toBe(32)

    expect(() => authority.handshake(handshakePayload(bootstrap), { trusted: true })).toThrow(
      'bootstrap'
    )
    const counters = authority.countersSnapshot()
    expect(counters.channelUnauthenticated).toBeGreaterThan(0)
  })

  test('refuses an untrusted client context before touching the bootstrap', () => {
    const authority = createChannelAuthority({ shellHost: SHELL_HOST, shellOrigin: SHELL_ORIGIN })
    const bootstrap = authority.issueLaunchBootstrap()
    expect(() => authority.handshake(handshakePayload(bootstrap), { trusted: false })).toThrow(
      'untrusted client origin'
    )
    // The bootstrap was not burned by the refused attempt.
    const reply = authority.handshake(handshakePayload(bootstrap), { trusted: true })
    expect(reply.ok).toBe(true)
  })

  test('expires handshakes against the injected clock', () => {
    let now = 1_000_000_000_000
    const authority = createChannelAuthority({
      now: () => now,
      shellHost: SHELL_HOST,
      shellOrigin: SHELL_ORIGIN,
    })
    const bootstrap = authority.issueLaunchBootstrap()
    now += 5 * 60_000
    expect(() =>
      authority.handshake(handshakePayload(bootstrap, 1_000_000_000_000), { trusted: true })
    ).toThrow('handshake window')
  })

  test('authenticates signed legacy requests and rejects replay and tampering', () => {
    const authority = createChannelAuthority({ shellHost: SHELL_HOST, shellOrigin: SHELL_ORIGIN })
    const reply = authority.handshake(handshakePayload(authority.issueLaunchBootstrap()), {
      trusted: true,
    })
    if (!reply.ok) throw new Error('handshake failed')
    const secret = Buffer.from(reply.clientSecret, 'base64url')

    const signed = (body: string, nonce = Buffer.from(randomUUID()).toString('base64url')) => {
      const timestamp = String(Date.now())
      const bodySha256 = createHash('sha256').update(body, 'utf8').digest('hex')
      const proof = createHmac('sha256', secret)
        .update(
          [
            LEGACY_INVOKE_PROOF_CONTEXT,
            reply.channelId,
            reply.clientCredentialId,
            nonce,
            timestamp,
            bodySha256,
          ].join('\u001f')
        )
        .digest('base64url')
      return {
        headers: {
          'x-adea-channel': reply.channelId,
          'x-adea-credential': reply.clientCredentialId,
          'x-adea-nonce': nonce,
          'x-adea-timestamp': timestamp,
          'x-adea-proof': proof,
        },
        body,
      }
    }

    const first = signed('{"cmd":"adea_app_version"}')
    expect(authority.authenticateLegacyRequest(first)).toEqual({
      channelId: reply.channelId,
      clientCredentialId: reply.clientCredentialId,
    })

    // A replayed request — same nonce, same body — is refused.
    expect(() => authority.authenticateLegacyRequest(first)).toThrow('nonce')

    // A tampered body under a reused proof never verifies.
    const tampered = { headers: { ...first.headers }, body: '{"cmd":"desktop_auth_start"}' }
    expect(() => authority.authenticateLegacyRequest(tampered)).toThrow()

    // A wrong credential is unknown even when the channel id exists.
    expect(() =>
      authority.authenticateLegacyRequest({
        headers: { ...first.headers, 'x-adea-credential': randomUUID() },
        body: first.body,
      })
    ).toThrow('credential')
  })

  test('executes authorized dev.* frames and denies everything else', async () => {
    const authority = createChannelAuthority({ shellHost: SHELL_HOST, shellOrigin: SHELL_ORIGIN })
    const reply = authority.handshake(handshakePayload(authority.issueLaunchBootstrap()), {
      trusted: true,
    })
    if (!reply.ok) throw new Error('handshake failed')
    const secret = Buffer.from(reply.clientSecret, 'base64url')

    const frame = (command: DevCommand) => ({
      channelId: reply.channelId,
      clientCredentialId: reply.clientCredentialId,
      command,
      proof: createHmac('sha256', secret)
        .update(
          devCommandProofMessage({
            channelId: reply.channelId,
            clientCredentialId: reply.clientCredentialId,
            command,
          })
        )
        .digest('base64url'),
    })
    const snapshotCommand = (overrides?: Partial<DevCommand>): DevCommand =>
      ({
        schemaVersion: 1,
        operation: 'dev.capability.snapshot',
        requestId: randomUUID(),
        nonce: Buffer.from(randomUUID()).toString('base64url'),
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        scope: SCOPE,
        capabilities: [],
        body: {},
        ...overrides,
      }) as DevCommand

    authority.registerCommandProvider('dev.capability.snapshot', (command) =>
      authority.capabilitySnapshot(command.scope, {
        channelId: reply.channelId,
        clientCredentialId: reply.clientCredentialId,
      })
    )

    const good = await authority.execute(frame(snapshotCommand()), { trusted: true })
    expect(good.ok).toBe(true)
    if (good.ok) {
      expect(good.value).toMatchObject({
        scope: SCOPE,
        granted: ['dev.appLibrary.manage', 'dev.appearance.read'],
      })
    }

    // A valid frame whose proof was computed over a different command is
    // refused: the MAC binds the exact canonical command content.
    const commandA = snapshotCommand()
    const commandB = snapshotCommand()
    const proofForA = frame(commandA).proof
    const swapped = await authority.execute(
      {
        channelId: reply.channelId,
        clientCredentialId: reply.clientCredentialId,
        command: commandB,
        proof: proofForA,
      },
      { trusted: true }
    )
    expect(swapped).toMatchObject({ ok: false, error: { code: 'identity_mismatch' } })

    // A frame that fails envelope validation is typed, never a generic 500.
    const malformed = await authority.execute(
      frame(snapshotCommand({ idempotencyKey: 'x'.repeat(129) })),
      { trusted: true }
    )
    expect(malformed.ok).toBe(false)

    // A bare command (no channel frame) is rejected — the host does not
    // accept unframed DevCommands.
    const bare = await authority.execute(snapshotCommand(), { trusted: true })
    expect(bare.ok).toBe(false)

    // An expired command is refused.
    const expired = await authority.execute(
      frame(
        snapshotCommand({
          issuedAt: new Date(Date.now() - 120_000).toISOString(),
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        })
      ),
      { trusted: true }
    )
    expect(expired).toMatchObject({ ok: false, error: { code: 'token_expired' } })

    // A replayed nonce is refused even though the proof still verifies.
    const replayedCommand = snapshotCommand()
    await authority.execute(frame(replayedCommand), { trusted: true })
    const replayed = await authority.execute(frame(replayedCommand), { trusted: true })
    expect(replayed).toMatchObject({ ok: false, error: { code: 'replay_rejected' } })

    // An unregistered operation is denied by default.
    const unavailable = await authority.execute(
      frame({
        ...snapshotCommand(),
        operation: 'dev.project.list',
        capabilities: ['dev.project.read'],
        body: { limit: 10 },
      }),
      { trusted: true }
    )
    expect(unavailable).toMatchObject({ ok: false, error: { code: 'capability_unavailable' } })
  })

  test('stream grants attach exactly once through the registered provider', () => {
    const authority = createChannelAuthority({ shellHost: SHELL_HOST, shellOrigin: SHELL_ORIGIN })
    const reply = authority.handshake(handshakePayload(authority.issueLaunchBootstrap()), {
      trusted: true,
    })
    if (!reply.ok) throw new Error('handshake failed')
    const identity = {
      channelId: reply.channelId,
      clientCredentialId: reply.clientCredentialId,
    }
    const secret = Buffer.from(reply.clientSecret, 'base64url')
    authority.registerStreamProvider('terminal-bytes-v1')

    const grant = authority.mintStreamGrant({
      identity,
      protocol: 'terminal-bytes-v1',
      scope: SCOPE,
      resource: { kind: 'terminal', id: 'terminal-1', generation: 3 },
      direction: 'write',
      maxFrameBytes: 1024,
    })
    expect(grant.fromSequence).toBe('0')

    const attach = {
      schemaVersion: 1,
      grantId: grant.grantId,
      requestId: randomUUID(),
      nonce: Buffer.from(randomUUID()).toString('base64url'),
      fromSequence: '0',
      proof: '',
    }
    attach.proof = createHmac('sha256', secret)
      .update(devStreamAttachProofMessage({ channelId: identity.channelId, attach }))
      .digest('base64url')

    const attached = authority.attachStream({ identity, attach })
    expect(attached.grantId).toBe(grant.grantId)

    // The consumed grant never attaches again, even with a fresh proof.
    const replay = {
      ...attach,
      requestId: randomUUID(),
      nonce: Buffer.from(randomUUID()).toString('base64url'),
    }
    replay.proof = createHmac('sha256', secret)
      .update(devStreamAttachProofMessage({ channelId: identity.channelId, attach: replay }))
      .digest('base64url')
    expect(() => authority.attachStream({ identity, attach: replay })).toThrow('consumed')

    // A live grant minted for one channel cannot be attached from another.
    const other = authority.handshake(handshakePayload(authority.issueLaunchBootstrap()), {
      trusted: true,
    })
    if (!other.ok) throw new Error('second handshake failed')
    const otherIdentity = {
      channelId: other.channelId,
      clientCredentialId: other.clientCredentialId,
    }
    const foreignGrant = authority.mintStreamGrant({
      identity,
      protocol: 'terminal-bytes-v1',
      scope: SCOPE,
      resource: { kind: 'terminal', id: 'terminal-2', generation: 1 },
      direction: 'write',
    })
    const foreignAttach = {
      schemaVersion: 1,
      grantId: foreignGrant.grantId,
      requestId: randomUUID(),
      nonce: Buffer.from(randomUUID()).toString('base64url'),
      fromSequence: '0',
      proof: '',
    }
    foreignAttach.proof = createHmac('sha256', Buffer.from(other.clientSecret, 'base64url'))
      .update(
        devStreamAttachProofMessage({ channelId: otherIdentity.channelId, attach: foreignAttach })
      )
      .digest('base64url')
    expect(() =>
      authority.attachStream({ identity: otherIdentity, attach: foreignAttach })
    ).toThrow('bound to another channel')
  })

  test('audit records and counters never contain secret material', () => {
    const authority = createChannelAuthority({ shellHost: SHELL_HOST, shellOrigin: SHELL_ORIGIN })
    const bootstrap = authority.issueLaunchBootstrap()
    authority.handshake(handshakePayload(bootstrap), { trusted: true })
    // A replayed bootstrap is refused and recorded without ever echoing it.
    expect(() => authority.handshake(handshakePayload(bootstrap), { trusted: true })).toThrow()
    const dump = JSON.stringify({
      audit: authority.auditSnapshot(),
      ...authority.countersSnapshot(),
    })
    expect(dump).not.toContain(bootstrap)
    expect(dump).not.toContain('"clientSecret"')
    expect(dump).toContain('handshake_accepted')
    expect(dump).toContain('handshake_refused')
  })
})

describe('channel gateway', () => {
  let dataDir: string
  let authority: ReturnType<typeof createChannelAuthority>
  let gateway!: ReturnType<typeof createChannelGateway>
  let server: Bun.Server | undefined
  let origin: string

  const bootstrap = () => gateway.bootstrapToken()

  async function handshake(bootstrapValue: string) {
    const response = await fetch(`${origin}/__adea/handshake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({
        schemaVersion: 1,
        method: 'dev.runtime.handshake.v1',
        requestId: randomUUID(),
        bootstrap: bootstrapValue,
        supportedProtocolVersions: ['1'],
        nonce: Buffer.from(randomUUID()).toString('base64url'),
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      }),
    })
    return { status: response.status, reply: (await response.json()) as Record<string, unknown> }
  }

  function signedInvoke(
    reply: { channelId: string; clientCredentialId: string; clientSecret: string },
    cmd: string,
    args?: Record<string, unknown>
  ) {
    const body = JSON.stringify({ cmd, args: args ?? null })
    const timestamp = String(Date.now())
    const nonce = Buffer.from(randomUUID()).toString('base64url')
    const bodySha256 = createHash('sha256').update(body, 'utf8').digest('hex')
    const proof = createHmac('sha256', Buffer.from(reply.clientSecret, 'base64url'))
      .update(
        [
          LEGACY_INVOKE_PROOF_CONTEXT,
          reply.channelId,
          reply.clientCredentialId,
          nonce,
          timestamp,
          bodySha256,
        ].join('\u001f')
      )
      .digest('base64url')
    return fetch(`${origin}/__adea/invoke`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-adea-channel': reply.channelId,
        'x-adea-credential': reply.clientCredentialId,
        'x-adea-nonce': nonce,
        'x-adea-timestamp': timestamp,
        'x-adea-proof': proof,
        origin,
      },
      body,
    })
  }

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'adea-shell-channel-'))
    // Bun picks the test port at bind time; the fetch closure reads the
    // gateway late so the authority can pin the real host:port.
    server = Bun.serve({
      hostname: SHELL_HOST,
      port: 0,
      fetch: (request, bunServer) =>
        gateway.handle(request, (req, data) => bunServer.upgrade(req, { data })),
      // Stable delegating handlers: Bun captures this object at serve time,
      // and the gateway exists only once the ephemeral port is known.
      websocket: {
        open: (socket) => gateway?.websockets.open(socket),
        message: (socket, message) => gateway?.websockets.message(socket, message),
        close: (socket) => gateway?.websockets.close(socket),
      },
    })
    const shellHost = `${SHELL_HOST}:${server.port}`
    const shellOrigin = `http://${SHELL_HOST}:${server.port}`
    origin = shellOrigin
    authority = createChannelAuthority({ shellHost, shellOrigin })
    gateway = createChannelGateway({
      authority,
      invoke: createCommandSurface(dataDir) as (
        cmd: string,
        args?: Record<string, unknown>
      ) => BridgeResult | Promise<BridgeResult>,
      shellOrigin,
    })
  })

  afterAll(() => {
    server?.stop(true)
    rmSync(dataDir, { force: true, recursive: true })
  })

  test('serves the bridge script without embedding secrets', async () => {
    const response = await fetch(`${origin}/__adea/bridge.js`, { headers: { origin } })
    expect(response.status).toBe(200)
    const script = await response.text()
    expect(script).toContain('__adeaDesktop')
    expect(script).toContain(LEGACY_INVOKE_PROOF_CONTEXT)
    expect(script).not.toContain(bootstrap())
  })

  test('refuses unauthenticated invoke and dev.* names on the legacy path', async () => {
    const refused = await fetch(`${origin}/__adea/invoke`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        host: `${SHELL_HOST}:${server.port}`,
        origin,
      },
      body: '{"cmd":"adea_app_version"}',
    })
    expect(refused.status).toBe(401)

    const handshakeResult = await handshake(bootstrap())
    expect(handshakeResult.reply.ok).toBe(true)
    const reply = handshakeResult.reply as unknown as {
      channelId: string
      clientCredentialId: string
      clientSecret: string
    }
    const devRouted = await signedInvoke(reply, 'dev.capability.snapshot')
    expect(devRouted.status).toBe(200)
    expect(await devRouted.json()).toMatchObject({ ok: false })
  })

  test('round-trips the pinned command families over the guarded invoke path', async () => {
    const { reply } = await handshake(bootstrap())
    const identity = reply as unknown as {
      channelId: string
      clientCredentialId: string
      clientSecret: string
    }

    const version = (await (
      await signedInvoke(identity, 'adea_app_version')
    ).json()) as BridgeResult
    expect(version.ok).toBe(true)

    const created = (await (
      await signedInvoke(identity, 'local_content_create', {
        input: {
          contentType: 'task_objective',
          plaintext: 'channel-bound private content',
          sensitivity: 'restricted',
          storagePolicy: 'local_authority',
          synchronizationPolicy: 'local_only',
          workspaceId: 'workspace-1',
        },
      })
    ).json()) as BridgeResult
    expect(created.ok).toBe(true)

    // A contentId is an identity, never a path: traversal attempts fail.
    const traversal = (await (
      await signedInvoke(identity, 'local_content_read', {
        input: { contentId: '../../secrets', workspaceId: 'workspace-1' },
      })
    ).json()) as BridgeResult
    expect(traversal.ok).toBe(false)

    const unknown = (await (
      await signedInvoke(identity, 'desktop_surprise')
    ).json()) as BridgeResult
    expect(unknown).toMatchObject({ ok: false })
  })

  test('event tokens are single use on the SSE path', async () => {
    const { reply } = await handshake(bootstrap())
    const identity = reply as unknown as {
      channelId: string
      clientCredentialId: string
      clientSecret: string
    }
    const body = JSON.stringify({ event: 'desktop-auth-callback-ready' })
    const timestamp = String(Date.now())
    const nonce = Buffer.from(randomUUID()).toString('base64url')
    const bodySha256 = createHash('sha256').update(body, 'utf8').digest('hex')
    const proof = createHmac('sha256', Buffer.from(identity.clientSecret, 'base64url'))
      .update(
        [
          LEGACY_INVOKE_PROOF_CONTEXT,
          identity.channelId,
          identity.clientCredentialId,
          nonce,
          timestamp,
          bodySha256,
        ].join('\u001f')
      )
      .digest('base64url')
    const minted = (await (
      await fetch(`${origin}/__adea/events-token`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-adea-channel': identity.channelId,
          'x-adea-credential': identity.clientCredentialId,
          'x-adea-nonce': nonce,
          'x-adea-timestamp': timestamp,
          'x-adea-proof': proof,
          origin,
        },
        body,
      })
    ).json()) as { token: string }

    // A token minted for one event cannot be substituted into another event
    // stream, even when the channel and token are otherwise valid.
    const wrongEvent = await fetch(
      `${origin}/__adea/events?event=demo&channel=${identity.channelId}&credential=${identity.clientCredentialId}&token=${minted.token}`,
      { headers: { origin } }
    )
    expect(wrongEvent.status).toBe(401)

    const first = await fetch(
      `${origin}/__adea/events?event=desktop-auth-callback-ready&channel=${identity.channelId}&credential=${identity.clientCredentialId}&token=${minted.token}`,
      { headers: { origin } }
    )
    expect(first.status).toBe(200)
    await first.body?.cancel()
    const second = await fetch(
      `${origin}/__adea/events?event=desktop-auth-callback-ready&channel=${identity.channelId}&credential=${identity.clientCredentialId}&token=${minted.token}`,
      { headers: { origin } }
    )
    expect(second.status).toBe(401)
  })

  test('carries handshake, execute, and stream frames over the full-duplex channel', async () => {
    gateway.registerStreamHandler('terminal-bytes-v1', (session) => {
      session.onFrame = (frame) => {
        if (frame.type === 'input') {
          session.send({ type: 'data', sequence: frame.sequence, bytes: frame.bytes })
        }
      }
    })
    const ws = new WebSocket(`ws://${SHELL_HOST}:${server.port}/__adea/channel`, {
      headers: { Origin: origin },
    })
    const messages: { data: string | Uint8Array; binary: boolean }[] = []
    const waiters: ((message: { data: string | Uint8Array; binary: boolean }) => void)[] = []
    let closed: ((code: number) => void) | undefined
    ws.addEventListener('message', (event) => {
      const entry = {
        data: event.data as string | Uint8Array,
        binary: typeof event.data !== 'string',
      }
      const waiter = waiters.shift()
      if (waiter) waiter(entry)
      else messages.push(entry)
    })
    ws.addEventListener('close', (event) => closed?.(event.code))
    const opened = new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve())
      ws.addEventListener('error', () => reject(new Error('websocket failed')))
    })
    await opened
    // oxlint-disable-next-line require-await
    const next = async () =>
      new Promise<{ data: string | Uint8Array; binary: boolean }>((resolve) => {
        const pending = messages.shift()
        if (pending) resolve(pending)
        else waiters.push(resolve)
      })
    ws.addEventListener('close', (event) => closed?.(event.code))

    const bootstrapValue = bootstrap()
    ws.send(
      JSON.stringify({
        schemaVersion: 1,
        method: 'dev.runtime.handshake.v1',
        requestId: randomUUID(),
        bootstrap: bootstrapValue,
        supportedProtocolVersions: ['1'],
        nonce: Buffer.from(randomUUID()).toString('base64url'),
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      })
    )
    const handshakeMessage = (await next()) as { data: string }
    const handshakeReply = JSON.parse(handshakeMessage.data).reply
    expect(handshakeReply.ok).toBe(true)
    const identity = {
      channelId: handshakeReply.channelId,
      clientCredentialId: handshakeReply.clientCredentialId,
    }
    const secret = Buffer.from(handshakeReply.clientSecret, 'base64url')

    authority.registerCommandProvider('dev.capability.snapshot', (command) =>
      authority.capabilitySnapshot(command.scope, identity)
    )
    const command: DevCommand = {
      schemaVersion: 1,
      operation: 'dev.capability.snapshot',
      requestId: randomUUID(),
      nonce: Buffer.from(randomUUID()).toString('base64url'),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      scope: SCOPE,
      capabilities: [],
      body: {},
    }
    ws.send(
      JSON.stringify({
        method: 'dev.runtime.execute.v1',
        frame: {
          channelId: identity.channelId,
          clientCredentialId: identity.clientCredentialId,
          command,
          proof: createHmac('sha256', secret)
            .update(
              devCommandProofMessage({
                channelId: identity.channelId,
                clientCredentialId: identity.clientCredentialId,
                command,
              })
            )
            .digest('base64url'),
        },
      })
    )
    const executeMessage = (await next()) as { data: string }
    expect(JSON.parse(executeMessage.data).reply).toMatchObject({
      ok: true,
      operation: 'dev.capability.snapshot',
    })

    const grant = authority.mintStreamGrant({
      identity,
      protocol: 'terminal-bytes-v1',
      scope: SCOPE,
      resource: { kind: 'terminal', id: 'terminal-9', generation: 2 },
      direction: 'write',
      maxFrameBytes: 256,
    })
    const attach = {
      schemaVersion: 1,
      grantId: grant.grantId,
      requestId: randomUUID(),
      nonce: Buffer.from(randomUUID()).toString('base64url'),
      fromSequence: '0',
      proof: '',
    }
    attach.proof = createHmac('sha256', secret)
      .update(devStreamAttachProofMessage({ channelId: identity.channelId, attach }))
      .digest('base64url')
    ws.send(JSON.stringify({ method: 'dev.runtime.stream.attach.v1', attach }))
    const openedFrame = (await next()) as { data: Uint8Array }
    const { parseStreamFrame } = await import('../shell/src/dev-runtime/channel/wire')
    expect(parseStreamFrame(new Uint8Array(openedFrame.data as Uint8Array))).toMatchObject({
      type: 'opened',
      protocol: 'terminal-bytes-v1',
      generation: 2,
    })

    const payload = new TextEncoder().encode('echo-bytes')
    ws.send(
      encodeStreamFrame({ type: 'input', sequence: '0', generation: 2, bytes: payload }),
      true
    )
    const echoed = (await next()) as { data: Uint8Array }
    expect(parseStreamFrame(new Uint8Array(echoed.data as Uint8Array))).toMatchObject({
      type: 'data',
      sequence: '0',
    })

    // An oversize client frame is refused and closes the stream. Its offset
    // continues the write cursor exactly (0 + 10 bytes).
    const closePromise = new Promise<number>((resolve) => {
      closed = resolve
    })
    ws.send(
      encodeStreamFrame({
        type: 'input',
        sequence: '10',
        generation: 2,
        bytes: new Uint8Array(300),
      }),
      true
    )
    const closedCode = await closePromise
    expect(closedCode).toBe(1013)
    ws.close()
  })

  test('evaluated bridge script performs the handshake and signs real requests', async () => {
    const window: Record<string, unknown> = { __ADEA_LAUNCH_BOOTSTRAP__: bootstrap() }
    const eventSources: { url: string; closed: boolean }[] = []
    const EventSource = class {
      url: string
      closed = false
      onmessage: ((message: { data: string }) => void) | null = null
      constructor(url: string) {
        this.url = url
        eventSources.push(this)
      }
      close() {
        this.closed = true
      }
    }
    new Function('window', 'EventSource', gateway.bridgeScript())(window, EventSource)
    const bridge = window.__adeaDesktop as {
      invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
      listen: (event: string, handler: (payload: unknown) => void) => Promise<() => void>
      devExecute: (command: DevCommand) => Promise<unknown>
    }

    const version = await bridge.invoke('adea_app_version')
    expect(typeof version).toBe('string')
    const devReply = await bridge.devExecute({
      schemaVersion: 1,
      operation: 'dev.capability.snapshot',
      requestId: randomUUID(),
      nonce: Buffer.from(randomUUID()).toString('base64url'),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      scope: SCOPE,
      capabilities: [],
      body: {},
    })
    expect(devReply).toMatchObject({ ok: true, operation: 'dev.capability.snapshot' })

    // The bridge keeps its channel secret out of the window object; the
    // frozen bridge property is deliberately non-enumerable and non-writable.
    expect(Object.keys(window)).toEqual(['__ADEA_LAUNCH_BOOTSTRAP__'])
    expect('__adeaDesktop' in window).toBe(true)

    const dispose = await bridge.listen('desktop-auth-callback-ready', () => {})
    expect(eventSources).toHaveLength(1)
    expect(eventSources[0]!.url).toContain('/__adea/events?event=desktop-auth-callback-ready')
    expect(eventSources[0]!.url).toContain('token=')
    dispose()
    expect(eventSources[0]!.closed).toBe(true)
  })
})

describe('stream inbound validator', () => {
  const grant = {
    schemaVersion: 1,
    grantId: randomUUID(),
    protocol: 'terminal-bytes-v1',
    channelId: '00000000-0000-4000-8000-00000000000a',
    scope: SCOPE,
    resource: { kind: 'terminal', id: 'terminal-1', generation: 5 },
    direction: 'write',
    fromSequence: '4',
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    maxFrameBytes: 128,
  } as const

  test('write offsets must start exactly at fromSequence and advance by byte length', () => {
    const inbound = createStreamInbound(grant)
    // The first chunk lands ON the resume point (byte-offset semantics, not
    // strictly-above).
    expect(
      inbound.accept({ type: 'input', sequence: '4', generation: 5, bytes: new Uint8Array(10) })
    ).toEqual({ ok: true })
    // The next chunk must continue exactly at the offset end (4 + 10).
    expect(
      inbound.accept({ type: 'input', sequence: '14', generation: 5, bytes: new Uint8Array(10) })
    ).toEqual({ ok: true })
  })

  test('gapped, replayed, and overlapping write offsets close the stream typed', () => {
    // Gap: the offset skips bytes the cursor never received.
    const gapped = createStreamInbound(grant)
    const gapVerdict = gapped.accept({
      type: 'input',
      sequence: '9',
      generation: 5,
      bytes: new Uint8Array(10),
    })
    expect(gapVerdict).toMatchObject({ ok: false, closeCode: 'incompatible' })

    // Replay of the first offset after the cursor advanced past it, and an
    // overlap inside the first chunk's byte range.
    const replayed = createStreamInbound(grant)
    expect(
      replayed.accept({ type: 'input', sequence: '4', generation: 5, bytes: new Uint8Array(10) })
    ).toEqual({ ok: true })
    expect(
      replayed.accept({ type: 'input', sequence: '4', generation: 5, bytes: new Uint8Array(10) })
    ).toMatchObject({ ok: false, closeCode: 'incompatible' })
    const overlapped = createStreamInbound(grant)
    expect(
      overlapped.accept({ type: 'input', sequence: '4', generation: 5, bytes: new Uint8Array(10) })
    ).toEqual({ ok: true })
    expect(
      overlapped.accept({ type: 'input', sequence: '9', generation: 5, bytes: new Uint8Array(10) })
    ).toMatchObject({ ok: false, closeCode: 'incompatible' })
  })

  test('file write offsets start at fromSequence 0 (the reconciled first-chunk case)', () => {
    const fileGrant = {
      ...grant,
      protocol: 'file-bytes-v1',
      resource: { kind: 'workspace_root', id: 'wt-1', generation: 5 },
      fromSequence: '0',
    } as typeof grant
    const inbound = createStreamInbound(fileGrant)
    // The old strictly-increasing rule rejected this exact frame: its offset
    // equals the grant's fromSequence.
    expect(
      inbound.accept({ type: 'input', sequence: '0', generation: 5, bytes: new Uint8Array(4) })
    ).toEqual({ ok: true })
    expect(
      inbound.accept({ type: 'input', sequence: '4', generation: 5, bytes: new Uint8Array(4) })
    ).toEqual({ ok: true })
    // A gapped chunk closes typed...
    expect(
      createStreamInbound(fileGrant).accept({
        type: 'input',
        sequence: '5',
        generation: 5,
        bytes: new Uint8Array(4),
      })
    ).toMatchObject({ ok: false, closeCode: 'incompatible' })
    // ...and so does replaying the first offset.
    const replay = createStreamInbound(fileGrant)
    expect(
      replay.accept({ type: 'input', sequence: '0', generation: 5, bytes: new Uint8Array(4) })
    ).toEqual({ ok: true })
    expect(
      replay.accept({ type: 'input', sequence: '0', generation: 5, bytes: new Uint8Array(4) })
    ).toMatchObject({ ok: false, closeCode: 'incompatible' })
  })

  test('byte-less write frames keep strictly increasing event sequences', () => {
    const inbound = createStreamInbound(grant)
    expect(
      inbound.accept({ type: 'resize', sequence: '9', generation: 5, cols: 2, rows: 2 })
    ).toEqual({ ok: true })
    // Replays of an event counter stay refused.
    expect(
      inbound.accept({ type: 'resize', sequence: '9', generation: 5, cols: 2, rows: 2 })
    ).toMatchObject({ ok: false, closeCode: 'incompatible' })

    // Event counters never fall behind bytes already consumed.
    const behind = createStreamInbound(grant)
    expect(
      behind.accept({ type: 'input', sequence: '4', generation: 5, bytes: new Uint8Array(10) })
    ).toEqual({ ok: true })
    expect(
      behind.accept({ type: 'resize', sequence: '8', generation: 5, cols: 2, rows: 2 })
    ).toMatchObject({ ok: false, closeCode: 'incompatible' })

    // ...and they do not advance the offset cursor: input contiguity continues
    // at the same offset end across interleaved control frames.
    const mixed = createStreamInbound(grant)
    expect(
      mixed.accept({ type: 'input', sequence: '4', generation: 5, bytes: new Uint8Array(10) })
    ).toEqual({ ok: true })
    expect(
      mixed.accept({
        type: 'gesture',
        sequence: '20',
        generation: 5,
        gesture: { kind: 'tap', x: 0.5, y: 0.5 },
      })
    ).toEqual({ ok: true })
    expect(
      mixed.accept({ type: 'input', sequence: '14', generation: 5, bytes: new Uint8Array(4) })
    ).toEqual({ ok: true })
  })

  test('enforces direction, sequence, generation, and size bounds', () => {
    const inbound = createStreamInbound(grant)
    // An offset below the resume point replays already-passed bytes.
    expect(
      inbound.accept({ type: 'input', sequence: '2', generation: 5, bytes: new Uint8Array(1) })
    ).toMatchObject({ ok: false, closeCode: 'incompatible' })

    const fresh = createStreamInbound(grant)
    expect(
      fresh.accept({ type: 'input', sequence: '4', generation: 5, bytes: new Uint8Array(10) })
    ).toEqual({ ok: true })
    expect(
      fresh.accept({ type: 'input', sequence: '14', generation: 4, bytes: new Uint8Array(10) })
    ).toMatchObject({ ok: false, closeCode: 'stale_generation' })

    const sized = createStreamInbound(grant)
    expect(
      sized.accept({ type: 'input', sequence: '4', generation: 5, bytes: new Uint8Array(129) })
    ).toMatchObject({ ok: false, closeCode: 'backpressure' })
  })

  test('read grants accept only credit', () => {
    const readGrant = { ...grant, direction: 'read' } as typeof grant
    const inbound = createStreamInbound(readGrant)
    expect(
      inbound.accept({ type: 'ack', throughSequence: '4', availableCreditBytes: 1024 })
    ).toEqual({ ok: true })
    expect(
      inbound.accept({ type: 'ack', throughSequence: '3', availableCreditBytes: 1024 })
    ).toEqual({ ok: true })
    expect(
      inbound.accept({ type: 'input', sequence: '5', generation: 5, bytes: new Uint8Array(1) })
    ).toMatchObject({ ok: false, closeCode: 'incompatible' })
  })
})
