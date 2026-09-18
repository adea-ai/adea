// The detached terminal sidecar binary entry (issue #396).
//
// Ships as a single compiled executable (`bun build --compile`, ADR 0008
// exception documented in docs/decisions/0008-build-bundler-vite-vs-bun.md):
// a versioned binary with faster spawn and a cleaner adoption handshake
// (adea#490). Registration, supervision, crash-loop policy, and upgrade
// belong to the M10 supervisor (#185) — this entry never supervises itself.
//
// Usage: adea-terminal-sidecar --data-dir <dir> [--socket <path>]
// Writes the owner-only endpoint file and serves the sidecar protocol on a
// unix socket. SIGTERM/SIGINT flushes durable checkpoints and exits;
// PTY process groups are left running so a UI restart adopts them.
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { createBunPtyAdapter } from '../pty-adapter'
import { writeEndpointFile } from './endpoint-file'
import { createSidecarService, newSidecarCredential } from './service'
import { SIDECAR_PROTOCOL, type ByteDuplex } from './protocol'

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const dataDir = argValue('--data-dir')
if (!dataDir) {
  console.error('adea-terminal-sidecar: --data-dir is required')
  process.exit(2)
}

// Best-effort macOS/Linux start identity for the endpoint record; the
// supervisor's durable launch records remain the destruction authority.
function pidStartIdentity(): string {
  try {
    const proc = Bun.spawnSync(['ps', '-o', 'lstart=', '-p', String(process.pid)])
    return proc.stdout.toString().trim() || `boot-${process.pid}`
  } catch {
    return `boot-${process.pid}`
  }
}

const credential = newSidecarCredential()
const socketPath = argValue('--socket') ?? `${dataDir}/dev-runtime/terminal-sidecar/sidecar.sock`
const sidecarVersion = process.env.ADEA_SIDECAR_VERSION ?? '0.0.0-dev'
const executableIdentity =
  process.env.ADEA_SIDECAR_IDENTITY ?? `adea-terminal-sidecar@${sidecarVersion}`

const service = createSidecarService({
  runtimeRoot: `${dataDir}/dev-runtime`,
  ptyAdapter: createBunPtyAdapter(),
  sidecarVersion,
  credential,
  executableIdentity,
  pidStartIdentity: pidStartIdentity(),
})

/** Adapts Bun's listen-mode socket callbacks to the ByteDuplex seam. */
class SocketDuplex implements ByteDuplex {
  private readonly dataCallbacks = new Set<(bytes: Uint8Array) => void>()
  private readonly closeCallbacks = new Set<() => void>()
  private socket: { write(data: Uint8Array | string): number; end(): number | void } | null = null

  attach(socket: { write(data: Uint8Array | string): number; end(): number | void }): void {
    this.socket = socket
  }

  deliver(data: Uint8Array): void {
    for (const callback of this.dataCallbacks) callback(data)
  }

  closeRemote(): void {
    for (const callback of this.closeCallbacks) callback()
  }

  send(bytes: Uint8Array): void {
    // Bun listen-mode sockets expose write()/end(), not send().
    this.socket?.write(bytes)
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
    this.socket?.end()
  }
}

const connections = new Map<unknown, SocketDuplex>()

// The socket directory is the endpoint file's directory; create it before
// the listener so a first boot never races its own bind.
mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 })

const server = Bun.listen({
  unix: socketPath,
  socket: {
    open(socket) {
      const duplex = new SocketDuplex()
      duplex.attach(socket as { write(data: Uint8Array | string): number; end(): number | void })
      connections.set(socket, duplex)
      service.handleConnection(duplex)
    },
    data(socket, data) {
      connections.get(socket)?.deliver(new Uint8Array(data))
    },
    close(socket) {
      connections.get(socket)?.closeRemote()
      connections.delete(socket)
    },
    error(socket) {
      connections.get(socket)?.closeRemote()
      connections.delete(socket)
    },
  },
})

writeEndpointFile(dataDir, {
  schemaVersion: 1,
  protocol: SIDECAR_PROTOCOL,
  sidecarVersion,
  executableIdentity,
  pid: process.pid,
  pidStartIdentity: pidStartIdentity(),
  credential: Buffer.from(credential).toString('base64url'),
  socketPath,
  createdAt: new Date().toISOString(),
})

let shuttingDown = false
async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  await service.prepareForShutdown()
  server.stop(true)
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())

// Keep the event loop alive even with no connected client.
setInterval(() => {}, 30_000).unref?.()
