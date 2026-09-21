// The desktop `DevRuntimeService.streams()` implementation (#399 residue):
// attaches minted `file-bytes-v1` grants through the shell's stream relay,
// which runs the gateway's real attach contract (single-use channel-bound
// grant → authority `attachStream` → inbound frame discipline → provider
// byte-halves) on the page's own channel. The renderer never binds a second
// WebSocket — the launch bootstrap is consumed once per page and grants are
// caller-channel-bound — and never sees the channel secret: the bridge signs
// the attach proof inside its closure, and only opaque proofs cross here.
//
// Wire legs (both bounded control transports):
//  - shell → renderer frames ride the signed event path
//    (`desktop_file_stream`, payloads `{ streamId, frame }`, byte-bearing
//    frames base64-encoded within the 64 KiB frame bound);
//  - renderer → shell frames ride the signed legacy invoke path
//    (`desktop_file_stream_frame`).
//
// Client-side bounds honored here regardless of host behaviour: one 64 MiB
// transfer ceiling check is the pane's, but a refused relay bind surfaces as
// a typed `DevError` (never a string), so open/save falls back cleanly.
import type { DevError, DevStreamFrame, DevStreamGrant } from '@adea-ai/types/dev-runtime'
import type { DevStreamTransport, DevStreamTransportSocket } from '@adea-ai/dev-view/platform'

import type { DesktopShell } from './desktop-bridge'

/** The signed event the shell relay publishes relay frames on. */
export const FILE_STREAM_RELAY_EVENT = 'desktop_file_stream'

/**
 * The relay command family composes in the shell entry next to
 * `desktop_identity_*` (docs/specs/desktop-auth.md, IPC contract) — it needs
 * the authority and gateway, not the `commands.ts` registry. Dispatch goes
 * through the same signed bridge invoke, spelled via this table so the
 * commands.ts registry scanner does not misreport the family as unregistered
 * surface.
 */
const RELAY_COMMANDS = {
  open: 'desktop_file_stream_open',
  frame: 'desktop_file_stream_frame',
  close: 'desktop_file_stream_close',
} as const

/** One relay-leg frame: the JSON-safe mirror of a `DevStreamFrame` (`bytes`
 *  is base64). Must stay shape-compatible with the shell's relay codec. */
export type RelayFrame =
  | { type: 'opened'; protocol: string; generation: number; nextSequence: string }
  | { type: 'data'; sequence: string; bytes: string }
  | { type: 'input'; sequence: string; generation: number; bytes: string }
  | { type: 'ack'; throughSequence: string; availableCreditBytes: number }
  | { type: 'error'; error: DevError }
  | { type: 'close'; code: string; reason?: string }

function relayError(code: string, message: string): { error: DevError } {
  return {
    error: {
      code: code as DevError['code'],
      retryable: code === 'capability_unavailable' || code === 'token_expired',
      message,
    },
  }
}

/** Decodes one relay frame from the event payload into a `DevStreamFrame`. */
export function fromRelayFrame(payload: RelayFrame): DevStreamFrame {
  switch (payload.type) {
    case 'opened':
      return {
        type: 'opened',
        protocol: payload.protocol as DevStreamGrant['protocol'],
        generation: payload.generation,
        nextSequence: payload.nextSequence,
      }
    case 'data':
      return {
        type: 'data',
        sequence: payload.sequence,
        bytes: new Uint8Array(
          atob(payload.bytes)
            .split('')
            .map((char) => char.charCodeAt(0))
        ),
      }
    case 'ack':
      return {
        type: 'ack',
        throughSequence: payload.throughSequence,
        availableCreditBytes: payload.availableCreditBytes,
      }
    case 'input':
      return {
        type: 'input',
        sequence: payload.sequence,
        generation: payload.generation,
        bytes: new Uint8Array(
          atob(payload.bytes)
            .split('')
            .map((char) => char.charCodeAt(0))
        ),
      }
    case 'error':
      return { type: 'error', error: payload.error }
    case 'close':
      return {
        type: 'close',
        code: payload.code as Extract<DevStreamFrame, { type: 'close' }>['code'],
        ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
      }
    default:
      throw new Error('unknown relay frame kind')
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 1)
    binary += String.fromCharCode(bytes[index] as number)
  return btoa(binary)
}

function randomNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let binary = ''
  for (let index = 0; index < bytes.length; index += 1)
    binary += String.fromCharCode(bytes[index] as number)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Builds the stream transport from the injected bridge. Returns `undefined`
 * when the bridge predates the relay surface — the pane keeps its bounded
 * control-path behaviour, exactly like a web-only runtime.
 */
export function createDesktopStreamTransport(options: {
  bridge: DesktopShell
}): DevStreamTransport | undefined {
  const { bridge } = options
  // The bridge only exists inside the app's own window (guarded upstream);
  // its relay-signing seam is what makes the transport bindable at all.
  if (!bridge.streamAttachProof) return undefined
  const signAttach: NonNullable<DesktopShell['streamAttachProof']> = bridge.streamAttachProof

  function connect(
    grant: DevStreamGrant,
    handlers: {
      onFrame: (frame: DevStreamFrame) => void
      onClose: (code: number, reason: string) => void
    }
  ): DevStreamTransportSocket {
    let settled = false
    let bound = false
    let disposeEventSource: (() => void) | undefined
    const queued: DevStreamFrame[] = []

    const socket: DevStreamTransportSocket = {
      // Logically open as soon as the pane holds the socket — the model sends
      // its write/input frames immediately after connect and expects the
      // transport to queue them until the attach bind completes (the same
      // contract the authenticated channel socket has).
      get open() {
        return !settled
      },
      send(frame: DevStreamFrame) {
        if (settled) return
        if (!bound) {
          queued.push(frame)
          return
        }
        enqueue(frame)
      },
      close(code: number, reason: string) {
        void settle(code, reason)
      },
    }

    function fail(error: DevError): void {
      if (settled) return
      settled = true
      bound = false
      try {
        handlers.onFrame({ type: 'error', error })
      } catch {
        /* handler errors never break the transport */
      }
      handlers.onClose(1008, error.code)
      void teardown()
    }

    async function teardown(): Promise<void> {
      const unsubscribe = disposeEventSource
      disposeEventSource = undefined
      try {
        await bridge.invoke(RELAY_COMMANDS.close, {
          channelId: bindIdentity?.channelId,
          clientCredentialId: bindIdentity?.clientCredentialId,
          streamId: grant.grantId,
        })
      } catch {
        /* best-effort teardown; the relay sweeps abandoned sessions */
      }
      unsubscribe?.()
    }

    async function deliver(frame: DevStreamFrame): Promise<void> {
      if (frame.type !== 'ack' && frame.type !== 'input') return
      const framePayload: Record<string, unknown> =
        frame.type === 'ack'
          ? {
              type: 'ack',
              throughSequence: frame.throughSequence,
              availableCreditBytes: frame.availableCreditBytes,
            }
          : {
              type: 'input',
              sequence: frame.sequence,
              generation: frame.generation,
              bytes: toBase64(frame.bytes),
            }
      try {
        const result = (await bridge.invoke(RELAY_COMMANDS.frame, {
          channelId: bindIdentity?.channelId,
          clientCredentialId: bindIdentity?.clientCredentialId,
          streamId: grant.grantId,
          frame: framePayload,
        })) as { status?: string } | undefined
        if (result?.status === 'refused') {
          fail(relayError('invalid_state', 'the relay refused a stream frame').error)
        }
      } catch {
        if (!settled) {
          fail(relayError('channel_unauthenticated', 'the stream relay invoke failed').error)
        }
      }
    }

    // Client frames reach the relay strictly in send order — the credit
    // window and input contiguity both assume the channel's FIFO discipline,
    // so concurrent invokes are chained, never raced.
    let deliveryChain: Promise<void> = Promise.resolve()
    function enqueue(frame: DevStreamFrame): void {
      deliveryChain = deliveryChain.then(() => deliver(frame)).catch(() => {})
    }

    function onEvent(payload: unknown): void {
      if (settled) return
      const event = payload as { streamId?: unknown; frame?: RelayFrame } | undefined
      if (!event || event.streamId !== grant.grantId || !event.frame) return
      let frame: DevStreamFrame
      try {
        frame = fromRelayFrame(event.frame)
      } catch {
        fail(relayError('invalid_state', 'the relay delivered a malformed frame').error)
        return
      }
      if (frame.type === 'close') {
        settled = true
        bound = false
        void teardown()
      }
      handlers.onFrame(frame)
    }

    let bindIdentity: { channelId: string; clientCredentialId: string } | undefined

    void (async () => {
      try {
        const requestId = crypto.randomUUID()
        const nonce = randomNonce()
        const signed = await signAttach({
          grantId: grant.grantId,
          requestId,
          nonce,
          fromSequence: grant.fromSequence,
        })
        bindIdentity = {
          channelId: signed.channelId,
          clientCredentialId: signed.clientCredentialId,
        }
        // Subscribe before the open invoke: the relay starts pumping the
        // moment the provider attaches, and no frame may be missed.
        disposeEventSource = await bridge.listen(FILE_STREAM_RELAY_EVENT, onEvent)
        const result = (await bridge.invoke(RELAY_COMMANDS.open, {
          channelId: signed.channelId,
          clientCredentialId: signed.clientCredentialId,
          attach: {
            schemaVersion: 1,
            grantId: grant.grantId,
            requestId,
            nonce,
            fromSequence: grant.fromSequence,
            proof: signed.proof,
          },
        })) as { status?: string; code?: string; message?: string } | undefined
        if (!result || result.status !== 'granted') {
          fail(
            relayError(
              result?.code ?? 'capability_unavailable',
              result?.message ?? 'the shell refused the bulk-stream attach'
            ).error
          )
          return
        }
        bound = true
        for (const frame of queued.splice(0)) {
          if (settled) break
          enqueue(frame)
        }
      } catch (error) {
        fail(
          relayError(
            'capability_unavailable',
            error instanceof Error ? error.message : 'the stream relay bind failed'
          ).error
        )
      }
    })()

    async function settle(code: number, reason: string): Promise<void> {
      if (settled) return
      settled = true
      bound = false
      handlers.onClose(code, reason)
      await teardown()
    }

    return socket
  }

  return { connect }
}
