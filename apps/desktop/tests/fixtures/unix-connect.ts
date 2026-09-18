// Real unix-socket duplex for sidecar live-process tests.
import type { ByteDuplex } from '../../shell/src/dev-runtime/terminal/sidecar/protocol'

export async function connectUnix(socketPath: string): Promise<ByteDuplex> {
  const dataCallbacks = new Set<(bytes: Uint8Array) => void>()
  const closeCallbacks = new Set<() => void>()

  const socket = await Bun.connect({
    unix: socketPath,
    socket: {
      data(_socket, data) {
        for (const callback of [...dataCallbacks]) callback(new Uint8Array(data))
      },
      close() {
        for (const callback of [...closeCallbacks]) callback()
      },
    },
  })

  return {
    send: (bytes) => {
      socket.write(bytes)
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
      socket.end()
    },
  }
}
