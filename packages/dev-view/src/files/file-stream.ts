/*
 * Client half of the `file-bytes-v1` bulk stream (#399 residue). Pure model
 * over an injected attach seam: reads collect offset-sequenced data frames
 * under ack credit, writes emit generation-stamped chunks at running byte
 * offsets. Both settle only on the server's `normal` close — an `error`
 * frame (e.g. `file_changed` on a discarded write) rejects the promise.
 * No DOM, no socket construction: the host supplies the authenticated
 * transport, this module owns the protocol discipline.
 */
import type { DevError, DevStreamFrame, DevStreamGrant } from '@adea-ai/types/dev-runtime'

/** One attached, grant-bound stream socket. The production transport wraps
 *  the authenticated channel WebSocket (`dev.runtime.stream.attach.v1`). */
export type FileStreamSocket = {
  readonly open: boolean
  send(frame: DevStreamFrame): void
  close(code: number, reason: string): void
}

/** Attaches one fresh single-use grant: handlers receive frames and the
 *  socket's eventual close. */
export type FileStreamTransport = {
  connect(
    grant: DevStreamGrant,
    handlers: {
      onFrame: (frame: DevStreamFrame) => void
      onClose: (code: number, reason: string) => void
    }
  ): FileStreamSocket
}

/** Chunks ride the grant's maxFrameBytes; the provider mints grants at
 *  64 KiB, so writes use the same ceiling client-side. */
export function fileChunkSize(grant: DevStreamGrant): number {
  return Math.max(1, Math.min(grant.maxFrameBytes, 1024 * 1024))
}

/** Reads the whole granted byte range: offsets must arrive exactly in
 *  sequence (each frame's sequence is its byte offset from the grant's
 *  fromSequence); every frame is acknowledged with matching credit. */
export function readFileViaStream(
  transport: FileStreamTransport,
  grant: DevStreamGrant
): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Uint8Array[] = []
    let received = BigInt(grant.fromSequence)
    let settled = false
    let socket: FileStreamSocket | undefined
    // The server may begin pumping during connect — before this client holds
    // the socket handle — so acknowledgements emitted that early are queued
    // and flushed the moment the socket exists.
    const pendingSends: DevStreamFrame[] = []

    const fail = (error: DevError | string): void => {
      if (settled) return
      settled = true
      const message = typeof error === 'string' ? error : error.message
      const code = typeof error === 'string' ? 'invalid_state' : error.code
      reject({ error: { code, retryable: false, message } })
      socket?.close(1000, 'client settled')
    }
    const finish = (): void => {
      if (settled) return
      settled = true
      const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
      const merged = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        merged.set(chunk, offset)
        offset += chunk.byteLength
      }
      resolve(merged)
    }
    const sendAck = (frame: DevStreamFrame): void => {
      if (socket) socket.send(frame)
      else pendingSends.push(frame)
    }

    socket = transport.connect(grant, {
      onFrame: (frame) => {
        if (settled) return
        if (frame.type === 'data') {
          if (BigInt(frame.sequence) !== received) {
            fail('bulk read frames must be contiguous byte offsets')
            return
          }
          chunks.push(frame.bytes)
          received += BigInt(frame.bytes.byteLength)
          sendAck({
            type: 'ack',
            throughSequence: frame.sequence,
            availableCreditBytes: frame.bytes.byteLength,
          })
          return
        }
        if (frame.type === 'error') {
          fail(frame.error)
          return
        }
        if (frame.type === 'close') {
          if (frame.code === 'normal') finish()
          else fail(`bulk read closed: ${frame.code}`)
        }
      },
      onClose: (code, reason) => {
        if (!settled) fail(`bulk read socket closed (${code}): ${reason}`)
      },
    })
    for (const frame of pendingSends.splice(0)) socket.send(frame)
  })
}

/** Writes bytes through the granted stream: contiguous input frames at
 *  running byte offsets, stamped with the grant's generation. Resolves only
 *  on the server's `normal` close (which follows its digest-verified atomic
 *  rename); a discarded write arrives as an `error` frame and rejects. */
export function writeFileViaStream(
  transport: FileStreamTransport,
  grant: DevStreamGrant,
  bytes: Uint8Array
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    let sent = 0
    let socket: FileStreamSocket | undefined

    const fail = (error: DevError | string): void => {
      if (settled) return
      settled = true
      const message = typeof error === 'string' ? error : error.message
      const code = typeof error === 'string' ? 'invalid_state' : error.code
      reject({ error: { code, retryable: false, message } })
      socket?.close(1000, 'client settled')
    }
    const finish = (): void => {
      if (settled) return
      settled = true
      resolve()
    }

    socket = transport.connect(grant, {
      onFrame: (frame) => {
        if (settled) return
        if (frame.type === 'error') {
          fail(frame.error)
          return
        }
        if (frame.type === 'close') {
          if (frame.code === 'normal') finish()
          else fail(`bulk write closed: ${frame.code}`)
        }
      },
      onClose: (code, reason) => {
        if (!settled) fail(`bulk write socket closed (${code}): ${reason}`)
      },
    })

    const chunkSize = fileChunkSize(grant)
    while (sent < bytes.byteLength) {
      if (!socket.open) return // onClose settles the promise
      const chunk = bytes.subarray(sent, Math.min(sent + chunkSize, bytes.byteLength))
      socket.send({
        type: 'input',
        sequence: String(sent),
        generation: grant.resource.generation,
        bytes: chunk,
      })
      sent += chunk.byteLength
    }
    if (bytes.byteLength === 0) {
      // A declared-empty write settles server-side at attach; nothing to do.
    }
  })
}
