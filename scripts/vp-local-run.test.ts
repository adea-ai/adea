import { afterAll, describe, expect, test } from 'bun:test'

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  cacheDirectory,
  defaultCacheHome,
  environmentKey,
  parseArgs,
  relevantEnvironment,
  repositoryIdentity,
  vpRunArguments,
  withLock,
} from './vp-local-run.mjs'

const scratch = mkdtempSync(join(tmpdir(), 'vp-local-run-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function checkout(name: string): string {
  const root = join(scratch, name)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'bun.lock'), '{"lock":1}\n')
  writeFileSync(join(root, 'vite.config.ts'), 'export default {}\n')
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'],
    {
      cwd: root,
    }
  )
  return root
}

const base = {
  vitePlusVersion: '1.3.0',
  nodeVersion: 'v22.11.0',
  platform: 'linux',
  arch: 'x64',
}

function key(
  root: string,
  env: Record<string, string> = {},
  overrides: Partial<typeof base> = {}
): string {
  return environmentKey({ root, env, ...base, ...overrides })
}

describe('repositoryIdentity', () => {
  test('two worktrees of one repository share an identity; an unrelated repository does not', () => {
    const main = checkout('identity-main')
    const worktree = join(scratch, 'identity-worktree')
    execFileSync('git', ['worktree', 'add', '-q', worktree, '-b', 'feature'], { cwd: main })
    const other = checkout('identity-other')

    expect(repositoryIdentity(worktree)).toBe(repositoryIdentity(main))
    expect(repositoryIdentity(other)).not.toBe(repositoryIdentity(main))
  })

  test('a directory that is not a git repository is identified by its own path', () => {
    const plain = join(scratch, 'plain')
    mkdirSync(plain, { recursive: true })
    expect(repositoryIdentity(plain)).toBe(repositoryIdentity(plain))
  })
})

describe('environmentKey', () => {
  const root = checkout('key-root')

  test('is stable for the same inputs', () => {
    expect(key(root)).toBe(key(root))
  })

  test('changes with each build-relevant environment variable and ignores unrelated ones', () => {
    const plain = key(root)
    expect(key(root, { NODE_ENV: 'production' })).not.toBe(plain)
    expect(key(root, { VITE_FEATURE: '1' })).not.toBe(plain)
    expect(key(root, { ORCH_MODE: 'x' })).not.toBe(plain)
    expect(key(root, { BUN_CONFIG_NO_CLEAR_TERMINAL: '1' })).not.toBe(plain)
    expect(key(root, { NODE_OPTIONS: '--max-old-space-size=4096' })).not.toBe(plain)
    expect(key(root, { HOME: '/elsewhere', PATH: '/bin', LANG: 'C', SHLVL: '3' })).toBe(plain)
  })

  test('the cache path that the wrapper itself sets never changes the key', () => {
    expect(key(root, { VITE_CACHE_PATH: '/tmp/anything' })).toBe(key(root))
  })

  test('changes with the lockfile, the config, the Vite+ version, the Node version and the platform', () => {
    const plain = key(root)
    const lockRoot = checkout('key-lock')
    writeFileSync(join(lockRoot, 'bun.lock'), '{"lock":2}\n')
    expect(key(lockRoot)).not.toBe(plain)

    const configRoot = checkout('key-config')
    writeFileSync(join(configRoot, 'vite.config.ts'), 'export default { run: {} }\n')
    expect(key(configRoot)).not.toBe(plain)

    expect(key(root, {}, { vitePlusVersion: '1.3.1' })).not.toBe(plain)
    expect(key(root, {}, { nodeVersion: 'v24.0.0' })).not.toBe(plain)
    expect(key(root, {}, { platform: 'darwin' })).not.toBe(plain)
    expect(key(root, {}, { arch: 'arm64' })).not.toBe(plain)
  })
})

describe('relevantEnvironment', () => {
  test('keeps only the prefixed names, sorted, and drops the wrapper-owned cache path', () => {
    expect(
      relevantEnvironment({
        VITE_B: 'b',
        HOME: '/h',
        NODE_ENV: 'test',
        VITE_CACHE_PATH: '/c',
        BUN_X: 'x',
      })
    ).toEqual([
      ['BUN_X', 'x'],
      ['NODE_ENV', 'test'],
      ['VITE_B', 'b'],
    ])
  })
})

describe('cache location', () => {
  test('one directory per repository and environment under the cache home', () => {
    const home = join(scratch, 'home')
    const repoA = cacheDirectory({ cacheHome: home, repository: '/repo/a', environment: 'e1' })
    const repoB = cacheDirectory({ cacheHome: home, repository: '/repo/b', environment: 'e1' })
    const envB = cacheDirectory({ cacheHome: home, repository: '/repo/a', environment: 'e2' })
    expect(repoA.startsWith(home)).toBe(true)
    expect(repoA).not.toBe(repoB)
    expect(repoA).not.toBe(envB)
    expect(repoA.endsWith('/e1')).toBe(true)
  })

  test('the cache home comes from ADEA_VP_CACHE_HOME, then an absolute XDG_CACHE_HOME, then ~/.cache', () => {
    expect(defaultCacheHome({ ADEA_VP_CACHE_HOME: '/x/y' })).toBe('/x/y')
    expect(defaultCacheHome({ XDG_CACHE_HOME: '/xdg' })).toBe('/xdg/adea-vp')
    expect(defaultCacheHome({ XDG_CACHE_HOME: 'relative' })).toMatch(/\.cache\/adea-vp$/)
  })
})

describe('parseArgs and vpRunArguments', () => {
  test('defaults to orch:build and passes everything after -- through', () => {
    expect(parseArgs([])).toEqual({ task: 'orch:build', passthrough: [] })
    expect(parseArgs(['orch:test', '--', '--filter', 'x'])).toEqual({
      task: 'orch:test',
      passthrough: ['--filter', 'x'],
    })
  })

  test('refuses more than one task name and names that are not plain task names', () => {
    expect(() => parseArgs(['a', 'b'])).toThrow('at most one task name')
    expect(() => parseArgs(['bad name; rm -rf /'])).toThrow('not a plain task name')
  })

  test('adds --cache locally and omits it when caching is off (CI)', () => {
    expect(vpRunArguments({ task: 'orch:build', passthrough: [], cacheEnabled: true })).toEqual([
      'run',
      '--cache',
      'orch:build',
    ])
    expect(
      vpRunArguments({ task: 'orch:build', passthrough: ['-x'], cacheEnabled: false })
    ).toEqual(['run', 'orch:build', '-x'])
  })
})

describe('withLock', () => {
  test('runs one holder at a time on a directory', async () => {
    const dir = join(scratch, 'serial', 'cache')
    const events: string[] = []
    const holder = (name: string) =>
      withLock(dir, async () => {
        events.push(`${name}:in`)
        await new Promise((done) => setTimeout(done, 80))
        events.push(`${name}:out`)
      })
    await Promise.all([holder('a'), holder('b')])
    expect(events).toHaveLength(4)
    const [first] = events
    const second = first.startsWith('a') ? 'b' : 'a'
    expect(events).toEqual([
      `${first}`,
      first.replace(':in', ':out'),
      `${second}:in`,
      `${second}:out`,
    ])
    expect(existsSync(`${dir}.lock`)).toBe(false)
  })

  test('reclaims a lock whose owner process has exited', async () => {
    const dir = join(scratch, 'stale', 'cache')
    mkdirSync(join(scratch, 'stale'), { recursive: true })
    const deadPid = spawnSync(
      process.execPath,
      ['-e', 'process.stdout.write(String(process.pid))'],
      {
        encoding: 'utf8',
      }
    ).stdout
    writeFileSync(`${dir}.lock`, deadPid)

    let ran = false
    await withLock(dir, () => {
      ran = true
    })
    expect(ran).toBe(true)
    expect(existsSync(`${dir}.lock`)).toBe(false)
  })

  test('times out rather than breaking a lock held by a live process', async () => {
    const dir = join(scratch, 'live', 'cache')
    mkdirSync(join(scratch, 'live'), { recursive: true })
    writeFileSync(`${dir}.lock`, String(process.pid))
    await expect(withLock(dir, () => 'never', { timeoutMs: 150, pollMs: 20 })).rejects.toThrow(
      'timed out waiting for the cache lock'
    )
    expect(readFileSync(`${dir}.lock`, 'utf8')).toBe(String(process.pid))
    rmSync(`${dir}.lock`)
  })

  test('releases the lock when the work throws', async () => {
    const dir = join(scratch, 'throws', 'cache')
    await expect(
      withLock(dir, () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(existsSync(`${dir}.lock`)).toBe(false)
  })
})
