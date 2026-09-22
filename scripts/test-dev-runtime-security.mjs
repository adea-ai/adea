// Named M12 security/adversarial lane for the Dev Runtime (#426): the M10
// shell-channel boundary, browser lane hardening, vault, and terminal input
// authority suites. Suites run serially with explicit per-test timeouts and
// the lane exits nonzero when any suite fails, after writing its retained
// summary artifact.
import { spawnSync } from 'node:child_process'

import { writeLaneSummary } from './dev-runtime-lane-report.mjs'

const startedAt = new Date()
const command = 'bun run test:security:dev-runtime'

const suites = [
  'apps/desktop/tests/dev-runtime-command-matrix.test.ts',
  'apps/desktop/tests/shell-channel.test.ts',
  'apps/desktop/tests/dev-runtime-browser.test.ts',
  'apps/desktop/tests/dev-runtime-vault.test.ts',
  'apps/desktop/tests/terminal-input-authority.test.ts',
]

const results = []
for (const suite of suites) {
  const run = spawnSync('bun', ['test', '--timeout', '120000', suite], {
    stdio: 'inherit',
    env: process.env,
  })
  results.push({ suite, exitCode: run.status ?? 1 })
  if (run.status !== 0) {
    console.error(`Dev Runtime security suite failed: ${suite}`)
    break
  }
}

const failed = results.find((result) => result.exitCode !== 0)
await writeLaneSummary('security', {
  command,
  status: failed ? 'failed' : 'passed',
  startedAt,
  details: { suites: results },
})
process.exit(failed ? failed.exitCode : 0)
