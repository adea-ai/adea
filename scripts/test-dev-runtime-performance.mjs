import { performance } from 'node:perf_hooks'

import { writeLaneSummary } from './dev-runtime-lane-report.mjs'
import { createMetricsHistory } from '../apps/desktop/shell/src/dev-runtime/resources/metrics.ts'
import {
  createProcessSampler,
  SAMPLE_MAX_PIDS,
} from '../apps/desktop/shell/src/dev-runtime/resources/sample-processes.ts'
import { processRows } from '../packages/dev-view/src/resources/resources-model.ts'

const startedAt = new Date()
const command = 'bun run test:performance:dev-runtime'

// The M12 performance lane currently exercises the bounded screenshot
// retention store, whose budget is 5 seconds for 1,000 bounded captures.
// Extend this file with further measured budgets (shell paint, terminal
// input-to-paint p95, virtualization) as their harnesses land.
try {
  const { createScreenshotStore } =
    await import('../apps/desktop/shell/src/dev-runtime/browser/screenshots.ts')

  const store = createScreenshotStore({
    scope: {
      accountId: '00000000-0000-4000-8000-000000000001',
      workspaceId: '00000000-0000-4000-8000-000000000002',
      runtimeNodeId: '00000000-0000-4000-8000-000000000003',
    },
    retention: { maxBytesEach: 1024, maxTotalBytes: 1024 * 1024 },
    randomId: (() => {
      let n = 0
      return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
    })(),
  })
  const bytes = new Uint8Array(512)
  const started = performance.now()
  for (let index = 0; index < 1000; index += 1) {
    store.record({
      bytes,
      format: 'png',
      width: 32,
      height: 32,
      provenance: {
        ownerId: 'perf-lane',
        laneKind: 'task_owned',
        origin: 'http://127.0.0.1:5173/',
        viewport: { width: 32, height: 32, deviceScaleFactor: 1 },
        redacted: true,
      },
    })
  }
  const elapsed = performance.now() - started
  if (elapsed > 5000)
    throw new Error(`screenshot retention benchmark exceeded 5s: ${elapsed.toFixed(1)}ms`)
  console.log(
    `Dev Runtime performance benchmark passed: 1000 bounded captures in ${elapsed.toFixed(1)}ms`
  )

  // Synthetic scale pass: one bounded ps observation per pull, 100 canonical
  // session IDs, 1,000 running process rows. This measures the actual sampler,
  // metrics-history, and UI row-reducer code without spawning 1,000 OS jobs.
  const pids = Array.from({ length: 1_000 }, (_, index) => index + 1_000)
  const records = pids.map((pid, index) => ({
    id: `process-${String(index).padStart(4, '0')}`,
    state: 'running',
    runtimeSessionId: `session-${Math.floor(index / 10)}`,
  }))
  let psCalls = 0
  let maxPidsPerCall = 0
  const sampler = createProcessSampler({
    runPs: async (args) => {
      psCalls += 1
      const selected = args[3].split(',').map(Number)
      maxPidsPerCall = Math.max(maxPidsPerCall, selected.length)
      return {
        exitCode: 0,
        stdout: selected.map((pid) => `${pid} 0:01 1024`).join('\n'),
        stderr: '',
      }
    },
  })
  const metricHistory = createMetricsHistory()
  const observedPids = new Set()
  const scaleStarted = performance.now()
  for (let pull = 0; pull < Math.ceil(pids.length / SAMPLE_MAX_PIDS); pull += 1) {
    for (const sample of await sampler(pids)) {
      observedPids.add(sample.pid)
      const index = sample.pid - 1_000
      metricHistory.recordSample(
        { ownerId: records[index].id, runtimeSessionId: records[index].runtimeSessionId },
        sample
      )
    }
  }
  const scaleElapsedMs = performance.now() - scaleStarted
  const sessionCount = new Set(metricHistory.list().map((point) => point.runtimeSessionId)).size
  if (observedPids.size !== 1_000 || sessionCount !== 100)
    throw new Error(
      `resource scale coverage incomplete: ${observedPids.size} processes / ${sessionCount} sessions`
    )
  if (psCalls !== 16 || maxPidsPerCall > SAMPLE_MAX_PIDS)
    throw new Error(`resource scale exceeded bounded ps calls: ${psCalls} calls`)
  for (let warmup = 0; warmup < 5; warmup += 1) processRows(records)
  const rowDurationsMs = []
  for (let run = 0; run < 30; run += 1) {
    const rowStarted = performance.now()
    if (processRows(records).length !== 1_000) throw new Error('resource rows were truncated')
    rowDurationsMs.push(performance.now() - rowStarted)
  }
  const sortedDurations = rowDurationsMs.toSorted((left, right) => left - right)
  const rowP95Ms = sortedDurations[Math.ceil(sortedDurations.length * 0.95) - 1]
  if (rowP95Ms > 16)
    throw new Error(`1,000-row projection exceeded 16ms p95: ${rowP95Ms.toFixed(1)}ms`)
  console.log(
    `Dev Runtime synthetic resource scale passed: ${observedPids.size} processes / ${sessionCount} sessions in ${psCalls} bounded ps calls; row p95 ${rowP95Ms.toFixed(2)}ms`
  )
  await writeLaneSummary('performance', {
    command,
    status: 'passed',
    startedAt,
    details: {
      benchmark: 'screenshot-retention-1000-captures',
      elapsedMs: Number(elapsed.toFixed(1)),
      budgetMs: 5000,
      resourceScale: {
        kind: 'synthetic',
        processCount: observedPids.size,
        sessionCount,
        psCalls,
        maxPidsPerCall,
        samplingElapsedMs: Number(scaleElapsedMs.toFixed(2)),
        rowProjectionP95Ms: Number(rowP95Ms.toFixed(2)),
        rowProjectionBudgetMs: 16,
      },
    },
  })
  process.exit(0)
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  await writeLaneSummary('performance', {
    command,
    status: 'failed',
    startedAt,
    details: { error: error instanceof Error ? error.message : String(error) },
  })
  process.exit(1)
}
