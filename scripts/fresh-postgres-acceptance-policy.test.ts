import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

// The fresh-account policy suite is a Node test file, because the runner it
// exercises is a Node program. It lives below `scripts/`, so the ordinary
// lane's `scripts/*.test.ts` selection does not reach it. This wrapper runs
// it in the ordinary lane, so the policy gates and the fresh-account rule are
// covered by the same checks that run on every pull request.
//
// The suite needs the repository toolchain's Node on the path. It is the same
// Node the repository's own scripts use, and a missing one is a toolchain
// failure rather than a reason to pass quietly.

const root = resolve(import.meta.dir, '..')
const policySuite = 'scripts/fresh-postgres-acceptance/policy.test.mjs'

/**
 * Runs the policy suite under Node.
 *
 * A failure to start the process is not a result of the suite, so it is
 * retried once. A suite that runs and fails is never retried: the result is
 * the result.
 */
function runPolicySuite() {
  let result = spawnSync('node', ['--test', policySuite], {
    cwd: root,
    encoding: 'utf8',
    timeout: 180_000,
    killSignal: 'SIGKILL',
  })
  if (result.error) {
    result = spawnSync('node', ['--test', policySuite], {
      cwd: root,
      encoding: 'utf8',
      timeout: 180_000,
      killSignal: 'SIGKILL',
    })
  }
  return result
}

describe('the fresh-account policy suite', () => {
  test('passes under the repository toolchain', () => {
    const result = runPolicySuite()
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    expect(result.error?.message ?? '').toBe('')
    expect(result.status, output).toBe(0)
    expect(output).toContain('the fresh-account rule catches every construct it claims to catch')
    expect(output).not.toMatch(/^fail \d+$/m)
  }, 180_000)
})
