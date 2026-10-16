import { describe, expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loneMiss, parseVpOutput, withoutVpRemoteCache } from './vite-plus-proof.mjs'

// The Vite+ proof wrapper's --self-check mutates a fixture. It must do that in
// a disposable worktree and never touch the checkout it is run from.
const root = fileURLToPath(new URL('..', import.meta.url))
const script = join(root, 'scripts/vite-plus-proof.mjs')
const edited = 'packages/types/tests/management.test.ts'

const which = (tool: string) => execFileSync('which', [tool], { encoding: 'utf8' }).trim()
// The script is a Node script; `process.execPath` is Bun under `bun test`.
const node = which('node')

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })

const untracked = 'scripts/.vite-plus-proof-test-untracked'

// A dirty disposable checkout, never the caller's checkout. The untracked
// sentinel is already present before the self-check runs, so cleanup must keep
// its exact contents and the concurrent tracked edit intact.
function dirtyFingerprint(cwd: string) {
  return {
    status: git(cwd, 'status', '--porcelain', '--untracked-files=all'),
    diff: git(cwd, 'diff'),
    edited: readFileSync(join(cwd, edited), 'utf8'),
    untracked: readFileSync(join(cwd, untracked), 'utf8'),
    worktrees: git(cwd, 'worktree', 'list', '--porcelain'),
  }
}

function withDirtyCheckout(fn: (cwd: string) => void) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'vp-proof-dirty-checkout-')))
  let added = false
  try {
    execFileSync('git', ['-C', root, 'worktree', 'add', '--detach', cwd, 'HEAD'], {
      stdio: 'ignore',
    })
    added = true
    const editedFile = join(cwd, edited)
    writeFileSync(
      editedFile,
      `${readFileSync(editedFile, 'utf8')}\n// concurrent uncommitted edit\n`
    )
    writeFileSync(join(cwd, untracked), 'pre-existing untracked contents\n')
    fn(cwd)
  } finally {
    if (added)
      spawnSync('git', ['-C', root, 'worktree', 'remove', '--force', cwd], { stdio: 'ignore' })
    rmSync(cwd, { recursive: true, force: true })
  }
}

describe('vite-plus-proof --self-check', () => {
  // `bun` is missing from PATH, so the disposable worktree is created and the
  // install inside it fails: the failure path after the worktree exists.
  test('leaves a dirty checkout unchanged when the self-check fails', () => {
    const bin = mkdtempSync(join(tmpdir(), 'vp-proof-path-'))
    try {
      symlinkSync(which('git'), join(bin, 'git'))
      withDirtyCheckout((cwd) => {
        const before = dirtyFingerprint(cwd)
        const result = spawnSync(node, [join(cwd, 'scripts/vite-plus-proof.mjs'), '--self-check'], {
          cwd,
          encoding: 'utf8',
          env: { ...process.env, PATH: bin },
        })
        expect(result.status).not.toBe(0)
        expect(dirtyFingerprint(cwd)).toEqual(before)
      })
    } finally {
      rmSync(bin, { recursive: true, force: true })
    }
  })

  // The full run installs dependencies and executes the graph, so it is opt-in
  // and runs in the Vite+ proof workflow.
  test.skipIf(!process.env.ADEA_VP_PROOF || !existsSync(join(root, 'node_modules/.bin/vp')))(
    'leaves a dirty checkout unchanged when the self-check succeeds',
    () => {
      withDirtyCheckout((cwd) => {
        const before = dirtyFingerprint(cwd)
        const result = spawnSync(node, [join(cwd, 'scripts/vite-plus-proof.mjs'), '--self-check'], {
          cwd,
          encoding: 'utf8',
        })
        expect(result.stdout).not.toContain('FAIL')
        expect(result.status).toBe(0)
        expect(dirtyFingerprint(cwd)).toEqual(before)
      })
    },
    300_000
  )
})

describe('self-check child environment', () => {
  test('removes all Vite+ remote-cache settings but preserves local settings', () => {
    expect(
      withoutVpRemoteCache({
        PATH: '/bin',
        VITE_CACHE_PATH: '/tmp/local-task-cache',
        VP_REMOTE_CACHE_URL: 'https://cache.invalid',
        VP_REMOTE_CACHE_TOKEN: 'test-only-token',
        VP_REMOTE_CACHE_TEAM: 'test-only-team',
      })
    ).toEqual({ PATH: '/bin', VITE_CACHE_PATH: '/tmp/local-task-cache' })
  })
})

// `vp run` output as printed (colors off): one line per cache miss.
const vpOutput = (misses: string[], hits: number) =>
  [...misses, `vp run: ${hits}/12 cache hit (${Math.round((hits / 12) * 100)}%)`].join('\n')
const miss = (cwd: string, command: string) =>
  `~/${cwd}$ ${command} ○ cache miss: input changed, executing`

const parseProof = (output: string) => parseVpOutput(output, 'proof')

describe('--miss matching', () => {
  const typesTest = vpOutput([miss('packages/types', 'bun test tests')], 11)

  test('maps a miss to its task id and accepts the expected lone miss', () => {
    const result = parseVpOutput(typesTest, 'proof')
    expect(result.missed.map((entry) => entry.task)).toEqual(['types:test'])
    expect(loneMiss(result, 'types:test')).toBe(true)
  })

  test('rejects a different lone task, a build miss, several misses and no miss', () => {
    expect(
      loneMiss(
        parseProof(vpOutput([miss('packages/spatial', 'bun test ./test')], 11)),
        'types:test'
      )
    ).toBe(false)
    expect(
      loneMiss(
        parseProof(vpOutput([miss('packages/types', 'tsc -p tsconfig.json')], 11)),
        'types:test'
      )
    ).toBe(false)
    expect(
      loneMiss(
        parseProof(
          vpOutput(
            [
              miss('packages/types', 'bun test tests'),
              miss('packages/auth', 'bun test tests/unit'),
            ],
            10
          )
        ),
        'types:test'
      )
    ).toBe(false)
    expect(loneMiss(parseProof(vpOutput([], 12)), 'types:test')).toBe(false)
    // The command text is not a task id.
    expect(loneMiss(parseProof(typesTest), 'packages/types: bun test tests')).toBe(false)
  })

  test('requires the 12-task proof graph', () => {
    expect(() => parseVpOutput(typesTest.replace('/12', '/11'), 'proof')).toThrow('12-task graph')
    expect(() => parseVpOutput('nothing', 'proof')).toThrow('no cache summary')
  })
})

// Run a step of the proof workflow as the runner would: a `run:` script with
// GITHUB_OUTPUT/GITHUB_ENV files, in a throwaway checkout.
function workflowStep(name: string) {
  const lines = readFileSync(join(root, '.github/workflows/vite-plus-proof.yml'), 'utf8').split(
    '\n'
  )
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`)
  expect(start).toBeGreaterThan(-1)
  const at = lines.findIndex((line, index) => index > start && /^ {8}run:/.test(line))
  const inline = lines[at].replace(/^ {8}run: ?/, '')
  if (inline !== '|') return inline
  const body: string[] = []
  for (const line of lines.slice(at + 1)) {
    if (line.trim() && !line.startsWith('          ')) break
    body.push(line.slice(10))
  }
  return body.join('\n')
}

const parseEnvFile = (file: string) =>
  Object.fromEntries(
    readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
  )

function runStep(name: string, cwd: string, env: Record<string, string> = {}) {
  // The runner's output files live outside the checkout the step runs in.
  const files = mkdtempSync(join(tmpdir(), 'vp-proof-gh-'))
  const output = join(files, 'output')
  const envFile = join(files, 'env')
  writeFileSync(output, '')
  writeFileSync(envFile, '')
  const result = spawnSync('bash', ['-c', workflowStep(name)], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, GITHUB_OUTPUT: output, GITHUB_ENV: envFile, ...env },
  })
  try {
    expect(result.status).toBe(0)
    return { outputs: parseEnvFile(output), exported: parseEnvFile(envFile) }
  } finally {
    rmSync(files, { recursive: true, force: true })
  }
}

describe('commit trailers drive the assertion', () => {
  test('a vp-proof-miss trailer reaches the matcher as the task id', () => {
    const repo = mkdtempSync(join(tmpdir(), 'vp-proof-trailer-'))
    try {
      const run = (...args: string[]) =>
        execFileSync('git', ['-C', repo, ...args], {
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 't',
            GIT_AUTHOR_EMAIL: 't@t',
            GIT_COMMITTER_NAME: 't',
            GIT_COMMITTER_EMAIL: 't@t',
          },
          encoding: 'utf8',
        })
      run('init', '-q')
      run(
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'test(ci): edit a Bun-only file\n\nvp-proof-expect: one-miss\nvp-proof-miss: types:test\nvp-proof-manifest: abc123'
      )
      const { outputs } = runStep('Read the expected cache pattern', repo, {
        COMMIT_SHA: run('rev-parse', 'HEAD').trim(),
      })
      expect(outputs).toEqual({ expect: 'one-miss', miss: 'types:test', manifest: 'abc123' })
      const result = parseVpOutput(
        vpOutput([miss('packages/types', 'bun test tests')], 11),
        'proof'
      )
      expect(loneMiss(result, outputs.miss)).toBe(true)
      const wrong = parseVpOutput(
        vpOutput([miss('packages/auth', 'bun test tests/unit')], 11),
        'proof'
      )
      expect(loneMiss(wrong, outputs.miss)).toBe(false)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

const inherited = (value?: string) => {
  const { VITE_CACHE_PATH: _ignored, ...rest } = process.env
  return { ...rest, ...(value === undefined ? {} : { VITE_CACHE_PATH: value }) }
}

describe('VITE_CACHE_PATH', () => {
  test('the workflow exports a task-cache override under RUNNER_TEMP', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-proof-runner-temp-'))
    try {
      const expected = join(dir, 'adea-vite-plus-proof-cache')
      const { exported } = runStep('Set runner-local Vite+ cache path', root, {
        RUNNER_TEMP: dir,
      })
      expect(exported).toEqual({ VITE_CACHE_PATH: expected })
      expect(resolve(exported.VITE_CACHE_PATH)).toBe(expected)
      expect(exported.VITE_CACHE_PATH.startsWith(`${dir}/`)).toBe(true)

      // The proof wrapper must honor inherited absolute overrides, resolve
      // relative overrides, and keep the default when no override is set.
      const direct = (value?: string) =>
        spawnSync(node, [script, '--cache-path'], {
          encoding: 'utf8',
          env: inherited(value),
        }).stdout.trim()
      const custom = join(dir, 'custom-cache')
      expect(direct(custom)).toBe(custom)
      expect(direct('rel/cache')).toBe(resolve(root, 'rel/cache'))
      expect(direct()).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the workflow uses the exact Code Foundry action and its cache override contract', () => {
    const workflow = readFileSync(join(root, '.github/workflows/vite-plus-proof.yml'), 'utf8')
    const foundrySha = 'de2e9bb275a4fb16d6709893c588c922977f061d'
    expect(workflow).toContain(`CODE_FOUNDRY_SHA: ${foundrySha}`)
    expect(workflow).toContain(`uses: 0xPlayerOne/code-foundry/.github/actions/setup@${foundrySha}`)
    expect(workflow).toContain("cache-vite-plus: 'true'")
    expect(workflow).toContain('ref: ${{ env.CODE_FOUNDRY_SHA }}')
    expect(workflow).toContain('src/runtime.mjs')
    expect(workflow).toContain('src/runtime-core.mjs')
    expect(workflow).toContain('mv .github/.code-foundry "$RUNNER_TEMP/code-foundry"')
    expect(workflow).toContain('.github/actions/vite-plus-cache-save')
    expect(workflow).toContain(
      'cp -R "$RUNNER_TEMP/code-foundry/.github/actions/." .github/actions/'
    )
    expect(workflow).toContain('cache_path="$RUNNER_TEMP/adea-vite-plus-proof-cache"')
    expect(workflow).toContain('CODE_FOUNDRY_VITE_CACHE_PATHS" | grep -Fqx "$expected"')
    expect(workflow).toContain('test "$VITE_CACHE_PATH" = "$expected"')
    expect(workflow).toContain('test -n "$(find "$VITE_CACHE_PATH" -type f -print -quit)"')
    expect(workflow).toContain('uses: ./.github/actions/vite-plus-cache-save')
    expect(workflow).toContain('steps.code-foundry-setup.outputs.vite-plus-cache-path')
    expect(workflow).toContain('steps.code-foundry-setup.outputs.vite-plus-cache-key')
    expect(workflow).toContain('steps.code-foundry-setup.outputs.vite-plus-cache-save')
    expect(workflow).not.toContain('uses: actions/cache/restore@v5')
    expect(workflow).not.toContain('uses: actions/cache/save@v5')
    expect(workflow).not.toContain('vite-plus-v1')
    expect(workflow).not.toContain('uses: ./.github/actions/setup')
    expect(workflow).not.toContain("cache-vite-plus: 'false'")
  })
})
