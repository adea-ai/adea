// Named M12 #538 terminal endurance lane: a bounded, real-sidecar terminal
// soak. It drives continuous PTY output floods, checkpoint churn, resize
// storms, attach/detach churn, a deliberate no-ack slow-subscriber phase, and
// a mid-stream SIGKILL → restart → durable replay verification through the
// REAL detached sidecar process on a real unix socket and a real Bun PTY
// (macOS/Linux only).
//
// What it asserts (bounded local evidence; the packaged 24-hour gate stays
// open until that run exists):
// - zero lost bytes (E5): every emitted producer record arrives exactly once
//   with an exact fixed-width payload, per-round received bytes stay inside a
//   tight envelope of the expected volume, chunk sequences are contiguous for
//   the primary subscriber, and the durable chain replays a byte-exact prefix
//   of the live stream (incremental SHA-256 digests; bytes are never held in
//   memory whole);
// - bounded memory: the sidecar process RSS is sampled throughout and the
//   session's durable byte total never exceeds the spec cap (256 MiB/session
//   plus bounded in-flight slack), which keeps retention GC churning under
//   multi-gigabyte cumulative production;
// - deterministic replay/resync anchors: below-ring attach probes resolve to
//   the identical anchor on every retry, the mid-stream high-water produces
//   exactly one resync notice per gap (no storm), and the anchor equals the
//   live ring's oldest sequence;
// - restart correctness: a SIGKILL mid-stream followed by a fresh sidecar
//   boot on the same data dir leaves a checksummed durable chain that
//   byte-exactly replays a prefix of the pre-crash stream, search still
//   matches the markers, and the service admits and streams a fresh terminal.
//
// Parameters (all optional):
//   ADEA_DEV_RUNTIME_TERMINAL_SOAK_ROUNDS      load rounds (default 1, max 10000)
//   ADEA_DEV_RUNTIME_TERMINAL_SOAK_DURATION_MS wall-clock budget (default 0 = rounds only, max 86400000)
//   ADEA_DEV_RUNTIME_TERMINAL_SOAK_FLOOD_LINES producer records per round (default 40000 ≈ 1.36 MiB)
//
// Run standalone (`bun scripts/dev-runtime-terminal-soak.mjs`) or as the
// real-sidecar phase of `bun run test:soak:dev-runtime`.
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

import { createCheckpointSink } from '../apps/desktop/shell/src/dev-runtime/terminal/checkpoints.ts'
import { adoptSidecar } from '../apps/desktop/shell/src/dev-runtime/terminal/sidecar/adoption.ts'
import { readEndpointFile } from '../apps/desktop/shell/src/dev-runtime/terminal/sidecar/endpoint-file.ts'
import { connectUnix } from '../apps/desktop/tests/fixtures/unix-connect.ts'

const scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const executableIdentity = 'adea-terminal-sidecar@soak'
const terminalId = '00000000-0000-4000-8000-000000000538'
const MAIN = 'soak-main'
const PAYLOAD = '0123456789abcdef'
// Spec caps (apps/desktop/shell/src/dev-runtime/terminal/limits.ts).
const DURABLE_MAX_BYTES_PER_SESSION = 256 * 1024 * 1024
const DURABLE_SLACK_BYTES = 16 * 1024 * 1024
const RECORD_BYTES = 34 // "SOAKLINE%06d|payload|\r\n" after PTY ONLCR

// A wall-clock budget governs the run when the caller gives one; an explicit
// round count is then a hard upper bound. Without this, the round cap (whose
// default is one round, and whose maximum is 10,000 ≈ 1.7h of warm rounds at
// ~0.6s each) would end a 24-hour soak long before its budget.
const roundsRequested = process.env.ADEA_DEV_RUNTIME_TERMINAL_SOAK_ROUNDS !== undefined
const rounds = roundsRequested ? Number(process.env.ADEA_DEV_RUNTIME_TERMINAL_SOAK_ROUNDS) : 1
const durationMs = Number(process.env.ADEA_DEV_RUNTIME_TERMINAL_SOAK_DURATION_MS ?? 0)
const floodLines = Number(process.env.ADEA_DEV_RUNTIME_TERMINAL_SOAK_FLOOD_LINES ?? 40_000)
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10_000) {
  console.error('ADEA_DEV_RUNTIME_TERMINAL_SOAK_ROUNDS must be an integer from 1 to 10000')
  process.exit(2)
}
if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 86_400_000) {
  console.error('ADEA_DEV_RUNTIME_TERMINAL_SOAK_DURATION_MS must be a number from 0 to 86400000')
  process.exit(2)
}
if (!Number.isInteger(floodLines) || floodLines < 100 || floodLines > 2_000_000) {
  console.error('ADEA_DEV_RUNTIME_TERMINAL_SOAK_FLOOD_LINES must be an integer from 100 to 2000000')
  process.exit(2)
}
if (process.platform !== 'darwin' && process.platform !== 'linux') {
  console.error(`terminal soak requires a POSIX PTY platform; ${process.platform} is unsupported`)
  process.exit(2)
}

const startedAt = new Date()
const laneStarted = performance.now()
const samples = []
const failures = []
const verified = []
function fail(what, detail) {
  failures.push({ what, detail })
  console.error(`TERMINAL-SOAK FAIL ${what}: ${detail}`)
}
function note(what, detail) {
  verified.push({ what, detail })
  console.log(`TERMINAL-SOAK ok ${what}: ${detail}`)
}

/**
 * What was happening when an accounting assertion failed.
 *
 * The first 24-hour attempt failed three byte/record assertions across 12,541
 * rounds — one round 2 bytes short, one round ~40 KB long carrying duplicated
 * producer records — and the summary offered nothing to separate a transport
 * defect from a subscriber that was resynced, a credit latch that fired, or a
 * machine too starved to drain its own acknowledgements. Every failure now
 * carries those facts, so the next occurrence is diagnosable instead of
 * re-guessed.
 */
const eventWindow = { acks: 0, ackMs: [], mainResyncs: 0, notices: 0 }
function resetEventWindow() {
  eventWindow.acks = 0
  eventWindow.ackMs.length = 0
  eventWindow.mainResyncs = 0
  eventWindow.notices = 0
}
function attribution() {
  const sorted = eventWindow.ackMs.toSorted((left, right) => left - right)
  return {
    acksIssued: eventWindow.acks,
    ackMaxMs: sorted.length ? sorted[sorted.length - 1] : null,
    ackP50Ms: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
    mainResyncs: eventWindow.mainResyncs,
    resyncNotices: eventWindow.notices,
  }
}

// ── sidecar process plumbing ────────────────────────────────────────────────
const entryPath = new URL(
  '../apps/desktop/shell/src/dev-runtime/terminal/sidecar/entry.ts',
  import.meta.url
).pathname
const dataDir = mkdtempSync(join(tmpdir(), 'adea-terminal-soak-'))
const runtimeRoot = join(dataDir, 'dev-runtime')

function startSidecar() {
  const child = spawn(process.execPath, ['run', entryPath, '--data-dir', dataDir], {
    env: {
      ...process.env,
      ADEA_SIDECAR_VERSION: 'soak',
      ADEA_SIDECAR_IDENTITY: executableIdentity,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // Drain pipes so a chatty child can never wedge on a full buffer.
  child.stdout.resume()
  child.stderr.resume()
  return child
}

async function waitForEndpoint(deadlineMs, expectPid) {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    const endpoint = readEndpointFile(dataDir)
    // After a SIGKILL the stale endpoint file persists until the fresh boot
    // supersedes it; only an endpoint naming the expected pid is live.
    if (endpoint && (expectPid === undefined || endpoint.pid === expectPid)) return endpoint
    if (Date.now() > deadline) return null
    await Bun.sleep(100)
  }
}

async function stopSidecar(child, graceful) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill(graceful ? 'SIGTERM' : 'SIGKILL')
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    Bun.sleep(graceful ? 5_000 : 1_000).then(() => false),
  ])
  if (exited === false) {
    try {
      child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), Bun.sleep(2_000)])
}

async function adopt(requestTimeoutMs) {
  const result = await adoptSidecar({
    dataDir,
    scope,
    expectedExecutableIdentity: executableIdentity,
    evaluateAdoption: (protocol) => (protocol.major === 1 ? 'adopt' : 'incompatible'),
    connect: (socketPath) => connectUnix(socketPath),
    ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
  })
  if (!result.ok) throw new Error(`sidecar adoption failed: ${result.code} ${result.message}`)
  return result.client
}

// ── stream accounting ───────────────────────────────────────────────────────
const received = {
  frames: 0,
  bytes: 0,
  digest: createHash('sha256'),
  lastSeq: -1n,
  contiguous: true,
  // Rolling seq→bytes window (byte-budgeted) for replay byte comparisons.
  window: new Map(),
  windowBytes: 0,
  windowLimit: 32 * 1024 * 1024,
}
let lastFrameAt = 0
const resyncNotices = []
const probeFrames = new Map() // subscriberId → Array<{seq, bytes}>
// seq → cumulative MAIN-stream bytes at that sequence's end; drives the
// bounded durable-bridge probe offset below.
const seqToCumulativeBytes = new Map()
let unackedSinceAck = 0
const pendingAcks = new Set()
let mainClient = null
let ackEnabled = true

// Text-side round scanner: producer records and sentinels are parsed from the
// PRIMARY subscriber's byte stream, cleared at each round boundary.
let streamText = ''
let activeMarker = null
let markerResolve = null

/**
 * How long the stream may deliver nothing before the lane calls it stalled.
 * Generous on purpose: the third attempt's rounds reached a p95 of 43 s and a
 * maximum of 158 s while still making progress, so a small window reports a
 * busy host as a dead stream. The finding is a stream that has *stopped*; the
 * failure message carries the silence it observed either way.
 */
const STALL_MS = 240_000

function trackFrame(meta, bytes) {
  if (meta.subscriberId === MAIN) {
    lastFrameAt = performance.now()
    received.frames += 1
    received.bytes += bytes.byteLength
    received.digest.update(bytes)
    const seq = BigInt(meta.seq)
    if (seq !== received.lastSeq + 1n && received.contiguous) {
      received.contiguous = false
      fail('live sequence continuity', `expected seq ${received.lastSeq + 1n}, got ${seq}`)
    }
    received.lastSeq = seq
    seqToCumulativeBytes.set(seq, received.bytes)
    received.window.set(seq, Buffer.from(bytes))
    received.windowBytes += bytes.byteLength
    while (received.windowBytes > received.windowLimit) {
      const oldest = received.window.keys().next().value
      received.windowBytes -= received.window.get(oldest).byteLength
      received.window.delete(oldest)
    }
    streamText += Buffer.from(bytes).toString('latin1')
    if (streamText.length > 4 * 1024 * 1024) streamText = streamText.slice(-2 * 1024 * 1024)
    if (activeMarker && streamText.includes(activeMarker) && markerResolve) {
      const resolve = markerResolve
      markerResolve = null
      resolve(true)
    }
    // Credit the producer back so the primary subscriber never crosses the
    // per-subscriber high-water; the deliberate no-ack subscriber skips this.
    unackedSinceAck += bytes.byteLength
    if (ackEnabled && unackedSinceAck >= 512 * 1024) flushAck()
    return
  }
  const bucket = probeFrames.get(meta.subscriberId)
  if (bucket) bucket.push({ seq: BigInt(meta.seq), bytes: Buffer.from(bytes) })
}

function flushAck() {
  if (unackedSinceAck === 0) return
  const count = unackedSinceAck
  unackedSinceAck = 0
  const ackStarted = performance.now()
  const ack = mainClient.acknowledge(terminalId, MAIN, count)
  eventWindow.acks += 1
  void ack.then(
    () => eventWindow.ackMs.push(performance.now() - ackStarted),
    () => eventWindow.ackMs.push(performance.now() - ackStarted)
  )
  pendingAcks.add(ack)
  void ack.then(
    () => pendingAcks.delete(ack),
    () => pendingAcks.delete(ack)
  )
}

/**
 * Wait until the primary stream has been quiet for `quietMs`, or `timeoutMs`
 * elapses. A phase's tail can still be in flight when its own marker resolves
 * (the marker proves ordering, not that the writer is done with the round's
 * accounting window), and anything that arrives after a round boundary is
 * charged to the next round: that is exactly a "duplicate producer records /
 * +N unaccounted bytes" failure with no defect behind it.
 */
async function drainQuiescent(quietMs = 1_500, timeoutMs = 60_000) {
  const deadline = performance.now() + timeoutMs
  let lastBytes = received.bytes
  let quietSince = performance.now()
  while (performance.now() < deadline) {
    await Bun.sleep(150)
    if (received.bytes !== lastBytes) {
      lastBytes = received.bytes
      quietSince = performance.now()
      continue
    }
    if (performance.now() - quietSince >= quietMs) return true
  }
  return false
}

function waitForMarker(marker, timeoutMs) {
  activeMarker = marker
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (markerResolve === resolve) markerResolve = null
      activeMarker = null
      resolve(false)
    }, timeoutMs)
    markerResolve = (seen) => {
      clearTimeout(timer)
      activeMarker = null
      resolve(seen)
    }
    if (streamText.includes(marker)) {
      clearTimeout(timer)
      markerResolve = null
      activeMarker = null
      resolve(true)
    }
  })
}

/**
 * Waits for a round's sentinel, but fails on a *stalled stream* rather than on
 * a fixed clock. A loaded machine can stretch a round past any fixed timeout
 * while still making progress — the third 24-hour attempt lost its sentinel to
 * exactly that, reporting "marker never arrived" when the truth was "this
 * machine was busy" — whereas a stream that has delivered no bytes for
 * `stallMs` is a finding whatever the wall clock says. Returns 'marker',
 * 'stalled', or 'expired'.
 */
function waitForMarkerOrStall(marker, stallMs = STALL_MS, ceilingMs = 900_000) {
  const waitStartedAt = performance.now()
  return new Promise((resolve) => {
    const tick = () => {
      if (streamText.includes(marker)) {
        finish('marker')
        return
      }
      const now = performance.now()
      // `lastFrameAt` is 0 until the first frame of the lane arrives, and
      // `now - 0` is an eternity: an unguarded comparison declared the very
      // first sentinel stalled the instant it was asked for.
      const silenceMs = lastFrameAt === 0 ? 0 : Math.round(now - lastFrameAt)
      if (silenceMs > stallMs) {
        finish('stalled')
        return
      }
      if (now - waitStartedAt > ceilingMs) {
        finish('expired')
        return
      }
      timer = setTimeout(tick, 250)
    }
    let timer = setTimeout(tick, 250)
    function finish(outcome) {
      clearTimeout(timer)
      activeMarker = null
      markerResolve = null
      resolve(outcome)
    }
    activeMarker = marker
    markerResolve = (seen) => {
      if (seen) finish('marker')
    }
  })
}

// ── producer commands ───────────────────────────────────────────────────────
function floodCommand(label) {
  return (
    `awk 'BEGIN{for(i=0;i<${floodLines};i++)` +
    `printf "SOAKLINE%06d|${PAYLOAD}|\\n",i}'` +
    `; echo "${label}"\n`
  )
}
const RECORD_PATTERN = /SOAKLINE(\d{6})\|0123456789abcdef\|\r?\n/g

async function writeProducer(text) {
  const written = await mainClient.writeInput(terminalId, new TextEncoder().encode(text))
  if (!written.ok) throw new Error(`producer writeInput rejected: ${written.code}`)
}

// ── resource sampling ───────────────────────────────────────────────────────
function sampleSidecarRss(pid) {
  try {
    const rss = Number(
      Bun.spawnSync(['ps', '-o', 'rss=', '-p', String(pid)])
        .stdout.toString()
        .trim()
    )
    return Number.isFinite(rss) && rss > 0 ? rss * 1024 : null
  } catch {
    return null
  }
}

function durableBytes() {
  let total = 0
  try {
    for (const name of readdirSync(join(runtimeRoot, terminalId))) {
      if (!name.startsWith('seg-')) continue
      try {
        total += statSync(join(runtimeRoot, terminalId, name)).size
      } catch {
        /* raced eviction */
      }
    }
  } catch {
    /* no durable history yet */
  }
  return total
}

let sampleUntil = Number.POSITIVE_INFINITY
async function sampler(pid) {
  // The main flow stops sampling by moving `sampleUntil` into the past.
  while (Date.now() < sampleUntil) {
    const rss = sampleSidecarRss(pid)
    const durable = durableBytes()
    samples.push({ at: new Date().toISOString(), rssBytes: rss, durableBytes: durable })
    if (rss !== null && rss > 1_500_000_000) {
      fail('sidecar RSS bound', `RSS sample ${rss} bytes exceeds the 1.5 GiB fail-fast bound`)
    }
    if (durable > DURABLE_MAX_BYTES_PER_SESSION + DURABLE_SLACK_BYTES) {
      fail(
        'durable session cap',
        `durable ${durable} bytes exceeds 256 MiB + ${DURABLE_SLACK_BYTES} slack`
      )
    }
    await Bun.sleep(15_000)
  }
}

// ── probes ──────────────────────────────────────────────────────────────────
let probeCount = 0
async function detachQuietly(client, subscriberId) {
  const detached = await client.detach(terminalId, subscriberId)
  if (!detached.ok) fail('probe detach', `${subscriberId}: ${detached.code} ${detached.message}`)
}

/**
 * Ring-window replay probe: attach `ringWindow` chunks behind the live edge
 * (well under the 1 MiB per-subscriber high-water) and require the replay to
 * continue the cursor exactly with byte-identical content.
 */
async function ringReplayProbe(client) {
  probeCount += 1
  const nextSeq = received.lastSeq + 1n
  const windowChunks = 12n
  if (nextSeq <= windowChunks) return
  const since = nextSeq - windowChunks
  probeFrames.set('probe-ring', [])
  const attached = await client.attach({
    terminalId,
    subscriberId: 'probe-ring',
    sinceSeq: since.toString(),
  })
  if (!attached.ok) {
    fail('ring replay probe', `${attached.code} ${attached.message}`)
  } else if (attached.value.resyncRequired) {
    fail('ring replay probe', `unexpected resync from ${since}`)
  } else {
    const frames = probeFrames.get('probe-ring')
    let expected = since
    let mismatches = 0
    for (const frame of frames) {
      if (frame.seq !== expected) {
        fail('ring replay probe', `continuity: expected seq ${expected}, got ${frame.seq}`)
        break
      }
      const cached = received.window.get(frame.seq)
      if (cached && !cached.equals(frame.bytes)) mismatches += 1
      expected += 1n
    }
    if (expected !== nextSeq) {
      fail('ring replay probe', `replayed through ${expected - 1n}, expected ${nextSeq - 1n}`)
    } else if (mismatches > 0) {
      fail('ring replay probe', `${mismatches} chunks differ from the live-received bytes`)
    } else {
      note('ring replay probe', `${frames.length} chunks byte-identical from seq ${since}`)
    }
  }
  await detachQuietly(client, 'probe-ring')
  probeFrames.delete('probe-ring')
}

/**
 * Durable-bridge probe: attach from ~6 MiB behind the live edge — older than
 * the 4 MiB ring, so the replay crosses the durable-bridge boundary — while
 * keeping the whole enqueue (bridge ≤ ~2 MiB + ring ≤ 4 MiB) under the
 * sidecar socket queue bound (8 MiB, DEFAULT_MAX_QUEUED_BYTES).
 *
 * Deliberately bounded: an UNBOUNDED below-ring attach (e.g. sinceSeq '0'
 * after the ring pruned and retention kept tens of MiB sealed) enqueues the
 * entire bridge synchronously in the sidecar's attach handler and overflows
 * the 8 MiB queue, which fails the connection closed; the shell transport
 * would reconnect and re-request the same oversized bridge. That non-
 * converging recovery loop is a product defect filed against #538 — the soak
 * probes around it and the evidence doc records it.
 */
async function durableHeadProbe(client) {
  probeCount += 1
  const nextSeq = received.lastSeq + 1n
  const spanBytes = 6 * 1024 * 1024
  if (received.bytes < 2 * spanBytes) return
  let since = 0n
  for (const [seq, cumulative] of seqToCumulativeBytes) {
    if (cumulative <= received.bytes - spanBytes && seq > since) since = seq
  }
  if (since <= 0n) return
  probeFrames.set('probe-head', [])
  const first = await client.attach({
    terminalId,
    subscriberId: 'probe-head',
    sinceSeq: since.toString(),
  })
  if (!first.ok) {
    fail('durable bridge probe', `${first.code} ${first.message}`)
  } else if (first.value.resyncRequired) {
    const second = await client.attach({
      terminalId,
      subscriberId: 'probe-head-2',
      sinceSeq: since.toString(),
    })
    if (!second.ok || !second.value.resyncRequired) {
      fail('resync anchor determinism', `retry did not resync: ${JSON.stringify(second)}`)
    } else if (second.value.checkpointSequence !== first.value.checkpointSequence) {
      fail(
        'resync anchor determinism',
        `anchors differ across retries: ${first.value.checkpointSequence} vs ${second.value.checkpointSequence}`
      )
    } else {
      note(
        'durable bridge probe',
        `pruned span resyncs from stable anchor ${first.value.checkpointSequence}`
      )
    }
    await detachQuietly(client, 'probe-head-2')
  } else {
    const frames = probeFrames.get('probe-head') ?? []
    let expected = since
    let mismatches = 0
    let compared = 0
    for (const frame of frames) {
      if (frame.seq !== expected) {
        fail('durable bridge probe', `continuity: expected seq ${expected}, got ${frame.seq}`)
        break
      }
      const cached = received.window.get(frame.seq)
      if (cached) {
        compared += 1
        if (!cached.equals(frame.bytes)) mismatches += 1
      }
      expected += 1n
    }
    if (mismatches > 0) {
      fail('durable bridge probe', `${mismatches} replayed chunks differ from the live bytes`)
    } else if (expected !== nextSeq) {
      fail('durable bridge probe', `replayed through ${expected - 1n}, expected ${nextSeq - 1n}`)
    } else {
      note(
        'durable bridge probe',
        `bridge+ring replay from seq ${since}: ${frames.length} chunks contiguous, ${compared} byte-compared against the live window`
      )
    }
  }
  await detachQuietly(client, 'probe-head')
  probeFrames.delete('probe-head')
}

let churnCount = 0
async function attachDetachChurn(client) {
  churnCount += 1
  const nextSeq = (received.lastSeq + 1n).toString()
  for (let cycle = 0; cycle < 20; cycle += 1) {
    const attached = await client.attach({
      terminalId,
      subscriberId: `churn-${cycle}`,
      sinceSeq: nextSeq,
    })
    if (!attached.ok) {
      fail('attach churn', `cycle ${cycle}: ${attached.code} ${attached.message}`)
      return
    }
    const detached = await client.detach(terminalId, `churn-${cycle}`)
    if (!detached.ok) {
      fail('detach churn', `cycle ${cycle}: ${detached.code} ${detached.message}`)
      return
    }
  }
  note('attach/detach churn', `20 cycles OK (total ${churnCount})`)
}

let stormCount = 0
async function resizeStorm(client) {
  stormCount += 1
  const sizes = [
    [80, 24],
    [200, 60],
    [120, 40],
    [310, 90],
    [80, 24],
  ]
  for (let burst = 0; burst < 8; burst += 1) {
    for (const [cols, rows] of sizes) {
      const resized = await client.resize(terminalId, cols, rows)
      if (!resized.ok) {
        fail('resize storm', `burst ${burst} ${cols}x${rows}: ${resized.code} ${resized.message}`)
        return
      }
    }
  }
  note('resize storm', `40 resizes OK (total ${stormCount})`)
}

/**
 * Slow-subscriber phase: one subscriber never acks while more than the 1 MiB
 * per-subscriber high-water streams past it. Exactly one resync notice may
 * arrive for it, and fresh output after a clearing ack must not re-notice.
 */
async function noAckResyncPhase(client, phaseIndex) {
  const marker = `SOAKSLOW ${phaseIndex} END`
  const noticesBefore = resyncNotices.length
  const nextSeq = (received.lastSeq + 1n).toString()
  const attached = await client.attach({
    terminalId,
    subscriberId: 'soak-slow',
    sinceSeq: nextSeq,
  })
  if (!attached.ok) {
    fail('slow subscriber attach', `${attached.code} ${attached.message}`)
    return
  }
  await writeProducer(floodCommand(marker))
  const done = await waitForMarker(marker, 180_000)
  if (!done) {
    fail('slow subscriber flood', 'sentinel never arrived')
    return
  }
  await drainQuiescent()
  flushAck()
  await Promise.allSettled(pendingAcks)
  const notices = resyncNotices
    .slice(noticesBefore)
    .filter((notice) => notice.subscriberId === 'soak-slow')
  if (notices.length !== 1) {
    fail('mid-stream resync', `expected exactly 1 notice for soak-slow, saw ${notices.length}`)
  } else {
    note('mid-stream resync', `1 notice for soak-slow, anchor ${notices[0].checkpointSequence}`)
  }
  // Clear the latch with a huge ack; a further record must not re-notice.
  await client.acknowledge(terminalId, 'soak-slow', 1024 * 1024 * 1024)
  const noticesAfter = resyncNotices.length
  const tailMarker = `SOAKSLOW ${phaseIndex} TAIL`
  await writeProducer(floodCommand(tailMarker))
  const tailSeen = await waitForMarker(tailMarker, 180_000)
  if (!tailSeen) {
    // Unchecked, this was invisible: the phase returned while its tail was
    // still streaming, and the next round reported the tail as thousands of
    // duplicated producer records plus tens of kilobytes of extra volume.
    fail('slow subscriber flood (tail)', `phase ${phaseIndex}: tail sentinel never arrived`)
  }
  await drainQuiescent()
  const reNotices = resyncNotices
    .slice(noticesAfter)
    .filter((notice) => notice.subscriberId === 'soak-slow')
  if (reNotices.length !== 0) {
    fail('mid-stream resync latch', `${reNotices.length} duplicate notices after the ack`)
  }
  await detachQuietly(client, 'soak-slow')
}

// ── round driver ────────────────────────────────────────────────────────────
const roundLedger = []

async function runRound(roundIndex) {
  const roundStart = performance.now()
  resetEventWindow()
  const bytesAtStart = received.bytes
  const framesAtStart = received.frames
  streamText = ''
  const marker = `SOAKROUND ${roundIndex} END`
  await writeProducer(floodCommand(marker))
  const sentinelStart = performance.now()
  const done = await waitForMarkerOrStall(marker)
  if (done !== 'marker') {
    const waitedMs = Math.round(performance.now() - sentinelStart)
    fail(
      'producer sentinel',
      `round ${roundIndex}: ${
        done === 'stalled'
          ? `the stream delivered no bytes for ${STALL_MS}ms while the sentinel was outstanding`
          : 'the sentinel did not arrive within the 900000ms ceiling'
      } (waited ${waitedMs}ms); ${JSON.stringify(attribution())}`
    )
    return null
  }
  // The byte envelope is only exact if the round's window contains the round's
  // bytes: wait for the writer to go quiet before reading the totals.
  await drainQuiescent()
  const roundText = streamText
  const records = []
  let match
  RECORD_PATTERN.lastIndex = 0
  while ((match = RECORD_PATTERN.exec(roundText)) !== null) records.push(Number(match[1]))
  if (records.length !== floodLines) {
    fail(
      'zero lost bytes (record count)',
      `round ${roundIndex}: parsed ${records.length} records, expected ${floodLines}; ` +
        JSON.stringify(attribution())
    )
  }
  if (new Set(records).size !== records.length) {
    fail(
      'zero lost bytes (duplication)',
      `round ${roundIndex}: duplicate producer records; ${JSON.stringify(attribution())}`
    )
  }
  const seen = new Set(records)
  let missing = -1
  for (let index = 0; index < floodLines; index += 1) {
    if (!seen.has(index)) {
      missing = index
      break
    }
  }
  if (missing !== -1) {
    fail('zero lost bytes (gap)', `round ${roundIndex}: record ${missing} never arrived`)
  }
  const expectedFloodBytes = floodLines * RECORD_BYTES
  const sentinelBytes = marker.length + 2
  const noise = received.bytes - bytesAtStart - expectedFloodBytes - sentinelBytes
  if (noise < 0 || noise > 128) {
    fail(
      'byte volume envelope',
      `round ${roundIndex}: ${noise} unaccounted bytes outside the ±128 envelope ` +
        `(round bytes ${received.bytes - bytesAtStart}, frames ${received.frames - framesAtStart}); ` +
        JSON.stringify(attribution())
    )
  }
  streamText = ''
  const roundMs = Math.round(performance.now() - roundStart)
  roundLedger.push({
    round: roundIndex,
    bytes: received.bytes - bytesAtStart,
    frames: received.frames - framesAtStart,
    noiseBytes: noise,
    durationMs: roundMs,
  })
  return roundMs
}

// ── crash/restart phase ─────────────────────────────────────────────────────

async function crashRestartPhase(sidecarChild) {
  console.log('TERMINAL-SOAK crash phase: checkpoint, SIGKILL, restart, durable replay')
  // Capture the seal boundary, then seal: after the checkpoint reply the
  // newest sealed segment ends exactly at this boundary, so the replay from
  // it must be byte-exact. Chunks the producer pushes between the reply and
  // the SIGKILL live in the open buffer and MAY be lost — the spec's crash
  // window. (The read is bounded: sink.read(sealBoundary.seq) materializes
  // only the final sealed span, not a multi-gigabyte history.)
  flushAck()
  await Promise.allSettled(pendingAcks)
  const checkpointed = await mainClient.checkpoint(terminalId)
  if (!checkpointed.ok) fail('pre-crash checkpoint', `${checkpointed.code} ${checkpointed.message}`)
  // Capture the boundary only after the reply: data and control frames share
  // one FIFO, so at reply time every chunk appended before the checkpoint ran
  // has already been counted, and chunks appended after it are queued behind
  // the reply. Everything ≤ this sequence is sealed on disk.
  const sealedThrough = received.lastSeq

  await stopSidecar(sidecarChild, false)
  note(
    'sidecar SIGKILL',
    `exited with signal=${String(sidecarChild.signalCode)} code=${String(sidecarChild.exitCode)}`
  )

  const restarted = startSidecar()
  const endpoint = await waitForEndpoint(15_000, restarted.pid)
  if (!endpoint) {
    fail('sidecar restart', 'no endpoint file appeared after restart')
    await stopSidecar(restarted, false)
    return
  }
  const fresh = await adopt(300_000)
  note('sidecar restart', `fresh sidecar adopted at pid ${restarted.pid}`)

  // Durable replay through the SAME sink module a shell-side re-create opens,
  // from the sealed boundary (bounded tail read; the boundary chunk itself is
  // included, so everything appended before the checkpoint is covered).
  const sink = createCheckpointSink({ runtimeRoot, terminalId, generation: 2 })
  const tail = sink.read(sealedThrough.toString())
  let mismatches = 0
  let compared = 0
  let replayBytes = 0
  let expected = sealedThrough
  for (const chunk of tail) {
    const seq = BigInt(chunk.seq)
    if (seq !== expected) {
      fail('durable chain continuity', `expected seq ${expected}, durable chunk ${seq}`)
      break
    }
    const cached = received.window.get(seq)
    if (cached) {
      compared += 1
      if (!cached.equals(Buffer.from(chunk.bytes))) mismatches += 1
    }
    replayBytes += chunk.bytes.byteLength
    expected += 1n
  }
  if (tail.length === 0 || expected - 1n < sealedThrough) {
    fail(
      'durable replay coverage',
      `durable chain does not cover the sealed boundary ${sealedThrough} (ends at ${expected - 1n})`
    )
  } else if (mismatches > 0) {
    fail('durable replay byte fidelity', `${mismatches} tail chunks differ from the live bytes`)
  } else {
    note(
      'durable replay after crash',
      `tail from the sealed boundary ${sealedThrough}: ${tail.length} chunks / ${replayBytes} bytes, ` +
        `${compared} byte-compared against the live stream (durable end ${expected - 1n})`
    )
  }

  // Search still matches the pre-crash markers on the reopened history.
  const matches = sink.search('SOAKROUND', 5)
  if (matches.length === 0) fail('post-crash search', 'no durable matches for SOAKROUND markers')
  else note('post-crash search', `${matches.length} marker matches (limit 5)`)

  // The restarted service admits a fresh terminal and streams it.
  const freshId = '00000000-0000-4000-8000-000000000539'
  const created = await fresh.create({
    terminalId: freshId,
    generation: 1,
    cols: 80,
    rows: 24,
    cwd: '/tmp',
    shell: '/bin/sh',
    args: ['-i'],
  })
  if (!created.ok) {
    fail('post-restart terminal create', `${created.code} ${created.message}`)
  } else {
    const got = []
    const previousRouter = mainClient
    void previousRouter
    fresh.setEvents({
      onDataFrame: (meta, bytes) => {
        if (meta.terminalId === freshId) got.push(Buffer.from(bytes))
      },
    })
    const attachFresh = await fresh.attach({
      terminalId: freshId,
      subscriberId: 'fresh-sub',
      sinceSeq: '0',
    })
    if (!attachFresh.ok) fail('post-restart attach', `${attachFresh.code} ${attachFresh.message}`)
    await fresh.writeInput(freshId, new TextEncoder().encode('echo ADEA-SOAK-RESTART-OK\n'))
    const deadline = Date.now() + 30_000
    let sawIt = false
    while (Date.now() < deadline && !sawIt) {
      await Bun.sleep(200)
      sawIt = got.some((buffer) => buffer.includes('ADEA-SOAK-RESTART-OK'))
    }
    if (!sawIt) fail('post-restart stream', 'echo marker never streamed back')
    else note('post-restart stream', 'echo marker streamed through the restarted sidecar')
    await fresh.terminate(freshId)
  }
  fresh.close()
  await stopSidecar(restarted, true)
}

// ── main ────────────────────────────────────────────────────────────────────
let exitCode = 0
const sidecar = startSidecar()
try {
  const endpoint = await waitForEndpoint(15_000)
  if (!endpoint) throw new Error('sidecar entry did not write an endpoint file')
  mainClient = await adopt(300_000)
  mainClient.setEvents({
    onDataFrame: (meta, bytes) => trackFrame(meta, bytes),
    onResync: (notice) => {
      resyncNotices.push(notice)
      eventWindow.notices += 1
      if (notice.subscriberId === MAIN) eventWindow.mainResyncs += 1
    },
    onExited: () => undefined,
  })
  const samplerDone = sampler(sidecar.pid)

  const created = await mainClient.create({
    terminalId,
    generation: 1,
    cols: 120,
    rows: 40,
    cwd: '/tmp',
    shell: '/bin/sh',
    args: ['-i'],
  })
  if (!created.ok) throw new Error(`producer terminal create failed: ${created.code}`)
  const attached = await mainClient.attach({ terminalId, subscriberId: MAIN, sinceSeq: '0' })
  if (!attached.ok) throw new Error(`producer attach failed: ${attached.code}`)
  await mainClient.acknowledge(terminalId, MAIN, 1024 * 1024 * 1024)

  // Disable prompt and echo so round accounting is exact. Under load the
  // shell may take a while to consume input, and until `stty -echo` runs the
  // kernel line discipline echoes every command — which would fake each
  // round's sentinel — so echo-off is confirmed before any flood round: the
  // ready marker must arrive WITHOUT the typed command appearing in the
  // stream.
  let echoOff = false
  for (let attempt = 0; attempt < 60 && !echoOff; attempt += 1) {
    streamText = ''
    await writeProducer("stty -echo; echo 'SOAKSETUP READY'\n")
    const ready = await waitForMarker('SOAKSETUP READY', 30_000)
    await Bun.sleep(200)
    echoOff = ready && !streamText.includes('stty -echo')
  }
  if (!echoOff) throw new Error('producer shell never disabled echo; round accounting impossible')
  streamText = ''

  let round = 0
  let phase = 0
  const roundCap = roundsRequested ? rounds : durationMs > 0 ? Number.MAX_SAFE_INTEGER : rounds
  while (round < roundCap) {
    round += 1
    const roundMs = await runRound(round)
    if (roundMs === null) break
    flushAck()
    if (round % 3 === 0) {
      const checkpoint = await mainClient.checkpoint(terminalId)
      if (!checkpoint.ok) fail('checkpoint churn', `round ${round}: ${checkpoint.code}`)
    }
    if (round % 5 === 0) await attachDetachChurn(mainClient)
    if (round % 7 === 0) await resizeStorm(mainClient)
    if (round % 10 === 0) await ringReplayProbe(mainClient)
    if (round % 40 === 0) await durableHeadProbe(mainClient)
    if (round % 25 === 0) {
      phase += 1
      await noAckResyncPhase(mainClient, phase)
    }
    if (durationMs > 0 && performance.now() - laneStarted >= durationMs) break
  }
  sampleUntil = 0
  await samplerDone
  await Promise.allSettled(pendingAcks)

  // A round that timed out leaves its flood still arriving; probing that stream
  // reports the abandoned round as a probe defect (the ring probe's off-by-one
  // and the resync-anchor retry were both exactly that in the third attempt).
  // Probe only a stream whose round loop ended cleanly.
  if (received.lastSeq >= 0n && failures.length === 0) {
    await drainQuiescent()
    await ringReplayProbe(mainClient)
    await durableHeadProbe(mainClient)
  }
  const finalCheckpoint = await mainClient.checkpoint(terminalId)
  if (!finalCheckpoint.ok) fail('final checkpoint', finalCheckpoint.code)

  await crashRestartPhase(sidecar)
  mainClient.close()
  console.log(
    `TERMINAL-SOAK rounds=${roundLedger.length} bytes=${received.bytes} frames=${received.frames} ` +
      `probes=${probeCount} storms=${stormCount} churn=${churnCount} ` +
      `elapsedMs=${Math.round(performance.now() - laneStarted)}`
  )
} catch (cause) {
  fail('lane', cause instanceof Error ? (cause.stack ?? cause.message) : String(cause))
} finally {
  sampleUntil = 0
  if (!received.contiguous) exitCode = 1
  if (failures.length > 0) exitCode = 1
  // A wall-clock budget the round cap ends early is a silent false pass: a
  // "24-hour" soak that stops after one round reports success. Fail loudly so
  // an acceptance claim is only made when the budget actually bound.
  const laneElapsedMs = Math.round(performance.now() - laneStarted)
  // A run that already failed (an integrity assertion, a thrown setup error)
  // did not stop because the budget was short; reporting a second, misleading
  // failure on top of the real one is how a 24-hour soak ends up looking like
  // a round-cap problem.
  const stoppedForFailures = failures.length > 0
  const budgetHonored = durationMs === 0 || laneElapsedMs >= durationMs || stoppedForFailures
  if (!budgetHonored) {
    exitCode = 1
    console.error(
      `TERMINAL-SOAK FAIL: ${roundLedger.length} rounds ended the run after ${laneElapsedMs}ms, ` +
        `short of the ${durationMs}ms budget` +
        (roundsRequested ? ` (ADEA_DEV_RUNTIME_TERMINAL_SOAK_ROUNDS=${rounds})` : '') +
        '; raise ADEA_DEV_RUNTIME_TERMINAL_SOAK_ROUNDS or the duration budget'
    )
  } else if (exitCode === 0) {
    console.log(`TERMINAL-SOAK PASS (${verified.length} verified assertions, 0 failures)`)
  }
  const rss = samples.map((sample) => sample.rssBytes).filter((value) => value !== null)
  const durable = samples.map((sample) => sample.durableBytes)
  const { writeLaneSummary } = await import('./dev-runtime-lane-report.mjs')
  await writeLaneSummary('terminal-soak', {
    command: 'bun scripts/dev-runtime-terminal-soak.mjs',
    status: exitCode === 0 ? 'passed' : 'failed',
    startedAt,
    details: {
      rounds: roundLedger.length,
      requestedRounds: rounds,
      durationBudgetMs: durationMs,
      budgetHonored,
      floodLines,
      elapsedMs: Math.round(performance.now() - laneStarted),
      integrity: {
        receivedBytes: received.bytes,
        receivedFrames: received.frames,
        liveSequenceContiguous: received.contiguous,
        verifiedAssertions: verified.length,
        failures,
      },
      resources: {
        rssSamples: samples.length,
        rssMinBytes: rss.length ? Math.min(...rss) : null,
        rssMaxBytes: rss.length ? Math.max(...rss) : null,
        rssMedianBytes: rss.length
          ? rss.toSorted((left, right) => left - right)[Math.floor(rss.length / 2)]
          : null,
        durableMaxBytes: durable.length ? Math.max(...durable) : 0,
        durableCapBytes: DURABLE_MAX_BYTES_PER_SESSION,
      },
      probes: {
        replays: probeCount,
        resizeStorms: stormCount,
        attachDetachChurn: churnCount,
        resyncNotices: resyncNotices.length,
        resyncNoticesBySubscriber: Object.fromEntries(
          [...new Set(resyncNotices.map((notice) => notice.subscriberId))].map((id) => [
            id,
            resyncNotices.filter((notice) => notice.subscriberId === id).length,
          ])
        ),
      },
      roundLedger,
      samples,
    },
  })
  await stopSidecar(sidecar, exitCode === 0)
  rmSync(dataDir, { recursive: true, force: true })
}
process.exit(exitCode)
