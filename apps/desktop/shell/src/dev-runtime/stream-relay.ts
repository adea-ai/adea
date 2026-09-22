// The desktop renderer's bulk-stream attach relay (#399 residue).
//
// `DevRuntimeService.streams()` in the web client attaches `file-bytes-v1`
// grants through this relay instead of a second WebSocket: the launch
// bootstrap is consumed once per page and every handshake mints a NEW channel
// (grants are caller-channel-bound), so per-transfer WS channels would evict
// the page channel from `MAX_ACTIVE_CHANNELS` and brick the bridge. The relay
// keeps the exact gateway attach contract on the page's own channel: the
// bridge signs the attach proof under its channel secret (which never leaves
// the bridge closure), the grant is consumed through the authority's real
// `attachStream` (single-use, 60 s, channel-bound, replay-protected,
// capability-gated), client frames pass the same `createStreamInbound`
// discipline the gateway WebSocket applies, and the real registered provider
// byte-halves pump an in-memory session. Frames cross to the renderer on the
// signed event path (`publish` → SSE) and return on the signed legacy invoke
// path — both are bounded control transports, so relay payloads are
// JSON-safe: byte-bearing frames carry base64 within the frame bound.
import { Buffer } from 'node:buffer'

import type { ChannelAuthority, ChannelIdentity } from './channel/authority'
import type { StreamProvider } from './channel/server'
import { createStreamInbound, type StreamCloseCode } from './channel/wire'
import type {
  DevError,
  DevStreamFrame,
  DevStreamGrant,
} from '../../../../../packages/types/src/dev-runtime'

/** The signed event every relay stream publishes its frames on. Payloads are
 *  `{ streamId, frame: RelayFrame }`; clients filter by their grant id. */
export const FILE_STREAM_RELAY_EVENT = 'desktop_file_stream'

// Relay payload bound: file grants mint 64 KiB frames; base64 inflates 4/3.
// Oversize payloads are refused before the inbound validator sees them.
export const RELAY_FRAME_BYTES_MAX = 128 * 1024

// Grace beyond the 60 s attach expiry: an in-flight transfer legitimately
// outlives its grant's attach window; abandonment (client gone, frames
// unanswered) is what the sweep actually reclaims.
const STREAM_GRACE_MS = 5 * 60_000

/** The JSON-safe frame shape crossing the relay legs (`bytes` is base64). */
export type RelayFrame =
  | { type: 'opened'; protocol: string; generation: number; nextSequence: string }
  | { type: 'data'; sequence: string; bytes: string }
  | { type: 'input'; sequence: string; generation: number; bytes: string }
  | { type: 'ack'; throughSequence: string; availableCreditBytes: number }
  | { type: 'error'; error: DevError }
  | { type: 'close'; code: StreamCloseCode; reason?: string }

export type RelayStreamRefusal = { status: 'refused'; code: string; message: string }
export type RelayStreamGranted = { status: 'granted'; grant: DevStreamGrant }
export type RelayStreamAccepted = { status: 'accepted' }
export type RelayStreamClosed = { status: 'closed'; code: StreamCloseCode; reason?: string }

export type RelayResult<T> = T | RelayStreamRefusal

function refusal(code: string, message: string): RelayStreamRefusal {
  return { status: 'refused', code, message }
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

function fromBase64(text: unknown, bound: number): Uint8Array {
  if (typeof text !== 'string') throw new Error('relay frame payload is missing')
  const bytes = new Uint8Array(Buffer.from(text, 'base64'))
  if (bytes.byteLength > bound) throw new Error('relay frame payload exceeds the bound')
  return bytes
}

/** Encodes one stream frame for the relay legs (server→client direction may
 *  carry every file-stream kind; the decoder accepts only client input). */
export function toRelayFrame(frame: DevStreamFrame): RelayFrame {
  switch (frame.type) {
    case 'opened':
      return {
        type: 'opened',
        protocol: frame.protocol,
        generation: frame.generation,
        nextSequence: frame.nextSequence,
      }
    case 'data':
      return { type: 'data', sequence: frame.sequence, bytes: toBase64(frame.bytes) }
    case 'ack':
      return {
        type: 'ack',
        throughSequence: frame.throughSequence,
        availableCreditBytes: frame.availableCreditBytes,
      }
    case 'input':
      return {
        type: 'input',
        sequence: frame.sequence,
        generation: frame.generation,
        bytes: toBase64(frame.bytes),
      }
    case 'error':
      return { type: 'error', error: frame.error }
    case 'close':
      return {
        type: 'close',
        code: frame.code,
        ...(frame.reason !== undefined ? { reason: frame.reason } : {}),
      }
    default:
      throw new Error(`relay frames do not carry ${(frame as { type: string }).type} frames`)
  }
}

/** Decodes one client→server relay frame; refuses unknown kinds and oversize
 *  payloads before the inbound validator applies the grant's own bounds. */
export function fromRelayFrame(payload: unknown, maxFrameBytes: number): DevStreamFrame {
  const candidate = payload as RelayFrame | undefined
  if (!candidate || typeof candidate !== 'object') throw new Error('relay frame is missing')
  const bound = Math.min(maxFrameBytes, RELAY_FRAME_BYTES_MAX)
  if (candidate.type === 'ack') {
    if (
      typeof candidate.throughSequence !== 'string' ||
      typeof candidate.availableCreditBytes !== 'number'
    )
      throw new Error('relay ack frame is malformed')
    return {
      type: 'ack',
      throughSequence: candidate.throughSequence,
      availableCreditBytes: candidate.availableCreditBytes,
    }
  }
  if (candidate.type === 'input') {
    if (typeof candidate.sequence !== 'string' || typeof candidate.generation !== 'number')
      throw new Error('relay input frame is malformed')
    return {
      type: 'input',
      sequence: candidate.sequence,
      generation: candidate.generation,
      bytes: fromBase64(candidate.bytes, bound),
    }
  }
  throw new Error(`relay streams accept only ack/input frames, not ${String(candidate.type)}`)
}

type RelaySession = {
  grant: DevStreamGrant
  identity: ChannelIdentity
  inbound: ReturnType<typeof createStreamInbound>
  send: (frame: DevStreamFrame) => void
  close: (code: StreamCloseCode, reason?: string) => void
  onFrame?: (frame: DevStreamFrame) => void
  onClose?: () => void
  /** Abandonment bound: attach expiry plus a streaming grace window. */
  expiresAt: number
}

export type FileStreamRelay = {
  /** Consumes the attach (real `attachStream`), binds the in-memory session,
   *  announces `opened`, and hands the session to the registered provider. */
  open(input: {
    identity: ChannelIdentity
    attach: unknown
  }): Promise<RelayResult<RelayStreamGranted>>
  /** Applies one client frame through the gateway's inbound discipline. */
  frame(input: {
    identity: ChannelIdentity
    streamId: string
    frame: unknown
  }): RelayResult<RelayStreamAccepted | RelayStreamClosed>
  /** Renderer-initiated teardown (mirror of the gateway's socket-close path:
   *  inbound closed, provider cleanup, no reply frame). */
  dispose(input: { identity: ChannelIdentity; streamId: string }): RelayResult<RelayStreamAccepted>
  sweep(): void
}

/**
 * The gateway's inbound discipline, applied verbatim: the shared
 * `createStreamInbound` validator enforces the write direction's byte-offset
 * contiguity (first chunk at the grant's `fromSequence`, every later chunk at
 * the running offset end), so the relay no longer defers ordering to the
 * provider. The provider keeps its byte-exact atomic-write guarantees
 * (digest, declared length, identity re-proofs, atomic rename) on top.
 */
function acceptFrame(
  session: RelaySession,
  frame: DevStreamFrame
): { ok: true } | { ok: false; closeCode: StreamCloseCode; reason: string } {
  return session.inbound.accept(frame)
}

export function createFileStreamRelay(input: {
  authority: Pick<ChannelAuthority, 'attachStream'>
  /** The registered stream provider for a protocol, when composed. */
  providerFor: (protocol: string) => StreamProvider | undefined
  /** The gateway's signed event fan-out (SSE bridge subscribers). */
  publish: (event: string, payload: unknown) => void
  now?: () => number
}): FileStreamRelay {
  const now = input.now ?? Date.now
  const sessions = new Map<string, RelaySession>()

  function teardown(session: RelaySession, announceAbandon: boolean): void {
    sessions.delete(session.grant.grantId)
    session.inbound.markClosed()
    try {
      session.onClose?.()
    } catch {
      /* provider cleanup must never break the relay */
    }
    if (!announceAbandon) return
    // An abandoned stream announces its teardown so a still-listening client
    // settles typed instead of waiting forever.
    try {
      input.publish(FILE_STREAM_RELAY_EVENT, {
        streamId: session.grant.grantId,
        frame: toRelayFrame({ type: 'close', code: 'expired', reason: 'relay stream abandoned' }),
      })
    } catch {
      /* subscriber vanished mid-write */
    }
  }

  function liveSession(identity: ChannelIdentity, streamId: string): RelayResult<RelaySession> {
    const session = sessions.get(streamId)
    if (!session) return refusal('not_found', 'no live relay stream is bound to this grant')
    if (
      session.identity.channelId !== identity.channelId ||
      session.identity.clientCredentialId !== identity.clientCredentialId
    )
      return refusal('identity_mismatch', 'relay stream is bound to another channel')
    return session
  }

  function publishClose(session: RelaySession, code: StreamCloseCode, reason?: string): void {
    try {
      input.publish(FILE_STREAM_RELAY_EVENT, {
        streamId: session.grant.grantId,
        frame: toRelayFrame({ type: 'close', code, ...(reason !== undefined ? { reason } : {}) }),
      })
    } catch {
      /* subscriber vanished mid-write */
    }
  }

  /** Drops abandoned sessions whose streaming grace window has passed. */
  function sweepSessions(): void {
    const at = now()
    // Deleting the current entry during Map iteration is safe and intended.
    for (const session of sessions.values()) if (session.expiresAt <= at) teardown(session, true)
  }

  return {
    async open({ identity, attach }) {
      sweepSessions()
      let grant: DevStreamGrant
      try {
        grant = input.authority.attachStream({
          identity,
          attach,
          acceptProtocol: (protocol) => input.providerFor(protocol) !== undefined,
        })
      } catch (error) {
        const candidate = error as { code?: unknown; message?: unknown }
        if (
          candidate &&
          typeof candidate.code === 'string' &&
          typeof candidate.message === 'string'
        )
          return refusal(candidate.code, candidate.message)
        return refusal('unsupported_version', 'stream attach was malformed')
      }
      const provider = input.providerFor(grant.protocol)
      if (!provider)
        return refusal(
          'capability_unavailable',
          'no provider is registered for the granted protocol'
        )
      const session: RelaySession = {
        grant,
        identity: {
          channelId: identity.channelId,
          clientCredentialId: identity.clientCredentialId,
        },
        inbound: createStreamInbound(grant),
        send: (frame) => {
          input.publish(FILE_STREAM_RELAY_EVENT, {
            streamId: grant.grantId,
            frame: toRelayFrame(frame),
          })
        },
        close: (code, reason) => {
          if (!sessions.has(grant.grantId)) return
          teardown(session, false)
          publishClose(session, code, reason)
        },
        expiresAt: Date.parse(grant.expiresAt) + STREAM_GRACE_MS,
      }
      sessions.set(grant.grantId, session)
      session.send({
        type: 'opened',
        protocol: grant.protocol,
        generation: grant.resource.generation,
        nextSequence: grant.fromSequence,
      })
      try {
        provider(session)
      } catch (error) {
        session.close('incompatible', error instanceof Error ? error.message : 'provider failed')
      }
      return { status: 'granted', grant }
    },

    frame({ identity, streamId, frame }) {
      sweepSessions()
      const found = liveSession(identity, streamId)
      if (!isSession(found)) return found
      const session = found
      if (session.expiresAt <= now()) {
        teardown(session, true)
        return refusal('token_expired', 'relay stream outlived its window')
      }
      let decoded: DevStreamFrame
      try {
        decoded = fromRelayFrame(frame, session.grant.maxFrameBytes)
      } catch (error) {
        session.close(
          'incompatible',
          error instanceof Error ? error.message : 'malformed relay frame'
        )
        return refusal('unsupported_version', 'malformed relay frame')
      }
      const verdict = acceptFrame(session, decoded)
      if (!verdict.ok) {
        session.close(verdict.closeCode, verdict.reason)
        return {
          status: 'closed',
          code: verdict.closeCode,
          ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
        }
      }
      try {
        session.onFrame?.(decoded)
      } catch (error) {
        session.close(
          'incompatible',
          error instanceof Error ? error.message : 'provider frame handling failed'
        )
        return refusal('invalid_state', 'provider frame handling failed')
      }
      return { status: 'accepted' }
    },

    dispose({ identity, streamId }) {
      const found = liveSession(identity, streamId)
      if (!isSession(found)) return found
      teardown(found, false)
      return { status: 'accepted' }
    },

    sweep() {
      sweepSessions()
    },
  }
}

function isSession(value: unknown): value is RelaySession {
  return typeof value === 'object' && value !== null && 'inbound' in (value as object)
}
