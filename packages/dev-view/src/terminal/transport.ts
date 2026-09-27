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
import { devErrorCodes, type DevError, type DevStreamFrame } from '@adea-ai/types/dev-runtime'

export type TerminalConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'

/** Minimal socket surface over the app's authenticated channel stream. */
export interface TerminalStreamSocket {
  readonly bufferedAmount: number
  send(frame: DevStreamFrame): void
  close(code: number, reason: string): void
  readonly open: boolean
}

export type TerminalAttachContext = Readonly<{
  /** The next output sequence accepted by this renderer. */
  fromSequence: string
  /** Last generation authenticated by an opened frame; absent on first attach. */
  generation?: number
}>

export type TerminalStreamHandlers = Readonly<{
  onFrame: (frame: DevStreamFrame) => void
  onClose: () => void
}>

export type TerminalTransportOptions = {
  /**
   * Opens one fresh authenticated stream (new grant per attempt). On first
   * attach the caller binds its grant to the captured TerminalRecord; the
   * optional context generation is reconnect evidence, not authority.
   */
  connect: (
    handlers: TerminalStreamHandlers,
    context: TerminalAttachContext
  ) => TerminalStreamSocket
  /** Delivers replayed and live output to the renderer, in order. */
  onOutput: (sequence: string, bytes: Uint8Array) => void
  onConnectionState?: (state: TerminalConnectionState) => void
  onConnectionError?: (error: Pick<DevError, 'code' | 'retryable' | 'message'>) => void
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
type ActiveConnection = {
  context: TerminalAttachContext
  socket: TerminalStreamSocket | null
  generation?: number
  opened: boolean
  closed: boolean
  pendingAcks: Extract<DevStreamFrame, { type: 'ack' }>[]
  resizePending: boolean
  inputFlushInProgress: boolean
}

const terminalProtocol = 'terminal-bytes-v1'
const canonicalSequence = /^(0|[1-9][0-9]*)$/

function normalizeConnectError(reason: unknown): DevError {
  if (typeof reason === 'object' && reason !== null) {
    const candidate = reason as Record<string, unknown>
    if (
      typeof candidate.code === 'string' &&
      devErrorCodes.includes(candidate.code as (typeof devErrorCodes)[number]) &&
      typeof candidate.retryable === 'boolean' &&
      typeof candidate.message === 'string'
    ) {
      return {
        code: candidate.code as DevError['code'],
        retryable: candidate.retryable,
        message: candidate.message,
      }
    }
  }
  return {
    code: 'runtime_node_unavailable',
    retryable: false,
    message: 'terminal stream connection could not be opened',
  }
}

export function createTerminalTransport(options: TerminalTransportOptions) {
  const limits = { ...DEFAULT_TRANSPORT_LIMITS, ...options.limits }
  const now = options.now ?? Date.now
  let activeConnection: ActiveConnection | null = null
  let state: TerminalConnectionState = 'idle'
  let started = false
  let disposed = false
  let suspended = false
  let terminalEnded = false
  let nextOutputSeq = 0n
  let lastVerifiedGeneration: number | undefined
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

  function isCurrent(connection: ActiveConnection): boolean {
    return activeConnection === connection && !connection.closed
  }

  function discardPendingInputs(): void {
    pendingInputs.length = 0
    pendingInputBytes = 0
  }

  // Fallback poll for the one case no inbound frame reports: the LOCAL socket's
  // outbound buffer draining. Credit returned by a `data` frame is signalled
  // directly (see `handleFrame`), so this only covers pure buffer drain.
  //
  // It used to fire at a flat 100Hz for as long as any input was queued, which
  // is ~50 wake-ups per keystroke burst against a full window while nothing was
  // happening. It now backs off when a tick makes no progress and resets the
  // moment anything drains, so sustained backpressure costs ~10Hz instead. The
  // ceiling bounds the extra latency in the fully-stalled case; a frame arrival
  // or a real drain always wakes it immediately, so the common path is unchanged.
  const DRAIN_POLL_MS = 10
  const DRAIN_POLL_MAX_MS = 100
  let drainBackoffMs = DRAIN_POLL_MS

  function scheduleDrain(): void {
    if (drainTimer !== null || pendingInputs.length === 0) return
    drainTimer = setTimeout(() => {
      drainTimer = null
      const before = pendingInputs.length
      flushInputs()
      drainBackoffMs =
        pendingInputs.length < before
          ? DRAIN_POLL_MS
          : Math.min(drainBackoffMs * 2, DRAIN_POLL_MAX_MS)
      scheduleDrain()
    }, drainBackoffMs)
  }

  function reportAndStop(
    connection: ActiveConnection,
    code: Extract<DevError['code'], 'sequence_gap' | 'stale_generation' | 'unsupported_version'>,
    message: string
  ): void {
    if (!isCurrent(connection)) return
    const error = { code, retryable: false as const, message }
    terminalEnded = true
    discardPendingInputs()
    retireConnection(connection, { retry: false, closeSocket: true, reason: message })
    options.onConnectionError?.(error)
  }

  function stopForError(connection: ActiveConnection, error: DevError): void {
    if (!isCurrent(connection)) return
    // Permission and generation failures cannot become safe by repeating the
    // same grant. Honor retryable only for other typed, temporary failures.
    const retry =
      error.retryable && error.code !== 'permission_denied' && error.code !== 'stale_generation'
    if (!retry) {
      terminalEnded = true
      discardPendingInputs()
    }
    retireConnection(connection, { retry, closeSocket: true, reason: error.code })
    options.onConnectionError?.(error)
  }

  function retireConnection(
    connection: ActiveConnection,
    optionsForClose: { retry: boolean; closeSocket: boolean; reason: string }
  ): void {
    if (!isCurrent(connection)) return
    connection.closed = true
    activeConnection = null
    clearTimers()
    drainBackoffMs = DRAIN_POLL_MS
    if (optionsForClose.closeSocket && connection.socket !== null) {
      try {
        connection.socket.close(optionsForClose.retry ? 4001 : 1000, optionsForClose.reason)
      } catch {
        // The connection has already been retired; a failed local close cannot
        // make stale callbacks current again.
      }
    }
    if (disposed || terminalEnded || !started || suspended || !optionsForClose.retry) {
      setState('closed')
      return
    }
    scheduleReconnect()
  }

  function scheduleReconnect(): void {
    if (reconnectTimer !== null || disposed || terminalEnded || suspended || !started) return
    setState('reconnecting')
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

  function sendAck(connection: ActiveConnection, frame: Extract<DevStreamFrame, { type: 'ack' }>) {
    if (!isCurrent(connection)) return
    const active = connection.socket
    if (active === null) {
      connection.pendingAcks.push(frame)
      return
    }
    if (!active.open) return
    try {
      active.send(frame)
    } catch {
      retireConnection(connection, { retry: true, closeSocket: true, reason: 'ack send failed' })
    }
  }

  function flushAcks(connection: ActiveConnection): void {
    const active = connection.socket
    if (!isCurrent(connection) || active === null || !active.open) return
    while (connection.pendingAcks.length > 0 && isCurrent(connection)) {
      const frame = connection.pendingAcks[0]!
      try {
        active.send(frame)
        connection.pendingAcks.shift()
      } catch {
        retireConnection(connection, { retry: true, closeSocket: true, reason: 'ack send failed' })
        return
      }
    }
  }

  function flushResize(connection: ActiveConnection): void {
    const active = connection.socket
    if (
      !connection.resizePending ||
      !connection.opened ||
      connection.generation === undefined ||
      active == null ||
      !active.open ||
      !isCurrent(connection)
    )
      return
    if (lastSentResize === null) {
      connection.resizePending = false
      return
    }
    try {
      active.send({
        type: 'resize',
        sequence: '0',
        generation: connection.generation,
        cols: lastSentResize.cols,
        rows: lastSentResize.rows,
      })
      connection.resizePending = false
    } catch {
      retireConnection(connection, {
        retry: true,
        closeSocket: true,
        reason: 'resize send failed',
      })
    }
  }

  function flushInputs(): void {
    const connection = activeConnection
    const active = connection?.socket
    if (
      !connection ||
      !connection.opened ||
      connection.generation === undefined ||
      active == null ||
      !active.open ||
      connection.inputFlushInProgress
    )
      return
    connection.inputFlushInProgress = true
    try {
      while (
        isCurrent(connection) &&
        pendingInputs.length > 0 &&
        active.bufferedAmount <= limits.socketHighWaterBytes
      ) {
        const pending = pendingInputs.shift()
        if (!pending) return
        // Once handed to send(), delivery may be ambiguous even if it throws
        // or synchronously reports an error. Remove this chunk before the call
        // so a re-entrant stop cannot clear the queue and then underflow its
        // byte accounting on return.
        pendingInputBytes -= pending.bytes
        try {
          active.send({
            type: 'input',
            sequence: '0',
            generation: connection.generation,
            bytes: pending.payload,
          })
        } catch {
          stopForError(connection, {
            code: 'delivery_ambiguous',
            retryable: false,
            message: 'terminal input delivery is ambiguous; queued input was discarded',
          })
          return
        }
      }
    } finally {
      connection.inputFlushInProgress = false
    }
  }

  function startHeartbeat(connection: ActiveConnection): void {
    if (heartbeatTimer !== null) clearInterval(heartbeatTimer)
    heartbeatTimer = setInterval(() => {
      if (!isCurrent(connection) || !connection.opened) return
      const active = connection.socket
      if (active === null || !active.open) return
      if (now() - lastHeartbeatAt > limits.heartbeatUnhealthyAfterMs) {
        retireConnection(connection, {
          retry: true,
          closeSocket: true,
          reason: 'heartbeat timeout',
        })
        return
      }
      try {
        active.send({
          type: 'heartbeat',
          observedAt: new Date().toISOString(),
          throughSequence: (nextOutputSeq - 1n).toString(),
        })
      } catch {
        retireConnection(connection, {
          retry: true,
          closeSocket: true,
          reason: 'heartbeat send failed',
        })
      }
    }, limits.heartbeatIntervalMs)
  }

  function acceptOpened(
    connection: ActiveConnection,
    frame: Extract<DevStreamFrame, { type: 'opened' }>
  ): void {
    if (connection.opened) {
      reportAndStop(connection, 'unsupported_version', 'stream sent more than one opened frame')
      return
    }
    if (frame.protocol !== terminalProtocol) {
      reportAndStop(
        connection,
        'unsupported_version',
        'stream protocol does not match terminal-bytes-v1'
      )
      return
    }
    if (!Number.isSafeInteger(frame.generation) || frame.generation < 0) {
      reportAndStop(connection, 'stale_generation', 'opened frame has an invalid generation')
      return
    }
    if (!canonicalSequence.test(frame.nextSequence)) {
      reportAndStop(connection, 'sequence_gap', 'opened frame has an invalid output cursor')
      return
    }
    const openedSequence = BigInt(frame.nextSequence)
    const generationChanged =
      connection.context.generation !== undefined &&
      frame.generation !== connection.context.generation
    if (!generationChanged && openedSequence !== nextOutputSeq) {
      reportAndStop(
        connection,
        'sequence_gap',
        'opened cursor does not match the requested output cursor'
      )
      return
    }
    let discardedOldGenerationInput = false
    if (generationChanged) {
      if (pendingInputs.length > 0) {
        discardPendingInputs()
        discardedOldGenerationInput = true
      }
      // The new grant is generation-bound by the caller to its current
      // TerminalRecord. Output sequences restart with a fresh terminal
      // generation, so the host's authenticated cursor replaces the old one.
      nextOutputSeq = openedSequence
      unackedBytes = 0
    }
    connection.opened = true
    connection.generation = frame.generation
    lastVerifiedGeneration = frame.generation
    reconnectAttempt = 0
    lastHeartbeatAt = now()
    connection.resizePending = lastSentResize !== null
    setState('open')
    if (!isCurrent(connection)) return
    startHeartbeat(connection)
    flushAcks(connection)
    flushResize(connection)
    flushInputs()
    scheduleDrain()
    if (discardedOldGenerationInput) {
      options.onConnectionError?.({
        code: 'stale_generation',
        retryable: false,
        message: 'queued terminal input was discarded after the terminal generation changed',
      })
    }
  }

  function handleFrame(connection: ActiveConnection, frame: DevStreamFrame): void {
    if (!isCurrent(connection)) return
    if (frame.type === 'opened') {
      acceptOpened(connection, frame)
      return
    }
    if (frame.type === 'error') {
      stopForError(connection, frame.error)
      return
    }
    if (frame.type === 'close') {
      const retry = frame.code === 'backpressure' || frame.code === 'expired'
      if (!retry) terminalEnded = true
      retireConnection(connection, {
        retry,
        closeSocket: false,
        reason: frame.reason ?? frame.code,
      })
      return
    }
    if (!connection.opened) {
      reportAndStop(connection, 'unsupported_version', 'stream sent data before its opened frame')
      return
    }
    switch (frame.type) {
      case 'data': {
        const seq = BigInt(frame.sequence)
        if (seq < nextOutputSeq) return
        if (seq > nextOutputSeq) {
          options.onSequenceGap?.(nextOutputSeq.toString(), frame.sequence)
          return
        }
        nextOutputSeq = seq + 1n
        unackedBytes += frame.bytes.byteLength
        options.onOutput(frame.sequence, frame.bytes)
        if (!isCurrent(connection)) return
        sendAck(connection, {
          type: 'ack',
          throughSequence: frame.sequence,
          availableCreditBytes: frame.bytes.byteLength,
        })
        if (pendingInputs.length > 0) {
          drainBackoffMs = DRAIN_POLL_MS
          if (drainTimer !== null) {
            clearTimeout(drainTimer)
            drainTimer = null
          }
          flushInputs()
          scheduleDrain()
        }
        return
      }
      case 'resync':
        options.onResyncRequired?.(frame.checkpointSequence)
        return
      case 'heartbeat':
        lastHeartbeatAt = now()
        return
      default:
        return
    }
  }

  function open(): void {
    if (disposed || suspended || terminalEnded || activeConnection !== null) return
    setState('connecting')
    const context: TerminalAttachContext = {
      fromSequence: nextOutputSeq.toString(),
      ...(lastVerifiedGeneration === undefined ? {} : { generation: lastVerifiedGeneration }),
    }
    const connection: ActiveConnection = {
      context,
      socket: null,
      opened: false,
      closed: false,
      pendingAcks: [],
      resizePending: false,
      inputFlushInProgress: false,
    }
    activeConnection = connection
    let socket: TerminalStreamSocket
    try {
      socket = options.connect(
        {
          onFrame: (frame) => handleFrame(connection, frame),
          onClose: () => {
            if (isCurrent(connection)) {
              retireConnection(connection, {
                retry: true,
                closeSocket: false,
                reason: 'socket closed',
              })
            }
          },
        },
        context
      )
    } catch (error) {
      stopForError(connection, normalizeConnectError(error))
      return
    }
    if (!isCurrent(connection)) {
      try {
        socket.close(1000, 'connection retired during attach')
      } catch {
        // It was never installed as the active socket.
      }
      return
    }
    connection.socket = socket
    if (connection.opened) {
      flushAcks(connection)
      flushResize(connection)
      flushInputs()
      scheduleDrain()
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
      if (bytes.byteLength > limits.inputQueueMaxBytes) {
        options.onInputOverflow?.(limits.inputQueueMaxBytes)
        return false
      }
      // The caller may reuse its buffer as soon as write() returns, including
      // while this transport is holding the bytes behind socket backpressure.
      const payload = bytes.slice()
      const connection = activeConnection
      const socket = connection?.socket
      if (
        connection?.opened &&
        connection.generation !== undefined &&
        socket?.open &&
        socket.bufferedAmount <= limits.socketHighWaterBytes &&
        pendingInputs.length === 0
      ) {
        try {
          socket.send({
            type: 'input',
            sequence: '0',
            generation: connection.generation,
            bytes: payload,
          })
          return true
        } catch {
          // A synchronous send error cannot prove whether the remote PTY saw
          // these bytes. Do not replay a command that may already have run.
          stopForError(connection, {
            code: 'delivery_ambiguous',
            retryable: false,
            message: 'terminal input delivery is ambiguous; input was not retried',
          })
          return false
        }
      }
      if (pendingInputBytes + payload.byteLength > limits.inputQueueMaxBytes) {
        options.onInputOverflow?.(limits.inputQueueMaxBytes)
        return false
      }
      pendingInputs.push({ bytes: payload.byteLength, payload })
      pendingInputBytes += payload.byteLength
      scheduleDrain()
      return true
    },

    resize(cols: number, rows: number): void {
      if (lastSentResize?.cols === cols && lastSentResize.rows === rows) return
      lastSentResize = { cols, rows }
      // Resizes ride the control path in production; transport replays the
      // last dimensions only after a reconnect's generation is authenticated.
    },

    suspend(): void {
      if (suspended || disposed) return
      suspended = true
      clearTimers()
      const active = activeConnection
      if (active !== null && isCurrent(active)) {
        active.closed = true
        activeConnection = null
        try {
          active.socket?.close(1000, 'suspended')
        } catch {
          // Suspension remains effective even when the socket close fails.
        }
      }
      setState('closed')
    },

    resume(): void {
      if (!suspended || disposed || !started) return
      suspended = false
      if (terminalEnded) return
      reconnectAttempt = 0
      open()
    },

    resyncFrom(checkpointSequence: string): void {
      nextOutputSeq = BigInt(checkpointSequence)
      reconnectAttempt = 0
      clearTimers()
      const active = activeConnection
      if (active !== null && isCurrent(active)) {
        active.closed = true
        activeConnection = null
        try {
          active.socket?.close(1000, 'resync')
        } catch {
          // The new attach still starts from the checkpoint anchor.
        }
      }
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
      const active = activeConnection
      if (active !== null && isCurrent(active)) {
        active.closed = true
        activeConnection = null
        try {
          active.socket?.close(1000, 'disposed')
        } catch {
          // Disposal is final even when the local socket cannot close cleanly.
        }
      }
      setState('closed')
    },
  }
}

export type TerminalTransport = ReturnType<typeof createTerminalTransport>
