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
// unix socket. A boot on a data dir whose endpoint names a live same-identity
// process supersedes it cleanly; a stale endpoint is unlinked. SIGTERM/SIGINT
// flushes durable checkpoints and exits (force-exited after a bounded grace
// so a stalled shutdown can never orphan the process); PTY process groups are
// left running so a UI restart adopts them.
import { mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'

import { createBunPtyAdapter } from '../pty-adapter'
import { endpointFilePath, readEndpointFile, writeEndpointFile } from './endpoint-file'
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
function startIdentity(pid: number): string {
  try {
    const proc = Bun.spawnSync(['ps', '-o', 'lstart=', '-p', String(pid)])
    return proc.stdout.toString().trim() || `boot-${pid}`
  } catch {
    return `boot-${pid}`
  }
}

function pidStartIdentity(): string {
  return startIdentity(process.pid)
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Removes a dead predecessor's endpoint and socket so a fresh bind succeeds. */
function clearStaleEndpoint(dir: string, socketPath: string): void {
  try {
    rmSync(endpointFilePath(dir), { force: true })
  } catch {
    /* best effort */
  }
  try {
    rmSync(socketPath, { force: true })
  } catch {
    /* best effort */
  }
}

const credential = newSidecarCredential()
const socketPath = argValue('--socket') ?? `${dataDir}/dev-runtime/terminal-sidecar/sidecar.sock`
const sidecarVersion = process.env.ADEA_SIDECAR_VERSION ?? '0.0.0-dev'
const executableIdentity =
  process.env.ADEA_SIDECAR_IDENTITY ?? `adea-terminal-sidecar@${sidecarVersion}`

// Boot-time ownership guard (additive, issue #396 hardening): the endpoint
// file names this data dir's current owner. A live process that verifiably
// holds it — same executable identity plus a `ps` start-identity recheck, the
// same proof the supervisor uses before any signal — is superseded: it is
// asked to exit cleanly (its own SIGTERM path flushes durable checkpoints)
// inside a bounded window, then force-killed. Anything else is a stale
// record (dead PID, recycled PID, replaced executable) and is only unlinked,
// never signalled.
const previous = readEndpointFile(dataDir)
if (previous && previous.pid !== process.pid) {
  const identityMatches = previous.executableIdentity === executableIdentity
  const startMatches = previous.pidStartIdentity === startIdentity(previous.pid)
  if (identityMatches && startMatches && isAlive(previous.pid)) {
    try {
      process.kill(previous.pid, 'SIGTERM')
    } catch {
      /* already gone */
    }
    const deadline = Date.now() + 5_000
    while (isAlive(previous.pid) && Date.now() < deadline) {
      await Bun.sleep(100)
    }
    if (isAlive(previous.pid)) {
      try {
        process.kill(previous.pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
    clearStaleEndpoint(dataDir, socketPath)
  } else {
    clearStaleEndpoint(dataDir, socketPath)
  }
}

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
  // Belt over the graceful suspenders: a stalled checkpoint flush or server
  // stop must never turn a signalled sidecar into a leaked orphan. After the
  // grace window the process exits unconditionally (checkpoint segment writes
  // are atomic, so the worst case equals the bytes an orphan would lose).
  const forceExit = setTimeout(() => process.exit(0), 5_000)
  try {
    await service.prepareForShutdown()
  } finally {
    clearTimeout(forceExit)
    server.stop(true)
    process.exit(0)
  }
}
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())

// Orphan belt: the endpoint file is this sidecar's only handle for a UI
// restart to adopt it through. If the file disappears while the process is
// live, no future adoption can ever target it and the process is unrecoverable
// garbage — typically a test lane or cleanup that removed the data dir under a
// still-running sidecar. Exiting then (through the same graceful path) keeps a
// leaked lane from parking an unadoptable process — and its PTY children —
// behind the test runner's end-of-run child reaping. Production never deletes
// a live sidecar's data location (M10 manifest: cleanup retains component
// data), so this fires only in the unrecoverable case.
const endpointWatch = setInterval(() => {
  if (shuttingDown) return
  if (readEndpointFile(dataDir) === null) {
    console.error('adea-terminal-sidecar: endpoint file disappeared; exiting')
    void shutdown()
  }
}, 3_000)
endpointWatch.unref?.()

// Keep the event loop alive even with no connected client.
setInterval(() => {}, 30_000).unref?.()
