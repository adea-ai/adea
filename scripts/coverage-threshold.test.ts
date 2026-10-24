import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('the configured 80% coverage goal rejects uncalled functions in the real Bun runner', () => {
  const config = Bun.TOML.parse(
    readFileSync(resolve(import.meta.dir, '../bunfig.toml'), 'utf8')
  ) as {
    test: { coverageThreshold: Record<string, number>; coverageReporter: string[] }
  }
  expect(config.test.coverageThreshold).toEqual({ lines: 0.8, functions: 0.8 })
  expect(config.test.coverageReporter).toContain('text')
  const scratch = mkdtempSync(join(tmpdir(), 'coverage-goal-'))
  try {
    const threshold = Object.entries(config.test.coverageThreshold)
      .map(([key, value]) => `${key} = ${value}`)
      .join(', ')
    writeFileSync(
      join(scratch, 'bunfig.toml'),
      `[test]\ncoverageThreshold = { ${threshold} }\ncoverageSkipTestFiles = true\ncoverageReporter = ["text"]\n`
    )
    writeFileSync(
      join(scratch, 'subject.ts'),
      'export function used() { return 1 }\nexport function unused() { return 2 }\n'
    )
    const fixture = join(scratch, 'subject.test.ts')
    const run = () =>
      Bun.spawnSync([process.execPath, 'test', '--coverage'], {
        cwd: scratch,
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 10_000,
      })
    writeFileSync(
      fixture,
      "import {test,expect} from 'bun:test'\nimport {used,unused} from './subject'\ntest('fixture',()=>expect(used()).toBe(1))\n"
    )
    const below = run()
    expect(below.exitCode).toBe(1)
    // Bun 1.4.4 counts the uncalled function's line as uncovered too.
    expect(below.stdout.toString() + below.stderr.toString()).toMatch(
      /All files\s*\|\s*50\.00\s*\|\s*50\.00/
    )
    writeFileSync(
      fixture,
      "import {test,expect} from 'bun:test'\nimport {used,unused} from './subject'\ntest('fixture',()=>{expect(used()).toBe(1);expect(unused()).toBe(2)})\n"
    )
    expect(run().exitCode).toBe(0)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}, 30_000)
