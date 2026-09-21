// Real unix-socket duplex for sidecar live-process tests. Delegates to the
// production backpressured writer (sidecar/socket-writer.ts): Bun unix
// write() silently drops what does not fit the kernel send buffer, so both
// directions of the transport must serialize through the drain-aware pump —
// the #396 transport-defect fix. Keeping the fixture on the production
// implementation means the live-process lanes (terminal-pty-smoke, packaged
// terminal smokes) exercise the exact transport the shell ships.
import {
  connectUnixByteDuplex,
  type UnixByteDuplex,
} from '../../shell/src/dev-runtime/terminal/sidecar/socket-writer'

export async function connectUnix(socketPath: string): Promise<UnixByteDuplex> {
  return connectUnixByteDuplex(socketPath)
}
