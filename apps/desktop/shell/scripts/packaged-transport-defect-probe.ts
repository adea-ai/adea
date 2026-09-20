// Transport-defect probe for the terminal sidecar socket (finding of the
// M12 packaged evidence lane, Wave E session 21; handoff to the #396
// owners). It demonstrates and quantifies the defect that blocks below-ring
// durable-bridge replay and any large burst on the sidecar's framed unix
// stream:
//
//   1. Bun's unix `socket.write()` does not queue reliably: once the send
//      buffer is full, writes issued faster than the peer drains are DROPPED
//      silently (pure Bun sockets, no Adea code on the wire);
//   2. the sidecar's `SocketDuplex.send` (shell/src/dev-runtime/terminal/
//      sidecar/entry.ts) never checks writability/backpressure, and the
//      service publishes subscriber frames with fire-and-forget writes —
//      so any output burst larger than the buffer (a 6 MiB flood, a whole
//      ring replay) drops bytes mid-frame and the client's frame decoder
//      misaligns ("sidecar frame exceeds the maximum size").
//
// Reproduced against BOTH the dev entry (source) and the packaged entry
// (Adea-dev.app/Contents/Resources/app/dev-runtime-sidecar/entry.js on the
// bundled Bun runtime) — it is a pre-existing transport defect, not a
// packaging artifact. The packaged replay smoke
// (packaged-terminal-smoke.ts) stays inside the proven burst envelope and
// documents everything that remains blocked until this is fixed. Fix
// direction (owner to verify): serialize writes and honor writability
// (e.g. check socket.buffered / await drain, or move the framed stream to
// a transport that queues) in SocketDuplex + the sidecar client duplex.
//
// Usage: bun apps/desktop/shell/scripts/packaged-transport-defect-probe.ts [--artifact <path>]
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'

const SCOPE = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

/** One framed record on the probe's wire: u32 big-endian length + 1 + payload. */
function frame(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.byteLength)
  const view = new DataView(out.buffer)
  view.setUint32(0, payload.byteLength + 1, false)
  out[4] = 1
  out.set(payload, 5)
  return out
}

/** Proof 1 — pure Bun unix socket: a server burst of 20,000 small framed
 *  writes against a reading client. Counts what survives. */
async function pureSocketBurstLoss(): Promise<{
  sent: number
  receivedCleanFrames: number
  receivedBytes: number
  misaligned: boolean
}> {
  const path = join(tmpdir(), `adea-socket-probe-${randomBytes(4).toString('hex')}.sock`)
  const encoder = new TextEncoder()
  const SENT = 20_000
  const server = Bun.listen({
    unix: path,
    socket: {
      open(socket) {
        for (let index = 0; index < SENT; index += 1) {
          socket.write(frame(encoder.encode(`m${index}:${'x'.repeat(40)}\n`)))
        }
      },
      data() {},
      error() {},
      close() {},
    },
  })
  let bytes = 0
  let frames = 0
  let misaligned = false
  let buffer = new Uint8Array(0)
  const client = await Bun.connect({
    unix: path,
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
          if (length > 1024 * 1024) {
            misaligned = true
            return
          }
          if (buffer.byteLength < 4 + length) break
          const payload = buffer.subarray(5, 4 + length)
          bytes += payload.byteLength
          frames += 1
          buffer = buffer.slice(4 + length)
        }
      },
      error() {},
      close() {},
    },
  })
  await Bun.sleep(3_000)
  client.end()
  server.stop(true)
  try {
    rmSync(path, { force: true })
  } catch {
    // socket file cleanup is best-effort
  }
  return { sent: SENT, receivedCleanFrames: frames, receivedBytes: bytes, misaligned }
}

type SidecarFloodResult = {
  sidecar: 'dev-entry' | 'packaged-entry'
  appBundle: string | null
  floodLines: number
  cleanFramesWalked: number
  wireBytesObserved: number
  misalignedAtOffset: number | null
  claimedLengthAtMisalignment: number | null
  decoderError: string | null
}

/** Proof 2 — the real sidecar: flood a PTY to an attached subscriber and
 *  record exactly where the framed stream misaligns. */
async function sidecarFloodMisalignment(
  sidecar: 'dev-entry' | 'packaged-entry',
  appBundle: string | null
): Promise<SidecarFloodResult> {
  const ROOT = join(import.meta.dir, '..', '..', '..', '..')
  const dataDir = mkdtempSync(join(tmpdir(), 'adea-transport-probe-'))
  const entry =
    sidecar === 'packaged-entry' && appBundle
      ? join(appBundle, 'Contents/Resources/app/dev-runtime-sidecar/entry.js')
      : join(ROOT, 'apps/desktop/shell/src/dev-runtime/terminal/sidecar/entry.ts')
  const bun =
    sidecar === 'packaged-entry' && appBundle
      ? join(appBundle, 'Contents/MacOS/bun')
      : process.execPath
  const proc = Bun.spawn([bun, entry, '--data-dir', dataDir], {
    env: {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      SHELL: process.env.SHELL,
      ADEA_SIDECAR_VERSION: 'probe',
      ADEA_SIDECAR_IDENTITY: 'adea-terminal-sidecar@probe',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  })
  const { readEndpointFile } = await import(
    join(ROOT, 'apps/desktop/shell/src/dev-runtime/terminal/sidecar/endpoint-file.ts')
  )
  let endpoint = null
  for (let attempt = 0; attempt < 50 && !endpoint; attempt += 1) {
    endpoint = readEndpointFile(dataDir)
    if (!endpoint) await Bun.sleep(100)
  }
  if (!endpoint) throw new Error('probe sidecar never published its endpoint')
  const rawPath = join(dataDir, 'raw-inbound.bin')
  const raw: number[] = []
  const dataCallbacks = new Set<(bytes: Uint8Array) => void>()
  const socket = await Bun.connect({
    unix: endpoint.socketPath,
    socket: {
      data(_socket, data) {
        for (let index = 0; index < data.byteLength; index += 1) raw.push(data[index])
        for (const callback of dataCallbacks) callback(new Uint8Array(data))
      },
      error() {},
      close() {},
    },
  })
  const { connectSidecarClient } = await import(
    join(ROOT, 'apps/desktop/shell/src/dev-runtime/terminal/sidecar/client.ts')
  )
  void connectSidecarClient
  let decoderError: string | null = null
  const connected = await connectSidecarClient({
    duplex: {
      send: (bytes: Uint8Array) => socket.write(bytes),
      onData: (callback: (bytes: Uint8Array) => void) => {
        dataCallbacks.add((bytes) => {
          try {
            callback(bytes)
          } catch (error) {
            decoderError ??= error instanceof Error ? error.message : String(error)
          }
        })
        return () => undefined
      },
      onClose: () => () => undefined,
      close: () => socket.end(),
    },
    scope: SCOPE,
    credential: endpoint.credential,
    nonce: randomBytes(16).toString('hex'),
    onDataFrame: () => undefined,
  })
  const result: SidecarFloodResult = {
    sidecar,
    appBundle: sidecar === 'packaged-entry' ? appBundle : null,
    floodLines: 524_288,
    cleanFramesWalked: 0,
    wireBytesObserved: 0,
    misalignedAtOffset: null,
    claimedLengthAtMisalignment: null,
    decoderError,
  }
  if (!connected.ok) {
    proc.kill('SIGKILL')
    rmSync(dataDir, { recursive: true, force: true })
    result.decoderError = `connect failed: ${connected.message}`
    return result
  }
  const client = connected.client
  const terminalId = randomUUID()
  await client.create({
    terminalId,
    generation: 1,
    cols: 120,
    rows: 40,
    cwd: dataDir,
    shell: process.env.SHELL ?? '/bin/zsh',
    args: [],
  })
  try {
    await client.attach({ terminalId, subscriberId: 'probe', sinceSeq: '0' })
    await client.writeInput(
      terminalId,
      new TextEncoder().encode('head -c 524288 /dev/zero | tr "\\0" "x"\n')
    )
    const deadline = Date.now() + 8_000
    while (Date.now() < deadline) {
      if (decoderError !== null) break
      await Bun.sleep(200)
    }
    await Bun.sleep(500)
  } catch {
    // a corrupt stream also breaks request correlation; the raw walk below
    // is the evidence
  } finally {
    client.close()
    proc.kill('SIGKILL')
  }
  // Walk the captured wire stream with the same framing the decoder uses.
  const wire = Buffer.from(raw)
  result.wireBytesObserved = wire.byteLength
  let position = 0
  while (position + 5 <= wire.byteLength) {
    const length = wire.readUInt32BE(position)
    if (length > 64 * 1024 * 1024 || position + 4 + length > wire.byteLength) {
      result.misalignedAtOffset = position
      result.claimedLengthAtMisalignment = length
      break
    }
    position += 4 + length
    result.cleanFramesWalked += 1
  }
  try {
    writeFileSync(rawPath, wire, { mode: 0o600 })
  } catch {
    // artifact retention is best-effort
  }
  rmSync(dataDir, { recursive: true, force: true })
  return result
}

async function main(): Promise<number> {
  if (process.platform !== 'darwin') {
    console.error('packaged-transport-defect-probe: darwin-only (real PTY line)')
    return 2
  }
  const startedAt = new Date().toISOString()
  const artifactPath = argValue('--artifact') ?? 'artifacts/packaged/terminal-transport-defect.json'
  const appBundle =
    argValue('--app-bundle') ??
    join(import.meta.dir, '..', 'build', 'dev-macos-arm64', 'Adea-dev.app')

  console.log('PROBE 1 pure Bun unix socket: burst of 20,000 framed writes vs a reading client')
  const socket = await pureSocketBurstLoss()
  const socketLost = socket.sent - socket.receivedCleanFrames
  console.log(
    `  sent=${socket.sent} receivedCleanFrames=${socket.receivedCleanFrames} lostOrNeverDelivered=${socketLost} misaligned=${socket.misaligned}`
  )

  console.log('PROBE 2 sidecar flood: framed stream walk on the captured wire bytes')
  const dev = await sidecarFloodMisalignment('dev-entry', null)
  console.log(
    `  dev-entry: cleanFrames=${dev.cleanFramesWalked} wireBytes=${dev.wireBytesObserved} misalignedAt=${dev.misalignedAtOffset} claimedLen=${dev.claimedLengthAtMisalignment} decoderError=${dev.decoderError}`
  )
  let packaged: SidecarFloodResult | null = null
  try {
    readFileSync(join(appBundle, 'Contents/Resources/app/dev-runtime-sidecar/entry.js'))
    packaged = await sidecarFloodMisalignment('packaged-entry', appBundle)
    console.log(
      `  packaged-entry: cleanFrames=${packaged.cleanFramesWalked} wireBytes=${packaged.wireBytesObserved} misalignedAt=${packaged.misalignedAtOffset} claimedLen=${packaged.claimedLengthAtMisalignment} decoderError=${packaged.decoderError}`
    )
  } catch {
    console.log('  packaged-entry: bundle not found; skipped (run the packaged lane first)')
  }

  writeFileSync(
    artifactPath,
    JSON.stringify(
      {
        lane: 'terminal-transport-defect-probe',
        issue: '396',
        finding:
          'Bun unix socket.write() drops writes once the send buffer is full; the sidecar ' +
          'SocketDuplex.send and the sidecar client duplex never check writability, so any ' +
          'output burst larger than the socket buffer (sustained PTY output, below-ring ' +
          'durable-bridge replay, whole-ring replay) silently drops bytes mid-frame and ' +
          'misaligns the framed stream. Fix direction: serialize writes and honor drain/' +
          'writability in SocketDuplex (entry.ts) and the client duplex.',
        reproducedOn: ['dev entry (source tree)', 'packaged entry (Adea-dev.app bundled Bun)'],
        blockedEvidence:
          'below-ring durable bridge replay (attach with sinceSeq below ring coverage) — ' +
          'the bridge burst exceeds the buffer and corrupts; see packaged-terminal-smoke.ts',
        startedAt,
        finishedAt: new Date().toISOString(),
        bun: process.versions.bun,
        command:
          'bun apps/desktop/shell/scripts/packaged-transport-defect-probe.ts --app-bundle <Adea-dev.app>',
        pureSocket: socket,
        pureSocketLostFrames: socketLost,
        sidecarFlood: { dev, packaged },
      },
      null,
      2
    ) + '\n',
    { mode: 0o600 }
  )
  console.log(`artifact: ${artifactPath}`)
  const defectShown =
    socketLost > 0 &&
    dev.misalignedAtOffset !== null &&
    (packaged === null || packaged.misalignedAtOffset !== null)
  if (defectShown) {
    console.log('TRANSPORT-DEFECT PROBE: defect reproduced (this is the expected outcome)')
    return 0
  }
  console.log(
    'TRANSPORT-DEFECT PROBE: defect NOT reproduced (transport may be fixed — update the lane)'
  )
  return 1
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error('TRANSPORT-DEFECT-PROBE ERROR', error)
    process.exit(1)
  })
