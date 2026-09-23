// Wire protocol between the desktop shell and the detached versioned
// terminal sidecar (issue #396). The sidecar owns PTYs and durable history
// so shells survive UI/app restarts; its endpoint file carries the protocol
// version, executable identity, PID/start identity, and endpoint credential
// (owner-only; a PID/port file alone grants nothing).
//
// Framing: [u32 big-endian length][u8 channel][payload]
//   channel 0x01: canonical JSON control message
//   channel 0x02: byte frame — [u32 metaLength][meta JSON][raw bytes]
// Byte frames are never base64- or JSON-transcoded (Dev Runtime spec).
export const SIDECAR_PROTOCOL = { name: 'adea-terminal-sidecar', major: 1, minor: 0 } as const

export const ENDPOINT_SCHEMA_VERSION = 1

export type SidecarProtocol = Readonly<{ name: string; major: number; minor: number }>

export type SidecarScope = Readonly<{
  accountId: string
  workspaceId: string
  runtimeNodeId: string
}>

export type SidecarRequest =
  | {
      type: 'hello'
      credential: string
      nonce: string
      protocol: SidecarProtocol
      scope: SidecarScope
    }
  | {
      type: 'terminal.create'
      requestId: string
      terminalId: string
      generation: number
      cols: number
      rows: number
      cwd: string
      shell: string
      args: readonly string[]
    }
  | { type: 'terminal.write'; requestId: string; terminalId: string; byteLength: number }
  | { type: 'terminal.resize'; requestId: string; terminalId: string; cols: number; rows: number }
  | {
      type: 'terminal.signal'
      requestId: string
      terminalId: string
      signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'SIGHUP'
    }
  | { type: 'terminal.terminate'; requestId: string; terminalId: string }
  | {
      type: 'terminal.attach'
      requestId: string
      terminalId: string
      subscriberId: string
      sinceSeq: string
    }
  | { type: 'terminal.detach'; requestId: string; terminalId: string; subscriberId: string }
  | {
      type: 'terminal.ack'
      requestId: string
      terminalId: string
      subscriberId: string
      byteCount: number
    }
  | { type: 'terminal.checkpoint'; requestId: string; terminalId: string }
  | { type: 'terminal.list'; requestId: string }
  | { type: 'terminal.search'; requestId: string; terminalId: string; query: string; limit: number }
  | { type: 'terminal.historyDelete'; requestId: string; terminalId: string }

export type SidecarResponse =
  | {
      type: 'welcome'
      protocol: SidecarProtocol
      sidecarVersion: string
      pid: number
      pidStartIdentity: string
    }
  | { type: 'refused'; code: string; message: string }
  | { type: 'result'; requestId: string; ok: true; value: unknown }
  | { type: 'result'; requestId: string; ok: false; error: { code: string; message: string } }
  | { type: 'resync'; terminalId: string; subscriberId: string; checkpointSequence: string }
  | { type: 'exited'; terminalId: string; generation: number; exitCode: number | null }
  | { type: 'heartbeat'; at: string }

export type ByteFrameMeta = Readonly<{
  kind: 'terminal.data' | 'terminal.input'
  terminalId: string
  generation: number
  seq: string
  emittedAt: string
  byteLength: number
  /** Sidecar subscriber this frame belongs to (data out / input in routing). */
  subscriberId?: string
}>

export const FRAME_CHANNEL_CONTROL = 0x01
export const FRAME_CHANNEL_BYTES = 0x02

export function encodeControl(message: SidecarRequest | SidecarResponse): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(message))
  const out = new Uint8Array(5 + payload.byteLength)
  const view = new DataView(out.buffer)
  view.setUint32(0, payload.byteLength + 1, false)
  out[4] = FRAME_CHANNEL_CONTROL
  out.set(payload, 5)
  return out
}

export function encodeByteFrame(meta: ByteFrameMeta, bytes: Uint8Array): Uint8Array {
  const metaPayload = new TextEncoder().encode(JSON.stringify(meta))
  const out = new Uint8Array(5 + 4 + metaPayload.byteLength + bytes.byteLength)
  const view = new DataView(out.buffer)
  view.setUint32(0, 1 + 4 + metaPayload.byteLength + bytes.byteLength, false)
  out[4] = FRAME_CHANNEL_BYTES
  view.setUint32(5, metaPayload.byteLength, false)
  out.set(metaPayload, 9)
  out.set(bytes, 9 + metaPayload.byteLength)
  return out
}

export type DecodedSidecarFrame =
  | { channel: typeof FRAME_CHANNEL_CONTROL; message: SidecarRequest | SidecarResponse }
  | { channel: typeof FRAME_CHANNEL_BYTES; meta: ByteFrameMeta; bytes: Uint8Array }

/** Incremental frame decoder: tolerates chunk and frame boundaries. */
export function createFrameDecoder() {
  let buffer = new Uint8Array(0)
  const frames: DecodedSidecarFrame[] = []

  function take(): DecodedSidecarFrame | null {
    if (buffer.byteLength < 5) return null
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    const length = view.getUint32(0, false)
    if (length > 64 * 1024 * 1024) throw new Error('sidecar frame exceeds the maximum size')
    if (buffer.byteLength < 4 + length) return null
    const channel = buffer[4]!
    const payload = buffer.subarray(5, 4 + length)
    buffer = buffer.slice(4 + length)
    if (channel === FRAME_CHANNEL_CONTROL) {
      const message = JSON.parse(new TextDecoder().decode(payload))
      return { channel, message }
    }
    if (channel === FRAME_CHANNEL_BYTES) {
      const metaView = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
      const metaLength = metaView.getUint32(0, false)
      const meta = JSON.parse(new TextDecoder().decode(payload.subarray(4, 4 + metaLength)))
      const bytes = payload.slice(4 + metaLength)
      return { channel, meta, bytes }
    }
    throw new Error(`unknown sidecar frame channel ${channel}`)
  }

  return {
    push(bytes: Uint8Array): DecodedSidecarFrame[] {
      const merged = new Uint8Array(buffer.byteLength + bytes.byteLength)
      merged.set(buffer)
      merged.set(bytes, buffer.byteLength)
      buffer = merged
      frames.length = 0
      for (;;) {
        const frame = take()
        if (!frame) break
        frames.push(frame)
      }
      return [...frames]
    },
  }
}

/** Transport-agnostic duplex seam so the sidecar is testable in-process. */
export interface ByteDuplex {
  send(bytes: Uint8Array): void
  onData(callback: (bytes: Uint8Array) => void): () => void
  onClose(callback: () => void): void
  close(): void
  /**
   * Resolves once the transport's pending write queue is at or below
   * `highWaterBytes`, or the connection is gone. A replay far larger than the
   * transport's queue bound paces on this instead of enqueueing the whole span
   * and tripping the overflow guard (#593). Absent on in-process duplexes with
   * no queue that can overflow.
   */
  whenBelow?(highWaterBytes: number): Promise<void>
}
