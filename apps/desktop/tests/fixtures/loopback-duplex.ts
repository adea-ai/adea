// In-process duplex pair fixture: the sidecar service's transport seam lets
// tests run client and service without a real socket while exercising the
// exact framing protocol.
import type { ByteDuplex } from '../../shell/src/dev-runtime/terminal/sidecar/protocol'

class Half implements ByteDuplex {
  private readonly dataCallbacks = new Set<(bytes: Uint8Array) => void>()
  private readonly closeCallbacks = new Set<() => void>()
  private remote: Half | null = null
  closed = false

  connect(remote: Half): void {
    this.remote = remote
  }

  send(bytes: Uint8Array): void {
    // Asynchronous delivery so framing/ordering matches a real socket.
    queueMicrotask(() => {
      if (this.closed || !this.remote || this.remote.closed) return
      this.remote.deliver(bytes)
    })
  }

  onData(callback: (bytes: Uint8Array) => void): () => void {
    this.dataCallbacks.add(callback)
    return () => {
      this.dataCallbacks.delete(callback)
    }
  }

  onClose(callback: () => void): () => void {
    this.closeCallbacks.add(callback)
    return () => {
      this.closeCallbacks.delete(callback)
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    // A real socket's close is observed by the peer (end/close event); the
    // local side also stops delivering.
    if (this.remote && !this.remote.closed) {
      for (const callback of this.remote.closeCallbacks) callback()
      this.remote.closed = true
    }
    for (const callback of this.closeCallbacks) callback()
  }

  private deliver(bytes: Uint8Array): void {
    for (const callback of this.dataCallbacks) callback(bytes)
  }
}

export function createLoopbackPair(): [ByteDuplex, ByteDuplex] {
  const left = new Half()
  const right = new Half()
  left.connect(right)
  right.connect(left)
  return [left, right]
}

/**
 * A server-side half whose write queue is bounded like the real socket
 * writer's: a producer that hands over more than `queueBound` bytes before the
 * peer drains trips the same failure the #593 repro hit (the connection is
 * ended mid-replay). Frames leave one per `drainMs`, standing in for a kernel
 * send buffer emptying, and `whenBelow` is the pacing seam a producer uses to
 * stay under the bound. Pass `paced: false` to model the pre-#593 transport
 * that offered no seam at all.
 */
class BoundedHalf extends Half {
  private readonly queue: Uint8Array[] = []
  private queuedBytes = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private waiters: Array<{ highWaterBytes: number; resolve: () => void }> = []
  private tripped = false

  /** Assigned by the factory only when pacing is enabled. */
  whenBelow?: (highWaterBytes: number) => Promise<void>

  constructor(
    private readonly queueBound: number,
    private readonly drainMs: number
  ) {
    super()
  }

  override send(bytes: Uint8Array): void {
    if (this.tripped || this.closed) return
    if (this.queuedBytes + bytes.byteLength > this.queueBound) {
      this.tripped = true
      this.queue.length = 0
      this.queuedBytes = 0
      this.wake()
      this.close()
      return
    }
    this.queue.push(bytes)
    this.queuedBytes += bytes.byteLength
    this.startDraining()
    this.wake()
  }

  override close(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.wake()
    super.close()
  }

  overflowed(): boolean {
    return this.tripped
  }

  awaitBelow(highWaterBytes: number): Promise<void> {
    if (this.tripped || this.closed || this.queuedBytes <= highWaterBytes) return Promise.resolve()
    return new Promise((resolve) => {
      this.waiters.push({ highWaterBytes, resolve })
    })
  }

  private startDraining(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      const next = this.queue.shift()
      if (next) {
        this.queuedBytes -= next.byteLength
        // Hand it to the peer through the base implementation (asynchronous
        // delivery, exactly like the unbounded fixture).
        super.send(next)
        this.wake()
      }
      if (this.queue.length === 0 && this.timer) {
        clearInterval(this.timer)
        this.timer = null
      }
    }, this.drainMs)
  }

  private wake(): void {
    if (this.waiters.length === 0) return
    const ready = this.waiters.filter(
      (waiter) => this.tripped || this.closed || this.queuedBytes <= waiter.highWaterBytes
    )
    if (ready.length === 0) return
    this.waiters = this.waiters.filter((waiter) => !ready.includes(waiter))
    for (const waiter of ready) waiter.resolve()
  }
}

export type BoundedLoopbackPair = {
  client: ByteDuplex
  server: ByteDuplex
  /** True once a producer exceeded the modeled queue bound. */
  overflowed: () => boolean
}

export function createBoundedLoopbackPair(options: {
  queueBound: number
  drainMs?: number
  paced?: boolean
}): BoundedLoopbackPair {
  const client = new Half()
  const server = new BoundedHalf(options.queueBound, options.drainMs ?? 1)
  client.connect(server)
  server.connect(client)
  if (options.paced ?? true) {
    server.whenBelow = (highWaterBytes) => server.awaitBelow(highWaterBytes)
  }
  return { client, server, overflowed: () => server.overflowed() }
}
