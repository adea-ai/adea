// Packaged usage long-task proof (#539, thread 2).
//
// The scale lane (`scripts/test-dev-runtime-scale.mjs`, PR #554) measures the
// resources surface's budgets: one bounded `ps` observation per pull, the
// UI-task analog under 16 ms, and the metrics caps binding. #539's remaining
// gap is that those numbers were never taken on the *packaged* runtime, and
// that a burst is not a long task — the acceptance asks for the surface under
// sustained load with bounded history.
//
// So this lane drives the same production seams (the registrar, the bounded
// sampler, the client's own projection and summary reducers) for a sustained
// window and asserts nothing drifts: the per-pull budget, the sampling
// discipline, the 720-points-per-owner cap, and a last-bucket p95 that is not a
// multiple of the first's.
//
// Run it with the runtime the app ships:
//
//   /Applications/Adea.app/Contents/MacOS/bun \
//     apps/desktop/shell/scripts/packaged-usage-long-task.ts \
//     --seconds 60 --artifact artifacts/packaged/usage-long-task.json --require-packaged
//
// `--require-packaged` fails when the runtime is not the bundled app's, so a
// result cannot be claimed from a developer's Bun by accident. No real process
// is spawned: the sampler's transport is scripted exactly as the scale lane
// scripts it, which keeps the load synthetic and the assertion about the
// pipeline rather than about this machine's process table.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { performance } from 'node:perf_hooks'

import { registerResourcesRuntime } from '../src/dev-runtime/resources/register'
import {
  createProcessSampler,
  SAMPLE_MAX_PIDS,
} from '../src/dev-runtime/resources/sample-processes'
import { HISTORY_WINDOW_MS, MAX_POINTS_PER_OWNER } from '../src/dev-runtime/resources/metrics'
import {
  metricSummary,
  processRows,
} from '../../../../packages/dev-view/src/resources/resources-model'

const SCOPE = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const PULL_BUDGET_MS = 16
const HANG_GUARD_MS = 5_000
const CLOCK_STEP_MS = 2_000

function argValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const seconds = Number(argValue('--seconds') ?? 60)
const processCount = Number(argValue('--processes') ?? 1_000)
const sessionCount = Number(argValue('--sessions') ?? 100)
const artifactPath = argValue('--artifact') ?? 'artifacts/packaged/usage-long-task.json'
const requirePackaged = process.argv.includes('--require-packaged')
const runtime = process.execPath
const packaged = runtime.includes('.app/Contents/MacOS/')

function percent(sorted, fraction) {
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1))
  return sorted[index]
}

function stats(values) {
  const sorted = [...values].toSorted((left, right) => left - right)
  return {
    samples: sorted.length,
    p50: Number(percent(sorted, 0.5).toFixed(3)),
    p95: Number(percent(sorted, 0.95).toFixed(3)),
    max: Number((sorted[sorted.length - 1] ?? 0).toFixed(3)),
  }
}

/** Mirrors the scale lane's seeding: one durable record plus one live
 *  component per process, ten processes to a runtime session. */
function seedInventory(processes, sessions) {
  const perSession = processes / sessions
  const records = []
  const components = []
  for (let index = 0; index < processes; index += 1) {
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
  return {
    records,
    components,
    resolveOwner: (componentId) => {
      const index = Number(componentId.slice(5))
      const session = `session-${String(Math.floor(index / perSession)).padStart(3, '0')}`
      return { ownerKind: 'harness', ownerId: session, runtimeSessionId: session }
    },
  }
}

async function main() {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3_600)
    throw new Error('--seconds must be between 1 and 3600')
  if (processCount % sessionCount !== 0)
    throw new Error('--processes must divide evenly across --sessions')
  if (requirePackaged && !packaged)
    throw new Error(
      `--require-packaged was passed but the runtime is ${runtime}; run this with the app's bundled Bun`
    )

  const inventory = seedInventory(processCount, sessionCount)
  const clock = { value: 1_000_000 }
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
      const selected = String(args[3]).split(',').map(Number)
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
  const snapshot = providers['dev.resources.snapshot']
  if (!snapshot) throw new Error('dev.resources.snapshot was not registered')

  // Warm-up: module caches and JIT are not part of a long task's steady state.
  await snapshot({ body: {} })

  const pullMs = []
  const projectionMs = []
  const summaryMs = []
  const buckets = []
  let lastRows = 0
  // One pull per second for the requested window, floored at 30 so the trend
  // buckets mean something even for a smoke-length invocation.
  const pulls = Math.max(30, Math.round(seconds))
  const bucketSize = Math.max(1, Math.floor(pulls / 5))

  for (let index = 0; index < pulls; index += 1) {
    clock.value += CLOCK_STEP_MS
    const started = performance.now()
    const reply = await snapshot({ body: {} })
    const elapsed = performance.now() - started
    if (elapsed > HANG_GUARD_MS)
      throw new Error(`pull ${index} took ${Math.round(elapsed)}ms, past the hang guard`)
    pullMs.push(elapsed)

    const rows = reply.processes ?? []
    lastRows = rows.length
    const projectionStart = performance.now()
    processRows(rows)
    projectionMs.push(performance.now() - projectionStart)

    const points = registered.metrics.list({ runtimeSessionId: 'session-000' })
    const summaryStart = performance.now()
    metricSummary(points)
    summaryMs.push(performance.now() - summaryStart)

    if ((index + 1) % bucketSize === 0 || index === pulls - 1) {
      const from = buckets.length * bucketSize
      buckets.push({
        bucket: buckets.length + 1,
        pulls: pullMs.length - from,
        ...stats(pullMs.slice(from)),
      })
    }
  }

  const points = registered.metrics.list()
  const ownerCounts = new Map()
  for (const point of points)
    ownerCounts.set(point.ownerId, (ownerCounts.get(point.ownerId) ?? 0) + 1)
  const maxOwnerPoints = Math.max(0, ...ownerCounts.values())

  const pullStats = stats(pullMs)
  const projection = stats(projectionMs)
  const summary = stats(summaryMs)
  const first = buckets[0]
  const last = buckets[buckets.length - 1]
  const findings = []
  if (psCalls !== pulls + 1)
    findings.push(
      `one ps observation per pull expected (${pulls + 1} with warm-up), saw ${psCalls}`
    )
  if (maxPidsPerCall > SAMPLE_MAX_PIDS)
    findings.push(`a ps observation selected ${maxPidsPerCall} PIDs, past ${SAMPLE_MAX_PIDS}`)
  if (minPidsPerCall !== SAMPLE_MAX_PIDS)
    findings.push(
      `the bounded window shrank to ${minPidsPerCall} PIDs; rotation is not covering the inventory`
    )
  if (observedPids.size !== processCount)
    findings.push(`the window rotated through ${observedPids.size} of ${processCount} pids`)
  if (lastRows !== processCount)
    findings.push(`the last pull projected ${lastRows} rows, expected ${processCount}`)
  if (projection.p95 > PULL_BUDGET_MS)
    findings.push(`row projection p95 ${projection.p95}ms exceeds ${PULL_BUDGET_MS}ms`)
  if (summary.p95 > PULL_BUDGET_MS)
    findings.push(`metric summary p95 ${summary.p95}ms exceeds ${PULL_BUDGET_MS}ms`)
  if (ownerCounts.size !== processCount)
    findings.push(`metrics cover ${ownerCounts.size} owners, expected ${processCount}`)
  if (maxOwnerPoints > MAX_POINTS_PER_OWNER)
    findings.push(`an owner holds ${maxOwnerPoints} points, past the ${MAX_POINTS_PER_OWNER} cap`)
  // Sustained load must not drift: a last bucket whose p95 is more than double
  // the first's is growth, not noise. The floor keeps a sub-millisecond first
  // bucket from making the ratio meaningless.
  const driftCeiling = Math.max(first.p95 * 2, PULL_BUDGET_MS * 8)
  if (last.p95 > driftCeiling)
    findings.push(`pull p95 grew from ${first.p95}ms to ${last.p95}ms (ceiling ${driftCeiling}ms)`)

  const artifact = {
    lane: 'packaged-usage-long-task',
    issue: '#539',
    status: findings.length === 0 ? 'passed' : 'failed',
    runtime: { argv0: runtime, bun: Bun.version, packaged },
    workload: {
      processes: processCount,
      sessions: sessionCount,
      pulls,
      clockStepMs: CLOCK_STEP_MS,
    },
    budgets: {
      pullBudgetMs: PULL_BUDGET_MS,
      hangGuardMs: HANG_GUARD_MS,
      sampleMaxPids: SAMPLE_MAX_PIDS,
    },
    caps: {
      pointsPerOwnerCap: MAX_POINTS_PER_OWNER,
      historyWindowMs: HISTORY_WINDOW_MS,
      maxObservedPointsPerOwner: maxOwnerPoints,
      owners: ownerCounts.size,
    },
    sampling: {
      psCalls,
      maxPidsPerCall,
      minPidsPerCall,
      distinctPidsObserved: observedPids.size,
      rowsOnLastPull: lastRows,
    },
    latency: { pull: pullStats, projection, summary },
    buckets,
    findings,
    recordedAt: new Date().toISOString(),
  }
  mkdirSync(dirname(artifactPath), { recursive: true })
  writeFileSync(artifactPath, JSON.stringify(artifact, null, 2))

  console.log(
    `PACKAGED-USAGE-LONG-TASK pulls=${pulls} rows=${lastRows} pullP95=${pullStats.p95}ms ` +
      `projectionP95=${projection.p95}ms summaryP95=${summary.p95}ms psCalls=${psCalls} ` +
      `pids=${observedPids.size} ownerPoints=${maxOwnerPoints}/${MAX_POINTS_PER_OWNER}`
  )
  for (const finding of findings) console.error(`PACKAGED-USAGE-LONG-TASK FAIL ${finding}`)
  if (findings.length === 0) console.log('PACKAGED-USAGE-LONG-TASK PASS')
  else process.exit(1)
}

await main()
