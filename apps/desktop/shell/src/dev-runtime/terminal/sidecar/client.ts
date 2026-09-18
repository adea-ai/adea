// Shell-side client for the terminal sidecar (issue #396): performs the
// authenticated hello (endpoint credential + fresh nonce + protocol
// identity + scope binding), correlates request/response, and surfaces
// data/resync/exit events. A PID or port file grants nothing — only the
// endpoint credential authenticates.
import {
  createFrameDecoder,
  encodeByteFrame,
  encodeControl,
  SIDECAR_PROTOCOL,
  type ByteDuplex,
  type ByteFrameMeta,
  type DecodedSidecarFrame,
  type SidecarRequest,
  type SidecarResponse,
  type SidecarScope,
} from './protocol'

export type SidecarClientOptions = {
  duplex: ByteDuplex
  scope: SidecarScope
  credential: string
  nonce: string
  requestTimeoutMs?: number
  onDataFrame?: (meta: ByteFrameMeta, bytes: Uint8Array) => void
  onResync?: (notice: {
    terminalId: string
    subscriberId: string
    checkpointSequence: string
  }) => void
  onExited?: (notice: { terminalId: string; generation: number; exitCode: number | null }) => void
  onClose?: () => void
}

export type SidecarConnectResult =
  | { ok: true; client: SidecarClient }
  | { ok: false; code: string; message: string }

let requestCounter = 0
function nextRequestId(): string {
  requestCounter += 1
  return `sidecar-req-${requestCounter}`
}

export type SidecarClient = {
  /** Spawns a terminal PTY inside the sidecar. */
  create(args: {
    terminalId: string
    generation: number
    cols: number
    rows: number
    cwd: string
    shell: string
    args: readonly string[]
  }): Promise<SidecarResult<{ terminalId: string }>>
  /** Attach to a terminal; replays covered sequences then streams live. */
  attach(args: {
    terminalId: string
    subscriberId: string
    sinceSeq: string
  }): Promise<SidecarResult<AttachReply>>
  writeInput(terminalId: string, bytes: Uint8Array): Promise<SidecarResult<{ written: number }>>
  resize(
    terminalId: string,
    cols: number,
    rows: number
  ): Promise<SidecarResult<{ resized: boolean }>>
  signal(
    terminalId: string,
    signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'SIGHUP'
  ): Promise<SidecarResult<{ signalled: boolean }>>
  terminate(terminalId: string): Promise<SidecarResult<{ terminating: boolean }>>
  detach(terminalId: string, subscriberId: string): Promise<SidecarResult<{ detached: boolean }>>
  acknowledge(
    terminalId: string,
    subscriberId: string,
    byteCount: number
  ): Promise<SidecarResult<{ acknowledged: boolean }>>
  checkpoint(terminalId: string): Promise<SidecarResult<{ checkpoint: unknown }>>
  list(): Promise<SidecarResult<{ terminals: unknown[] }>>
  search(
    terminalId: string,
    query: string,
    limit: number
  ): Promise<SidecarResult<{ matches: unknown[] }>>
  deleteHistory(terminalId: string): Promise<SidecarResult<{ deletedSegments: number }>>
  readonly welcome: {
    sidecarVersion: string
    pid: number
    pidStartIdentity: string
    protocol: typeof SIDECAR_PROTOCOL
  }
  close(): void
  isClosed(): boolean
}

export type SidecarResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string }

export type AttachReply =
  | { resyncRequired: false; replayed: number; nextSeq: string }
  | { resyncRequired: true; checkpointSequence: string }

export function connectSidecarClient(options: SidecarClientOptions): Promise<SidecarConnectResult> {
  const { duplex } = options
  const decoder = createFrameDecoder()
  const pending = new Map<
    string,
    { resolve: (result: SidecarResult<unknown>) => void; timer: ReturnType<typeof setTimeout> }
  >()
  let closed = false
  let resolved = false
  let resolveConnectRef: (result: SidecarConnectResult) => void = () => {}

  function fail(code: string, message: string): void {
    if (closed || resolved) return
    closed = true
    resolved = true
    clearTimeout(helloTimer)
    for (const entry of pending.values()) clearTimeout(entry.timer)
    pending.clear()
    duplex.close()
    resolveConnectRef({ ok: false, code, message })
  }

  const helloTimeoutMs = options.requestTimeoutMs ?? 10_000
  const helloTimer = setTimeout(() => {
    if (!resolved) fail('timeout', 'sidecar hello timed out')
  }, helloTimeoutMs)

  return new Promise<SidecarConnectResult>((resolveConnect) => {
    resolveConnectRef = resolveConnect
    let welcome: SidecarClient['welcome'] | null = null

    function handleFrame(frame: DecodedSidecarFrame): void {
      if (frame.channel === 0x02) {
        options.onDataFrame?.(frame.meta, frame.bytes)
        return
      }
      const message = frame.message as SidecarResponse
      if (message.type === 'welcome') {
        if (welcome || resolved) return
        resolved = true
        clearTimeout(helloTimer)
        welcome = {
          sidecarVersion: message.sidecarVersion,
          pid: message.pid,
          pidStartIdentity: message.pidStartIdentity,
          protocol: message.protocol,
        }
        resolveConnect({
          ok: true,
          client: {
            welcome,
            create: (args) =>
              request<{ terminalId: string }>({
                type: 'terminal.create',
                requestId: nextRequestId(),
                terminalId: args.terminalId,
                generation: args.generation,
                cols: args.cols,
                rows: args.rows,
                cwd: args.cwd,
                shell: args.shell,
                args: args.args,
              }),
            attach: (args) =>
              request<
                | { resyncRequired: false; replayed: number; nextSeq: string }
                | { resyncRequired: true; checkpointSequence: string }
              >({
                type: 'terminal.attach',
                requestId: nextRequestId(),
                terminalId: args.terminalId,
                subscriberId: args.subscriberId,
                sinceSeq: args.sinceSeq,
              }),
            writeInput: (terminalId, bytes) => {
              const requestId = nextRequestId()
              duplex.send(
                encodeByteFrame(
                  {
                    kind: 'terminal.input',
                    terminalId,
                    generation: 0,
                    seq: requestId,
                    emittedAt: '',
                    byteLength: bytes.byteLength,
                  },
                  bytes
                )
              )
              return request<{ written: number }>({
                type: 'terminal.write',
                requestId,
                terminalId,
                byteLength: bytes.byteLength,
              })
            },
            resize: (terminalId, cols, rows) =>
              request<{ resized: boolean }>({
                type: 'terminal.resize',
                requestId: nextRequestId(),
                terminalId,
                cols,
                rows,
              }),
            signal: (terminalId, signal) =>
              request<{ signalled: boolean }>({
                type: 'terminal.signal',
                requestId: nextRequestId(),
                terminalId,
                signal,
              }),
            terminate: (terminalId) =>
              request<{ terminating: boolean }>({
                type: 'terminal.terminate',
                requestId: nextRequestId(),
                terminalId,
              }),
            detach: (terminalId, subscriberId) =>
              request<{ detached: boolean }>({
                type: 'terminal.detach',
                requestId: nextRequestId(),
                terminalId,
                subscriberId,
              }),
            acknowledge: (terminalId, subscriberId, byteCount) =>
              request<{ acknowledged: boolean }>({
                type: 'terminal.ack',
                requestId: nextRequestId(),
                terminalId,
                subscriberId,
                byteCount,
              }),
            checkpoint: (terminalId) =>
              request<{ checkpoint: unknown }>({
                type: 'terminal.checkpoint',
                requestId: nextRequestId(),
                terminalId,
              }),
            list: () =>
              request<{ terminals: unknown[] }>({
                type: 'terminal.list',
                requestId: nextRequestId(),
              }),
            search: (terminalId, query, limit) =>
              request<{ matches: unknown[] }>({
                type: 'terminal.search',
                requestId: nextRequestId(),
                terminalId,
                query,
                limit,
              }),
            deleteHistory: (terminalId) =>
              request<{ deletedSegments: number }>({
                type: 'terminal.historyDelete',
                requestId: nextRequestId(),
                terminalId,
              }),
            close() {
              closed = true
              for (const entry of pending.values()) clearTimeout(entry.timer)
              pending.clear()
              duplex.close()
            },
            isClosed: () => closed,
          },
        })
        return
      }
      if (message.type === 'refused') {
        fail(message.code, message.message)
        return
      }
      if (message.type === 'result') {
        const entry = pending.get(message.requestId)
        if (!entry) return
        pending.delete(message.requestId)
        clearTimeout(entry.timer)
        entry.resolve(
          message.ok
            ? { ok: true, value: message.value }
            : { ok: false, code: message.error.code, message: message.error.message }
        )
        return
      }
      if (message.type === 'resync') {
        options.onResync?.(message)
        return
      }
      if (message.type === 'exited') {
        options.onExited?.(message)
      }
    }

    const unsubscribe = duplex.onData((bytes) => {
      for (const frame of decoder.push(bytes)) handleFrame(frame)
    })
    duplex.onClose(() => {
      closed = true
      unsubscribe()
      options.onClose?.()
    })

    function request<T>(requestMessage: SidecarRequest): Promise<SidecarResult<T>> {
      if (closed)
        return Promise.resolve({ ok: false, code: 'invalid_state', message: 'client is closed' })
      return new Promise<SidecarResult<T>>((resolve) => {
        const timeoutMs = options.requestTimeoutMs ?? 10_000
        const timer = setTimeout(() => {
          pending.delete(requestMessage.requestId)
          resolve({ ok: false, code: 'timeout', message: 'sidecar request timed out' })
        }, timeoutMs)
        pending.set(requestMessage.requestId, {
          resolve: resolve as (result: SidecarResult<unknown>) => void,
          timer,
        })
        duplex.send(encodeControl(requestMessage))
      })
    }

    duplex.send(
      encodeControl({
        type: 'hello',
        credential: options.credential,
        nonce: options.nonce,
        protocol: SIDECAR_PROTOCOL,
        scope: options.scope,
      })
    )
  })
}
