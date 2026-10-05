// CLI resolution for GUI-process spawns: a Dock-launched app inherits
// launchd's minimal PATH, so user-installed CLIs (Homebrew above all) must be
// found through the candidate directories, with PATH still winning first.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import { resolveCliExecutable } from '../shell/src/dev-runtime/worktrees/git-run'

describe('resolveCliExecutable', () => {
  const savedPath = process.env.PATH
  const savedHome = process.env.HOME
  const dirs: string[] = []

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'adea-cli-resolution-'))
    dirs.push(dir)
    return dir
  }

  afterEach(() => {
    process.env.PATH = savedPath
    process.env.HOME = savedHome
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs.length = 0
  })

  test('a PATH hit wins over the candidate directories', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'fake-cli'), '#!/bin/sh\n')
    chmodSync(join(dir, 'fake-cli'), 0o755)
    const home = tempDir()
    mkdirSync(join(home, '.local/bin'), { recursive: true })
    writeFileSync(join(home, '.local/bin/fake-cli'), '#!/bin/sh\n')
    chmodSync(join(home, '.local/bin/fake-cli'), 0o755)
    process.env.PATH = dir
    process.env.HOME = home
    expect(resolveCliExecutable('fake-cli')).toBe(join(dir, 'fake-cli'))
  })

  test('a Homebrew-missing PATH falls through to the home-relative candidates', () => {
    const home = tempDir()
    mkdirSync(join(home, '.local/bin'), { recursive: true })
    writeFileSync(join(home, '.local/bin/fake-cli'), '#!/bin/sh\n')
    chmodSync(join(home, '.local/bin/fake-cli'), 0o755)
    process.env.PATH = ''
    process.env.HOME = home
    expect(resolveCliExecutable('fake-cli')).toBe(join(home, '.local/bin', 'fake-cli'))
  })

  test('an unknown executable resolves to null so the spawn ENOENT stays typed', () => {
    process.env.PATH = ''
    process.env.HOME = tempDir()
    expect(resolveCliExecutable('definitely-not-installed-cli')).toBeNull()
  })
})
