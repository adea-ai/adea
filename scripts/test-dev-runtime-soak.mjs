// Named M12 soak lane for the Dev Runtime (#426): replays the terminal-channel
// suite for ADEA_DEV_RUNTIME_SOAK_ROUNDS rounds (default 20, the short local
// verification; the 24-hour acceptance soak raises the count) to surface
// descriptor/listener/memory accumulation. Exits nonzero on the first failing
// round, after writing its retained summary artifact.
import { spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'

import { writeLaneSummary } from './dev-runtime-lane-report.mjs'

const startedAt = new Date()
const command = 'bun run test:soak:dev-runtime'
const rounds = Number(process.env.ADEA_DEV_RUNTIME_SOAK_ROUNDS ?? 20)
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 1000) {
  console.error('ADEA_DEV_RUNTIME_SOAK_ROUNDS must be an integer from 1 to 1000')
  process.exit(2)
}

const roundDurationsMs = []
let failure = null
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

await writeLaneSummary('soak', {
  command,
  status: failure ? 'failed' : 'passed',
  startedAt,
  details: {
    rounds: failure ? failure.round : rounds,
    requestedRounds: rounds,
    exitCode: failure ? failure.exitCode : 0,
    roundDurationsMs,
  },
})
process.exit(failure ? failure.exitCode : 0)
