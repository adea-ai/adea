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
import { join } from 'node:path'

import { withGitExcludesFile } from './vp-local-run.mjs'

const repoRoot = join(import.meta.dirname, '..')

test('the borrowed-dependency exclusion reaches Git without replacing inherited config or shared excludes', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'vp-local-git-excludes-'))
  const fixtureName = `.vp-local-excludes-${randomUUID()}`
  const fixturePath = join(repoRoot, fixtureName)
  const excludeFile = join(scratch, 'exclude')
  const target = join(scratch, 'borrowed-dependency')
  const infoExclude = join(repoRoot, '.git', 'info', 'exclude')
  const infoExcludeBefore = readFileSync(infoExclude)
  const localExcludesBefore = spawnSync(
    'git',
    ['config', '--local', '--get', 'core.excludesFile'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    }
  )
  const inherited = {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.quotePath',
    GIT_CONFIG_VALUE_0: 'false',
  }
  let fixtureCreated = false

  try {
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
    if (fixtureCreated) unlinkSync(fixturePath)
    const localExcludesAfter = spawnSync(
      'git',
      ['config', '--local', '--get', 'core.excludesFile'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
      }
    )
    const infoExcludeAfter = readFileSync(infoExclude)
    rmSync(scratch, { recursive: true, force: true })
    expect(localExcludesAfter.status).toBe(localExcludesBefore.status)
    expect(localExcludesAfter.stdout).toBe(localExcludesBefore.stdout)
    expect(infoExcludeAfter).toEqual(infoExcludeBefore)
  }
})
