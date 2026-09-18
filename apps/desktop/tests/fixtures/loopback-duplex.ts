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
