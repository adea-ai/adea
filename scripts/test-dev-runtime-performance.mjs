import { performance } from 'node:perf_hooks'

import { writeLaneSummary } from './dev-runtime-lane-report.mjs'

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
  await writeLaneSummary('performance', {
    command,
    status: 'passed',
    startedAt,
    details: {
      benchmark: 'screenshot-retention-1000-captures',
      elapsedMs: Number(elapsed.toFixed(1)),
      budgetMs: 5000,
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
