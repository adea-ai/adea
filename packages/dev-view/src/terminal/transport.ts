// Client-side terminal stream transport (issue #396).
//
// Provenance: bounded input queue, socket high-water draining, exponential
// reconnect with capped delays, heartbeat/ping timeout, suspend/resume, and
// stale-socket guards are adapted from bb
// `packages/client-core/src/terminal/terminal-websocket-transport.ts`
// (revision 52a9256373d4d36f9b60e9e2a7f333464091a2ac, MIT). The donor's
// URL/JSON/base64 path is deliberately replaced: sequence gaps here invoke
// the explicit checkpoint resync flow (never a silent counter advance), and
// delivery rides the authenticated terminal-bytes-v1 grant the M10 channel
// issued — availability mechanics are not authorization.
import type { DevStreamFrame } from '@adea-ai/types/dev-runtime'

export type TerminalConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'

/** Minimal socket surface over the app's authenticated channel stream. */
export interface TerminalStreamSocket {
  readonly bufferedAmount: number
  send(frame: DevStreamFrame): void
  close(code: number, reason: string): void
  readonly open: boolean
}

export type TerminalTransportOptions = {
  /** Opens one fresh authenticated stream (new grant per attempt). */
  connect: (handlers: {
    onFrame: (frame: DevStreamFrame) => void
    onClose: () => void
  }) => TerminalStreamSocket
  /** Delivers replayed and live output to the renderer, in order. */
  onOutput: (sequence: string, bytes: Uint8Array) => void
  onConnectionState?: (state: TerminalConnectionState) => void
  /** A gap was detected; the caller must resync from the checkpoint anchor. */
  onSequenceGap?: (expectedSeq: string, receivedSeq: string) => void
  /** `resync_required` arrived with the newest checkpoint anchor. */
  onResyncRequired?: (checkpointSequence: string) => void
  onInputOverflow?: (maxBytes: number) => void
  now?: () => number
  /** Test overrides; production uses the normative spec values. */
  limits?: Partial<typeof DEFAULT_TRANSPORT_LIMITS>
}

export const DEFAULT_TRANSPORT_LIMITS = {
  inputQueueMaxBytes: 1024 * 1024,
  socketHighWaterBytes: 1024 * 1024,
  heartbeatIntervalMs: 15_000,
  heartbeatUnhealthyAfterMs: 45_000,
  reconnectBaseMs: 250,
  reconnectMaxMs: 30_000,
} as const

type PendingInput = { bytes: number; payload: Uint8Array }

export function createTerminalTransport(options: TerminalTransportOptions) {
  const limits = { ...DEFAULT_TRANSPORT_LIMITS, ...options.limits }
  const now = options.now ?? Date.now
  let socket: TerminalStreamSocket | null = null
  let state: TerminalConnectionState = 'idle'
  let started = false
  let disposed = false
  let suspended = false
  let terminalEnded = false
  let nextOutputSeq = 0n
  let reconnectAttempt = 0
  let lastHeartbeatAt = 0
  let lastSentResize: { cols: number; rows: number } | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let drainTimer: ReturnType<typeof setTimeout> | null = null
  const pendingInputs: PendingInput[] = []
  let pendingInputBytes = 0
  let unackedBytes = 0

  function setState(next: TerminalConnectionState): void {
    if (state === next) return
    state = next
    options.onConnectionState?.(next)
  }

  function clearTimers(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
    if (drainTimer !== null) {
      clearTimeout(drainTimer)
      drainTimer = null
    }
  }

  const DRAIN_POLL_MS = 10

  /** bb's drain poll: queued input retries while credit is withheld. */
  function scheduleDrain(): void {
    if (drainTimer !== null || pendingInputs.length === 0) return
    drainTimer = setTimeout(() => {
      drainTimer = null
      flushInputs()
      scheduleDrain()
    }, DRAIN_POLL_MS)
  }

  function handleFrame(frame: DevStreamFrame): void {
    switch (frame.type) {
      case 'data': {
        const seq = BigInt(frame.sequence)
        if (seq < nextOutputSeq) return // duplicate replay guard: exactly once
        if (seq > nextOutputSeq) {
          // Never advance past an unexplained gap: resync from the anchor.
          options.onSequenceGap?.(nextOutputSeq.toString(), frame.sequence)
          return
        }
        nextOutputSeq = seq + 1n
        unackedBytes += frame.bytes.byteLength
        options.onOutput(frame.sequence, frame.bytes)
        // Credit flows back immediately; the server pauses at zero credit.
        socket?.send({
          type: 'ack',
          throughSequence: frame.sequence,
          availableCreditBytes: frame.bytes.byteLength,
        })
        return
      }
      case 'resync':
        options.onResyncRequired?.(frame.checkpointSequence)
        return
      case 'heartbeat':
        lastHeartbeatAt = now()
        return
      case 'close':
        if (frame.code === 'normal' || frame.code === 'backpressure') {
          terminalEnded = frame.code === 'normal'
          socketClosed()
        }
        return
      case 'error':
        return
      default:
        return
    }
  }

  function socketClosed(): void {
    const dead = socket
    socket = null
    clearTimers()
    void dead
    if (disposed || terminalEnded || !started || suspended) {
      setState('closed')
      return
    }
    scheduleReconnect()
  }

  function scheduleReconnect(): void {
    if (reconnectTimer !== null) return
    setState('reconnecting')
    // 250 ms exponential with jitter, capped at 30 s (spec defaults).
    const exponential = Math.min(
      limits.reconnectBaseMs * 2 ** Math.min(reconnectAttempt, 16),
      limits.reconnectMaxMs
    )
    const jittered = exponential / 2 + Math.random() * (exponential / 2)
    reconnectAttempt += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      open()
    }, jittered)
  }

  function open(): void {
    if (disposed || suspended || terminalEnded || socket !== null) return
    setState('connecting')
    socket = options.connect({
      onFrame: (frame) => {
        if (socket && frame.type === 'heartbeat') lastHeartbeatAt = now()
        handleFrame(frame)
      },
      onClose: () => {
        if (socket === null) return
        socketClosed()
      },
    })
    reconnectAttempt = 0
    lastHeartbeatAt = now()
    setState('open')
    heartbeatTimer = setInterval(() => {
      if (socket === null) return
      if (now() - lastHeartbeatAt > limits.heartbeatUnhealthyAfterMs) {
        socket.close(4000, 'heartbeat timeout')
        socketClosed()
        return
      }
      socket.send({
        type: 'heartbeat',
        observedAt: new Date().toISOString(),
        throughSequence: (nextOutputSeq - 1n).toString(),
      })
    }, limits.heartbeatIntervalMs)
    // Replays arrive server-side from the grant's fromSequence; the local
    // cursor is authoritative after reconnect, so re-attach always requests
    // from the next expected sequence.
    flushInputs()
    if (lastSentResize)
      socket.send({
        type: 'resize',
        sequence: '0',
        generation: 0,
        cols: lastSentResize.cols,
        rows: lastSentResize.rows,
      })
  }

  function flushInputs(): void {
    const active = socket
    if (active === null || !active.open) return
    while (pendingInputs.length > 0 && active.bufferedAmount <= limits.socketHighWaterBytes) {
      const pending = pendingInputs[0]!
      active.send({ type: 'input', sequence: '0', generation: 0, bytes: pending.payload })
      pendingInputs.shift()
      pendingInputBytes -= pending.bytes
    }
  }

  return {
    /** The grant carries fromSequence; the transport's cursor continues it. */
    start(fromSequence: string): void {
      if (disposed || started) return
      started = true
      nextOutputSeq = BigInt(fromSequence)
      if (suspended) return
      open()
    },

    write(bytes: Uint8Array): boolean {
      if (disposed || terminalEnded) return false
      // The session cap applies before any direct send: oversized input is
      // backpressure regardless of socket state (spec: 1 MiB per session).
      if (bytes.byteLength > limits.inputQueueMaxBytes) {
        options.onInputOverflow?.(limits.inputQueueMaxBytes)
        return false
      }
      if (
        socket !== null &&
        socket.open &&
        socket.bufferedAmount <= limits.socketHighWaterBytes &&
        pendingInputs.length === 0
      ) {
        socket.send({ type: 'input', sequence: '0', generation: 0, bytes })
        return true
      }
      if (pendingInputBytes + bytes.byteLength > limits.inputQueueMaxBytes) {
        options.onInputOverflow?.(limits.inputQueueMaxBytes)
        return false
      }
      pendingInputs.push({ bytes: bytes.byteLength, payload: bytes })
      pendingInputBytes += bytes.byteLength
      scheduleDrain()
      return true
    },

    resize(cols: number, rows: number): void {
      if (lastSentResize?.cols === cols && lastSentResize.rows === rows) return
      lastSentResize = { cols, rows }
      // Resizes ride the control path (dev.terminal.resize) in production;
      // the transport replays the last resize after reconnect.
    },

    /** App hidden / window blurred: stop timers, keep durable state. */
    suspend(): void {
      if (suspended || disposed) return
      suspended = true
      clearTimers()
      const active = socket
      socket = null
      active?.close(1000, 'suspended')
      setState('closed')
    },

    resume(): void {
      if (!suspended || disposed || !started) return
      suspended = false
      if (terminalEnded) return
      reconnectAttempt = 0
      open()
    },

    /** Re-attach from a checkpoint anchor after a gap or overflow. */
    resyncFrom(checkpointSequence: string): void {
      nextOutputSeq = BigInt(checkpointSequence)
      reconnectAttempt = 0
      const active = socket
      socket = null
      clearTimers()
      active?.close(1000, 'resync')
      if (!suspended && started) open()
    },

    snapshot(): {
      state: TerminalConnectionState
      nextOutputSeq: string
      pendingInputBytes: number
      unackedBytes: number
      reconnectAttempt: number
    } {
      return {
        state,
        nextOutputSeq: nextOutputSeq.toString(),
        pendingInputBytes,
        unackedBytes,
        reconnectAttempt,
      }
    },

    dispose(): void {
      if (disposed) return
      disposed = true
      clearTimers()
      const active = socket
      socket = null
      active?.close(1000, 'disposed')
      setState('closed')
    },
  }
}

export type TerminalTransport = ReturnType<typeof createTerminalTransport>
