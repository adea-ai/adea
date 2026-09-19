// The terminal session store (issue #396): one PTY lifecycle per terminal ID,
// byte-accurate sequence-numbered output, bounded memory, replay, and
// backpressure.
//
// Provenance: session bookkeeping, bounded scrollback, output batching,
// per-terminal serialized operations, primary-device-attributes consumption,
// and the close grace period are adapted from bb
// `apps/host-daemon/src/terminals/terminal-manager.ts`
// (revision 52a9256373d4d36f9b60e9e2a7f333464091a2ac, MIT). The pinned donor
// seams are deliberately replaced and covered by tests:
// - bb is Node/node-pty over strings; Adea keeps raw `Uint8Array` chunks end
//   to end (no UTF-8 decode, no base64) per docs/specs/dev-runtime.md
//   ("Terminal protocol").
// - bb's scrollback is terminal-ID scoped memory only; Adea adds generation
//   ownership, per-subscriber flow control with `resync_required`, durable
//   checkpoints, and scope-bound authorization surfaces.
import { randomUUID } from 'node:crypto'

import type { PtyAdapter, PtyProcess } from './pty-adapter'
import { TERMINAL_LIMITS } from './limits'

export type TerminalLifecycle = 'creating' | 'running' | 'detached' | 'terminating' | 'exited'
export type TerminalHealth = 'healthy' | 'degraded' | 'replay_required' | 'faulted'

export type TerminalError = Readonly<{
  code:
    | 'not_found'
    | 'invalid_state'
    | 'stale_generation'
    | 'backpressure'
    | 'limit_exceeded'
    | 'sequence_gap'
    | 'spawn_failed'
    | 'unsupported_capability'
  message: string
}>

export type TerminalOk<T> = { ok: true; value: T } | { ok: false; error: TerminalError }

export function terminalError(code: TerminalError['code'], message: string): TerminalError {
  return { code, message }
}

export type TerminalChunk = Readonly<{
  terminalId: string
  generation: number
  /** Canonical unsigned decimal sequence; monotonically increasing from 0. */
  seq: string
  emittedAt: string
  bytes: Uint8Array
}>

/** One attached client stream. Delivery is fire-and-forget; credit returns via `acknowledge`. */
export interface TerminalSubscriber {
  readonly id: string
  deliver(chunk: TerminalChunk): void
}

export type ResyncNotice = Readonly<{
  subscriberId: string
  terminalId: string
  reason: 'backpressure'
  checkpointSequence: string
}>

export type TerminalExitNotice = Readonly<{
  terminalId: string
  generation: number
  exitCode: number | null
}>

export type TerminalManagerEvents = {
  onResync?(notice: ResyncNotice): void
  onExit?(notice: TerminalExitNotice): void
  /** Every appended ring chunk; the checkpoint sink consumes this. */
  onChunk?(chunk: TerminalChunk): void
}

export interface CreateTerminalInput {
  readonly terminalId: string
  readonly generation: number
  readonly cols: number
  readonly rows: number
  readonly shell: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Record<string, string>
  /**
   * Byte-level output transform applied before ring storage (the
   * shell-integration observer consumes protocol frames and denies OSC 52).
   * Must stay byte-preserving: it never decodes or trims.
   */
  readonly outputTransform?: (bytes: Uint8Array) => Uint8Array
}

export type TerminalSnapshot = Readonly<{
  terminalId: string
  generation: number
  lifecycle: TerminalLifecycle
  health: TerminalHealth
  cols: number
  rows: number
  nextSeq: string
  subscriberCount: number
}>

export type AttachResult =
  | { resyncRequired: false; replayed: number; nextSeq: string }
  | { resyncRequired: true; checkpointSequence: string }

export type TerminalManagerOptions = {
  ptyAdapter: PtyAdapter
  now?: () => number
  outputBatchDelayMs?: number
  closeGracePeriodMs?: number
  events?: TerminalManagerEvents
  /** Test/ops override only; production uses the normative spec limits. */
  limits?: typeof TERMINAL_LIMITS
}

const DA_QUERY = [0x1b, 0x5b, 0x30, 0x63] as const // ESC [ 0 c
const DA_REPLY = new Uint8Array([0x1b, 0x5b, 0x3f, 0x31, 0x3b, 0x32, 0x63]) // ESC [ ? 1 ; 2 c
const MAX_DA_REPLIES_PER_FLUSH = 8

type RingEntry = { seq: number; emittedAt: string; bytes: Uint8Array }

type SubscriberState = {
  id: string
  deliver: (chunk: TerminalChunk) => void
  /** Bytes delivered but not yet acknowledged. */
  outstandingBytes: number
  /** Set once the subscriber exceeded the high-water and must resync. */
  needsResync: boolean
  /** Next ring sequence this subscriber has not received yet. */
  nextUndeliveredSeq: number
}

type Session = {
  terminalId: string
  generation: number
  lifecycle: TerminalLifecycle
  health: TerminalHealth
  cols: number
  rows: number
  pty: PtyProcess | null
  outputTransform: ((bytes: Uint8Array) => Uint8Array) | null
  disposables: (() => void)[]
  ring: RingEntry[]
  ringBytes: number
  nextSeq: number
  oldestSeq: number
  pendingOutput: Uint8Array[]
  pendingOutputBytes: number
  outputFlushTimer: ReturnType<typeof setTimeout> | null
  closeTimer: ReturnType<typeof setTimeout> | null
  subscribers: Map<string, SubscriberState>
  /** Bytes of a partially received primary-device-attributes query. */
  pendingDaQuery: number
}

/**
 * Consumes primary-device-attributes queries at byte level so a shell that
 * probes terminal capability before any renderer attaches is answered once
 * (bounded per flush) instead of blocking. Adapted from bb's string matcher,
 * re-expressed as a byte state machine because Adea never decodes PTY bytes.
 */
export function consumeDeviceAttributes(
  pending: number,
  data: Uint8Array
): { output: Uint8Array; pending: number; queries: number } {
  const output = new Uint8Array(data.byteLength)
  let out = 0
  let queries = 0
  let state = pending
  for (let index = 0; index < data.byteLength; index += 1) {
    const byte = data[index]!
    if (byte === DA_QUERY[state]) {
      state += 1
      if (state === DA_QUERY.length) {
        queries += 1
        state = 0
      }
      continue
    }
    // Flush the matched prefix verbatim, then re-match this byte from scratch.
    for (let prefix = 0; prefix < state; prefix += 1) output[out++] = DA_QUERY[prefix]!
    state = byte === DA_QUERY[0] ? 1 : 0
    if (state === 0) output[out++] = byte
  }
  return { output: output.subarray(0, out), pending: state, queries }
}

/** Builds the wire chunk for one ring entry (pure; shared by the store). */
function chunkOf(session: Session, entry: RingEntry): TerminalChunk {
  return {
    terminalId: session.terminalId,
    generation: session.generation,
    seq: String(entry.seq),
    emittedAt: entry.emittedAt,
    bytes: entry.bytes,
  }
}

export function createTerminalManager(options: TerminalManagerOptions) {
  const now = options.now ?? Date.now
  const outputBatchDelayMs = options.outputBatchDelayMs ?? 4
  const closeGracePeriodMs = options.closeGracePeriodMs ?? 2_000
  const events = options.events ?? {}
  const limits = options.limits ?? TERMINAL_LIMITS
  const sessions = new Map<string, Session>()
  const operations = new Map<string, Promise<unknown>>()

  /** Serializes operations per terminal so state transitions cannot interleave. */
  function run<T>(terminalId: string, operation: () => Promise<T> | T): Promise<T> {
    const previous = operations.get(terminalId) ?? Promise.resolve()
    const next = previous.then(operation, operation)
    const tail = next.catch(() => undefined)
    operations.set(terminalId, tail)
    void tail.then(() => {
      if (operations.get(terminalId) === tail) operations.delete(terminalId)
    })
    return next
  }

  function handleOutput(session: Session, data: Uint8Array): void {
    if (sessions.get(session.terminalId) !== session) return
    if (session.outputTransform) data = session.outputTransform(data)
    const consumed = consumeDeviceAttributes(session.pendingDaQuery, data)
    session.pendingDaQuery = consumed.pending
    if (consumed.queries > 0 && session.pty) {
      const replies = Math.min(consumed.queries, MAX_DA_REPLIES_PER_FLUSH)
      for (let index = 0; index < replies; index += 1) {
        try {
          session.pty.write(DA_REPLY)
        } catch {
          break
        }
      }
    }
    bufferOutput(session, consumed.output)
  }

  function bufferOutput(session: Session, data: Uint8Array): void {
    if (data.byteLength === 0) return
    session.pendingOutput.push(data)
    session.pendingOutputBytes += data.byteLength
    if (session.pendingOutputBytes >= limits.maxChunkBytes) {
      flushOutput(session)
      return
    }
    if (session.outputFlushTimer !== null) return
    session.outputFlushTimer = setTimeout(() => {
      session.outputFlushTimer = null
      flushOutput(session)
    }, outputBatchDelayMs)
  }

  function flushOutput(session: Session): void {
    if (session.outputFlushTimer !== null) {
      clearTimeout(session.outputFlushTimer)
      session.outputFlushTimer = null
    }
    if (sessions.get(session.terminalId) !== session || session.pendingOutputBytes === 0) {
      session.pendingOutput = []
      session.pendingOutputBytes = 0
      return
    }
    // Coalesce the batch, then split at the 64 KiB chunk bound.
    const batch = new Uint8Array(session.pendingOutputBytes)
    let offset = 0
    for (const part of session.pendingOutput) {
      batch.set(part, offset)
      offset += part.byteLength
    }
    session.pendingOutput = []
    session.pendingOutputBytes = 0
    for (let start = 0; start < batch.byteLength; start += limits.maxChunkBytes) {
      const end = Math.min(start + limits.maxChunkBytes, batch.byteLength)
      appendRing(session, batch.subarray(start, end))
    }
    publishPending(session)
  }

  function appendRing(session: Session, bytes: Uint8Array): void {
    const entry: RingEntry = {
      seq: session.nextSeq,
      emittedAt: new Date(now()).toISOString(),
      bytes,
    }
    session.nextSeq += 1
    session.ring.push(entry)
    session.ringBytes += bytes.byteLength
    while (
      (session.ringBytes > limits.ringMaxBytes || session.ring.length > limits.ringMaxChunks) &&
      session.ring.length > 1
    ) {
      const removed = session.ring.shift()
      if (!removed) break
      session.ringBytes -= removed.bytes.byteLength
      session.oldestSeq = removed.seq + 1
    }
    events.onChunk?.(chunkOf(session, entry))
  }

  /**
   * Publishes undelivered ring chunks to subscribers. Publication pause is
   * per subscriber: the PTY reader and the ring never wait on a slow client;
   * a subscriber past the high-water is switched to `resync_required` with
   * the oldest covered sequence instead of growing memory without bound.
   */
  function publishPending(session: Session): void {
    for (const subscriber of session.subscribers.values()) {
      while (!subscriber.needsResync && subscriber.nextUndeliveredSeq < session.nextSeq) {
        if (subscriber.outstandingBytes >= limits.subscriberHighWaterBytes) {
          subscriber.needsResync = true
          events.onResync?.({
            subscriberId: subscriber.id,
            terminalId: session.terminalId,
            reason: 'backpressure',
            checkpointSequence: String(session.oldestSeq),
          })
          break
        }
        const entry = session.ring.find(
          (candidate) => candidate.seq === subscriber.nextUndeliveredSeq
        )
        if (!entry) {
          // Ring pruning passed this subscriber's cursor: memory never grows
          // to compensate, so the subscriber must resync from the anchor.
          subscriber.needsResync = true
          events.onResync?.({
            subscriberId: subscriber.id,
            terminalId: session.terminalId,
            reason: 'backpressure',
            checkpointSequence: String(session.oldestSeq),
          })
          break
        }
        subscriber.deliver(chunkOf(session, entry))
        subscriber.nextUndeliveredSeq = entry.seq + 1
        subscriber.outstandingBytes += entry.bytes.byteLength
      }
    }
  }

  function finishSession(session: Session, exitCode: number | null): void {
    if (sessions.get(session.terminalId) !== session) return
    flushOutput(session)
    if (session.closeTimer !== null) {
      clearTimeout(session.closeTimer)
      session.closeTimer = null
    }
    for (const dispose of session.disposables) dispose()
    session.disposables = []
    session.pty = null
    session.lifecycle = 'exited'
    sessions.delete(session.terminalId)
    events.onExit?.({ terminalId: session.terminalId, generation: session.generation, exitCode })
  }

  return {
    /** Serializes an external operation (e.g. terminate+cleanup) per terminal. */
    run,

    has(terminalId: string): boolean {
      return sessions.has(terminalId)
    },

    snapshot(terminalId: string): TerminalSnapshot | undefined {
      const session = sessions.get(terminalId)
      if (!session) return undefined
      return {
        terminalId: session.terminalId,
        generation: session.generation,
        lifecycle: session.lifecycle,
        health: session.health,
        cols: session.cols,
        rows: session.rows,
        nextSeq: String(session.nextSeq),
        subscriberCount: session.subscribers.size,
      }
    },

    list(): TerminalSnapshot[] {
      return [...sessions.keys()].map((id) => this.snapshot(id)!)
    },

    async create(input: CreateTerminalInput): Promise<TerminalOk<string>> {
      if (sessions.has(input.terminalId)) {
        return { ok: false, error: terminalError('invalid_state', 'terminal already exists') }
      }
      const spawned = options.ptyAdapter.spawn({
        shell: input.shell,
        args: input.args,
        cwd: input.cwd,
        cols: input.cols,
        rows: input.rows,
        env: input.env,
      })
      if (!spawned.ok) {
        return {
          ok: false,
          error: terminalError(
            spawned.code === 'unsupported_capability' ? 'unsupported_capability' : 'spawn_failed',
            spawned.message
          ),
        }
      }
      const session: Session = {
        terminalId: input.terminalId,
        generation: input.generation,
        lifecycle: 'running',
        health: 'healthy',
        cols: input.cols,
        rows: input.rows,
        pty: spawned.value,
        outputTransform: input.outputTransform ?? null,
        disposables: [],
        ring: [],
        ringBytes: 0,
        nextSeq: 0,
        oldestSeq: 0,
        pendingOutput: [],
        pendingOutputBytes: 0,
        outputFlushTimer: null,
        closeTimer: null,
        subscribers: new Map(),
        pendingDaQuery: 0,
      }
      sessions.set(input.terminalId, session)
      session.disposables.push(
        spawned.value.onData((data) => handleOutput(session, data)),
        spawned.value.onExit((event) => {
          void run(session.terminalId, () => finishSession(session, event.exitCode)).catch(
            () => undefined
          )
        })
      )
      return { ok: true, value: input.terminalId }
    },

    /**
     * Attaches a subscriber. Covered `sinceSeq` replays exactly once in order
     * before live delivery; coverage past the ring is a resync requirement
     * anchored at the oldest covered sequence.
     */
    attach(
      terminalId: string,
      subscriber: TerminalSubscriber,
      sinceSeq: string
    ): TerminalOk<AttachResult> {
      const session = sessions.get(terminalId)
      if (!session) return { ok: false, error: terminalError('not_found', 'terminal not found') }
      if (session.lifecycle === 'terminating' || session.lifecycle === 'exited') {
        return {
          ok: false,
          error: terminalError('invalid_state', `terminal is ${session.lifecycle}`),
        }
      }
      if (session.subscribers.size >= limits.maxSubscribers) {
        return { ok: false, error: terminalError('limit_exceeded', 'subscriber limit reached') }
      }
      if (BigInt(sinceSeq) > BigInt(session.nextSeq)) {
        return {
          ok: false,
          error: terminalError('sequence_gap', 'sinceSeq is beyond the terminal sequence'),
        }
      }
      if (BigInt(sinceSeq) < BigInt(session.oldestSeq)) {
        session.health = 'replay_required'
        return {
          ok: true,
          value: { resyncRequired: true, checkpointSequence: String(session.oldestSeq) },
        }
      }
      const subscriberState: SubscriberState = {
        id: subscriber.id,
        deliver: subscriber.deliver,
        outstandingBytes: 0,
        needsResync: false,
        nextUndeliveredSeq: Number(sinceSeq),
      }
      session.subscribers.set(subscriber.id, subscriberState)
      session.lifecycle = 'running'
      let replayed = 0
      for (const entry of session.ring) {
        if (BigInt(entry.seq) < BigInt(sinceSeq)) continue
        subscriberState.deliver(chunkOf(session, entry))
        subscriberState.nextUndeliveredSeq = entry.seq + 1
        subscriberState.outstandingBytes += entry.bytes.byteLength
        replayed += 1
      }
      return {
        ok: true,
        value: { resyncRequired: false, replayed, nextSeq: String(session.nextSeq) },
      }
    },

    detach(terminalId: string, subscriberId: string): TerminalOk<'detached'> {
      const session = sessions.get(terminalId)
      if (!session) return { ok: false, error: terminalError('not_found', 'terminal not found') }
      session.subscribers.delete(subscriberId)
      if (session.subscribers.size === 0 && session.lifecycle === 'running') {
        // App/window close detaches; the PTY itself stays alive (spec state machine).
        session.lifecycle = 'detached'
      }
      return { ok: true, value: 'detached' }
    },

    /** Acknowledges delivery credit for one subscriber; unlocks paused publication. */
    acknowledge(terminalId: string, subscriberId: string, byteCount: number): void {
      const session = sessions.get(terminalId)
      const subscriber = session?.subscribers.get(subscriberId)
      if (!session || !subscriber) return
      subscriber.outstandingBytes = Math.max(0, subscriber.outstandingBytes - byteCount)
      publishPending(session)
    },

    write(terminalId: string, bytes: Uint8Array): TerminalOk<'written'> {
      const session = sessions.get(terminalId)
      if (!session?.pty)
        return { ok: false, error: terminalError('not_found', 'terminal not found') }
      if (session.lifecycle === 'exited' || session.lifecycle === 'terminating') {
        return {
          ok: false,
          error: terminalError('invalid_state', `terminal is ${session.lifecycle}`),
        }
      }
      if (bytes.byteLength > limits.inputQueueMaxBytes) {
        return {
          ok: false,
          error: terminalError('backpressure', 'input exceeds the session queue limit'),
        }
      }
      try {
        session.pty.write(bytes)
      } catch (cause) {
        return {
          ok: false,
          error: terminalError(
            'invalid_state',
            `write failed: ${cause instanceof Error ? cause.message : String(cause)}`
          ),
        }
      }
      return { ok: true, value: 'written' }
    },

    resize(terminalId: string, cols: number, rows: number): TerminalOk<'resized'> {
      const session = sessions.get(terminalId)
      if (!session?.pty)
        return { ok: false, error: terminalError('not_found', 'terminal not found') }
      if (session.cols === cols && session.rows === rows) return { ok: true, value: 'resized' }
      session.cols = cols
      session.rows = rows
      try {
        session.pty.resize(cols, rows)
      } catch (cause) {
        return {
          ok: false,
          error: terminalError(
            'invalid_state',
            `resize failed: ${cause instanceof Error ? cause.message : String(cause)}`
          ),
        }
      }
      return { ok: true, value: 'resized' }
    },

    signal(
      terminalId: string,
      signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'SIGHUP'
    ): TerminalOk<'signalled'> {
      const session = sessions.get(terminalId)
      if (!session?.pty)
        return { ok: false, error: terminalError('not_found', 'terminal not found') }
      if (session.lifecycle === 'exited') {
        return { ok: false, error: terminalError('invalid_state', 'terminal already exited') }
      }
      try {
        session.pty.kill(signal)
      } catch {
        // The process died between the state check and the signal; the exit
        // handler records truth.
      }
      return { ok: true, value: 'signalled' }
    },

    /** Explicit terminate: graceful signal, then SIGKILL after the grace period. */
    terminate(terminalId: string): TerminalOk<'terminating'> {
      const session = sessions.get(terminalId)
      if (!session?.pty)
        return { ok: false, error: terminalError('not_found', 'terminal not found') }
      if (session.lifecycle === 'exited' || session.lifecycle === 'terminating') {
        return {
          ok: false,
          error: terminalError('invalid_state', `terminal is ${session.lifecycle}`),
        }
      }
      session.lifecycle = 'terminating'
      try {
        session.pty.kill('SIGTERM')
      } catch {
        finishSession(session, null)
        return { ok: true, value: 'terminating' }
      }
      session.closeTimer = setTimeout(() => {
        session.closeTimer = null
        if (sessions.get(terminalId) !== session || session.lifecycle === 'exited') return
        try {
          session.pty?.kill('SIGKILL')
        } catch {
          /* the exit handler owns cleanup */
        }
      }, closeGracePeriodMs)
      return { ok: true, value: 'terminating' }
    },

    /** Ring coverage for tests/ops: `[oldestSeq, nextSeq)`. */
    coverage(terminalId: string): { oldestSeq: string; nextSeq: string } | undefined {
      const session = sessions.get(terminalId)
      if (!session) return undefined
      return { oldestSeq: String(session.oldestSeq), nextSeq: String(session.nextSeq) }
    },

    chunks(terminalId: string, fromSeq: string): TerminalChunk[] {
      const session = sessions.get(terminalId)
      if (!session) return []
      return session.ring
        .filter((entry) => BigInt(entry.seq) >= BigInt(fromSeq))
        .map((entry) => chunkOf(session, entry))
    },

    /**
     * Detach-only shutdown: the sidecar stops supervising and flushes durable
     * state, leaving PTY history recoverable for adoption after a restart.
     */
    async shutdownForAdoption(): Promise<void> {
      for (const session of Array.from(sessions.values())) {
        flushOutput(session)
        for (const subscriberId of Array.from(session.subscribers.keys()))
          this.detach(session.terminalId, subscriberId)
      }
    },
  }
}

export type TerminalManager = ReturnType<typeof createTerminalManager>

export function newSubscriberId(): string {
  return randomUUID()
}
