// The terminal sidecar service (issue #396): the in-process core behind the
// detached sidecar binary. It authenticates every connection against the
// endpoint credential with a fresh nonce, binds one scope per connection,
// and serves terminal operations on top of the session manager, the
// checkpoint sinks, and the shell-integration observers.
//
// Provenance: sidecar composition and checkpoint persistence are adapted
// from orca `src/main/daemon/daemon-init.ts` and
// `src/main/daemon/daemon-pty-checkpoint-persistence.ts`
// (revision 403b62a8d8fa6e896a93acc4c15405be0f0b7dc7, MIT), reworked for
// Adea's scope binding, byte-preserving streams, and relative history
// identifiers.
import { randomBytes, timingSafeEqual } from 'node:crypto'

import { createCheckpointSink, type CheckpointSink, type SegmentChunk } from '../checkpoints'
import { TERMINAL_LIMITS } from '../limits'
import type { PtyAdapter } from '../pty-adapter'
import {
  buildTerminalEnv,
  createShellIntegrationObserver,
  newHookKey,
  parseShellKind,
  resolveWorktreeHistoryFile,
  selectShellFeatures,
  type ShellObservation,
} from '../shell-integration'
import {
  createTerminalManager,
  type TerminalManager,
  type TerminalSnapshot,
} from '../terminal-manager'
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

export type SidecarServiceOptions = {
  runtimeRoot: string
  ptyAdapter: PtyAdapter
  sidecarVersion: string
  /** The 256-bit endpoint credential this sidecar authenticates. */
  credential: Uint8Array
  executableIdentity: string
  pidStartIdentity: string
  now?: () => number
  /** Test/ops override only; production uses the normative spec limits. */
  managerLimits?: typeof TERMINAL_LIMITS
}

type ConnectionState = {
  duplex: ByteDuplex
  decoder: ReturnType<typeof createFrameDecoder>
  scope: SidecarScope | null
  closed: boolean
  /** subscriberId → terminalId for data/resync routing on this connection. */
  subscribers: Map<string, string>
}

/** One-way control send; a vanished connection just marks itself closed. */
function send(state: ConnectionState, message: SidecarResponse): void {
  if (state.closed) return
  try {
    state.duplex.send(encodeControl(message))
  } catch {
    state.closed = true
  }
}

/**
 * The contiguous durable chunk chain [sinceSeq, ringOldestSeq) — exactly the
 * span the in-memory ring cannot replay. Returns null when the durable
 * history does not bridge the gap (retention pruned the needed segments or a
 * segment was quarantined): replaying a partial prefix would fabricate a
 * continuous history with a hole in it, so the caller resyncs from the ring
 * anchor instead. Exported for the retention boundary tests: the same
 * deterministic null on every retry after GC is the resync contract.
 */
export function durableBridge(
  sink: CheckpointSink,
  sinceSeq: string,
  ringOldestSeq: string
): { chunks: SegmentChunk[]; byteLength: number } | null {
  let expected: bigint
  try {
    expected = BigInt(sinceSeq)
    if (expected >= BigInt(ringOldestSeq)) return null
  } catch {
    return null
  }
  const chunks: SegmentChunk[] = []
  let byteLength = 0
  for (const chunk of sink.read(sinceSeq)) {
    const seq = BigInt(chunk.seq)
    if (seq < expected) continue // duplicated across segment tail + open buffer
    if (seq > expected) return null // gap: history genuinely unavailable
    if (seq >= BigInt(ringOldestSeq)) break // the live ring replays from here
    chunks.push(chunk)
    byteLength += chunk.bytes.byteLength
    expected += 1n
  }
  return expected >= BigInt(ringOldestSeq) ? { chunks, byteLength } : null
}

export function createSidecarService(options: SidecarServiceOptions) {
  const now = options.now ?? Date.now
  const helloNonces = new Map<string, number>()
  const sinks = new Map<string, CheckpointSink>()
  const observationsByTerminal = new Map<string, ShellObservation[]>()
  const exitCodes = new Map<string, number | null>()
  const connections = new Set<ConnectionState>()

  const manager: TerminalManager = createTerminalManager({
    ptyAdapter: options.ptyAdapter,
    now,
    limits: options.managerLimits,
    events: {
      onChunk: (chunk) => {
        // ensureSink (not a bare lookup): every ring chunk is durably
        // appended even for a terminal whose sink was not opened in this
        // process yet (e.g. after adoption), never silently dropped.
        ensureSink(chunk.terminalId, chunk.generation).append({
          seq: chunk.seq,
          emittedAt: chunk.emittedAt,
          bytes: chunk.bytes,
        })
      },
      onResync: (notice) => {
        // A live subscriber crossed the mid-stream high-water (or the ring
        // pruned past its cursor): tell the connection that owns it, using the
        // same deterministic anchor (the oldest ring sequence) the attach-time
        // resync path returns. The manager latches the subscriber into
        // `needsResync` BEFORE emitting, so this surfaces exactly one notice
        // per gap — never a duplicate resync storm. Ordering on the duplex is
        // FIFO: the notice follows the last chunk that subscriber received,
        // so a client resyncing from the anchor recovers exactly the span it
        // missed, exactly once, from the ring or the durable checkpoints.
        for (const connection of connections) {
          if (connection.subscribers.get(notice.subscriberId) !== notice.terminalId) continue
          send(connection, {
            type: 'resync',
            terminalId: notice.terminalId,
            subscriberId: notice.subscriberId,
            checkpointSequence: notice.checkpointSequence,
          })
        }
      },
      onExit: (notice) => {
        exitCodes.set(notice.terminalId, notice.exitCode)
        sinks.get(notice.terminalId)?.checkpoint()
        for (const connection of connections) {
          send(connection, {
            type: 'exited',
            terminalId: notice.terminalId,
            generation: notice.generation,
            exitCode: notice.exitCode,
          })
        }
      },
    },
  })

  function respond(state: ConnectionState, requestId: string, value: unknown): void {
    send(state, { type: 'result', requestId, ok: true, value })
  }

  function respondError(
    state: ConnectionState,
    requestId: string,
    error: { code: string; message: string }
  ): void {
    send(state, { type: 'result', requestId, ok: false, error })
  }

  function refuse(state: ConnectionState, code: string, message: string): void {
    send(state, { type: 'refused', code, message })
  }

  function constantTimeCredential(candidate: string): boolean {
    const expected = Buffer.from(options.credential)
    let candidateBytes: Buffer
    try {
      candidateBytes = Buffer.from(candidate, 'base64url')
    } catch {
      return false
    }
    return candidateBytes.length === expected.length && timingSafeEqual(expected, candidateBytes)
  }

  function consumeHelloNonce(nonce: string): boolean {
    const at = now()
    for (const [key, expiry] of helloNonces) if (expiry < at) helloNonces.delete(key)
    if (helloNonces.has(nonce)) return false
    helloNonces.set(nonce, at + 60_000)
    return true
  }

  function recordObservation(terminalId: string, observation: ShellObservation): void {
    const list = observationsByTerminal.get(terminalId) ?? []
    list.push(observation)
    if (list.length > 1_000) list.shift()
    observationsByTerminal.set(terminalId, list)
  }

  function ensureSink(terminalId: string, generation: number): CheckpointSink {
    const existing = sinks.get(terminalId)
    if (existing) return existing
    const sink = createCheckpointSink({
      runtimeRoot: options.runtimeRoot,
      terminalId,
      generation,
      now,
      // Per-scope retention (#399 residue): every durable write also enforces
      // the workspace budget across all sessions under the runtime root,
      // oldest eligible session first. A session holding a live replay-window
      // reservation (a durable bridge mid-delivery) stays protected.
      scopeRetention: {
        isProtected: (candidateId) => (replayFloorReservations.get(candidateId) ?? 0) > 0,
      },
    })
    sinks.set(terminalId, sink)
    return sink
  }

  /** Live durable-bridge replay windows per terminal (ref-counted). */
  const replayFloorReservations = new Map<string, number>()

  function reserveReplayFloor(terminalId: string): () => void {
    replayFloorReservations.set(terminalId, (replayFloorReservations.get(terminalId) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const count = (replayFloorReservations.get(terminalId) ?? 0) - 1
      if (count <= 0) replayFloorReservations.delete(terminalId)
      else replayFloorReservations.set(terminalId, count)
    }
  }

  /**
   * The sink for a control request on a known terminal. Opens the durable
   * history on demand so checkpoint/search/delete serve a terminal adopted
   * into this process, not only one created here. Unknown terminals have no
   * history and stay `not_found`.
   */
  function sinkForRequest(terminalId: string): CheckpointSink | null {
    const existing = sinks.get(terminalId)
    if (existing) return existing
    const generation = manager.snapshot(terminalId)?.generation
    if (generation === undefined) return null
    return ensureSink(terminalId, generation)
  }

  async function handleControl(state: ConnectionState, request: SidecarRequest): Promise<void> {
    if (request.type === 'hello') {
      if (state.scope) {
        refuse(state, 'invalid_state', 'connection already completed the handshake')
        return
      }
      if (!constantTimeCredential(request.credential)) {
        refuse(state, 'channel_unauthenticated', 'endpoint credential did not verify')
        return
      }
      if (!consumeHelloNonce(request.nonce)) {
        refuse(state, 'replay_rejected', 'hello nonce is not fresh')
        return
      }
      if (
        request.protocol.name !== SIDECAR_PROTOCOL.name ||
        request.protocol.major !== SIDECAR_PROTOCOL.major
      ) {
        refuse(state, 'sidecar_incompatible', 'protocol major versions differ')
        return
      }
      state.scope = request.scope
      send(state, {
        type: 'welcome',
        protocol: SIDECAR_PROTOCOL,
        sidecarVersion: options.sidecarVersion,
        pid: process.pid,
        pidStartIdentity: options.pidStartIdentity,
      })
      return
    }
    if (!state.scope) {
      refuse(state, 'channel_unauthenticated', 'hello must complete first')
      return
    }
    switch (request.type) {
      case 'terminal.create': {
        // One hook key per terminal; the observer strips authenticated
        // protocol frames, denies OSC 52, and bounds OSC payloads before any
        // byte reaches the ring.
        const hookKey = newHookKey()
        const shellKind = parseShellKind(request.shell)
        const features = selectShellFeatures({
          shellKind,
          wantsCommandMarkers: true,
          reportsCwd: true,
          wantsHistory: true,
        })
        const histFile = resolveWorktreeHistoryFile(
          options.runtimeRoot,
          request.terminalId,
          shellKind
        )
        const env = buildTerminalEnv(process.env as Record<string, string | undefined>, {
          terminalId: request.terminalId,
          generation: request.generation,
          hookKey,
          features,
          histFile: histFile ?? undefined,
        })
        const observer = createShellIntegrationObserver({
          terminalId: request.terminalId,
          generation: request.generation,
          hookKey,
          now,
          onObservation: (observation) => recordObservation(request.terminalId, observation),
        })
        ensureSink(request.terminalId, request.generation)
        // create is async (spawn + listener wiring); await before replying.
        const created = await manager.create({
          terminalId: request.terminalId,
          generation: request.generation,
          cols: request.cols,
          rows: request.rows,
          shell: request.shell,
          args: request.args,
          cwd: request.cwd,
          env,
          outputTransform: observer.feed,
        })
        if (!created.ok) {
          respondError(state, request.requestId, created.error)
          return
        }
        respond(state, request.requestId, { terminalId: request.terminalId })
        return
      }
      case 'terminal.resize': {
        const result = manager.resize(request.terminalId, request.cols, request.rows)
        if (result.ok) respond(state, request.requestId, { resized: true })
        else respondError(state, request.requestId, result.error)
        return
      }
      case 'terminal.signal': {
        const result = manager.signal(request.terminalId, request.signal)
        if (result.ok) respond(state, request.requestId, { signalled: true })
        else respondError(state, request.requestId, result.error)
        return
      }
      case 'terminal.terminate': {
        const result = manager.terminate(request.terminalId)
        if (result.ok) respond(state, request.requestId, { terminating: true })
        else respondError(state, request.requestId, result.error)
        return
      }
      case 'terminal.attach': {
        const subscriberId = request.subscriberId
        const deliver = (chunk: {
          terminalId: string
          generation: number
          seq: string
          emittedAt: string
          bytes: Uint8Array
        }): void => {
          const meta: ByteFrameMeta = {
            kind: 'terminal.data',
            terminalId: chunk.terminalId,
            generation: chunk.generation,
            seq: chunk.seq,
            emittedAt: chunk.emittedAt,
            byteLength: chunk.bytes.byteLength,
            subscriberId,
          }
          try {
            state.duplex.send(encodeByteFrame(meta, chunk.bytes))
          } catch {
            state.closed = true
          }
        }
        const attached = manager.attach(
          request.terminalId,
          { id: subscriberId, deliver },
          request.sinceSeq
        )
        if (!attached.ok) {
          respondError(state, request.requestId, attached.error)
          return
        }
        if (attached.value.resyncRequired) {
          // The in-memory ring cannot cover sinceSeq. Try the durable
          // checkpoints: a contiguous segment chain that bridges the gap to
          // the live ring replays seamlessly (exactly once, in order); a
          // genuinely unavailable span returns the deterministic anchor —
          // the oldest ring sequence — so the client resyncs and resumes.
          const coverage = manager.coverage(request.terminalId)
          const snapshot = manager.snapshot(request.terminalId)
          if (coverage && snapshot) {
            const sink = ensureSink(request.terminalId, snapshot.generation)
            // Retention protection (#399 residue): the bridge span is a live
            // replay window. Until it is fully delivered, neither this
            // session's per-session pass nor a scope pass triggered by
            // another terminal's write may evict the segment covering
            // sinceSeq. The reservation is ref-counted and always released.
            const releaseScopeFloor = reserveReplayFloor(request.terminalId)
            const releaseSinkFloor = sink.protectFrom(request.sinceSeq)
            try {
              const bridge = durableBridge(sink, request.sinceSeq, coverage.oldestSeq)
              if (bridge) {
                for (const chunk of bridge.chunks) {
                  deliver({
                    terminalId: request.terminalId,
                    generation: snapshot.generation,
                    seq: chunk.seq,
                    emittedAt: chunk.emittedAt,
                    bytes: chunk.bytes,
                  })
                }
                const primed = manager.attach(
                  request.terminalId,
                  { id: subscriberId, deliver },
                  coverage.oldestSeq,
                  { preplayedBytes: bridge.byteLength }
                )
                if (!primed.ok) {
                  respondError(state, request.requestId, primed.error)
                  return
                }
                if (primed.value.resyncRequired) {
                  // The ring moved between probes (all synchronous, so this
                  // is defensive only): surface the fresh anchor truthfully.
                  respond(state, request.requestId, primed.value)
                  return
                }
                state.subscribers.set(subscriberId, request.terminalId)
                respond(state, request.requestId, {
                  resyncRequired: false,
                  replayed: bridge.chunks.length + primed.value.replayed,
                  nextSeq: primed.value.nextSeq,
                })
                return
              }
            } finally {
              releaseSinkFloor()
              releaseScopeFloor()
            }
          }
        }
        state.subscribers.set(subscriberId, request.terminalId)
        respond(state, request.requestId, attached.value)
        return
      }
      case 'terminal.detach': {
        const result = manager.detach(request.terminalId, request.subscriberId)
        state.subscribers.delete(request.subscriberId)
        if (result.ok) respond(state, request.requestId, { detached: true })
        else respondError(state, request.requestId, result.error)
        return
      }
      case 'terminal.ack': {
        manager.acknowledge(request.terminalId, request.subscriberId, request.byteCount)
        respond(state, request.requestId, { acknowledged: true })
        return
      }
      case 'terminal.checkpoint': {
        // ensureSink reopens the durable history of a terminal adopted into
        // this process (segments on disk, no sink instance yet).
        const sink = sinkForRequest(request.terminalId)
        if (!sink) {
          respondError(state, request.requestId, {
            code: 'not_found',
            message: 'no durable history',
          })
          return
        }
        const checkpointed = sink.checkpoint()
        if (checkpointed.ok) respond(state, request.requestId, { checkpoint: checkpointed.value })
        else respondError(state, request.requestId, checkpointed.error)
        return
      }
      case 'terminal.list': {
        respond(state, request.requestId, { terminals: manager.list() })
        return
      }
      case 'terminal.search': {
        const sink = sinkForRequest(request.terminalId)
        if (!sink) {
          respondError(state, request.requestId, {
            code: 'not_found',
            message: 'no durable history',
          })
          return
        }
        respond(state, request.requestId, {
          matches: sink.search(request.query, Math.min(request.limit, 500)),
        })
        return
      }
      case 'terminal.historyDelete': {
        const sink = sinkForRequest(request.terminalId)
        if (!sink) {
          respondError(state, request.requestId, {
            code: 'not_found',
            message: 'no durable history',
          })
          return
        }
        const deleted = sink.deleteHistory()
        if (deleted.ok)
          respond(state, request.requestId, { deletedSegments: deleted.value.deletedSegments })
        else respondError(state, request.requestId, deleted.error)
        return
      }
      default: {
        refuse(state, 'invalid_state', 'unsupported request type')
      }
    }
  }

  function handleByteFrame(
    state: ConnectionState,
    frame: Extract<DecodedSidecarFrame, { channel: 0x02 }>
  ): void {
    if (!state.scope) {
      refuse(state, 'channel_unauthenticated', 'hello must complete first')
      return
    }
    if (frame.meta.kind !== 'terminal.input') {
      refuse(state, 'invalid_state', `unexpected byte frame kind ${frame.meta.kind}`)
      return
    }
    // The client stamps the request ID into the byte-frame meta; the write
    // result correlates through it (no second control round-trip).
    const result = manager.write(frame.meta.terminalId, frame.bytes)
    if (result.ok) respond(state, frame.meta.seq, { written: frame.bytes.byteLength })
    else respondError(state, frame.meta.seq, result.error)
  }

  function handleConnection(duplex: ByteDuplex): void {
    const state: ConnectionState = {
      duplex,
      decoder: createFrameDecoder(),
      scope: null,
      closed: false,
      subscribers: new Map(),
    }
    connections.add(state)
    const unsubscribe = duplex.onData((bytes) => {
      let frames: DecodedSidecarFrame[]
      try {
        frames = state.decoder.push(bytes)
      } catch {
        refuse(state, 'invalid_state', 'malformed sidecar frame')
        state.closed = true
        duplex.close()
        return
      }
      for (const frame of frames) {
        try {
          if (frame.channel === 0x01) handleControl(state, frame.message as SidecarRequest)
          else handleByteFrame(state, frame)
        } catch (cause) {
          refuse(state, 'invalid_state', cause instanceof Error ? cause.message : String(cause))
        }
      }
    })
    duplex.onClose(() => {
      state.closed = true
      unsubscribe()
      // Detach every subscriber this connection owned; the PTYs live on.
      for (const [subscriberId, terminalId] of state.subscribers) {
        manager.detach(terminalId, subscriberId)
      }
      connections.delete(state)
    })
  }

  function snapshotList(): TerminalSnapshot[] {
    return manager.list()
  }

  return {
    handleConnection,
    manager,
    snapshotList,
    observationsFor: (terminalId: string) => observationsByTerminal.get(terminalId) ?? [],
    exitCodeFor: (terminalId: string) => exitCodes.get(terminalId) ?? null,
    sinkFor: (terminalId: string) => sinks.get(terminalId),
    /** Flushes durable state for adoption after a restart; PTYs stay alive. */
    async prepareForShutdown(): Promise<void> {
      await manager.shutdownForAdoption()
      for (const sink of sinks.values()) sink.checkpoint()
    },
    runtimeRoot: options.runtimeRoot,
    sidecarVersion: options.sidecarVersion,
    executableIdentity: options.executableIdentity,
  }
}

export type SidecarService = ReturnType<typeof createSidecarService>

export function newSidecarCredential(): Uint8Array {
  return randomBytes(32)
}
