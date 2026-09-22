// Named M12 scale lane for the Dev Runtime resources surface (#424): it seeds
// the production registrar with 100 runtime sessions / 1,000 process rows
// through the same seams production uses — injected durable launch records
// joined against a live supervision snapshot, plus the bounded ps-sampler
// transport seam — and measures the issue's remaining evidence box:
//
//   1. no polling storms: exactly one fixed-argv `ps` observation per pull,
//      each observing at most SAMPLE_MAX_PIDS (64) distinct PIDs, with the
//      bounded window rotating through the full inventory;
//   2. sample latency per pull and the UI-task analog budgets: the
//      sampler+projection pipeline (row projection, metric summary, pull
//      processing) stays under the 16 ms frame budget;
//   3. bounded metrics/history storage: the 720-points-per-owner and
//      24-hour retention caps hold at the named constants, driven through
//      the registrar's own pull path until both caps actually bind.
//
// The full `dev.resources.snapshot` host handler is reported per pull too
// (p50/p95 and a growth trend across pull buckets) with a 5-second hang
// guard — the sampler's documented command-timeout budget — because its cost
// is proportional to total retained history; the 16 ms budget above scopes
// the documented UI-task analog, not this host-side IPC handler.
//
// Budgets pinned here are the documented-raise surface: relaxing one is a
// deliberate edit to this file (and scripts/test-suite-boundary.test.ts).
import { performance } from 'node:perf_hooks'

import { writeLaneSummary } from './dev-runtime-lane-report.mjs'
import { registerResourcesRuntime } from '../apps/desktop/shell/src/dev-runtime/resources/register.ts'
import {
  createProcessSampler,
  SAMPLE_MAX_PIDS,
} from '../apps/desktop/shell/src/dev-runtime/resources/sample-processes.ts'
import {
  HISTORY_WINDOW_MS,
  MAX_POINTS_PER_OWNER,
} from '../apps/desktop/shell/src/dev-runtime/resources/metrics.ts'
import { metricSummary, processRows } from '../packages/dev-view/src/resources/resources-model.ts'

const startedAt = new Date()
const command = 'bun run test:scale:dev-runtime'

const SCOPE = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const PROCESSES = 1_000
const SESSIONS = 100
const PULL_BUDGET_MS = 16
const HANG_GUARD_MS = 5_000
const PULL_CLOCK_STEP_MS = 2_000

function percent(sorted, fraction) {
  const index = Math.ceil(sorted.length * fraction) - 1
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))]
}

function stats(durations) {
  const sorted = [...durations].toSorted((left, right) => left - right)
  return {
    p50: percent(sorted, 0.5),
    p95: percent(sorted, 0.95),
    max: sorted[sorted.length - 1],
  }
}

/** Seeds the registrar's production seams: one durable `launched` journal
 * record plus one matching live snapshot component per process, with the
 * session/worktree owner resolved exactly 10 processes per runtime session. */
function seedInventory(processCount, sessionCount) {
  const perSession = processCount / sessionCount
  const records = []
  const components = []
  for (let index = 0; index < processCount; index += 1) {
    const componentId = `comp-${String(index).padStart(4, '0')}`
    const identity = {
      pid: 10_000 + index,
      pidStartIdentity: `start-${index}`,
      executableIdentity: `/exe/${index}`,
    }
    records.push({
      kind: 'launched',
      at: new Date(1_000).toISOString(),
      componentId,
      generation: 1,
      processRecordId: `record-${componentId}`,
      identity,
      processGroup: `grp-${index}`,
    })
    components.push({
      id: componentId,
      state: 'running',
      health: 'healthy',
      generation: 1,
      launch: { identity, processGroup: `grp-${index}`, startedAt: new Date(1_000).toISOString() },
      manifest: { version: '1.0.0', digestSha256: 'd'.repeat(64) },
    })
  }
  const sessionOf = (componentId) => {
    const index = Number(componentId.slice(5))
    return `session-${String(Math.floor(index / perSession)).padStart(3, '0')}`
  }
  return {
    records,
    components,
    resolveOwner: (componentId) => ({
      ownerKind: 'harness',
      ownerId: sessionOf(componentId),
      runtimeSessionId: sessionOf(componentId),
    }),
  }
}

/** A registrar wired exactly like production composition: the bounded
 * sampler over an injectable transport, the durable journal, the live
 * snapshot view, and the owner resolution — with the scripted `ps` counting
 * every observation so the storm gate is exact. */
function bootScaleRegistrar(inventory, clock) {
  const providers = {}
  const authority = {
    registerCommandProvider(operation, handler) {
      providers[operation] = handler
    },
  }
  let psCalls = 0
  let maxPidsPerCall = 0
  let minPidsPerCall = Number.POSITIVE_INFINITY
  const observedPids = new Set()
  const sampler = createProcessSampler({
    runPs: async (args) => {
      psCalls += 1
      // The production fixed argv: `-o pid=,time=,rss= -p <comma-joined>`.
      const selected = args[3].split(',').map(Number)
      maxPidsPerCall = Math.max(maxPidsPerCall, selected.length)
      minPidsPerCall = Math.min(minPidsPerCall, selected.length)
      for (const pid of selected) observedPids.add(pid)
      return {
        exitCode: 0,
        stdout: selected.map((pid) => `${pid} 0:01 1024`).join('\n'),
        stderr: '',
      }
    },
  })
  const registered = registerResourcesRuntime({
    authority,
    scope: SCOPE,
    supervision: {
      snapshot: () => ({ components: inventory.components }),
      requestStop: () => ({ ok: true, value: { confirmationId: 'confirm', generation: 1 } }),
      stop: async () => ({ ok: false, code: 'invalid_state', message: 'not exercised here' }),
    },
    supervisionRecords: { list: () => inventory.records },
    resolveOwner: inventory.resolveOwner,
    sampleProcesses: sampler,
    now: () => clock.value,
  })
  return {
    providers,
    registered,
    sampling: {
      get psCalls() {
        return psCalls
      },
      get maxPidsPerCall() {
        return maxPidsPerCall
      },
      get minPidsPerCall() {
        return minPidsPerCall
      },
      observedPids,
    },
  }
}

function ownerPointCounts(points) {
  const byOwner = new Map()
  for (const point of points) {
    byOwner.set(point.ownerId, (byOwner.get(point.ownerId) ?? 0) + 1)
  }
  return byOwner
}

try {
  // ── Scenario A: 100 sessions / 1,000 processes at the documented 2-second
  // visible-active cadence. Gate: no polling storm (one ps per pull, ≤ 64
  // PIDs per observation, full window every pull) and full coverage.
  const clockA = { value: 1_000_000 }
  const inventoryA = seedInventory(PROCESSES, SESSIONS)
  const bootA = bootScaleRegistrar(inventoryA, clockA)
  const snapshotHandler = bootA.providers['dev.resources.snapshot']
  await snapshotHandler({ body: {} }) // warm-up (module caches, JIT)
  const pullDurationsMs = []
  const trendBuckets = []
  let bucket = []
  for (let pull = 0; pull < 500; pull += 1) {
    clockA.value += PULL_CLOCK_STEP_MS
    const pullStart = performance.now()
    await snapshotHandler({ body: {} })
    const elapsed = performance.now() - pullStart
    if (elapsed > HANG_GUARD_MS)
      throw new Error(`snapshot pull exceeded the 5s hang guard: ${elapsed.toFixed(0)}ms`)
    pullDurationsMs.push(elapsed)
    bucket.push(elapsed)
    if (bucket.length === 50) {
      trendBuckets.push(
        Number(
          percent(
            [...bucket].toSorted((l, r) => l - r),
            0.95
          ).toFixed(2)
        )
      )
      bucket = []
    }
  }
  const pullStats = stats(pullDurationsMs)
  const { psCalls, maxPidsPerCall, minPidsPerCall } = bootA.sampling
  // The warm-up pull before the loop contributes exactly one observation.
  if (psCalls !== 501)
    throw new Error(`polling storm: ${psCalls} ps observations for 500 pulls + 1 warm-up`)
  if (maxPidsPerCall > SAMPLE_MAX_PIDS)
    throw new Error(`ps window exceeded ${SAMPLE_MAX_PIDS} PIDs: ${maxPidsPerCall}`)
  if (minPidsPerCall !== SAMPLE_MAX_PIDS)
    throw new Error(
      `bounded window shrank to ${minPidsPerCall} PIDs; rotation is not covering the inventory`
    )
  const pointsA = bootA.registered.metrics.list()
  const ownersA = ownerPointCounts(pointsA)
  const sessionsA = new Set(pointsA.map((point) => point.runtimeSessionId))
  if (ownersA.size !== PROCESSES || sessionsA.size !== SESSIONS)
    throw new Error(`coverage incomplete: ${ownersA.size} processes / ${sessionsA.size} sessions`)
  for (const [owner, count] of ownersA) {
    if (count > MAX_POINTS_PER_OWNER)
      throw new Error(`owner ${owner} exceeded the ${MAX_POINTS_PER_OWNER}-point cap: ${count}`)
  }
  console.log(
    `scale A passed: ${PROCESSES} processes / ${SESSIONS} sessions over 500 pulls — ` +
      `${psCalls} ps observations (1/pull, ≤${SAMPLE_MAX_PIDS} PIDs each), ` +
      `host pull p50 ${pullStats.p50.toFixed(2)}ms p95 ${pullStats.p95.toFixed(2)}ms max ${pullStats.max.toFixed(2)}ms, ` +
      `p95 trend per 50 pulls [${trendBuckets.join(', ')}], stored points ${pointsA.length}`
  )

  // ── UI-task analog budgets (the 16 ms frame budget): the pure projection
  // work a Dev View callback performs per pull, plus the isolated sampler
  // pull-processing cost, plus the host handler as measured context.
  const lastSnapshot = await snapshotHandler({ body: {} })
  const rowDurationsMs = []
  for (let run = 0; run < 30; run += 1) {
    const rowStart = performance.now()
    if (processRows(lastSnapshot.processes).length !== PROCESSES)
      throw new Error('1,000-row projection was truncated')
    rowDurationsMs.push(performance.now() - rowStart)
  }
  const rowStats = stats(rowDurationsMs)
  if (rowStats.p95 > PULL_BUDGET_MS)
    throw new Error(
      `1,000-row projection exceeded the ${PULL_BUDGET_MS}ms p95 budget: ${rowStats.p95.toFixed(2)}ms`
    )

  const sessionPoints = bootA.registered.metrics.list({ runtimeSessionId: 'session-000' })
  const summaryDurationsMs = []
  for (let run = 0; run < 100; run += 1) {
    const summaryStart = performance.now()
    metricSummary(sessionPoints)
    summaryDurationsMs.push(performance.now() - summaryStart)
  }
  const summaryStats = stats(summaryDurationsMs)
  if (summaryStats.p95 > PULL_BUDGET_MS)
    throw new Error(
      `metric summary exceeded the ${PULL_BUDGET_MS}ms p95 budget: ${summaryStats.p95.toFixed(2)}ms`
    )

  const clockIsolated = { value: 1_000_000 }
  const isolated = createProcessSampler({
    runPs: async (args) => ({
      exitCode: 0,
      stdout: args[3]
        .split(',')
        .map((pid) => `${pid} 0:01 1024`)
        .join('\n'),
      stderr: '',
    }),
  })
  const pids = Array.from({ length: PROCESSES }, (_, index) => 10_000 + index)
  const samplerDurationsMs = []
  for (let run = 0; run < 30; run += 1) {
    const samplerStart = performance.now()
    const samples = await isolated(pids)
    samplerDurationsMs.push(performance.now() - samplerStart)
    if (samples.length !== SAMPLE_MAX_PIDS)
      throw new Error(`sampler returned ${samples.length} samples for a full window`)
    clockIsolated.value += PULL_CLOCK_STEP_MS
  }
  const samplerStats = stats(samplerDurationsMs)
  if (samplerStats.p95 > PULL_BUDGET_MS)
    throw new Error(
      `sampler pull exceeded the ${PULL_BUDGET_MS}ms p95 budget: ${samplerStats.p95.toFixed(2)}ms`
    )
  console.log(
    `scale A pipeline passed: sampler pull p95 ${samplerStats.p95.toFixed(2)}ms, ` +
      `row projection p95 ${rowStats.p95.toFixed(2)}ms, metric summary p95 ${summaryStats.p95.toFixed(2)}ms ` +
      `(budget ${PULL_BUDGET_MS}ms p95 each)`
  )

  // ── Scenario B: the retention caps must actually bind through the same
  // pull path. 64 processes across 8 sessions give every pull the full
  // 64-PID window, so 730 pulls deliver 730 samples per owner — 10 past the
  // 720-point cap. The clock then jumps a full 24-hour window per pull so
  // the time axis prunes too. Both prunes must leave exactly the bounded
  // number of points per owner, measured from the history the registrar
  // itself returned.
  const clockB = { value: 1_000_000 }
  const inventoryB = seedInventory(64, 8)
  const bootB = bootScaleRegistrar(inventoryB, clockB)
  const handlerB = bootB.providers['dev.resources.snapshot']
  await handlerB({ body: {} })
  for (let pull = 0; pull < MAX_POINTS_PER_OWNER + 10; pull += 1) {
    clockB.value += 1_000
    await handlerB({ body: {} })
  }
  const pointsAtCap = bootB.registered.metrics.list()
  const ownersAtCap = ownerPointCounts(pointsAtCap)
  if (
    ownersAtCap.size !== 64 ||
    [...ownersAtCap.values()].some((count) => count !== MAX_POINTS_PER_OWNER)
  )
    throw new Error(
      `720-point cap did not bind exactly: ${ownersAtCap.size} owners, counts ` +
        `${Math.min(...ownersAtCap.values())}..${Math.max(...ownersAtCap.values())}`
    )
  if (pointsAtCap.length !== 64 * MAX_POINTS_PER_OWNER)
    throw new Error(
      `aggregate storage exceeded 64 owners × ${MAX_POINTS_PER_OWNER} points: ${pointsAtCap.length}`
    )
  const capPhasePsCalls = bootB.sampling.psCalls

  const jumpClocksMs = []
  for (let pull = 0; pull < 15; pull += 1) {
    clockB.value += HISTORY_WINDOW_MS
    jumpClocksMs.push(clockB.value)
    await handlerB({ body: {} })
  }
  const pointsAtWindow = bootB.registered.metrics.list()
  const ownersAtWindow = ownerPointCounts(pointsAtWindow)
  // Each jump is exactly one window apart, so only the points recorded at or
  // after the final horizon survive: 730 capped points/owner must prune to
  // exactly that count — the time axis binding through the same pull path.
  const windowHorizonMs = clockB.value - HISTORY_WINDOW_MS
  const expectedSurvivors = jumpClocksMs.filter((at) => at >= windowHorizonMs).length
  if ([...ownersAtWindow.values()].some((count) => count !== expectedSurvivors))
    throw new Error(
      `24h window did not prune to the ${expectedSurvivors} post-jump points: counts ${Math.min(...ownersAtWindow.values())}..${Math.max(...ownersAtWindow.values())}`
    )
  const horizonIso = new Date(windowHorizonMs).toISOString()
  const oldestObservedAt = pointsAtWindow.reduce(
    (oldest, point) => (point.observedAt < oldest ? point.observedAt : oldest),
    horizonIso
  )
  if (Date.parse(oldestObservedAt) < windowHorizonMs)
    throw new Error(`24h window held points older than the window floor: ${oldestObservedAt}`)
  console.log(
    `scale B passed: 730 samples/owner pruned to exactly ${MAX_POINTS_PER_OWNER} (cap), ` +
      `then 24h-apart pulls pruned to exactly ${expectedSurvivors}/owner (window); ` +
      `aggregate bounded at ${64 * MAX_POINTS_PER_OWNER} points; ` +
      `${bootB.sampling.psCalls} ps observations for ${MAX_POINTS_PER_OWNER + 10 + 15} pulls + 1 warm-up`
  )

  // ── Real-transport probe: the scripted scenarios above prove the spawn
  // count exactly; this probe runs the production transport shape (one real
  // fixed-argv `ps` spawn per pull, wrapped to count it) against the OS so
  // the default path is grounded too.
  const realClock = { value: 1_000_000 }
  let realSpawns = 0
  const realSampler = createProcessSampler({
    runPs: async (args) => {
      realSpawns += 1
      const proc = Bun.spawnSync(['ps', ...args], {
        stdout: 'pipe',
        stderr: 'ignore',
        timeout: HANG_GUARD_MS,
      })
      return { exitCode: proc.exitCode ?? 1, stdout: proc.stdout.toString(), stderr: '' }
    },
  })
  const realDurationsMs = []
  for (let pull = 0; pull < 20; pull += 1) {
    const realStart = performance.now()
    const samples = await realSampler([process.pid])
    realDurationsMs.push(performance.now() - realStart)
    const own = samples.find((sample) => sample.pid === process.pid)
    if (!own || (own.residentBytes ?? 0) <= 0)
      throw new Error('real ps observation did not report this process truthfully')
    realClock.value += PULL_CLOCK_STEP_MS
  }
  if (realSpawns !== 20)
    throw new Error(`real transport spawned ps ${realSpawns} times for 20 pulls`)
  const realStats = stats(realDurationsMs)
  console.log(
    `scale real-transport passed: 20 pulls × 1 real ps spawn each, ` +
      `p50 ${realStats.p50.toFixed(2)}ms p95 ${realStats.p95.toFixed(2)}ms max ${realStats.max.toFixed(2)}ms`
  )

  await writeLaneSummary('scale', {
    command,
    status: 'passed',
    startedAt,
    details: {
      scenarioA: {
        processCount: PROCESSES,
        sessionCount: SESSIONS,
        pulls: 500,
        pullClockStepMs: PULL_CLOCK_STEP_MS,
        psObservations: psCalls,
        maxPidsPerObservation: maxPidsPerCall,
        hostPull: {
          p50Ms: Number(pullStats.p50.toFixed(2)),
          p95Ms: Number(pullStats.p95.toFixed(2)),
          maxMs: Number(pullStats.max.toFixed(2)),
          hangGuardMs: HANG_GUARD_MS,
        },
        p95TrendPer50PullsMs: trendBuckets,
        storedPoints: pointsA.length,
      },
      pipelineBudgets: {
        budgetP95Ms: PULL_BUDGET_MS,
        samplerPullP95Ms: Number(samplerStats.p95.toFixed(2)),
        rowProjectionP95Ms: Number(rowStats.p95.toFixed(2)),
        metricSummaryP95Ms: Number(summaryStats.p95.toFixed(2)),
      },
      scenarioB: {
        owners: 64,
        pulls: MAX_POINTS_PER_OWNER + 10,
        windowPulls: 15,
        maxPointsPerOwner: MAX_POINTS_PER_OWNER,
        windowMs: HISTORY_WINDOW_MS,
        aggregateBoundedPoints: 64 * MAX_POINTS_PER_OWNER,
        psObservations: bootB.sampling.psCalls,
        capPhasePsObservations: capPhasePsCalls,
      },
      realTransport: {
        pulls: 20,
        spawns: realSpawns,
        p50Ms: Number(realStats.p50.toFixed(2)),
        p95Ms: Number(realStats.p95.toFixed(2)),
        maxMs: Number(realStats.max.toFixed(2)),
      },
    },
  })
  process.exit(0)
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  await writeLaneSummary('scale', {
    command,
    status: 'failed',
    startedAt,
    details: { error: error instanceof Error ? error.message : String(error) },
  })
  process.exit(1)
}
