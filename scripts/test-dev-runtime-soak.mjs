// Named M12 soak lane for the Dev Runtime (#426): replays the terminal-channel
// suite for ADEA_DEV_RUNTIME_SOAK_ROUNDS rounds (default 20, the short local
// verification; the 24-hour acceptance soak raises the count) to surface
// descriptor/listener/memory accumulation. Exits nonzero on the first failing
// round, after writing its retained summary artifact.
//
// The lane also demonstrates bounded storage with real measured sizes (#424
// evidence box): before the rounds it drives the terminal checkpoint store at
// the real 256 MiB/session retention cap until retention must evict (bytes on
// disk measured after feeding more than the cap — the write volume is the
// acceleration, the cap and the production store are not), and drives the
// metrics history until the 720-point/24-hour caps bind (stored JSON size
// measured before/after extra samples). A probe failure fails the lane.
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

import { writeLaneSummary } from './dev-runtime-lane-report.mjs'
import { createCheckpointSink } from '../apps/desktop/shell/src/dev-runtime/terminal/checkpoints.ts'
import {
  CHECKPOINT_RETENTION,
  listSealedSegments,
} from '../apps/desktop/shell/src/dev-runtime/terminal/retention.ts'
import {
  createMetricsHistory,
  HISTORY_WINDOW_MS,
  MAX_POINTS_PER_OWNER,
} from '../apps/desktop/shell/src/dev-runtime/resources/metrics.ts'

const startedAt = new Date()
const command = 'bun run test:soak:dev-runtime'
const rounds = Number(process.env.ADEA_DEV_RUNTIME_SOAK_ROUNDS ?? 20)
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 1000) {
  console.error('ADEA_DEV_RUNTIME_SOAK_ROUNDS must be an integer from 1 to 1000')
  process.exit(2)
}

/** Terminal checkpoint retention at the REAL per-session cap: feed more than
 * 256 MiB through the production sink (real checksummed segments, atomic
 * renames, per-write retention passes) and measure what survived on disk —
 * the bound must hold in measured bytes, not just in named constants. */
function probeCheckpointRetention() {
  const probeStart = performance.now()
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'adea-soak-storage-'))
  try {
    const terminalId = randomUUID()
    const sink = createCheckpointSink({ runtimeRoot, terminalId, generation: 1 })
    const chunk = new Uint8Array(64 * 1024)
    chunk.fill(0x5a)
    const bytesToFeed = CHECKPOINT_RETENTION.maxBytesPerSession + 8 * 1024 * 1024
    let fedBytes = 0
    let seq = 0
    while (fedBytes < bytesToFeed) {
      seq += 1
      sink.append({ seq: String(seq), emittedAt: new Date(1_000).toISOString(), bytes: chunk })
      fedBytes += chunk.byteLength
    }
    const flushed = sink.checkpoint()
    if (!flushed.ok) throw new Error(`checkpoint flush failed: ${flushed.error.message}`)
    const segments = listSealedSegments(join(runtimeRoot, terminalId))
    const bytesOnDisk = segments.reduce((total, segment) => total + segment.size, 0)
    if (bytesOnDisk > CHECKPOINT_RETENTION.maxBytesPerSession)
      throw new Error(
        `checkpoint retention exceeded the ${CHECKPOINT_RETENTION.maxBytesPerSession}-byte session cap: ${bytesOnDisk} bytes on disk`
      )
    if (bytesOnDisk >= fedBytes)
      throw new Error(
        `checkpoint storage is not bounded: ${bytesOnDisk} bytes retained for ${fedBytes} bytes fed`
      )
    if (segments.length === 0 || sink.latestSequence() === '0')
      throw new Error('retention left no durable anchor; replay would be empty')
    const tail = sink.read(sink.latestSequence())
    if (tail.length === 0) throw new Error('durable replay after retention returned no chunks')
    console.log(
      `soak storage probe passed: fed ${(fedBytes / 1024 / 1024).toFixed(0)}MiB through the ` +
        `checkpoint sink, ${(bytesOnDisk / 1024 / 1024).toFixed(1)}MiB survived on disk ` +
        `(${segments.length} segments, cap ${(
          CHECKPOINT_RETENTION.maxBytesPerSession /
          1024 /
          1024
        ).toFixed(0)}MiB), replay tail ${tail.length} chunks`
    )
    return {
      capBytesPerSession: CHECKPOINT_RETENTION.maxBytesPerSession,
      fedBytes,
      bytesOnDiskAfter: bytesOnDisk,
      retainedSegments: segments.length,
      newestDurableSequence: sink.latestSequence(),
      replayTailChunks: tail.length,
      probeMs: Number((performance.now() - probeStart).toFixed(0)),
    }
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true })
  }
}

/** Metrics history bounds at the named constants: push one owner far past
 * the 720-point cap and across the 24-hour window, measuring the serialized
 * history before/after — storage must not grow once the caps bind. */
function probeMetricsHistoryBound() {
  const probeStart = performance.now()
  let clock = 1_000_000
  const history = createMetricsHistory({ now: () => clock })
  const owner = {
    ownerId: 'soak-owner',
    processRecordId: 'soak-owner',
    runtimeSessionId: 'soak-session',
  }
  let cpuSeconds = 1
  const record = () => {
    clock += 1_000
    cpuSeconds += 0.5
    history.recordSample(owner, { pid: 1, cpuSeconds, residentBytes: 1024 + (seq % 64) })
  }
  let seq = 0
  const feed = (count) => {
    for (let index = 0; index < count; index += 1) {
      seq += 1
      record()
    }
  }
  feed(MAX_POINTS_PER_OWNER + 500)
  const pointsAtCap = history.list()
  if (pointsAtCap.length !== MAX_POINTS_PER_OWNER)
    throw new Error(
      `metrics history exceeded the ${MAX_POINTS_PER_OWNER}-point cap: ${pointsAtCap.length} points`
    )
  const jsonBytesAtCap = JSON.stringify(pointsAtCap).length
  feed(500)
  const pointsAfterExtra = history.list()
  if (pointsAfterExtra.length !== MAX_POINTS_PER_OWNER)
    throw new Error(
      `metrics history grew past the cap after extra samples: ${pointsAfterExtra.length} points`
    )
  const jsonBytesAfterExtra = JSON.stringify(pointsAfterExtra).length
  clock += HISTORY_WINDOW_MS + 1
  feed(1)
  const pointsAtWindow = history.list()
  const horizonIso = new Date(clock - HISTORY_WINDOW_MS).toISOString()
  if (pointsAtWindow.some((point) => point.observedAt < horizonIso))
    throw new Error('metrics history kept points older than the 24-hour window')
  console.log(
    `soak metrics probe passed: 1,721 samples pruned to exactly ${pointsAtCap.length} points ` +
      `(serialized ${jsonBytesAtCap} → ${jsonBytesAfterExtra} bytes after 500 more samples), ` +
      `24h window held after a full-window clock jump`
  )
  return {
    maxPointsPerOwner: MAX_POINTS_PER_OWNER,
    samplesFed: seq,
    storedPointsAtCap: pointsAtCap.length,
    storedPointsAfterExtra: pointsAfterExtra.length,
    serializedBytesAtCap: jsonBytesAtCap,
    serializedBytesAfterExtra: jsonBytesAfterExtra,
    windowMs: HISTORY_WINDOW_MS,
    probeMs: Number((performance.now() - probeStart).toFixed(0)),
  }
}

let storage = {}
let probeFailure = null
try {
  storage = {
    checkpoint: probeCheckpointRetention(),
    metrics: probeMetricsHistoryBound(),
  }
} catch (error) {
  probeFailure = error instanceof Error ? error.message : String(error)
  console.error(`soak storage probe failed: ${probeFailure}`)
}

const roundDurationsMs = []
let failure = probeFailure ? { round: 0, exitCode: 1 } : null
if (!failure) {
  for (let round = 1; round <= rounds; round += 1) {
    const roundStart = performance.now()
    const result = spawnSync(
      'bun',
      ['test', '--timeout', '120000', 'apps/desktop/tests/terminal-channel.test.ts'],
      {
        stdio: 'inherit',
      }
    )
    roundDurationsMs.push(Math.round(performance.now() - roundStart))
    if (result.status !== 0) {
      console.error(`Dev Runtime soak failed on round ${round}/${rounds}`)
      failure = { round, exitCode: result.status ?? 1 }
      break
    }
  }
}

await writeLaneSummary('soak', {
  command,
  status: failure ? 'failed' : 'passed',
  startedAt,
  details: {
    rounds: failure ? failure.round : rounds,
    requestedRounds: rounds,
    exitCode: failure ? failure.exitCode : 0,
    roundDurationsMs,
    storage,
    ...(probeFailure ? { storageProbeError: probeFailure } : {}),
  },
})
process.exit(failure ? failure.exitCode : 0)
