// M12 #538 terminal endurance lane. This is a repeatable client/sidecar
// regression gate: it reruns the terminal transport and pane reducers so
// reconnect, backpressure, shell observation, and bounded state retention are
// exercised without claiming a production 24-hour soak. The acceptance run
// sets ADEA_DEV_RUNTIME_TERMINAL_ENDURANCE_DURATION_MS=86400000 and retains
// the same machine-readable summary.
import { spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'

import { writeLaneSummary } from './dev-runtime-lane-report.mjs'

const startedAt = new Date()
const command = 'bun run test:terminal-endurance'
const configuredRounds = Number(process.env.ADEA_DEV_RUNTIME_TERMINAL_ENDURANCE_ROUNDS ?? 5)
const targetDurationMs = Number(process.env.ADEA_DEV_RUNTIME_TERMINAL_ENDURANCE_DURATION_MS ?? 0)

if (!Number.isInteger(configuredRounds) || configuredRounds < 1 || configuredRounds > 10_000) {
  console.error('ADEA_DEV_RUNTIME_TERMINAL_ENDURANCE_ROUNDS must be an integer from 1 to 10000')
  process.exit(2)
}
if (!Number.isFinite(targetDurationMs) || targetDurationMs < 0 || targetDurationMs > 86_400_000) {
  console.error(
    'ADEA_DEV_RUNTIME_TERMINAL_ENDURANCE_DURATION_MS must be a number from 0 to 86400000'
  )
  process.exit(2)
}

const roundDurationsMs = []
let failure = null
let rounds = 0
const laneStarted = performance.now()
do {
  rounds += 1
  const roundStart = performance.now()
  const result = spawnSync(
    'bun',
    [
      'test',
      '--timeout',
      '120000',
      'packages/dev-view/tests/terminal-transport.test.ts',
      'packages/dev-view/tests/terminal-pane-experience.test.ts',
      'packages/dev-view/tests/terminal-shell-events.test.ts',
    ],
    { stdio: 'inherit' }
  )
  roundDurationsMs.push(Math.round(performance.now() - roundStart))
  if (result.status !== 0) {
    failure = { round, exitCode: result.status ?? 1 }
    break
  }
  if (targetDurationMs === 0 && rounds >= configuredRounds) break
} while (
  targetDurationMs === 0
    ? rounds < configuredRounds
    : performance.now() - laneStarted < targetDurationMs
)

const elapsedMs = Math.round(performance.now() - laneStarted)
await writeLaneSummary('terminal-endurance', {
  command,
  status: failure ? 'failed' : 'passed',
  startedAt,
  details: {
    rounds,
    requestedRounds: configuredRounds,
    targetDurationMs,
    elapsedMs,
    exitCode: failure ? failure.exitCode : 0,
    roundDurationsMs,
    acceptanceNote:
      targetDurationMs >= 86_400_000
        ? '24-hour client regression duration requested; pair with packaged PTY/resource evidence.'
        : 'Bounded local regression only; the 24-hour packaged PTY/resource gate remains open.',
  },
})
process.exit(failure ? failure.exitCode : 0)
