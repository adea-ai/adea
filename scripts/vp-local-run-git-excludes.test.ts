import { expect, test } from 'bun:test'

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { withGitExcludesFile } from './vp-local-run.mjs'

const repoRoot = join(import.meta.dirname, '..')

/** Git's own answer for where the shared exclude file lives: a linked worktree's `.git` is a file. */
function infoExcludePath(): string {
  const resolved = spawnSync('git', ['rev-parse', '--git-path', 'info/exclude'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  if (resolved.status !== 0) throw new Error(`git rev-parse --git-path failed: ${resolved.stderr}`)
  return resolve(repoRoot, resolved.stdout.trim())
}

/** The file's bytes, or null when it does not exist (a repository may have no exclude file). */
function readIfPresent(path: string): Buffer | null {
  return existsSync(path) ? readFileSync(path) : null
}

function localExcludesFile(): { status: number | null; stdout: string } {
  const result = spawnSync('git', ['config', '--local', '--get', 'core.excludesFile'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  return { status: result.status, stdout: result.stdout }
}

test('the borrowed-dependency exclusion reaches Git without replacing inherited config or shared excludes', () => {
  // Cleanup state is declared first and filled in as each step succeeds, so a setup step that
  // throws still reaches the finally block and removes whatever was created before it.
  let scratch: string | undefined
  let fixturePath: string | undefined
  let fixtureCreated = false
  let infoExclude: string | undefined
  let infoExcludeBefore: Buffer | null | undefined
  let localExcludesBefore: ReturnType<typeof localExcludesFile> | undefined

  try {
    scratch = mkdtempSync(join(tmpdir(), 'vp-local-git-excludes-'))
    const fixtureName = `.vp-local-excludes-${randomUUID()}`
    fixturePath = join(repoRoot, fixtureName)
    const excludeFile = join(scratch, 'exclude')
    const target = join(scratch, 'borrowed-dependency')
    infoExclude = infoExcludePath()
    infoExcludeBefore = readIfPresent(infoExclude)
    localExcludesBefore = localExcludesFile()
    const inherited = {
      ...process.env,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.quotePath',
      GIT_CONFIG_VALUE_0: 'false',
    }

    writeFileSync(excludeFile, `${fixtureName}\n`)
    writeFileSync(target, 'borrowed dependency fixture\n')
    if (existsSync(fixturePath)) throw new Error('the unique fixture path already exists')
    symlinkSync(target, fixturePath, 'file')
    fixtureCreated = true

    const env = withGitExcludesFile(inherited, excludeFile)
    expect(env.GIT_CONFIG_COUNT).toBe('2')
    expect(env.GIT_CONFIG_KEY_0).toBe('core.quotePath')
    expect(env.GIT_CONFIG_VALUE_0).toBe('false')
    expect(env.GIT_CONFIG_KEY_1).toBe('core.excludesFile')
    expect(env.GIT_CONFIG_VALUE_1).toBe(excludeFile)

    const inheritedValue = spawnSync('git', ['config', '--get', 'core.quotePath'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env,
    })
    expect(inheritedValue.status).toBe(0)
    expect(inheritedValue.stdout.trim()).toBe('false')

    const excluded = spawnSync('git', ['check-ignore', '--quiet', '--', fixtureName], {
      cwd: repoRoot,
      encoding: 'utf8',
      env,
    })
    expect(excluded.status).toBe(0)
    expect(lstatSync(fixturePath).isSymbolicLink()).toBe(true)
  } finally {
    if (fixtureCreated && fixturePath) unlinkSync(fixturePath)
    if (scratch) rmSync(scratch, { recursive: true, force: true })
    // Only compare what the test managed to record before it started.
    if (localExcludesBefore) expect(localExcludesFile()).toEqual(localExcludesBefore)
    if (infoExclude && infoExcludeBefore !== undefined)
      expect(readIfPresent(infoExclude)).toEqual(infoExcludeBefore)
  }
})
