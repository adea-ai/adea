import {
  decodeDevStreamFrame,
  decodeDevStreamGrant,
  decodeTerminalRecord,
  devErrorCodes,
  type DevError,
  type DevErrorCode,
  type DevCommand,
  type DevOperation,
  type DevStreamFrame,
  type DevStreamGrant,
  type Scope,
  type TerminalRecord,
} from '@adea-ai/types/dev-runtime'
import { buildDevCommand } from '../browser/command'
import type { DevRuntimeService, DevStreamTransport, DevStreamTransportSocket } from '../platform'
import type {
  TerminalAttachContext,
  TerminalStreamHandlers,
  TerminalStreamSocket,
} from './transport'

const terminalProtocol = 'terminal-bytes-v1'
const uint64Pattern = /^(0|[1-9][0-9]*)$/
const maxUint64 = (1n << 64n) - 1n
const maxPendingReadBytes = 1024 * 1024
const maxPendingReadFrames = 256
const terminalListPageSize = 500
const maxTerminalListPages = 64

type TerminalOperation = Extract<
  DevOperation,
  'dev.terminal.attach' | 'dev.terminal.input' | 'dev.terminal.list' | 'dev.terminal.resize'
>

type MeasuredStreamSocket = DevStreamTransportSocket & {
  readonly bufferedAmount?: number
}

type StreamSlot = {
  grant: DevStreamGrant
  socket: MeasuredStreamSocket | null
  opened: Extract<DevStreamFrame, { type: 'opened' }> | null
  closed: boolean
}

type Attempt = {
  record: TerminalRecord
  handlers: TerminalStreamHandlers
  closed: boolean
  ready: boolean
  read: StreamSlot | null
  write: StreamSlot | null
  pendingReadFrames: DevStreamFrame[]
  pendingReadBytes: number
}

type InputCursor = { generation: number; nextSequence: bigint }
type ResizeRequest = { generation: number; cols: number; rows: number }

export type TerminalRuntimeConnectionOptions = Readonly<{
  runtime: DevRuntimeService
  /** The exact selected terminal record; this is the first attach authority. */
  terminal: TerminalRecord
  commandContext?: Parameters<typeof buildDevCommand>[1]
}>

export type TerminalRuntimeConnection = Readonly<{
  /** Terminal reads accept host heartbeats and send ACKs only. */
  heartbeatMode: 'server_only'
  connect: (
    handlers: TerminalStreamHandlers,
    context: TerminalAttachContext
  ) => TerminalStreamSocket
}>

class ConnectionFailure extends Error {
  constructor(readonly error: Pick<DevError, 'code' | 'retryable' | 'message'>) {
    super(error.message)
  }
}

function failure(
  code: DevErrorCode,
  retryable: boolean,
  message: string
): Pick<DevError, 'code' | 'retryable' | 'message'> {
  return { code, retryable, message }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeFailure(reason: unknown): Pick<DevError, 'code' | 'retryable' | 'message'> {
  if (reason instanceof ConnectionFailure) return reason.error
  if (
    isRecord(reason) &&
    typeof reason.code === 'string' &&
    devErrorCodes.includes(reason.code as DevErrorCode)
  ) {
    const code = reason.code as DevErrorCode
    const nonretryable =
      code === 'permission_denied' ||
      code === 'capability_denied' ||
      code === 'stale_generation' ||
      code === 'identity_mismatch' ||
      code === 'sequence_gap' ||
      code === 'unsupported_version' ||
      code === 'incompatible'
    const retryable = !nonretryable && typeof reason.retryable === 'boolean' && reason.retryable
    return failure(code, retryable, safeMessage(code))
  }
  return failure(
    'runtime_node_unavailable',
    true,
    'The terminal runtime could not complete the authenticated connection.'
  )
}

function safeMessage(code: DevErrorCode): string {
  switch (code) {
    case 'permission_denied':
    case 'capability_denied':
    case 'capability_unavailable':
      return 'The terminal connection is not available for this runtime.'
    case 'stale_generation':
      return 'The selected terminal changed generation.'
    case 'sequence_gap':
      return 'The terminal stream cursor did not match its grant.'
    case 'identity_mismatch':
      return 'The terminal grant did not match the selected terminal.'
    case 'unsupported_version':
    case 'incompatible':
      return 'The terminal stream did not match the supported protocol.'
    case 'backpressure':
      return 'The terminal stream exceeded its bounded delivery window.'
    default:
      return 'The terminal runtime could not complete the authenticated connection.'
  }
}

function replyValue(value: unknown, operation: TerminalOperation, requestId: string): unknown {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.operation !== operation ||
    value.requestId !== requestId
  ) {
    fail('unsupported_version', 'The runtime returned an invalid terminal command reply.')
  }
  if (value.ok === false) {
    const error = value.error
    if (
      !isRecord(error) ||
      typeof error.code !== 'string' ||
      !devErrorCodes.includes(error.code as DevErrorCode) ||
      typeof error.retryable !== 'boolean' ||
      typeof error.message !== 'string'
    ) {
      fail('unsupported_version', 'The runtime returned an invalid terminal command error.')
    }
    throw new ConnectionFailure(normalizeFailure(error))
  }
  if (
    value.ok !== true ||
    !Object.hasOwn(value, 'value') ||
    typeof value.observedAt !== 'string' ||
    Number.isNaN(Date.parse(value.observedAt))
  ) {
    fail('unsupported_version', 'The runtime returned an invalid terminal command reply.')
  }
  return value.value
}

function fail(code: DevErrorCode, message = safeMessage(code), retryable = false): never {
  throw new ConnectionFailure(failure(code, retryable, message))
}

function immutableTerminal(value: unknown): TerminalRecord {
  const terminal = decodeTerminalRecord(value)
  return Object.freeze({ ...terminal, scope: Object.freeze({ ...terminal.scope }) })
}

function sameScope(left: Scope, right: Scope): boolean {
  return (
    left.accountId === right.accountId &&
    left.workspaceId === right.workspaceId &&
    left.runtimeNodeId === right.runtimeNodeId
  )
}

function sameTerminalIdentity(left: TerminalRecord, right: TerminalRecord): boolean {
  return (
    left.id === right.id &&
    left.runtimeSessionId === right.runtimeSessionId &&
    sameScope(left.scope, right.scope)
  )
}

function readBufferedAmount(socket: MeasuredStreamSocket): number {
  let amount: unknown
  try {
    amount = socket.bufferedAmount
  } catch {
    fail('capability_unavailable', 'The terminal relay does not expose measured buffering.')
  }
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
    fail('capability_unavailable', 'The terminal relay does not expose measured buffering.')
  }
  return amount
}

function validateCursor(value: string): bigint {
  if (!uint64Pattern.test(value)) fail('sequence_gap')
  const cursor = BigInt(value)
  if (cursor > maxUint64) fail('sequence_gap')
  return cursor
}

function validateGrant(
  value: unknown,
  selected: TerminalRecord,
  direction: DevStreamGrant['direction'],
  fromSequence: string
): DevStreamGrant {
  let grant: DevStreamGrant
  try {
    grant = decodeDevStreamGrant(value)
  } catch {
    fail('unsupported_version', 'The runtime returned a malformed terminal grant.')
  }
  if (grant.protocol !== terminalProtocol) fail('unsupported_version')
  if (grant.direction !== direction) fail('incompatible')
  if (
    grant.scope.accountId !== selected.scope.accountId ||
    grant.scope.workspaceId !== selected.scope.workspaceId ||
    grant.scope.runtimeNodeId !== selected.scope.runtimeNodeId ||
    grant.resource.kind !== 'terminal' ||
    grant.resource.id !== selected.id
  ) {
    fail('identity_mismatch')
  }
  if (grant.resource.generation !== selected.generation) fail('stale_generation')
  if (grant.fromSequence !== fromSequence) fail('sequence_gap')
  return grant
}

function openFrame(
  slot: StreamSlot,
  selected: TerminalRecord
): Extract<DevStreamFrame, { type: 'opened' }> {
  const frame = slot.opened
  if (!frame) fail('invalid_state', 'The terminal stream opened without an authenticated header.')
  if (frame.protocol !== slot.grant.protocol) fail('unsupported_version')
  if (frame.generation !== selected.generation) fail('stale_generation')
  if (frame.nextSequence !== slot.grant.fromSequence) fail('sequence_gap')
  return frame
}

function closeSlot(slot: StreamSlot | null, code: number, reason: string): void {
  if (!slot || slot.closed) return
  slot.closed = true
  const socket = slot.socket
  if (!socket) return
  try {
    socket.close(code, reason)
  } catch {
    // Retiring the local attempt fences callbacks even if close fails.
  }
}

/**
 * Adapts a captured terminal selection to the pure terminal socket model.
 * Every connection attempt mints separate read/write grants; no terminal is
 * inferred from the runtime's first item or from a later workspace listing.
 */
export function createTerminalRuntimeConnection(
  options: TerminalRuntimeConnectionOptions
): TerminalRuntimeConnection {
  const captured = immutableTerminal(options.terminal)
  const { runtime } = options
  let activeAttempt: Attempt | null = null
  let inputCursor: InputCursor | null = null
  let pendingResize: ResizeRequest | null = null
  let resizeInFlight = false

  async function execute(
    operation: TerminalOperation,
    selected: TerminalRecord,
    body: Record<string, unknown>,
    resource?: { kind: string; id: string; generation: number }
  ): Promise<unknown> {
    let command: DevCommand
    try {
      command = buildDevCommand(
        {
          operation,
          scope: selected.scope,
          body,
          ...(resource ? { resource } : {}),
        },
        options.commandContext
      )
    } catch {
      fail('incompatible', 'The terminal command could not be constructed.')
    }
    const raw = await runtime.execute(command)
    return replyValue(raw, operation, command.requestId)
  }

  async function currentTerminal(
    context: TerminalAttachContext,
    attempt: Attempt
  ): Promise<TerminalRecord | undefined> {
    if (context.generation === undefined) return captured

    let cursor: string | undefined
    const seenCursors = new Set<string>()
    let pageCount = 0
    const matches: TerminalRecord[] = []
    do {
      if (!isCurrent(attempt)) return undefined
      if (++pageCount > maxTerminalListPages) {
        fail('limit_exceeded', 'The terminal reconnect scan exceeded its page limit.')
      }
      const body: Record<string, unknown> = {
        runtimeSessionId: captured.runtimeSessionId,
        limit: terminalListPageSize,
        ...(cursor !== undefined ? { cursor } : {}),
      }
      const value = await execute('dev.terminal.list', captured, body)
      if (!isCurrent(attempt)) return undefined
      if (!isRecord(value) || !Array.isArray(value.items)) {
        fail('unsupported_version', 'The runtime returned an invalid terminal list page.')
      }
      if (value.items.length > terminalListPageSize) {
        fail('limit_exceeded', 'The runtime terminal page exceeded its requested size.')
      }
      for (const candidate of value.items) {
        let record: TerminalRecord
        try {
          record = immutableTerminal(candidate)
        } catch {
          fail('unsupported_version', 'The runtime returned an invalid terminal record.')
        }
        // This query is session-filtered. A row outside its exact scope or
        // session is a broken authority boundary, even if it is not the match.
        if (
          record.runtimeSessionId !== captured.runtimeSessionId ||
          !sameScope(record.scope, captured.scope)
        ) {
          fail('identity_mismatch')
        }
        if (record.id === captured.id) matches.push(record)
      }
      const next = value.nextCursor
      if (next !== undefined && (typeof next !== 'string' || next.length === 0)) {
        fail('unsupported_version', 'The runtime returned an invalid terminal list cursor.')
      }
      cursor = next as string | undefined
      if (cursor !== undefined) {
        if (seenCursors.has(cursor)) fail('invalid_state', 'The terminal list cursor repeated.')
        seenCursors.add(cursor)
      }
    } while (cursor !== undefined)

    if (matches.length !== 1) {
      fail(matches.length === 0 ? 'not_found' : 'identity_mismatch')
    }
    const current = matches[0]!
    if (!sameTerminalIdentity(current, captured)) fail('identity_mismatch')
    return current
  }

  function isCurrent(attempt: Attempt): boolean {
    return activeAttempt === attempt && !attempt.closed
  }

  function closeAttempt(
    attempt: Attempt,
    code = 1000,
    reason = 'terminal connection closed'
  ): void {
    if (attempt.closed) return
    attempt.closed = true
    attempt.ready = false
    attempt.pendingReadFrames.length = 0
    attempt.pendingReadBytes = 0
    if (activeAttempt === attempt) activeAttempt = null
    closeSlot(attempt.read, code, reason)
    closeSlot(attempt.write, code, reason)
  }

  function emitFailure(attempt: Attempt, reason: unknown): void {
    if (!isCurrent(attempt)) return
    const error = normalizeFailure(reason)
    closeAttempt(attempt, error.retryable ? 4001 : 1000, error.code)
    attempt.handlers.onFrame({ type: 'error', error })
  }

  function pushReadFrame(attempt: Attempt, frame: DevStreamFrame): void {
    if (!isCurrent(attempt)) return
    if (frame.type === 'error') {
      const error = normalizeFailure(frame.error)
      attempt.handlers.onFrame({ type: 'error', error })
      closeAttempt(attempt, error.retryable ? 4001 : 1000, error.code)
      return
    }
    if (frame.type === 'close') {
      attempt.handlers.onFrame(frame)
      closeAttempt(attempt, 1000, frame.code)
      return
    }
    attempt.handlers.onFrame(frame)
  }

  function tryReady(attempt: Attempt): void {
    if (
      !isCurrent(attempt) ||
      attempt.ready ||
      !attempt.read?.socket ||
      !attempt.write?.socket ||
      !attempt.read.opened ||
      !attempt.write.opened
    )
      return
    const readOpened = openFrame(attempt.read, attempt.record)
    openFrame(attempt.write, attempt.record)
    if (!attempt.read.socket.open || !attempt.write.socket.open) {
      fail('runtime_node_unavailable', 'A terminal stream closed while opening.', true)
    }
    // Refuse a provider without measured backpressure rather than presenting
    // a fabricated zero to the pane's bounded input queue.
    readBufferedAmount(attempt.read.socket)
    readBufferedAmount(attempt.write.socket)
    attempt.ready = true
    const nextInputSequence = BigInt(attempt.write.grant.fromSequence)
    inputCursor = { generation: attempt.record.generation, nextSequence: nextInputSequence }
    attempt.handlers.onFrame(readOpened)
    if (!isCurrent(attempt)) return
    const queued = attempt.pendingReadFrames.splice(0)
    attempt.pendingReadBytes = 0
    for (const frame of queued) {
      pushReadFrame(attempt, frame)
      if (!isCurrent(attempt)) return
    }
    flushResize(attempt)
  }

  function queueReadFrame(attempt: Attempt, frame: DevStreamFrame): void {
    if (!isCurrent(attempt)) return
    const bytes = frame.type === 'data' ? frame.bytes.byteLength : 0
    if (
      attempt.pendingReadFrames.length >= maxPendingReadFrames ||
      attempt.pendingReadBytes + bytes > maxPendingReadBytes
    ) {
      emitFailure(attempt, failure('backpressure', true, safeMessage('backpressure')))
      return
    }
    attempt.pendingReadFrames.push(frame)
    attempt.pendingReadBytes += bytes
  }

  function receiveFrame(
    attempt: Attempt,
    direction: DevStreamGrant['direction'],
    raw: unknown
  ): void {
    if (!isCurrent(attempt)) return
    let frame: DevStreamFrame
    try {
      frame = decodeDevStreamFrame(raw)
    } catch {
      emitFailure(
        attempt,
        failure('unsupported_version', false, safeMessage('unsupported_version'))
      )
      return
    }
    const slot = direction === 'read' ? attempt.read : attempt.write
    if (!slot || slot.closed) return
    if (frame.type === 'opened') {
      if (slot.opened) {
        emitFailure(
          attempt,
          failure('unsupported_version', false, safeMessage('unsupported_version'))
        )
        return
      }
      slot.opened = frame
      try {
        openFrame(slot, attempt.record)
      } catch (error) {
        emitFailure(attempt, error)
        return
      }
      try {
        tryReady(attempt)
      } catch (error) {
        emitFailure(attempt, error)
      }
      return
    }
    if (!slot.opened) {
      emitFailure(
        attempt,
        failure('unsupported_version', false, safeMessage('unsupported_version'))
      )
      return
    }
    if (direction === 'write') {
      if (frame.type === 'error' || frame.type === 'close') {
        pushReadFrame(attempt, frame)
        return
      }
      emitFailure(attempt, failure('incompatible', false, safeMessage('incompatible')))
      return
    }
    if (
      frame.type !== 'data' &&
      frame.type !== 'heartbeat' &&
      frame.type !== 'resync' &&
      frame.type !== 'error' &&
      frame.type !== 'close'
    ) {
      emitFailure(attempt, failure('incompatible', false, safeMessage('incompatible')))
      return
    }
    if (frame.type === 'error' || frame.type === 'close') {
      pushReadFrame(attempt, frame)
      return
    }
    if (frame.type === 'data') {
      if (frame.bytes.byteLength > slot.grant.maxFrameBytes) {
        emitFailure(attempt, failure('backpressure', false, safeMessage('backpressure')))
        return
      }
      frame = { ...frame, bytes: frame.bytes.slice() }
    }
    if (!attempt.ready || !attempt.read?.socket) {
      queueReadFrame(attempt, frame)
      return
    }
    pushReadFrame(attempt, frame)
  }

  function attachSlot(attempt: Attempt, streams: DevStreamTransport, grant: DevStreamGrant): void {
    const slot: StreamSlot = { grant, socket: null, opened: null, closed: false }
    if (grant.direction === 'read') attempt.read = slot
    else attempt.write = slot
    let socket: MeasuredStreamSocket
    try {
      socket = streams.connect(grant, {
        onFrame: (frame) => receiveFrame(attempt, grant.direction, frame),
        onClose: () => {
          if (isCurrent(attempt)) {
            emitFailure(
              attempt,
              failure(
                'runtime_node_unavailable',
                true,
                'The terminal stream disconnected before it could be reopened.'
              )
            )
          }
        },
      }) as MeasuredStreamSocket
    } catch (error) {
      emitFailure(attempt, error)
      return
    }
    if (!isCurrent(attempt) || slot.closed) {
      try {
        socket.close(1000, 'terminal attach was retired')
      } catch {
        // Late stream sockets are never installed into a current attempt.
      }
      return
    }
    slot.socket = socket
    try {
      readBufferedAmount(socket)
    } catch (error) {
      emitFailure(attempt, error)
      return
    }
    try {
      tryReady(attempt)
    } catch (error) {
      emitFailure(attempt, error)
    }
  }

  async function runResize(attempt: Attempt): Promise<void> {
    if (resizeInFlight || !pendingResize || !isCurrent(attempt) || !attempt.ready) return
    const request = pendingResize
    pendingResize = null
    resizeInFlight = true
    try {
      const value = await execute(
        'dev.terminal.resize',
        attempt.record,
        {
          terminalId: attempt.record.id,
          expectedGeneration: request.generation,
          cols: request.cols,
          rows: request.rows,
        },
        { kind: 'terminal', id: attempt.record.id, generation: request.generation }
      )
      const resized = immutableTerminal(value)
      if (!sameTerminalIdentity(resized, captured)) fail('identity_mismatch')
      if (resized.generation !== request.generation) fail('stale_generation')
    } catch (error) {
      if (isCurrent(attempt)) emitFailure(attempt, error)
    } finally {
      resizeInFlight = false
      const current = activeAttempt
      if (current && pendingResize) void runResize(current)
    }
  }

  function flushResize(attempt: Attempt): void {
    if (resizeInFlight || !pendingResize || !isCurrent(attempt) || !attempt.ready) return
    void runResize(attempt)
  }

  function makeSocket(attempt: Attempt): TerminalStreamSocket {
    return {
      get open() {
        return (
          isCurrent(attempt) &&
          attempt.ready &&
          Boolean(attempt.read?.socket?.open) &&
          Boolean(attempt.write?.socket?.open)
        )
      },
      get bufferedAmount() {
        if (
          !isCurrent(attempt) ||
          !attempt.ready ||
          !attempt.read?.socket ||
          !attempt.write?.socket
        ) {
          return Number.POSITIVE_INFINITY
        }
        try {
          return readBufferedAmount(attempt.read.socket) + readBufferedAmount(attempt.write.socket)
        } catch (error) {
          emitFailure(attempt, error)
          return Number.POSITIVE_INFINITY
        }
      },
      send(frame: DevStreamFrame) {
        if (
          !isCurrent(attempt) ||
          !attempt.ready ||
          !attempt.read?.socket ||
          !attempt.write?.socket
        ) {
          throw new Error('terminal stream is not ready')
        }
        let decoded: DevStreamFrame
        try {
          decoded = decodeDevStreamFrame(frame)
        } catch {
          fail('unsupported_version')
        }
        if (decoded.type === 'ack') {
          attempt.read.socket.send(decoded)
          return
        }
        if (decoded.type === 'input') {
          if (decoded.generation !== attempt.record.generation) fail('stale_generation')
          if (decoded.sequence !== '0') fail('sequence_gap')
          const cursor = inputCursor
          if (!cursor || cursor.generation !== attempt.record.generation) fail('stale_generation')
          if (cursor.nextSequence + BigInt(decoded.bytes.byteLength) > maxUint64) {
            fail('sequence_gap')
          }
          const maxFrameBytes = attempt.write.grant.maxFrameBytes
          let nextSequence = cursor.nextSequence
          for (let offset = 0; offset < decoded.bytes.byteLength; offset += maxFrameBytes) {
            const bytes = decoded.bytes.slice(offset, offset + maxFrameBytes)
            const start = nextSequence
            const end = start + BigInt(bytes.byteLength)
            const outbound: DevStreamFrame = {
              type: 'input',
              sequence: start.toString(),
              generation: attempt.record.generation,
              bytes,
            }
            // A successful send transfers this byte range to the authenticated
            // write grant. A throw remains ambiguous and the pane stops without
            // replaying the bytes.
            attempt.write.socket.send(outbound)
            nextSequence = end
            inputCursor = { generation: cursor.generation, nextSequence }
            if (!isCurrent(attempt)) throw new Error('terminal stream retired during input send')
          }
          return
        }
        if (decoded.type === 'resize') {
          if (decoded.generation !== attempt.record.generation) fail('stale_generation')
          if (
            decoded.sequence !== '0' ||
            !Number.isInteger(decoded.cols) ||
            decoded.cols < 1 ||
            decoded.cols > 1000 ||
            !Number.isInteger(decoded.rows) ||
            decoded.rows < 1 ||
            decoded.rows > 1000
          ) {
            fail('incompatible')
          }
          pendingResize = {
            generation: attempt.record.generation,
            cols: decoded.cols,
            rows: decoded.rows,
          }
          flushResize(attempt)
          return
        }
        fail('incompatible')
      },
      close(code, reason) {
        closeAttempt(attempt, code, reason)
      },
    }
  }

  function startAttempt(attempt: Attempt, context: TerminalAttachContext): void {
    void (async () => {
      try {
        validateCursor(context.fromSequence)
        if (
          context.generation !== undefined &&
          (!Number.isSafeInteger(context.generation) || context.generation < 0)
        ) {
          fail('stale_generation')
        }
        const streams = runtime.streams?.()
        if (!streams) fail('capability_unavailable')
        const selected = await currentTerminal(context, attempt)
        if (!selected || !isCurrent(attempt)) return
        const changedGeneration =
          context.generation !== undefined && context.generation !== selected.generation
        if (changedGeneration && pendingResize?.generation !== selected.generation) {
          pendingResize = null
        }
        const readFromSequence = changedGeneration ? '0' : context.fromSequence
        const cursor = inputCursor
        const writeFromSequence =
          !changedGeneration &&
          context.generation === selected.generation &&
          cursor?.generation === selected.generation
            ? cursor.nextSequence.toString()
            : '0'
        const resource = {
          kind: 'terminal',
          id: selected.id,
          generation: selected.generation,
        }
        const readValue = await execute(
          'dev.terminal.attach',
          selected,
          {
            terminalId: selected.id,
            expectedGeneration: selected.generation,
            direction: 'read',
            fromSequence: readFromSequence,
          },
          resource
        )
        if (!isCurrent(attempt)) return
        const readGrant = validateGrant(readValue, selected, 'read', readFromSequence)
        const writeValue = await execute(
          'dev.terminal.input',
          selected,
          {
            terminalId: selected.id,
            expectedGeneration: selected.generation,
            direction: 'write',
            fromSequence: writeFromSequence,
          },
          resource
        )
        if (!isCurrent(attempt)) return
        const writeGrant = validateGrant(writeValue, selected, 'write', writeFromSequence)
        if (
          readGrant.channelId !== writeGrant.channelId ||
          readGrant.grantId === writeGrant.grantId
        ) {
          fail('identity_mismatch')
        }
        attempt.record = selected
        attempt.read = { grant: readGrant, socket: null, opened: null, closed: false }
        attempt.write = { grant: writeGrant, socket: null, opened: null, closed: false }
        // Attach the write direction first so it is already authenticated
        // before the read side can begin replaying output.
        attachSlot(attempt, streams, writeGrant)
        if (!isCurrent(attempt)) return
        attachSlot(attempt, streams, readGrant)
      } catch (error) {
        emitFailure(attempt, error)
      }
    })()
  }

  return {
    heartbeatMode: 'server_only' as const,
    connect(handlers, context) {
      if (activeAttempt) closeAttempt(activeAttempt)
      const attempt: Attempt = {
        record: captured,
        handlers,
        closed: false,
        ready: false,
        read: null,
        write: null,
        pendingReadFrames: [],
        pendingReadBytes: 0,
      }
      activeAttempt = attempt
      const socket = makeSocket(attempt)
      startAttempt(attempt, context)
      return socket
    },
  }
}
