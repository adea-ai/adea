import { expect, spyOn, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import * as childProcess from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fullSelection, selectLane } from './ci-lane-selection.mjs'

const selector = fileURLToPath(new URL('./ci-lane-selection.mjs', import.meta.url))
const workspaceSpec = 'apps/web/e2e/conventional-workspace.spec.ts'
const workspaceBaseline = `${workspaceSpec}-snapshots/workspace-settings-light-linux.png`
const chatSpec = 'apps/web/e2e/chat-view-visual.spec.ts'
const chatBaseline = `${chatSpec}-snapshots/chat-home-linux.png`
const realGitTimeout = 60_000

test('a change outside every lane input leaves both lanes not applicable', () => {
  const paths = ['docs/guides/setup.md', 'README.md', '.github/workflows/release.yml']
  expect(selectLane('visual', paths)).toEqual({ applicable: false, workspace: false, chat: false })
  expect(selectLane('host', paths)).toEqual({ applicable: false })
  expect(selectLane('visual', [])).toEqual({ applicable: false, workspace: false, chat: false })
})

test('shared product code runs both pixel suites instead of one sampled suite', () => {
  for (const path of [
    'apps/web/src/components/workspace-settings.tsx',
    'packages/ui/src/styles/theme.css',
    'packages/dev-view/src/chat/composer/index.ts',
    'scripts/ci-lane-selection.mjs',
    'bun.lock',
    'package.json',
    'playwright.config.ts',
    'vite.config.ts',
    'tsconfig.base.json',
    'tsconfig.json',
    'bunfig.toml',
    '.github/workflows/visual-lane.yml',
  ]) {
    expect(selectLane('visual', [path])).toEqual({ applicable: true, workspace: true, chat: true })
  }
})

test('a suite is skipped only when the change is limited to the other suite', () => {
  expect(selectLane('visual', [workspaceSpec, workspaceBaseline])).toEqual({
    applicable: true,
    workspace: true,
    chat: false,
  })
  expect(selectLane('visual', [chatSpec, chatBaseline])).toEqual({
    applicable: true,
    workspace: false,
    chat: true,
  })
  expect(selectLane('visual', [workspaceSpec, chatBaseline])).toEqual({
    applicable: true,
    workspace: true,
    chat: true,
  })
  // One shared input next to a suite-only change still needs both suites.
  expect(selectLane('visual', [workspaceSpec, 'packages/ui/src/styles/theme.css'])).toEqual({
    applicable: true,
    workspace: true,
    chat: true,
  })
})

test('the host lane follows the web, database and workflow inputs', () => {
  for (const path of [
    'apps/web/src/server/chat.ts',
    'packages/db/src/schema/index.ts',
    'scripts/e2e-setup.mjs',
    'bun.lock',
    'vite.config.ts',
    'tsconfig.base.json',
    'tsconfig.json',
    'bunfig.toml',
    'compose.yml',
    'infra/postgres/init/01-roles.sql',
    '.github/workflows/tanstack-start.yml',
  ]) {
    expect(selectLane('host', [path])).toEqual({ applicable: true })
  }
  // The visual lane's own workflow is not a host input, nor the reverse.
  expect(selectLane('host', ['.github/workflows/visual-lane.yml'])).toEqual({ applicable: false })
  expect(selectLane('visual', ['compose.yml'])).toEqual({
    applicable: false,
    workspace: false,
    chat: false,
  })
})

test('rejects an unknown lane and falls back to everything when detection cannot run', () => {
  expect(() => selectLane('nightly', [])).toThrow('Unknown lane')
  expect(fullSelection('visual')).toEqual({ applicable: true, workspace: true, chat: true })
  expect(fullSelection('host')).toEqual({ applicable: true })
})

function withRepository(run: (directory: string, git: (...args: string[]) => string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'adea-lane-selection-'))
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: directory,
      encoding: 'utf8',
    }).trim()
  try {
    git('init', '-q')
    git('config', 'user.name', 'Lane selection fixture')
    git('config', 'user.email', 'lane-selection@example.invalid')
    run(directory, git)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function commit(directory: string, git: (...args: string[]) => string, path: string) {
  mkdirSync(dirname(join(directory, path)), { recursive: true })
  writeFileSync(join(directory, path), `${path}\n${Math.random()}\n`)
  git('add', '--all')
  git('commit', '-qm', `change ${path}`)
  return git('rev-parse', 'HEAD')
}

function runSelector(
  directory: string,
  lane: string,
  eventName: string,
  event: object
): { output: string; stdout: string } {
  const runner = mkdtempSync(join(tmpdir(), 'adea-lane-selection-event-'))
  const eventPath = join(runner, 'event.json')
  const outputPath = join(runner, 'output.txt')
  writeFileSync(eventPath, JSON.stringify(event))
  writeFileSync(outputPath, '')
  try {
    const stdout = execFileSync('node', [selector, lane], {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: eventName,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: outputPath,
      },
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return { output: readFileSync(outputPath, 'utf8').trim(), stdout }
  } finally {
    rmSync(runner, { recursive: true, force: true })
  }
}

const pullRequest = (base: string, head: string) => ({
  pull_request: { base: { sha: base }, head: { sha: head } },
})

test(
  'reads the pull request diff from the event commits and writes the step outputs',
  () => {
    withRepository((directory, git) => {
      commit(directory, git, 'README.md')
      const base = git('rev-parse', 'HEAD')
      const docs = commit(directory, git, 'docs/note.md')
      const chat = commit(directory, git, chatBaseline)
      const shared = commit(directory, git, 'packages/ui/src/styles/theme.css')

      expect(runSelector(directory, 'visual', 'pull_request', pullRequest(base, docs)).output).toBe(
        'applicable=false\nworkspace=false\nchat=false'
      )
      expect(runSelector(directory, 'visual', 'pull_request', pullRequest(docs, chat)).output).toBe(
        'applicable=true\nworkspace=false\nchat=true'
      )
      expect(
        runSelector(directory, 'visual', 'pull_request', pullRequest(base, shared)).output
      ).toBe('applicable=true\nworkspace=true\nchat=true')
      expect(runSelector(directory, 'host', 'pull_request', pullRequest(base, docs)).output).toBe(
        'applicable=false'
      )
      expect(runSelector(directory, 'host', 'pull_request', pullRequest(docs, shared)).output).toBe(
        'applicable=true'
      )
    })
  },
  realGitTimeout
)

test(
  'dispatches and unreadable diffs run the full lane instead of skipping it',
  () => {
    withRepository((directory, git) => {
      const head = commit(directory, git, 'docs/note.md')
      expect(runSelector(directory, 'visual', 'workflow_dispatch', {}).output).toBe(
        'applicable=true\nworkspace=true\nchat=true'
      )
      expect(
        runSelector(directory, 'host', 'pull_request', pullRequest('0'.repeat(40), head)).output
      ).toBe('applicable=true')
      expect(
        runSelector(directory, 'visual', 'pull_request', pullRequest('f'.repeat(40), head)).output
      ).toBe('applicable=true\nworkspace=true\nchat=true')
    })
  },
  realGitTimeout
)

async function selectorEntry(
  lane: string,
  event: unknown,
  diff: string,
  eventName = 'pull_request'
) {
  const directory = mkdtempSync(join(tmpdir(), 'adea-selector-entry-'))
  const eventPath = join(directory, 'event.json')
  const outputPath = join(directory, 'output')
  writeFileSync(eventPath, typeof event === 'string' ? event : JSON.stringify(event))
  writeFileSync(outputPath, '')
  const previous = { argv: process.argv, env: process.env }
  const output = spyOn(console, 'log').mockImplementation(() => {})
  const warning = spyOn(console, 'warn').mockImplementation(() => {})
  const git = spyOn(childProcess, 'execFileSync').mockImplementation(() => diff as never)
  try {
    process.argv = [process.execPath, selector, lane]
    process.env = {
      GITHUB_EVENT_NAME: eventName,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_OUTPUT: outputPath,
    }
    await import(`./ci-lane-selection.mjs?entry=${crypto.randomUUID()}`)
    return {
      output: readFileSync(outputPath, 'utf8'),
      gitCalls: [...git.mock.calls],
      warnings: warning.mock.calls.flat().join('\n'),
    }
  } finally {
    process.argv = previous.argv
    process.env = previous.env
    git.mockRestore()
    output.mockRestore()
    warning.mockRestore()
    rmSync(directory, { recursive: true, force: true })
  }
}

test('instrumented selector binds its diff to exact immutable event refs and preserves NUL paths', async () => {
  const before = 'a'.repeat(40),
    after = 'b'.repeat(40)
  const result = await selectorEntry(
    'visual',
    pullRequest(before, after),
    'packages/ui/name\nwith-newline.ts\0'
  )
  expect(result.output).toBe('applicable=true\nworkspace=true\nchat=true\n')
  expect(result.gitCalls).toHaveLength(1)
  expect(result.gitCalls[0]?.[0]).toBe('git')
  expect(result.gitCalls[0]?.[1]).toEqual([
    'diff',
    '--no-renames',
    '--name-only',
    '-z',
    before,
    after,
  ])
  const decoy = await selectorEntry(
    'visual',
    pullRequest(before, after),
    'docs/note\npackages/ui/decoy.ts\0'
  )
  expect(decoy.output).toBe('applicable=false\nworkspace=false\nchat=false\n')
  expect(decoy.gitCalls).toHaveLength(1)
})

test('instrumented selector skips docs-only input and never guesses an invalid event diff', async () => {
  const refs = pullRequest('a'.repeat(40), 'b'.repeat(40))
  expect((await selectorEntry('visual', refs, 'docs/note.md\0')).output).toBe(
    'applicable=false\nworkspace=false\nchat=false\n'
  )
  for (const event of [
    pullRequest('0'.repeat(40), 'b'.repeat(40)),
    pullRequest('A'.repeat(40), 'b'.repeat(40)),
    '{invalid',
  ]) {
    const result = await selectorEntry('visual', event, '')
    expect(result.output).toBe('applicable=true\nworkspace=true\nchat=true\n')
    expect(result.gitCalls).toHaveLength(0)
    expect(result.warnings).toContain('Change detection failed')
  }
  const dispatched = await selectorEntry('host', {}, '', 'workflow_dispatch')
  expect(dispatched.output).toBe('applicable=true\n')
  expect(dispatched.gitCalls).toHaveLength(0)
  await expect(selectorEntry('unknown', {}, '')).rejects.toThrow('Usage:')
})
