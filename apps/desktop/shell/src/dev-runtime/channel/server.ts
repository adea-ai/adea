// The channel gateway: every `/__adea/*` route and the full-duplex WebSocket,
// behind the M10 gate. The legacy invoke/events paths are guarded here (they
// are no longer an unauthenticated authority), `dev.runtime.execute.v1` and
// `dev.runtime.stream.attach.v1` run over the authenticated channel, and the
// static bridge script is served without secrets.
import type { ServerWebSocket } from 'bun'

import {
  LEGACY_INVOKE_PROOF_CONTEXT,
  MAX_CONTROL_BYTES,
  ChannelRejection,
  type ChannelAuthority,
  type ChannelIdentity,
} from './authority'
import { createBridgeScript } from './bridge'
import {
  createStreamInbound,
  encodeStreamFrame,
  parseStreamFrame,
  type StreamCloseCode,
} from './wire'

export type BridgeResult = { ok: true; value: unknown } | { ok: false; error: string }

const LEGACY_COMMAND_PATTERN = /^[a-z][a-z0-9_]*$/
const HANDSHAKE_MAX_BYTES = 64 * 1024
const EVENT_TOKEN_MAX_BYTES = 4 * 1024
const MAX_WS_EVENT_SUBSCRIPTIONS = 8

type StreamSession = {
  grant: import('../../../../../../packages/types/src/dev-runtime').DevStreamGrant
  inbound: ReturnType<typeof createStreamInbound>
  onFrame?: (
    frame: import('../../../../../../packages/types/src/dev-runtime').DevStreamFrame
  ) => void
  send: (frame: import('../../../../../../packages/types/src/dev-runtime').DevStreamFrame) => void
  close: (code: StreamCloseCode, reason?: string) => void
}

export type StreamProvider = (session: StreamSession) => void

export type SocketData = {
  identity?: ChannelIdentity
  subscriptions: Set<string>
  stream?: StreamSession
}

type ChannelSocket = ServerWebSocket<SocketData>

const WS_CLOSE_CODES: Record<StreamCloseCode, number> = {
  normal: 1000,
  expired: 1000,
  revoked: 1008,
  stale_generation: 1008,
  backpressure: 1013,
  incompatible: 1003,
}

function rejectionResponse(error: unknown): Response {
  if (error instanceof ChannelRejection) {
    return Response.json(
      {
        ok: false,
        error: { code: error.code, retryable: error.retryable, message: error.message },
      },
      { status: error.httpStatus }
    )
  }
  return Response.json(
    { ok: false, error: { code: 'invalid_state', retryable: false, message: 'request failed' } },
    { status: 400 }
  )
}

async function readBody(request: Request, maxBytes: number): Promise<string> {
  const body = await request.text()
  if (body.length > maxBytes) {
    throw new ChannelRejection('limit_exceeded', 'request body exceeds the control limit', 413)
  }
  return body
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    throw new ChannelRejection('unsupported_version', 'request body was not valid JSON', 400)
  }
}

function untrusted(): Response {
  return new Response(null, { status: 403 })
}
function unauthenticated(): Response {
  return new Response(null, { status: 401 })
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function createChannelGateway(input: {
  authority: ChannelAuthority
  invoke: (cmd: string, args?: Record<string, unknown>) => BridgeResult | Promise<BridgeResult>
  shellOrigin: string
}) {
  const { authority } = input
  const eventSubscribers = new Set<{
    event: string
    deliver: (payload: unknown) => void
  }>()
  const streamHandlers = new Map<string, StreamProvider>()

  function bridgeScript(): string {
    return createBridgeScript({
      // Must equal the separator authority.legacyProofMessage joins with.
      contextSeparator: '\u001f',
      shellOrigin: input.shellOrigin,
    })
  }

  function bootstrapToken(): string {
    return authority.issueLaunchBootstrap()
  }

  function trusted(request: Request): boolean {
    return authority.isTrustedRequest({
      host: request.headers.get('host'),
      origin: request.headers.get('origin'),
      secFetchSite: request.headers.get('sec-fetch-site'),
    })
  }

  function sseStream(event: string): Response {
    let heartbeat: ReturnType<typeof setInterval> | undefined
    const encoder = new TextEncoder()
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const subscriber = {
      event,
      deliver: (payload: unknown) => {
        try {
          controller?.enqueue(
            encoder.encode(`data: ${JSON.stringify({ payload })}

`)
          )
        } catch {
          /* subscriber vanished mid-write */
        }
      },
    }
    const stream = new ReadableStream({
      start(streamController) {
        controller = streamController
        controller.enqueue(encoder.encode(': connected\n\n'))
        heartbeat = setInterval(() => {
          try {
            controller?.enqueue(
              encoder.encode(`data: ${JSON.stringify({ at: Date.now() })}

`)
            )
          } catch {
            /* closed */
          }
        }, 30_000)
      },
      cancel() {
        eventSubscribers.delete(subscriber)
        if (heartbeat) clearInterval(heartbeat)
      },
    })
    eventSubscribers.add(subscriber)
    return new Response(stream, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
    })
  }

  /** Delivers a shell event to every authenticated subscriber. */
  function publish(event: string, payload: unknown): void {
    for (const subscriber of eventSubscribers) {
      if (subscriber.event === event) subscriber.deliver(payload)
    }
  }

  function registerStreamHandler(protocol: string, provider: StreamProvider): void {
    streamHandlers.set(protocol, provider)
  }

  function closeStream(
    socket: ChannelSocket,
    data: SocketData,
    closeCode: StreamCloseCode,
    reason?: string
  ): void {
    data.stream = undefined
    try {
      socket.send(
        encodeStreamFrame({ type: 'close', code: closeCode, ...(reason ? { reason } : {}) }),
        true
      )
    } catch {
      /* socket already gone */
    }
    socket.close(WS_CLOSE_CODES[closeCode], reason)
  }

  async function handleTextMessage(socket: ChannelSocket, raw: string): Promise<void> {
    const data = socket.data
    if (data.identity === undefined) {
      // The first text message must complete the handshake.
      try {
        const reply = authority.handshake(safeJson(raw), { trusted: true })
        if (!reply.ok) throw new ChannelRejection('channel_unauthenticated', 'handshake refused')
        data.identity = {
          channelId: reply.channelId,
          clientCredentialId: reply.clientCredentialId,
        }
        socket.send(JSON.stringify({ method: 'dev.runtime.handshake.v1', reply }), false)
      } catch (error) {
        const code = error instanceof ChannelRejection ? error.code : 'unsupported_version'
        socket.send(
          JSON.stringify({
            method: 'dev.runtime.handshake.v1',
            reply: { ok: false, error: { code, retryable: false, message: 'handshake refused' } },
          }),
          false
        )
        socket.close(1008, 'handshake refused')
      }
      return
    }
    const message = safeJson(raw) as { method?: string } | null
    if (!message || typeof message.method !== 'string') {
      socket.close(1003, 'malformed channel message')
      return
    }
    if (message.method === 'dev.runtime.execute.v1') {
      const reply = await authority.execute((message as { frame?: unknown }).frame, {
        trusted: true,
      })
      socket.send(JSON.stringify({ method: message.method, reply }), false)
      return
    }
    if (message.method === 'dev.runtime.stream.attach.v1') {
      const attach = (message as { attach?: unknown }).attach
      if (data.stream) {
        closeStream(socket, data, 'incompatible', 'a stream is already attached')
        return
      }
      let grant
      try {
        grant = authority.attachStream({
          identity: data.identity,
          attach,
          acceptProtocol: (protocol) => streamHandlers.has(protocol),
        })
      } catch (error) {
        const code = error instanceof ChannelRejection ? error.code : 'unsupported_version'
        socket.send(
          JSON.stringify({
            method: message.method,
            reply: {
              ok: false,
              error: { code, retryable: false, message: 'stream attach refused' },
            },
          }),
          false
        )
        return
      }
      const session: StreamSession = {
        grant,
        inbound: createStreamInbound(grant),
        send: (frame) => {
          socket.send(encodeStreamFrame(frame), true)
        },
        close: (code, reason) => closeStream(socket, data, code, reason),
      }
      data.stream = session
      session.send({
        type: 'opened',
        protocol: grant.protocol,
        generation: grant.resource.generation,
        nextSequence: grant.fromSequence,
      })
      const provider = streamHandlers.get(grant.protocol)
      if (provider) provider(session)
      return
    }
    if (message.method === 'dev.runtime.events.v1') {
      const payload = (message as { payload?: { subscribe?: unknown } }).payload
      const event = typeof payload?.subscribe === 'string' ? payload.subscribe : undefined
      if (!event || data.subscriptions.size >= MAX_WS_EVENT_SUBSCRIPTIONS) {
        socket.close(1003, 'event subscription refused')
        return
      }
      data.subscriptions.add(event)
      eventSubscribers.add({
        event,
        deliver: (eventPayload) =>
          socket.send(
            JSON.stringify({ method: 'dev.runtime.events.v1', payload: eventPayload }),
            false
          ),
      })
      return
    }
    socket.close(1003, 'unknown channel method')
  }

  function handleBinaryMessage(socket: ChannelSocket, raw: Uint8Array): void {
    const data = socket.data
    const stream = data.stream
    if (!stream) {
      socket.close(1003, 'no attached stream')
      return
    }
    let frame
    try {
      frame = parseStreamFrame(raw)
    } catch {
      closeStream(socket, data, 'incompatible', 'malformed stream frame')
      return
    }
    const verdict = stream.inbound.accept(frame)
    if (!verdict.ok) {
      closeStream(socket, data, verdict.closeCode, verdict.reason)
      return
    }
    stream.onFrame?.(frame)
  }

  /**
   * Handles every `/__adea/*` request. `upgrade` performs the WebSocket
   * upgrade for the full-duplex channel route; when it returns false the
   * caller answers with 401.
   */
  async function handle(
    request: Request,
    upgrade: (request: Request, data: SocketData) => boolean
  ): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname
    try {
      if (path === '/__adea/bridge.js') {
        if (!trusted(request)) return untrusted()
        return new Response(bridgeScript(), {
          headers: { 'content-type': 'text/javascript', 'cache-control': 'no-store' },
        })
      }
      if (path === '/__adea/handshake' && request.method === 'POST') {
        if (!trusted(request)) return untrusted()
        const body = await readBody(request, HANDSHAKE_MAX_BYTES)
        const reply = authority.handshake(parseJson(body), { trusted: true })
        return Response.json(reply)
      }
      if (path === '/__adea/invoke' && request.method === 'POST') {
        if (!trusted(request)) return untrusted()
        const body = await readBody(request, MAX_CONTROL_BYTES)
        authority.authenticateLegacyRequest({ headers: Object.fromEntries(request.headers), body })
        const payload = parseJson(body) as { cmd?: unknown; args?: unknown }
        const cmd = typeof payload.cmd === 'string' ? payload.cmd : ''
        if (!LEGACY_COMMAND_PATTERN.test(cmd) || cmd.startsWith('dev.')) {
          return Response.json({
            ok: false,
            error: 'unknown command: privileged dev.* operations use dev.runtime.execute.v1',
          })
        }
        const args =
          payload.args !== null &&
          typeof payload.args === 'object' &&
          !Array.isArray(payload.args) &&
          Object.getPrototypeOf(payload.args ?? {}) === Object.prototype
            ? (payload.args as Record<string, unknown>)
            : undefined
        const result = await input.invoke(cmd, args)
        return Response.json(result)
      }
      if (path === '/__adea/events-token' && request.method === 'POST') {
        if (!trusted(request)) return untrusted()
        const body = await readBody(request, EVENT_TOKEN_MAX_BYTES)
        const identity = authority.authenticateLegacyRequest({
          headers: Object.fromEntries(request.headers),
          body,
        })
        return Response.json(authority.mintEventsToken(identity))
      }
      if (path === '/__adea/events' && request.method === 'GET') {
        if (!trusted(request)) return untrusted()
        const channel = url.searchParams.get('channel')
        const credential = url.searchParams.get('credential')
        const token = url.searchParams.get('token')
        if (!channel || !credential || !token) return unauthenticated()
        const ok = authority.consumeEventsToken(
          { channelId: channel, clientCredentialId: credential },
          token
        )
        if (!ok) return unauthenticated()
        return sseStream(url.searchParams.get('event') ?? '')
      }
      if (path === '/__adea/channel' && request.method === 'GET') {
        if (!trusted(request)) return untrusted()
        const upgraded = upgrade(request, { subscriptions: new Set() })
        if (!upgraded) return unauthenticated()
        return new Response(null, { status: 101 })
      }
      return new Response(null, { status: 404 })
    } catch (error) {
      return rejectionResponse(error)
    }
  }

  const websockets = {
    open(_socket: ChannelSocket) {},
    message(socket: ChannelSocket, message: string | Uint8Array) {
      try {
        if (typeof message === 'string') {
          void handleTextMessage(socket, message)
        } else {
          handleBinaryMessage(socket, message)
        }
      } catch {
        socket.close(1011, 'channel handler failed')
      }
    },
    close(socket: ChannelSocket) {
      const data = socket.data
      data.stream?.inbound.markClosed()
      data.stream = undefined
      data.subscriptions.clear()
    },
  }

  return {
    bootstrapToken,
    bridgeScript,
    handle,
    websockets,
    publish,
    registerStreamHandler,
    LEGACY_INVOKE_PROOF_CONTEXT,
  }
}

export type ChannelGateway = ReturnType<typeof createChannelGateway>
