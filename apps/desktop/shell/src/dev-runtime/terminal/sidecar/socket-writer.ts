// Backpressured serialized socket writer for the terminal sidecar transport
// (issue #396 transport-defect fix).
//
// The defect (confirmed by scripts/packaged-transport-defect-probe.ts and the
// packaged evidence lane): Bun unix sockets' write() accepts only what fits
// the kernel send buffer and SILENTLY DROPS the remainder — it does not queue
// it. Once the peer stops draining, everything beyond the ~8 KiB in flight is
// lost (the probe's pure-socket burst lost 19,838 of 20,000 framed writes;
// a sidecar flood misaligned the framed stream at the ~21 KiB/32 KiB buffer
// boundaries). `socket.buffered` is NaN on unix sockets in Bun 1.4 and cannot
// pace writes; the reliable signals are write()'s return value (bytes
// accepted, the unaccepted tail is discarded) and the socket's `drain`
// callback (the send buffer emptied).
//
// Contract (Dev Runtime spec, "Terminal protocol → Sidecar transport
// writes"):
//   - Frames are written in submission order, exactly once, never dropped.
//     A write that is not fully accepted requeues the unaccepted remainder
//     and pauses until the socket drains; a single FIFO queue and a single
//     pump preserve the byte stream exactly.
//   - The pending queue is bounded: DEFAULT_MAX_QUEUED_BYTES (8 MiB) unless
//     the caller names a tighter bound. Overflow is explicit, never a silent
//     mid-stream drop (that would corrupt the framed stream): the writer
//     fails closed — it clears the queue, ends the socket, and reports — so
//     the peer sees a clean close and can reconnect/resync from durable
//     history.
//   - A small interactive write still takes the synchronous fast path: it is
//     handed to the kernel immediately during send(). Only a full socket
//     queues; latency for interactive traffic is unchanged.
//   - The wire format is untouched: this is a pure write-scheduling change;
//     existing peers keep working byte for byte.
import type { ByteDuplex } from './protocol'

/** The subset of a Bun unix socket the writer needs. */
export type SocketWriterSocket = {
  /** Returns the number of bytes accepted; anything beyond is discarded. */
  write(data: Uint8Array | string): number
  end(): number | void
}

export type SocketWriterOverflowReason = 'queue_overflow' | 'write_failed'

export type SocketWriterOptions = {
  /**
   * Maximum bytes awaiting the socket (the kernel send buffer is in addition
   * to this). Overflow fails the connection closed explicitly.
   */
  maxQueuedBytes?: number
  /** Called when the queue bound is exceeded or a write throws. */
  onOverflow?: (reason: SocketWriterOverflowReason) => void
  /** Fallback wait between drain wakeups; the drain event is primary. */
  drainPollMs?: number
  /** Bounded flush window for close(); the force-exit belt bounds the rest. */
  closeGraceMs?: number
}

/** Queue bound: comfortably above the 1 MiB subscriber high-water × the 8
 *  subscribers a session may have, and small enough that a vanished peer
 *  cannot balloon a connection's memory. */
export const DEFAULT_MAX_QUEUED_BYTES = 8 * 1024 * 1024

export type BackpressuredSocketWriter = {
  /** Queues and writes bytes in order; synchronous, never drops. */
  send(bytes: Uint8Array): void
  /** The owning socket's `drain` callback; wakes the paused pump. */
  notifyDrain(): void
  /** Bytes awaiting the socket (excludes what the kernel already took). */
  pendingBytes(): number
  isClosed(): boolean
  /** Stops accepting, flushes within the grace window, then ends the socket. */
  close(): Promise<void>
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function createBackpressuredSocketWriter(
  socket: SocketWriterSocket,
  options: SocketWriterOptions = {}
): BackpressuredSocketWriter {
  const maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES
  const drainPollMs = options.drainPollMs ?? 2
  const closeGraceMs = options.closeGraceMs ?? 2_000
  // Head-only mutation: a partial accept rewrites queue[0] to the unaccepted
  // remainder, so the byte order across the queue is the submission order.
  let queue: Uint8Array[] = []
  let queuedBytes = 0
  let pumping = false
  let accepting = true
  let dead = false
  let drainWaiters: Array<() => void> = []

  function wakeDrainWaiters(): void {
    const waiters = drainWaiters
    drainWaiters = []
    for (const waiter of waiters) waiter()
  }

  function fail(reason: SocketWriterOverflowReason): void {
    if (dead) return
    dead = true
    accepting = false
    queue = []
    queuedBytes = 0
    wakeDrainWaiters()
    options.onOverflow?.(reason)
    try {
      socket.end()
    } catch {
      /* the socket is already gone */
    }
  }

  function waitDrain(): Promise<void> {
    return new Promise((resolve) => {
      drainWaiters.push(resolve)
      // The drain event is the primary wakeup; this bounded poll only guards
      // against a missed wakeup so the pump can never stall forever.
      setTimeout(() => {
        const index = drainWaiters.indexOf(resolve)
        if (index >= 0) {
          drainWaiters.splice(index, 1)
          resolve()
        }
      }, drainPollMs)
    })
  }

  async function pump(): Promise<void> {
    if (pumping || dead) return
    pumping = true
    try {
      while (queue.length > 0) {
        if (dead) return
        const head = queue[0]!
        let accepted: number
        try {
          accepted = socket.write(head)
        } catch {
          fail('write_failed')
          return
        }
        if (accepted === head.byteLength) {
          queue.shift()
          queuedBytes -= head.byteLength
          continue
        }
        // Partial or rejected: the accepted prefix is in the kernel; requeue
        // the exact remainder and pause until the socket drains.
        if (accepted > 0) {
          queue[0] = head.subarray(accepted)
          queuedBytes -= accepted
        }
        await waitDrain()
      }
    } finally {
      pumping = false
      // A close() racing the final drain must still see the empty queue.
      wakeDrainWaiters()
    }
  }

  return {
    send(bytes: Uint8Array): void {
      if (!accepting || dead || bytes.byteLength === 0) return
      if (pumping || queue.length > 0) {
        if (queuedBytes + bytes.byteLength > maxQueuedBytes) {
          fail('queue_overflow')
          return
        }
        queue.push(bytes)
        queuedBytes += bytes.byteLength
        void pump()
        return
      }
      // Fast path: the socket is idle, so hand interactive bytes straight to
      // the kernel — no queue, no await, unchanged latency.
      let accepted: number
      try {
        accepted = socket.write(bytes)
      } catch {
        fail('write_failed')
        return
      }
      if (accepted < bytes.byteLength) {
        const remainder = bytes.subarray(Math.max(accepted, 0))
        if (remainder.byteLength > maxQueuedBytes) {
          fail('queue_overflow')
          return
        }
        queue.push(remainder)
        queuedBytes += remainder.byteLength
        void pump()
      }
    },

    notifyDrain(): void {
      wakeDrainWaiters()
    },

    pendingBytes(): number {
      return queuedBytes
    },

    isClosed(): boolean {
      return dead
    },

    async close(): Promise<void> {
      accepting = false
      if (dead) return
      const deadline = Date.now() + closeGraceMs
      while (queue.length > 0 && Date.now() < deadline) await sleep(1)
      dead = true
      queue = []
      queuedBytes = 0
      wakeDrainWaiters()
      try {
        socket.end()
      } catch {
        /* the socket is already gone */
      }
    },
  }
}

/** The transport seam the sidecar protocol speaks. */
export type UnixByteDuplex = ByteDuplex

export type ConnectUnixByteDuplexOptions = {
  /** Writer bounds; defaults match the spec'd transport contract. */
  maxQueuedBytes?: number
  onOverflow?: (reason: SocketWriterOverflowReason) => void
}

/**
 * Real unix-socket client duplex for the sidecar endpoint, with the same
 * serialized backpressured write path the sidecar entry uses: flooding this
 * direction (large pastes, scripted input) loses nothing and keeps frames in
 * order. The client-side attach path (terminal/register.ts streams) writes
 * to the sidecar through this duplex.
 */
export async function connectUnixByteDuplex(
  socketPath: string,
  options: ConnectUnixByteDuplexOptions = {}
): Promise<UnixByteDuplex> {
  const dataCallbacks = new Set<(bytes: Uint8Array) => void>()
  const closeCallbacks = new Set<() => void>()
  let writer: BackpressuredSocketWriter | null = null

  const socket = await Bun.connect({
    unix: socketPath,
    socket: {
      data(_socket, data) {
        for (const callback of dataCallbacks) callback(new Uint8Array(data))
      },
      drain() {
        writer?.notifyDrain()
      },
      error() {
        for (const callback of closeCallbacks) callback()
      },
      close() {
        for (const callback of closeCallbacks) callback()
      },
    },
  })
  writer = createBackpressuredSocketWriter(socket, options)

  return {
    send: (bytes) => {
      writer?.send(bytes)
    },
    onData: (callback) => {
      dataCallbacks.add(callback)
      return () => {
        dataCallbacks.delete(callback)
      }
    },
    onClose: (callback) => {
      closeCallbacks.add(callback)
      return () => {
        closeCallbacks.delete(callback)
      }
    },
    close: () => {
      void writer?.close()
    },
  }
}
