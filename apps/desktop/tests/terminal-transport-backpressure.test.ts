// Regression tests for the #396 terminal sidecar transport defect: Bun unix
// socket.write() silently drops what does not fit the kernel send buffer, so
// a fire-and-forget write path loses any burst larger than ~8 KiB (the
// packaged evidence probe lost 19,838 of 20,000 framed writes; a sidecar
// flood misaligned the framed stream at the ~21 KiB/32 KiB buffer
// boundaries). These tests pin the fix — a serialized, drain-aware, bounded
// write path (sidecar/socket-writer.ts) on BOTH ends of the socket — by
// flooding the real transport and asserting zero loss and exact order.
//
//   1. the writer over a real socket pair (dev path, no PTY);
//   2. the dev sidecar entry flooded through a real PTY (darwin);
//   3. the packaged sidecar entry flooded the same way (darwin, requires
//      `bun run test:packaged` — skips without the .app bundle).
//
// Run this file ONE AT A TIME (the real-process lanes own their children;
// bun test shares one thread across files).
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'

import {
  connectSidecarClient,
  type SidecarClient,
} from '../shell/src/dev-runtime/terminal/sidecar/client'
import { readEndpointFile } from '../shell/src/dev-runtime/terminal/sidecar/endpoint-file'
import {
  createBackpressuredSocketWriter,
  type SocketWriterOverflowReason,
} from '../shell/src/dev-runtime/terminal/sidecar/socket-writer'
import type { ByteDuplex } from '../shell/src/dev-runtime/terminal/sidecar/protocol'
import { connectUnix } from './fixtures/unix-connect'

const SCOPE = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}

/** FLOOD_BYTES of 'x' through the PTY: multi-megabyte, far past any buffer. */
const FLOOD_BYTES = 4 * 1024 * 1024

// ── 1. the writer itself, over a real socket pair ───────────────────────────

describe('backpressured socket writer', () => {
  test('a small interactive write goes straight to the kernel during send()', () => {
    const writes: number[] = []
    const writer = createBackpressuredSocketWriter({
      write: (data) => {
        writes.push(data.byteLength)
        return data.byteLength
      },
      end: () => undefined,
    })
    writer.send(new Uint8Array(16))
    // Synchronous fast path: no queue, no await, unchanged interactive latency.
    expect(writes).toEqual([16])
    expect(writer.pendingBytes()).toBe(0)
    expect(writer.isClosed()).toBe(false)
  })

  test('a multi-megabyte flood through the real socket pair loses nothing and keeps exact order', async () => {
    const socketPath = join(tmpdir(), `adea-writer-flood-${randomUUID()}.sock`)
    // 20,000 small frames (the defect probe's shape) plus 64 × 64 KiB frames
    // with an embedded index: far past the kernel send buffer in both the
    // many-small and few-large shapes the sidecar actually emits.
    const SMALL_FRAMES = 20_000
    const BIG_FRAMES = 64
    const BIG_BYTES = 64 * 1024
    const TOTAL_FRAMES = SMALL_FRAMES + BIG_FRAMES
    // Recorded server-side when the flood is built: the exact byte count the
    // wire must carry for zero loss.
    let expectedBytes = 0
    const smallFrame = (index: number): Uint8Array => {
      const payload = new TextEncoder().encode(`m${index}:${'x'.repeat(40)}\n`)
      expectedBytes += 5 + payload.byteLength
      return frame(1, payload)
    }
    const bigFrame = (index: number): Uint8Array => {
      const payload = new Uint8Array(BIG_BYTES)
      const view = new DataView(payload.buffer)
      view.setUint32(0, index, false)
      for (let offset = 4; offset < BIG_BYTES; offset += 1) payload[offset] = index & 0xff
      expectedBytes += 5 + payload.byteLength
      return frame(2, payload)
    }

    let serverWriter: ReturnType<typeof createBackpressuredSocketWriter> | null = null
    const server = Bun.listen({
      unix: socketPath,
      socket: {
        open(socket) {
          serverWriter = createBackpressuredSocketWriter(socket)
        },
        data(socket, data) {
          if (data.toString() !== 'flood' || !serverWriter) return
          for (let index = 0; index < SMALL_FRAMES; index += 1) serverWriter.send(smallFrame(index))
          for (let index = 0; index < BIG_FRAMES; index += 1) serverWriter.send(bigFrame(index))
        },
        drain() {
          serverWriter?.notifyDrain()
        },
        error() {},
        close() {},
      },
    })
    try {
      const received = await collectStream(
        socketPath,
        (state) => expectedBytes > 0 && state.frames.length >= TOTAL_FRAMES,
        60_000
      )
      expect(received.bytes).toBe(expectedBytes)
      // Walk the received stream and verify every frame's content in order.
      let smallSeen = 0
      let bigSeen = 0
      for (const wireFrame of received.frames) {
        if (wireFrame.channel === 1) {
          const text = new TextDecoder().decode(wireFrame.payload)
          expect(text.startsWith(`m${smallSeen}:`)).toBe(true)
          smallSeen += 1
        } else {
          expect(wireFrame.payload.byteLength).toBe(BIG_BYTES)
          const view = new DataView(wireFrame.payload.buffer, wireFrame.payload.byteOffset, 4)
          expect(view.getUint32(0, false)).toBe(bigSeen)
          bigSeen += 1
        }
      }
      expect(smallSeen).toBe(SMALL_FRAMES)
      expect(bigSeen).toBe(BIG_FRAMES)
    } finally {
      server.stop(true)
      rmSync(socketPath, { force: true })
    }
  }, 90_000)

  test('the queue bound is explicit: overflow fails the connection closed, never drops mid-stream', async () => {
    const socketPath = join(tmpdir(), `adea-writer-overflow-${randomUUID()}.sock`)
    // The reader never reads: the kernel buffer fills, the queue takes over.
    const overflows: SocketWriterOverflowReason[] = []
    const pendingSamples: number[] = []
    let writer: ReturnType<typeof createBackpressuredSocketWriter> | null = null
    const server = Bun.listen({
      unix: socketPath,
      socket: {
        open(socket) {
          writer = createBackpressuredSocketWriter(socket, {
            maxQueuedBytes: 4096,
            drainPollMs: 1,
            onOverflow: (reason) => overflows.push(reason),
          })
        },
        data() {},
        drain() {
          writer?.notifyDrain()
        },
        error() {},
        close() {},
      },
    })
    try {
      let peerClosed = false
      const client = await Bun.connect({
        unix: socketPath,
        socket: {
          data() {},
          error() {},
          close() {
            peerClosed = true
          },
        },
      })
      // Send far past kernel buffer + queue bound; sample the bound as it fills.
      let overflowed = false
      for (let index = 0; index < 512 && !overflowed; index += 1) {
        writer?.send(new Uint8Array(1024).fill(index & 0xff))
        pendingSamples.push(writer?.pendingBytes() ?? 0)
        overflowed = writer?.isClosed() ?? false
      }
      expect(overflows).toEqual(['queue_overflow'])
      expect(overflowed).toBe(true)
      expect(pendingSamples.length).toBeGreaterThan(0)
      expect(Math.max(...pendingSamples)).toBeLessThanOrEqual(4096)
      // The peer observes an explicit close, not a silently corrupted stream.
      expect(await waitFor(() => peerClosed, 5_000)).toBe(true)
      expect(writer?.pendingBytes()).toBe(0)
      client.end()
    } finally {
      server.stop(true)
      rmSync(socketPath, { force: true })
    }
  }, 30_000)
})

// ── 2 + 3. the real sidecar entries, flooded through a real PTY ────────────

type FloodOutcome = {
  frames: number
  seqsContiguous: boolean
  firstSeq: string | null
  lastSeq: string | null
  totalBytes: number
  longestXRun: number
  decoderError: string | null
}

async function floodSidecarEntry(entry: string, bun: string, runArg: boolean): Promise<FloodOutcome> {
  const dataDir = mkdtempSync(join(tmpdir(), 'adea-transport-flood-'))
  const argv = runArg ? [bun, 'run', entry, '--data-dir', dataDir] : [bun, entry, '--data-dir', dataDir]
  const child = Bun.spawn(argv, {
    env: {
      ...process.env,
      ADEA_SIDECAR_VERSION: 'flood-test',
      ADEA_SIDECAR_IDENTITY: 'adea-terminal-sidecar@flood-test',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  })
  try {
    let endpoint = null as ReturnType<typeof readEndpointFile>
    const readyDeadline = Date.now() + 15_000
    while (!endpoint && Date.now() < readyDeadline) {
      endpoint = readEndpointFile(dataDir)
      if (!endpoint) await Bun.sleep(100)
    }
    if (!endpoint) throw new Error('flood sidecar never published its endpoint')

    // The real client transport (fixtures/unix-connect → socket-writer), with
    // decoder throws captured so misalignment becomes an assertion, not noise.
    let decoderError: string | null = null
    const raw: ByteDuplex = await connectUnix(endpoint.socketPath)
    const duplex: ByteDuplex = {
      send: (bytes) => raw.send(bytes),
      onData: (callback) =>
        raw.onData((bytes) => {
          try {
            callback(bytes)
          } catch (cause) {
            decoderError ??= cause instanceof Error ? cause.message : String(cause)
          }
        }),
      onClose: (callback) => raw.onClose(callback),
      close: () => raw.close(),
    }
    const connected = await connectSidecarClient({
      duplex,
      scope: SCOPE,
      credential: endpoint.credential,
      nonce: randomBytes(16).toString('hex'),
    })
    if (!connected.ok) throw new Error(`flood connect failed: ${connected.message}`)
    const client: SidecarClient = connected.client

    const terminalId = randomUUID()
    const created = await client.create({
      terminalId,
      generation: 1,
      cols: 120,
      rows: 40,
      cwd: dataDir,
      // NO_RCS: deterministic, fast startup — user dotfiles must not steer a
      // transport regression test (their output also pollutes the stream).
      shell: '/bin/zsh',
      args: ['-f'],
    })
    if (!created.ok) throw new Error(`flood create failed: ${created.message}`)

    const seqs: bigint[] = []
    let totalBytes = 0
    // Incremental longest-run-of-'x' tracker: O(total) across the whole flood
    // and constant memory, so the test client never becomes a slow reader
    // that backpressures the transport it is measuring.
    let longestXRun = 0
    let carriedXRun = 0
    client.setEvents({
      onDataFrame: (meta, bytes) => {
        seqs.push(BigInt(meta.seq))
        totalBytes += bytes.byteLength
        let run = carriedXRun
        for (let index = 0; index < bytes.byteLength; index += 1) {
          if (bytes[index] === 0x78) {
            run += 1
            if (run > longestXRun) longestXRun = run
          } else {
            run = 0
          }
        }
        carriedXRun = run
        void client.acknowledge(terminalId, 'flood', bytes.byteLength)
      },
    })
    const attached = await client.attach({ terminalId, subscriberId: 'flood', sinceSeq: '0' })
    if (!attached.ok) throw new Error(`flood attach failed: ${attached.message}`)

    await client.writeInput(
      terminalId,
      new TextEncoder().encode(`head -c ${FLOOD_BYTES} /dev/zero | tr "\\0" "x"\n`)
    )

    // Deadline-based wait for the full flood. The budget follows the
    // real-process lane convention (packaged-terminal-replay uses 300s): the
    // flood is multi-megabyte through a real PTY and socket pair on a
    // possibly loaded machine.
    const deadline = Date.now() + 240_000
    while (Date.now() < deadline) {
      if (decoderError !== null) break
      if (longestXRun >= FLOOD_BYTES) {
        // Settle: trailing frames (newline, prompt) still in flight.
        await Bun.sleep(500)
        break
      }
      await Bun.sleep(50)
    }

    let seqsContiguous = true
    for (let index = 1; index < seqs.length; index += 1) {
      if (seqs[index] !== seqs[index - 1]! + 1n) {
        seqsContiguous = false
        break
      }
    }
    const outcome: FloodOutcome = {
      frames: seqs.length,
      seqsContiguous,
      firstSeq: seqs.length > 0 ? seqs[0]!.toString() : null,
      lastSeq: seqs.length > 0 ? seqs[seqs.length - 1]!.toString() : null,
      totalBytes,
      longestXRun,
      decoderError,
    }
    client.close()
    return outcome
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill()
      const exited = await Promise.race([
        child.exited.then(
          () => true,
          () => false
        ),
        Bun.sleep(3_000).then(() => false),
      ])
      if (!exited) {
        child.kill('SIGKILL')
        await Promise.race([child.exited, Bun.sleep(1_000)])
      }
    }
    rmSync(dataDir, { recursive: true, force: true })
  }
}

describe.skipIf(process.platform !== 'darwin')('sidecar transport flood (dev entry)', () => {
  test(
    'a multi-megabyte PTY flood arrives complete and in exact frame order',
    async () => {
      const outcome = await floodSidecarEntry(
        join(import.meta.dir, '../shell/src/dev-runtime/terminal/sidecar/entry.ts'),
        process.execPath,
        true
      )
      // The numbers ARE the evidence: a fire-and-forget transport shows a
      // short run and a decoder misalignment here.
      console.log('dev-entry flood outcome:', JSON.stringify(outcome))
      expect(outcome.decoderError).toBeNull()
      expect(outcome.seqsContiguous).toBe(true)
      expect(outcome.longestXRun).toBeGreaterThanOrEqual(FLOOD_BYTES)
      expect(outcome.frames).toBeGreaterThan(0)
    },
    300_000
  )
})

const packagedBundle = join(import.meta.dir, '../shell/build/dev-macos-arm64/Adea-dev.app')
const packagedEntry = join(packagedBundle, 'Contents/Resources/app/dev-runtime-sidecar/entry.js')
const packagedBun = join(packagedBundle, 'Contents/MacOS/bun')

describe.skipIf(process.platform !== 'darwin' || !existsSync(packagedEntry))(
  'sidecar transport flood (packaged entry)',
  () => {
    test(
      'the packaged entry survives the same multi-megabyte PTY flood',
      async () => {
        const outcome = await floodSidecarEntry(packagedEntry, packagedBun, false)
        expect(outcome.decoderError).toBeNull()
        expect(outcome.seqsContiguous).toBe(true)
        expect(outcome.longestXRun).toBeGreaterThanOrEqual(FLOOD_BYTES)
        expect(outcome.frames).toBeGreaterThan(0)
      },
      300_000
    )
  }
)

// ── helpers ──────────────────────────────────────────────────────────────────

/** Polls `predicate` until it holds or the budget expires. */
async function waitFor(predicate: () => boolean, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (!predicate() && Date.now() < deadline) await Bun.sleep(25)
  return predicate()
}

/** One framed record on the wire: u32 big-endian length + u8 channel + payload. */
function frame(channel: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.byteLength)
  const view = new DataView(out.buffer)
  view.setUint32(0, payload.byteLength + 1, false)
  out[4] = channel
  out.set(payload, 5)
  return out
}

type WireFrame = { channel: number; payload: Uint8Array }

/** Connects a raw reader, requests the flood, and collects until `done` holds. */
async function collectStream(
  socketPath: string,
  done: (state: { frames: WireFrame[]; bytes: number }) => boolean,
  budgetMs: number
): Promise<{ bytes: number; frames: WireFrame[] }> {
  let buffer = new Uint8Array(0)
  const frames: WireFrame[] = []
  let bytes = 0
  const client = await Bun.connect({
    unix: socketPath,
    socket: {
      data(_socket, data) {
        const merged = new Uint8Array(buffer.byteLength + data.byteLength)
        merged.set(buffer)
        merged.set(new Uint8Array(data), buffer.byteLength)
        buffer = merged
        for (;;) {
          if (buffer.byteLength < 5) break
          const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
          const length = view.getUint32(0, false)
          if (buffer.byteLength < 4 + length) break
          frames.push({
            channel: buffer[4]!,
            payload: buffer.subarray(5, 4 + length),
          })
          buffer = buffer.slice(4 + length)
          bytes += 4 + length
        }
      },
      error() {},
      close() {},
    },
  })
  client.write('flood')
  await waitFor(() => done({ frames, bytes }), budgetMs)
  client.end()
  return { bytes, frames }
}

afterAll(() => {
  // Flood lanes clean their own temp dirs; nothing retained by design.
})
