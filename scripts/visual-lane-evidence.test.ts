import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const workflow = Bun.YAML.parse(
  readFileSync(resolve(import.meta.dirname, '../.github/workflows/visual-lane.yml'), 'utf8')
) as { jobs: { visual: { steps: { name?: string; run?: string }[] } } }
const command = workflow.jobs.visual.steps.find(
  (step) => step.name === 'Visual regression lane'
)!.run!

test('a later passing visual suite cannot erase an earlier failing suite evidence or status', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'visual-lane-evidence-'))
  try {
    const bin = join(fixture, 'bin')
    mkdirSync(bin)
    // Playwright cleans its output directory at the beginning of each run.
    // Emulate that lifecycle at the command boundary, using the real workflow
    // shell and arguments. No browser, snapshot or product seam is substituted.
    const runner = join(bin, 'bun')
    writeFileSync(
      runner,
      `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
const suite = args[1].endsWith(':chat') ? 'chat' : 'workspace'
const output = args.find(arg => arg.startsWith('--output='))?.slice('--output='.length) ?? 'test-results'
fs.rmSync(output, { recursive: true, force: true })
fs.mkdirSync(output, { recursive: true })
fs.writeFileSync(path.join(output, suite + '-trace.zip'), suite)
process.exit(suite === 'workspace' ? 1 : 0)
`
    )
    chmodSync(runner, 0o755)
    const result = spawnSync('bash', ['-c', command], {
      cwd: fixture,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        RUN_WORKSPACE: 'true',
        RUN_CHAT: 'true',
      },
      encoding: 'utf8',
    })
    expect(result.status, result.stderr).toBe(1)
    expect(readFileSync(join(fixture, 'test-results/workspace/workspace-trace.zip'), 'utf8')).toBe(
      'workspace'
    )
    expect(readFileSync(join(fixture, 'test-results/chat/chat-trace.zip'), 'utf8')).toBe('chat')
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})
