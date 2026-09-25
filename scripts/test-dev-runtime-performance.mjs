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
  // ─── Files/diff client budgets (#399) ─────────────────────────────────────
  // The surfaces that run on the main thread when a person opens a large tree
  // or a large diff, measured where they actually execute. First tree paint is
  // browser-only and stays named in the artifact as the remainder rather than
  // being estimated here.
  // All three passes are gated at the long-task budget. These are absolute
  // timings, so the lane belongs on a settled machine: the same 10k-line round
  // trip measured 27ms warm and 130-200ms while the 24h soak held the machine,
  // and the listing page merge moves the same way. A red lane under load is
  // load, not a regression — re-run it before believing either.
  const FILES_BUDGET_MS = 50
  const FILES_GUARD_MS = FILES_BUDGET_MS
  const { mergeListing, visibleRows } =
    await import('../packages/dev-view/src/files/files-model.ts')
  const { documentFromRead, documentToBytes } =
    await import('../packages/dev-view/src/editor/editor-document.ts')
  const { hunkHeader, splitFileHunks } =
    await import('../packages/dev-view/src/source-control/source-control-model.ts')

  const benchmarkScope = {
    worktreeId: 'perf-eval-0001',
    rootIdentity: { mtimeNs: '1', size: '1' },
  }
  const entryAt = (relativePath, size, kind = 'file') => ({
    identity: { mtimeNs: '1', size: String(size) },
    kind,
    observedAt: '2026-09-25T00:00:00.000Z',
    path: { ...benchmarkScope, relativePath },
    size: String(size),
  })

  // A 100k-entry listing, projected the way the Files pane projects it.
  const listingEntries = []
  for (let directory = 0; directory < 1_000; directory += 1) {
    listingEntries.push(entryAt(`apps/app-${directory}`, 0, 'directory'))
    for (let file = 0; file < 99; file += 1)
      listingEntries.push(entryAt(`apps/app-${directory}/src-${file}.ts`, 1_024))
  }
  // The pane merges one paged listing at a time, so the gated number is the
  // page it actually waits on; the cold total for all 100k entries is recorded
  // beside it because that is the cost of a full first load, not a UI task.
  const pageDurations = []
  let tree = []
  const mergeStarted = performance.now()
  for (let offset = 0; offset < listingEntries.length; offset += 500) {
    const pageStarted = performance.now()
    tree = mergeListing(tree, listingEntries.slice(offset, offset + 500))
    pageDurations.push(performance.now() - pageStarted)
  }
  const mergeFullMs = performance.now() - mergeStarted
  const pageP95Ms = pageDurations.toSorted((left, right) => left - right)[
    Math.ceil(pageDurations.length * 0.95) - 1
  ]
  if (pageP95Ms > FILES_BUDGET_MS)
    throw new Error(
      `a 500-entry listing page merge exceeded ${FILES_BUDGET_MS}ms: ${pageP95Ms.toFixed(1)}ms`
    )

  // 'apps' only exists as the parent mergeListing derives, so the fixture has to
  // expand it explicitly — otherwise the projection stops at one row.
  const expanded = new Set(['apps', ...listingEntries.map((entry) => entry.path.relativePath)])
  const listingStarted = performance.now()
  const listingRowCount = visibleRows(tree, expanded).length
  const listingMs = performance.now() - listingStarted
  // Reported, not gated: a fully expanded 100k tree is the expensive shape the
  // windowing work in #677 exists to remove, and this number is its evidence.
  if (listingRowCount < 100_000)
    throw new Error(`the 100k-listing projection lost rows: ${listingRowCount}`)

  // A 10k-line document through the editor's own decode/encode round trip.
  const lineBytes = []
  for (let line = 0; line < 10_000; line += 1) {
    const ending = line % 3 === 0 ? '\r\n' : '\n'
    lineBytes.push(`line ${line} of a ten thousand line file${ending}`)
  }
  const documentBytes = new TextEncoder().encode(lineBytes.join(''))
  const documentStarted = performance.now()
  const document = documentFromRead({
    bytes: documentBytes,
    encoding: 'utf8',
    entry: entryAt('apps/app-0/src-0.ts', documentBytes.byteLength),
    eol: 'mixed',
    eof: true,
    offset: '0',
  })
  const roundTripped = documentToBytes(document, document.text, 'preserve')
  const documentMs = performance.now() - documentStarted
  if (roundTripped.byteLength !== documentBytes.byteLength)
    throw new Error('the 10k-line round trip changed the byte length')
  if (documentMs > FILES_GUARD_MS)
    throw new Error(
      `10k-line document round trip exceeded ${FILES_GUARD_MS}ms: ${documentMs.toFixed(1)}ms`
    )

  // A 10k-hunk diff, split per file the way the Source Control pane splits it.
  const hunks = []
  for (let hunk = 0; hunk < 10_000; hunk += 1) {
    hunks.push({
      lines: [
        { kind: 'context', text: ` context ${hunk}` },
        { kind: 'delete', text: `-before ${hunk}` },
        { kind: 'add', text: `+after ${hunk}` },
      ],
      newLines: 2,
      newStart: hunk * 3 + 1,
      oldLines: 2,
      oldStart: hunk * 3 + 1,
      path: {
        ...benchmarkScope,
        relativePath: `apps/app-${(hunk / 100) | 0}/src-${hunk % 100}.ts`,
      },
    })
  }
  const diffStarted = performance.now()
  const groups = splitFileHunks(hunks)
  const headers = groups.flatMap((group) => group.hunks.map((hunk) => hunkHeader(hunk)))
  const diffMs = performance.now() - diffStarted
  if (groups.length !== 100 || headers.length !== 10_000)
    throw new Error('the 10k-hunk split lost hunks or files')
  if (diffMs > FILES_GUARD_MS)
    throw new Error(`10k-hunk split exceeded ${FILES_GUARD_MS}ms: ${diffMs.toFixed(1)}ms`)

  const memoryAfterBytes = process.memoryUsage().rss
  console.log(
    `Dev Runtime files/diff budgets passed: listing page p95 ${pageP95Ms.toFixed(1)}ms across ${pageDurations.length} pages (cold 100k merge ${mergeFullMs.toFixed(0)}ms, full flatten ${listingMs.toFixed(0)}ms / ${listingRowCount} rows), 10k-line document ${documentMs.toFixed(1)}ms, 10k-hunk split ${diffMs.toFixed(1)}ms, RSS ${(memoryAfterBytes / 1024 / 1024).toFixed(0)}MB`
  )

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
      filesAndDiff: {
        budgetMs: FILES_BUDGET_MS,
        guardMs: FILES_GUARD_MS,
        listingEntries: listingEntries.length,
        listingPages: pageDurations.length,
        listingPageP95Ms: Number(pageP95Ms.toFixed(2)),
        listingRows: listingRowCount,
        listingMergeFullMs: Number(mergeFullMs.toFixed(2)),
        listingProjectFullMs: Number(listingMs.toFixed(2)),
        documentLines: 10_000,
        documentRoundTripMs: Number(documentMs.toFixed(2)),
        diffHunks: hunks.length,
        diffSplitMs: Number(diffMs.toFixed(2)),
        rssAfterBytes: memoryAfterBytes,
        notCovered: 'first tree paint is measured in a browser lane, not here',
      },
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
