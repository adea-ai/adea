import { afterAll, describe, expect, spyOn, test } from 'bun:test'

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  checkoutState,
  defaultCacheHome,
  ensurePrivateDirectory,
  environmentKey,
  exitCodeFor,
  LockRefused,
  main as runCommand,
  parseArgs,
  planCache,
  readVitePlusVersion,
  relevantEnvironment,
  runVp,
  runUnderLock,
  vpRunArguments,
  withLock,
} from './vp-local-run.mjs'

// The real path of the temporary directory: on macOS it is a symbolic link, and the guard refuses links.
const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'vp-local-run-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const MODULE = fileURLToPath(new URL('./vp-local-run.mjs', import.meta.url))
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim()
}

function checkout(name: string): string {
  const root = join(scratch, name)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'bun.lock'), '{"lock":1}\n')
  writeFileSync(join(root, 'vite.config.ts'), 'export default {}\n')
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'init')
  return root
}

function commitAll(root: string, message: string): void {
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', message)
}

function deadPid(): number {
  return Number(
    spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
      encoding: 'utf8',
    }).stdout
  )
}

const toolchain = {
  nodeVersion: 'v22.11.0',
  platform: 'linux',
  arch: 'x64',
  vitePlusVersion: '1.3.0',
  home: '/home/tester',
}

const planFor = (root: string, env: Record<string, string> = {}, home = '/cache/home') =>
  planCache({ root, env: { ADEA_VP_CACHE_HOME: home, ...env }, ...toolchain })

/** A lock or run record in the form the wrapper writes: the process id and a fresh token. */
const token = (pid: number) => `${pid}\n${randomUUID()}`

describe('checkoutState', () => {
  test('reports the commit, and dirtiness from tracked edits and untracked files', () => {
    const root = checkout('state')
    const head = git(root, 'rev-parse', 'HEAD')
    expect(checkoutState(root)).toEqual({ head, dirty: false })

    writeFileSync(join(root, 'bun.lock'), '{"lock":9}\n')
    expect(checkoutState(root)).toEqual({ head, dirty: true })
    git(root, 'checkout', '--', 'bun.lock')

    writeFileSync(join(root, 'untracked.txt'), 'x')
    expect(checkoutState(root)).toEqual({ head, dirty: true })
  })

  test('a directory that is not a git repository has no commit and counts as dirty', () => {
    const plain = join(scratch, 'not-git')
    mkdirSync(plain, { recursive: true })
    expect(checkoutState(plain)).toEqual({ head: null, dirty: true })
  })
})

describe('environmentKey', () => {
  const root = checkout('key-root')

  test('is stable for the same inputs', () => {
    expect(environmentKey({ root, env: {}, ...toolchain })).toBe(
      environmentKey({ root, env: {}, ...toolchain })
    )
  })

  test('changes with each build-relevant environment variable and ignores unrelated ones', () => {
    const plain = environmentKey({ root, env: {}, ...toolchain })
    const key = (env: Record<string, string>) => environmentKey({ root, env, ...toolchain })
    expect(key({ NODE_ENV: 'production' })).not.toBe(plain)
    expect(key({ VITE_FEATURE: '1' })).not.toBe(plain)
    expect(key({ ORCH_MODE: 'x' })).not.toBe(plain)
    expect(key({ BUN_CONFIG_NO_CLEAR_TERMINAL: '1' })).not.toBe(plain)
    expect(key({ NODE_OPTIONS: '--max-old-space-size=4096' })).not.toBe(plain)
    expect(key({ HOME: '/elsewhere', PATH: '/bin', LANG: 'C', SHLVL: '3' })).toBe(plain)
    expect(key({ VITE_CACHE_PATH: '/tmp/anything' })).toBe(plain)
  })

  test('changes with the lockfile, the config, the Vite+ version, the Node version and the platform', () => {
    const plain = environmentKey({ root, env: {}, ...toolchain })
    const lockRoot = checkout('key-lock')
    writeFileSync(join(lockRoot, 'bun.lock'), '{"lock":2}\n')
    expect(environmentKey({ root: lockRoot, env: {}, ...toolchain })).not.toBe(plain)

    const configRoot = checkout('key-config')
    writeFileSync(join(configRoot, 'vite.config.ts'), 'export default { run: {} }\n')
    expect(environmentKey({ root: configRoot, env: {}, ...toolchain })).not.toBe(plain)

    const other = (overrides: Partial<typeof toolchain>) =>
      environmentKey({ root, env: {}, ...toolchain, ...overrides })
    expect(other({ vitePlusVersion: '1.3.1' })).not.toBe(plain)
    expect(other({ nodeVersion: 'v24.0.0' })).not.toBe(plain)
    expect(other({ platform: 'darwin' })).not.toBe(plain)
    expect(other({ arch: 'arm64' })).not.toBe(plain)
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

describe('cache home', () => {
  test('ADEA_VP_CACHE_HOME first, then an absolute XDG_CACHE_HOME, then the home directory', () => {
    expect(defaultCacheHome({ ADEA_VP_CACHE_HOME: '/x/y' }, '/h')).toBe('/x/y')
    expect(defaultCacheHome({ XDG_CACHE_HOME: '/xdg' }, '/h')).toBe('/xdg/adea-vp')
    expect(defaultCacheHome({}, '/h')).toBe('/h/.cache/adea-vp')
  })

  test('relative values are ignored, and no absolute home means no shared cache at all', () => {
    expect(defaultCacheHome({ ADEA_VP_CACHE_HOME: 'rel' }, '/h')).toBe('/h/.cache/adea-vp')
    expect(defaultCacheHome({ XDG_CACHE_HOME: 'rel' }, '/h')).toBe('/h/.cache/adea-vp')
    expect(defaultCacheHome({}, '')).toBeNull()
    expect(defaultCacheHome({ ADEA_VP_CACHE_HOME: 'rel' }, 'relative-home')).toBeNull()
  })
})

describe('planCache', () => {
  test('CI and an explicit VITE_CACHE_PATH bypass the shared cache and name no directory', () => {
    const root = checkout('plan-bypass')
    expect(planFor(root, { CI: '1' })).toEqual({ mode: 'bypass', reason: 'CI is set' })
    const explicit = planFor(root, { VITE_CACHE_PATH: 'relative/or/absolute' })
    expect(explicit.mode).toBe('bypass')
    expect(explicit).not.toHaveProperty('directory')
  })

  test('a clean checkout uses a directory keyed by its commit and the environment', () => {
    const root = checkout('plan-clean')
    const head = git(root, 'rev-parse', 'HEAD')
    const plan = planFor(root)
    expect(plan.mode).toBe('clean')
    expect(plan.directory).toContain(`head-${head}`)
    expect(plan.directory.startsWith('/cache/home/repo-')).toBe(true)
  })

  test('clean worktrees of one repository at one commit share a directory; a later commit gets its own', () => {
    const main = checkout('plan-share')
    const worktree = join(scratch, 'plan-share-worktree')
    git(main, 'worktree', 'add', '-q', '--detach', worktree)
    expect(planFor(worktree).directory).toBe(planFor(main).directory)

    writeFileSync(join(main, 'next.txt'), 'n')
    commitAll(main, 'next')
    expect(planFor(main).directory).not.toBe(planFor(worktree).directory)
    expect(planFor(main).mode).toBe('clean')
  })

  test('an unrelated repository never shares a directory, even at the same commit', () => {
    const first = checkout('plan-unrelated-a')
    const second = checkout('plan-unrelated-b')
    expect(planFor(first).directory).not.toBe(planFor(second).directory)
  })

  test('a changed environment selects another directory and returning to it selects the first again', () => {
    const root = checkout('plan-env')
    const first = planFor(root).directory
    expect(planFor(root, { NODE_ENV: 'production' }).directory).not.toBe(first)
    expect(planFor(root).directory).toBe(first)
  })

  test('local changes and untracked files isolate the checkout; reverting restores the shared directory', () => {
    const main = checkout('plan-dirty')
    const shared = planFor(main).directory
    writeFileSync(join(main, 'bun.lock'), '{"lock":7}\n')
    const dirty = planFor(main)
    expect(dirty.mode).toBe('working')
    expect(dirty.reason).toBe('local changes or untracked files')
    expect(dirty.directory).not.toBe(shared)

    git(main, 'checkout', '--', 'bun.lock')
    writeFileSync(join(main, 'scratch.txt'), 'x')
    expect(planFor(main).mode).toBe('working')
    rmSync(join(main, 'scratch.txt'))
    expect(planFor(main).directory).toBe(shared)
  })

  test('two checkouts in the same dirty state never share a working directory', () => {
    const first = checkout('plan-iso-a')
    const second = checkout('plan-iso-b')
    writeFileSync(join(first, 'scratch.txt'), 'x')
    writeFileSync(join(second, 'scratch.txt'), 'x')
    expect(planFor(first).directory).not.toBe(planFor(second).directory)
  })

  test('a checkout with no commit is working and says so', () => {
    const plain = join(scratch, 'plan-no-commit')
    mkdirSync(plain, { recursive: true })
    const plan = planFor(plain)
    expect(plan.mode).toBe('working')
    expect(plan.reason).toBe('no commit')
  })

  test('no absolute cache home means bypass, not a relative directory', () => {
    const root = checkout('plan-no-home')
    const plan = planCache({
      root,
      env: { ADEA_VP_CACHE_HOME: 'relative' },
      ...toolchain,
      home: '',
    })
    expect(plan).toEqual({ mode: 'bypass', reason: 'no absolute cache home' })
  })
})

describe('ensurePrivateDirectory', () => {
  test('creates the directory and its components under the cache home', () => {
    const home = join(scratch, 'ensure-home')
    const target = join(home, 'repo', 'head-x', 'env')
    ensurePrivateDirectory(home, target)
    expect(lstatSync(target).isDirectory()).toBe(true)
    expect(lstatSync(home).isDirectory()).toBe(true)
  })

  test('refuses a symbolic link anywhere on the path and writes nothing through it', () => {
    const home = join(scratch, 'ensure-link')
    const elsewhere = join(scratch, 'ensure-elsewhere')
    mkdirSync(home, { recursive: true })
    mkdirSync(elsewhere, { recursive: true })
    symlinkSync(elsewhere, join(home, 'repo'))
    expect(() => ensurePrivateDirectory(home, join(home, 'repo', 'x'))).toThrow('symbolic link')
    expect(existsSync(join(elsewhere, 'x'))).toBe(false)
  })

  test('refuses a symbolic link as the cache home itself', () => {
    const real = join(scratch, 'ensure-real-home')
    const link = join(scratch, 'ensure-home-link')
    mkdirSync(real, { recursive: true })
    symlinkSync(real, link)
    expect(() => ensurePrivateDirectory(link, join(link, 'repo', 'x'))).toThrow('symbolic link')
    expect(existsSync(join(real, 'repo'))).toBe(false)
  })

  test('refuses a component that group members can write to', () => {
    const home = join(scratch, 'ensure-group')
    mkdirSync(join(home, 'repo'), { recursive: true })
    chmodSync(join(home, 'repo'), 0o770)
    expect(() => ensurePrivateDirectory(home, join(home, 'repo', 'x'))).toThrow(
      'writable by group or others'
    )
    chmodSync(join(home, 'repo'), 0o700)
  })

  test('refuses a component that other users can write to', () => {
    const home = join(scratch, 'ensure-open')
    mkdirSync(join(home, 'repo'), { recursive: true })
    chmodSync(join(home, 'repo'), 0o777)
    expect(() => ensurePrivateDirectory(home, join(home, 'repo', 'x'))).toThrow(
      'writable by group or others'
    )
    chmodSync(join(home, 'repo'), 0o700)
  })

  test('refuses a world-writable ancestor above the home, and accepts a sticky one', () => {
    const open = join(scratch, 'ensure-ancestor-open')
    mkdirSync(join(open, 'home'), { recursive: true })
    chmodSync(open, 0o777)
    expect(() => ensurePrivateDirectory(join(open, 'home'), join(open, 'home', 'x'))).toThrow(
      'writable by group or others'
    )
    expect(existsSync(join(open, 'home'))).toBe(true)
    expect(existsSync(join(open, 'home', 'x'))).toBe(false)
    chmodSync(open, 0o1777)
    ensurePrivateDirectory(join(open, 'home'), join(open, 'home', 'x'))
    expect(lstatSync(join(open, 'home', 'x')).isDirectory()).toBe(true)
    chmodSync(open, 0o700)
  })

  test('a fresh machine with no ~/.cache creates the missing ancestors with owner-only mode', () => {
    const base = join(scratch, 'fresh-machine')
    mkdirSync(base, { recursive: true })
    const home = join(base, '.cache', 'adea-vp')
    const target = join(home, 'repo', 'head-x', 'env')
    expect(existsSync(join(base, '.cache'))).toBe(false)
    ensurePrivateDirectory(home, target)
    expect(lstatSync(join(base, '.cache')).isDirectory()).toBe(true)
    expect(lstatSync(join(base, '.cache')).mode & 0o777).toBe(0o700)
    expect(lstatSync(target).isDirectory()).toBe(true)
    expect(realpathSync(target)).toBe(target)
  })

  test('a missing ancestor does not excuse an existing insecure one above it', () => {
    const open = join(scratch, 'fresh-open')
    mkdirSync(open, { recursive: true })
    chmodSync(open, 0o777)
    expect(() =>
      ensurePrivateDirectory(join(open, 'missing', 'home'), join(open, 'missing', 'home', 'x'))
    ).toThrow('writable by group or others')
    expect(existsSync(join(open, 'missing'))).toBe(false)
    chmodSync(open, 0o700)
  })

  test('refuses a target outside the cache home', () => {
    expect(() => ensurePrivateDirectory(join(scratch, 'h1'), join(scratch, 'h2', 'x'))).toThrow(
      'outside the cache home'
    )
  })
})

describe('parseArgs, vpRunArguments and exit codes', () => {
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

  test('adds --cache only when a cache is in use', () => {
    expect(vpRunArguments({ task: 'orch:build', passthrough: [], cacheEnabled: true })).toEqual([
      'run',
      '--cache',
      'orch:build',
    ])
    expect(
      vpRunArguments({ task: 'orch:build', passthrough: ['-x'], cacheEnabled: false })
    ).toEqual(['run', 'orch:build', '-x'])
  })

  test('a run stopped by a signal exits non-zero whatever vp reported', () => {
    expect(exitCodeFor({ code: 0, signal: 'SIGINT' })).toBe(130)
    expect(exitCodeFor({ code: 0, signal: 'SIGTERM' })).toBe(143)
    expect(exitCodeFor({ code: 0, signal: null })).toBe(0)
    expect(exitCodeFor({ code: 2, signal: null })).toBe(2)
    expect(exitCodeFor({ code: null, signal: null })).toBe(1)
  })
})

describe('withLock', () => {
  test('runs one holder at a time on a directory', async () => {
    const dir = join(scratch, 'serial', 'cache')
    const events: string[] = []
    const holder = (name: string) =>
      withLock(dir, async () => {
        events.push(`${name}:in`)
        await sleep(80)
        events.push(`${name}:out`)
      })
    await Promise.all([holder('a'), holder('b')])
    expect(events).toHaveLength(4)
    const first = events[0].split(':')[0]
    const second = first === 'a' ? 'b' : 'a'
    expect(events).toEqual([`${first}:in`, `${first}:out`, `${second}:in`, `${second}:out`])
    expect(existsSync(`${dir}.lock`)).toBe(false)
  })

  test('reclaims a lock whose owner process has exited', async () => {
    const dir = join(scratch, 'stale', 'cache')
    mkdirSync(join(scratch, 'stale'), { recursive: true })
    writeFileSync(`${dir}.lock`, token(deadPid()))

    let ran = false
    await withLock(dir, () => {
      ran = true
    })
    expect(ran).toBe(true)
    expect(existsSync(`${dir}.lock`)).toBe(false)
    expect(existsSync(`${dir}.lock.reclaim`)).toBe(false)
  })

  test('times out rather than breaking a lock held by a live process', async () => {
    const dir = join(scratch, 'live', 'cache')
    mkdirSync(join(scratch, 'live'), { recursive: true })
    const held = token(process.pid)
    writeFileSync(`${dir}.lock`, held)
    await expect(withLock(dir, () => 'never', { timeoutMs: 150, pollMs: 20 })).rejects.toThrow(
      'timed out waiting for the cache lock'
    )
    expect(readFileSync(`${dir}.lock`, 'utf8')).toBe(held)
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

  test('an empty lock file is refused, kept, and the wait does not run to its timeout', async () => {
    const dir = join(scratch, 'empty', 'cache')
    mkdirSync(join(scratch, 'empty'), { recursive: true })
    writeFileSync(`${dir}.lock`, '')
    const started = Date.now()
    await expect(
      withLock(dir, () => 'never', { timeoutMs: 5000, pollMs: 10 })
    ).rejects.toBeInstanceOf(LockRefused)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(readFileSync(`${dir}.lock`, 'utf8')).toBe('')
  })

  test('malformed and foreign lock contents are refused and kept', async () => {
    const dir = join(scratch, 'malformed', 'cache')
    mkdirSync(join(scratch, 'malformed'), { recursive: true })
    for (const content of ['garbage', '0\nx', `${process.pid}\nnot-a-token`, `${process.pid}\n`]) {
      writeFileSync(`${dir}.lock`, content)
      await expect(
        withLock(dir, () => 'never', { timeoutMs: 2000, pollMs: 10 })
      ).rejects.toBeInstanceOf(LockRefused)
      expect(readFileSync(`${dir}.lock`, 'utf8')).toBe(content)
    }
    rmSync(`${dir}.lock`)
  })

  test('a lock that is a symbolic link is refused and the link and its target are kept', async () => {
    const dir = join(scratch, 'linked', 'cache')
    mkdirSync(join(scratch, 'linked'), { recursive: true })
    const target = join(scratch, 'linked', 'target.txt')
    writeFileSync(target, token(deadPid()))
    symlinkSync(target, `${dir}.lock`)
    await expect(
      withLock(dir, () => 'never', { timeoutMs: 2000, pollMs: 10 })
    ).rejects.toBeInstanceOf(LockRefused)
    expect(lstatSync(`${dir}.lock`).isSymbolicLink()).toBe(true)
    expect(existsSync(target)).toBe(true)
  })

  test('a stale reclaim mutex is never broken by its age: the wait is bounded and nothing is removed', async () => {
    const dir = join(scratch, 'stale-mutex', 'cache')
    mkdirSync(join(scratch, 'stale-mutex'), { recursive: true })
    const dead = token(deadPid())
    writeFileSync(`${dir}.lock`, dead)
    const mutex = `${dir}.lock.reclaim`
    writeFileSync(mutex, token(deadPid()))
    utimesSync(mutex, new Date('2000-01-01'), new Date('2000-01-01'))

    await expect(withLock(dir, () => 'never', { timeoutMs: 300, pollMs: 10 })).rejects.toThrow(
      'the reclaim mutex'
    )
    expect(readFileSync(`${dir}.lock`, 'utf8')).toBe(dead)
    expect(existsSync(mutex)).toBe(true)
    rmSync(`${dir}.lock`)
    rmSync(mutex)
  })

  test('a successor cannot take the lock between the removal of a stale run record and the removal of its lock', async () => {
    const dir = join(scratch, 'run-cleanup', 'cache')
    mkdirSync(join(scratch, 'run-cleanup'), { recursive: true })
    const dead = token(deadPid())
    writeFileSync(`${dir}.lock`, dead)
    writeFileSync(`${dir}.lock.run`, `${deadPid()}\n${dead.split('\n')[1]}`)

    let paused!: () => void
    const atPause = new Promise<void>((done) => (paused = done))
    let resume!: () => void
    const gate = new Promise<void>((done) => (resume = done))
    const first = withLock(dir, async () => 'first-ran', {
      pollMs: 5,
      timeoutMs: 5000,
      hooks: {
        reclaimRunRemoved: async () => {
          paused()
          await gate
        },
      },
    })
    await atPause
    // The reclaimer is between the two removals: the run record is gone, and the stale lock still excludes a successor.
    expect(existsSync(`${dir}.lock.run`)).toBe(false)
    expect(readFileSync(`${dir}.lock`, 'utf8')).toBe(dead)
    await expect(withLock(dir, () => 'second-ran', { pollMs: 5, timeoutMs: 300 })).rejects.toThrow(
      'timed out waiting for the cache lock'
    )
    expect(existsSync(`${dir}.lock.run`)).toBe(false)

    resume()
    expect(await first).toBe('first-ran')
    expect(existsSync(`${dir}.lock`)).toBe(false)
    expect(existsSync(`${dir}.lock.reclaim`)).toBe(false)
  })

  test('a run record left by an earlier run is kept and nothing runs under the lock', async () => {
    const dir = join(scratch, 'leftover', 'cache')
    mkdirSync(join(scratch, 'leftover'), { recursive: true })
    for (const leftover of [`${process.pid}\n${randomUUID()}`, 'garbage']) {
      writeFileSync(`${dir}.lock.run`, leftover)
      let ran = false
      await expect(
        withLock(dir, () => {
          ran = true
        })
      ).rejects.toBeInstanceOf(LockRefused)
      expect(ran).toBe(false)
      expect(readFileSync(`${dir}.lock.run`, 'utf8')).toBe(leftover)
      expect(existsSync(`${dir}.lock`)).toBe(false)
      rmSync(`${dir}.lock.run`)
    }

    const target = join(scratch, 'leftover', 'target.txt')
    writeFileSync(target, 'elsewhere')
    symlinkSync(target, `${dir}.lock.run`)
    await expect(withLock(dir, () => 'never')).rejects.toBeInstanceOf(LockRefused)
    expect(lstatSync(`${dir}.lock.run`).isSymbolicLink()).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('elsewhere')
    expect(existsSync(`${dir}.lock`)).toBe(false)
    rmSync(`${dir}.lock.run`)
  })

  test('a reclaimer suspended while it holds the mutex keeps a second reclaimer out until it finishes', async () => {
    const dir = join(scratch, 'suspended', 'cache')
    mkdirSync(join(scratch, 'suspended'), { recursive: true })
    writeFileSync(`${dir}.lock`, token(deadPid()))

    let holding!: () => void
    const holds = new Promise<void>((done) => (holding = done))
    let release!: () => void
    const gate = new Promise<void>((done) => (release = done))

    const first = withLock(dir, async () => 'first-ran', {
      pollMs: 5,
      timeoutMs: 5000,
      hooks: {
        reclaimLocked: async () => {
          holding()
          await gate
        },
      },
    })
    await holds

    const second = withLock(dir, () => 'second-ran', { pollMs: 5, timeoutMs: 300 })
    await expect(second).rejects.toThrow('the reclaim mutex')
    expect(existsSync(`${dir}.lock.reclaim`)).toBe(true)

    release()
    expect(await first).toBe('first-ran')
    expect(existsSync(`${dir}.lock`)).toBe(false)
    expect(existsSync(`${dir}.lock.reclaim`)).toBe(false)
  })

  test('a reclaimer that read a dead owner before a successor took the lock never unlinks that successor', async () => {
    const dir = join(scratch, 'successor', 'cache')
    mkdirSync(join(scratch, 'successor'), { recursive: true })
    writeFileSync(`${dir}.lock`, token(deadPid()))

    // B reads the dead owner, then pauses before it reclaims.
    let bReadStale!: () => void
    const bRead = new Promise<void>((done) => (bReadStale = done))
    let releaseB!: () => void
    const bGate = new Promise<void>((done) => (releaseB = done))
    // A reclaims the same dead owner, takes the lock, and holds it while its work is paused.
    let aWorking!: () => void
    const aWorks = new Promise<void>((done) => (aWorking = done))
    let releaseA!: () => void
    const aGate = new Promise<void>((done) => (releaseA = done))

    const b = withLock(dir, async () => 'B-ran', {
      pollMs: 5,
      timeoutMs: 5000,
      hooks: {
        staleObserved: async () => {
          bReadStale()
          await bGate
        },
      },
    })
    await bRead

    const a = withLock(
      dir,
      async () => {
        aWorking()
        await aGate
        return 'A-ran'
      },
      { pollMs: 5 }
    )
    await aWorks
    const ownedByA = readFileSync(`${dir}.lock`, 'utf8')
    expect(ownedByA.startsWith(`${process.pid}\n`)).toBe(true)

    // B resumes with an observation that is now stale. It must leave A's live lock alone.
    releaseB()
    await sleep(60)
    expect(readFileSync(`${dir}.lock`, 'utf8')).toBe(ownedByA)

    releaseA()
    expect(await a).toBe('A-ran')
    expect(await b).toBe('B-ran')
    expect(existsSync(`${dir}.lock`)).toBe(false)
    expect(existsSync(`${dir}.lock.reclaim`)).toBe(false)
  })

  test('a recorded process group keeps the lock held after its owner is killed, and the lock is reclaimed once the group is gone', async () => {
    const dir = join(scratch, 'descendant', 'cache')
    mkdirSync(join(scratch, 'descendant'), { recursive: true })
    // The descendant is started by this process, so its exit is reaped here.
    const group = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      detached: true,
      stdio: 'ignore',
    })
    const groupPid = group.pid!
    const owner = join(scratch, 'descendant', 'owner.mjs')
    writeFileSync(
      owner,
      [
        'const { withLock } = await import(process.env.VP_MODULE)',
        'await withLock(process.env.VP_DIR, async (register) => {',
        '  register(Number(process.env.VP_GROUP))',
        '  console.log("registered")',
        '  await new Promise(() => {})',
        '})',
        '',
      ].join('\n')
    )
    const child = spawn(process.execPath, [owner], {
      env: { ...process.env, VP_MODULE: MODULE, VP_DIR: dir, VP_GROUP: String(groupPid) },
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    await new Promise<void>((done) => child.stdout!.once('data', () => done()))
    child.kill('SIGKILL')
    await new Promise((done) => child.once('exit', done))

    const lockedBy = readFileSync(`${dir}.lock`, 'utf8')
    await expect(withLock(dir, () => 'never', { timeoutMs: 300, pollMs: 20 })).rejects.toThrow(
      'timed out waiting for the cache lock'
    )
    expect(readFileSync(`${dir}.lock`, 'utf8')).toBe(lockedBy)

    process.kill(-groupPid, 'SIGKILL')
    await new Promise((done) => group.once('exit', done))
    expect(await withLock(dir, () => 'reclaimed', { timeoutMs: 2000, pollMs: 10 })).toBe(
      'reclaimed'
    )
    expect(existsSync(`${dir}.lock`)).toBe(false)
    expect(existsSync(`${dir}.lock.run`)).toBe(false)
  })

  test('an owner that exits normally while a group it recorded still runs leaves the lock held until that group exits', async () => {
    const dir = join(scratch, 'returns-with-group', 'cache')
    mkdirSync(join(scratch, 'returns-with-group'), { recursive: true })
    // The group is started by this process, so its exit is reaped here; the owner is a separate process that exits.
    const group = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      detached: true,
      stdio: 'ignore',
    })
    const groupPid = group.pid!
    const owner = join(scratch, 'returns-with-group', 'owner.mjs')
    writeFileSync(
      owner,
      [
        'const { withLock } = await import(process.env.VP_MODULE)',
        'await withLock(process.env.VP_DIR, async (register) => {',
        '  register(Number(process.env.VP_GROUP))',
        '})',
        '',
      ].join('\n')
    )
    const code = await new Promise<number | null>((done) => {
      spawn(process.execPath, [owner], {
        env: { ...process.env, VP_MODULE: MODULE, VP_DIR: dir, VP_GROUP: String(groupPid) },
        stdio: 'ignore',
      }).on('exit', done)
    })
    expect(code).toBe(0)
    expect(existsSync(`${dir}.lock`)).toBe(true)
    await expect(withLock(dir, () => 'never', { timeoutMs: 200, pollMs: 20 })).rejects.toThrow(
      'timed out waiting for the cache lock'
    )

    process.kill(-groupPid, 'SIGKILL')
    await new Promise((done) => group.once('exit', done))
    expect(await withLock(dir, () => 'reclaimed', { timeoutMs: 2000, pollMs: 10 })).toBe(
      'reclaimed'
    )
    expect(existsSync(`${dir}.lock`)).toBe(false)
    expect(existsSync(`${dir}.lock.run`)).toBe(false)
  })

  test('separate processes contending on one directory, starting from a dead owner, never overlap', async () => {
    const dir = join(scratch, 'multi', 'cache')
    mkdirSync(join(scratch, 'multi'), { recursive: true })
    writeFileSync(`${dir}.lock`, token(deadPid()))
    const log = join(scratch, 'multi', 'log.txt')
    const child = join(scratch, 'multi', 'child.mjs')
    writeFileSync(
      child,
      [
        "import { appendFileSync } from 'node:fs'",
        'const { withLock } = await import(process.env.VP_MODULE)',
        'const log = process.env.VP_LOG',
        'await withLock(process.env.VP_DIR, async () => {',
        '  appendFileSync(log, `in ${process.pid}\\n`)',
        '  await new Promise((done) => setTimeout(done, 40))',
        '  appendFileSync(log, `out ${process.pid}\\n`)',
        '}, { timeoutMs: 30000 })',
        '',
      ].join('\n')
    )

    const run = () =>
      new Promise<number | null>((done) => {
        const proc = spawn(process.execPath, [child], {
          env: { ...process.env, VP_MODULE: MODULE, VP_DIR: dir, VP_LOG: log },
          stdio: 'ignore',
        })
        proc.on('exit', (code) => done(code))
      })
    const codes = await Promise.all(Array.from({ length: 5 }, run))
    expect(codes.every((code) => code === 0)).toBe(true)

    const lines = readFileSync(log, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(10)
    for (let i = 0; i < lines.length; i += 2) {
      const [kindIn, pidIn] = lines[i].split(' ')
      const [kindOut, pidOut] = lines[i + 1].split(' ')
      expect(kindIn).toBe('in')
      expect(kindOut).toBe('out')
      expect(pidOut).toBe(pidIn)
    }
    expect(existsSync(`${dir}.lock`)).toBe(false)
    expect(existsSync(`${dir}.lock.reclaim`)).toBe(false)
  })
})

/** A cache home of its own, so that no two tests share a directory. */
const home = () => join(scratch, `run-home-${randomUUID()}`)

describe('runUnderLock', () => {
  test('launches the work when the checkout still matches its plan', async () => {
    const root = checkout('under-match')
    const h = home()
    const plan = planCache({ root, env: { ADEA_VP_CACHE_HOME: h }, ...toolchain })
    ensurePrivateDirectory(plan.cacheHome, plan.directory)
    const outcome = await runUnderLock({
      plan,
      replan: () => planCache({ root, env: { ADEA_VP_CACHE_HOME: h }, ...toolchain }),
      run: () => 'built',
    })
    expect(outcome).toEqual({ replanned: false, value: 'built' })
  })

  test('launches nothing when the commit moved while the run waited for the lock', async () => {
    const root = checkout('under-head')
    const h = home()
    const plan = planCache({ root, env: { ADEA_VP_CACHE_HOME: h }, ...toolchain })
    writeFileSync(join(root, 'next.txt'), 'n')
    commitAll(root, 'next')
    let launched = false
    const outcome = await runUnderLock({
      plan,
      replan: () => planCache({ root, env: { ADEA_VP_CACHE_HOME: h }, ...toolchain }),
      run: () => {
        launched = true
      },
    })
    expect(launched).toBe(false)
    expect(outcome.replanned).toBe(true)
    expect(outcome.reason).toBe('the checkout changed while waiting for the cache lock')
  })

  test('launches nothing when local changes appeared while the run waited for the lock', async () => {
    const root = checkout('under-dirty')
    const h = home()
    const plan = planCache({ root, env: { ADEA_VP_CACHE_HOME: h }, ...toolchain })
    writeFileSync(join(root, 'untracked.txt'), 'x')
    let launched = false
    const outcome = await runUnderLock({
      plan,
      replan: () => planCache({ root, env: { ADEA_VP_CACHE_HOME: h }, ...toolchain }),
      run: () => {
        launched = true
      },
    })
    expect(launched).toBe(false)
    expect(outcome.replanned).toBe(true)
  })

  test('launches nothing when the cache directory is no longer private', async () => {
    const root = checkout('under-open')
    const h = home()
    const plan = planCache({ root, env: { ADEA_VP_CACHE_HOME: h }, ...toolchain })
    ensurePrivateDirectory(plan.cacheHome, plan.directory)
    chmodSync(plan.directory, 0o777)
    let launched = false
    const outcome = await runUnderLock({
      plan,
      replan: () => planCache({ root, env: { ADEA_VP_CACHE_HOME: h }, ...toolchain }),
      run: () => {
        launched = true
      },
    })
    expect(launched).toBe(false)
    expect(outcome.replanned).toBe(true)
    expect(outcome.reason).toContain('writable by group or others')
    chmodSync(plan.directory, 0o700)
  })
})

/** A stand-in `vp`: records its arguments and the cache variable it was given, then exits with FAKE_VP_EXIT. */
const FAKE_VP = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
appendFileSync(process.env.FAKE_VP_LOG, JSON.stringify({ args: process.argv.slice(2), cache: process.env.VITE_CACHE_PATH ?? null }) + '\\n')
const code = Number(process.env.FAKE_VP_EXIT ?? 0)
if (process.env.FAKE_VP_SLEEP) setTimeout(() => process.exit(code), 60000)
else process.exit(code)
`

/** A committed checkout with a stand-in `vp` in node_modules, which git ignores. */
function fixtureCheckout(name: string): string {
  const root = checkout(name)
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n')
  commitAll(root, 'ignore node_modules')
  mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'vite-plus'), { recursive: true })
  writeFileSync(join(root, 'node_modules', 'vite-plus', 'package.json'), '{"version":"1.3.0"}\n')
  writeFileSync(join(root, 'node_modules', '.bin', 'vp'), FAKE_VP)
  chmodSync(join(root, 'node_modules', '.bin', 'vp'), 0o755)
  return root
}

/** Sets variables for `work` and restores them, and the exit code the test runner will use, afterwards. */
async function withEnv<T>(vars: Record<string, string>, work: () => Promise<T> | T): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]))
  const exitCode = process.exitCode
  Object.assign(process.env, vars)
  try {
    return await work()
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    process.exitCode = exitCode
  }
}

/** Runs `work` with the wrapper's own console output silenced. */
async function quietly<T>(work: () => Promise<T>): Promise<T> {
  const log = spyOn(console, 'log').mockImplementation(() => {})
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    return await work()
  } finally {
    log.mockRestore()
    warn.mockRestore()
  }
}

const calls = (log: string) =>
  existsSync(log)
    ? readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []

describe('main, runVp and exit codes', () => {
  test('CI runs the plain vp run: no cache variable, no --cache, and no cache home is created', async () => {
    const root = fixtureCheckout('main-ci')
    const log = join(scratch, 'main-ci.log')
    const cacheHomeDir = join(scratch, 'main-ci-home')
    await withEnv(
      { CI: '1', FAKE_VP_LOG: log, FAKE_VP_EXIT: '0', ADEA_VP_CACHE_HOME: cacheHomeDir },
      () => quietly(() => runCommand(['orch:build', '--', '--filter', 'x'], root))
    )
    expect(calls(log)).toEqual([{ args: ['run', 'orch:build', '--filter', 'x'], cache: null }])
    expect(existsSync(cacheHomeDir)).toBe(false)
  })

  test('a clean checkout runs vp run --cache in the shared directory, creating a fresh cache home, and passes the exit code on', async () => {
    const root = fixtureCheckout('main-clean')
    const log = join(scratch, 'main-clean.log')
    const cacheHomeDir = join(scratch, 'main-clean-home', '.cache', 'adea-vp')
    await withEnv(
      { FAKE_VP_LOG: log, FAKE_VP_EXIT: '3', ADEA_VP_CACHE_HOME: cacheHomeDir, CI: '' },
      async () => {
        delete process.env.CI
        await quietly(() => runCommand(['orch:test'], root))
        const plan = planCache({
          root,
          env: { ...process.env },
          nodeVersion: process.version,
          platform: process.platform,
          arch: process.arch,
          vitePlusVersion: readVitePlusVersion(root),
          home: homedir(),
        })
        expect(plan.mode).toBe('clean')
        expect(calls(log)).toEqual([
          { args: ['run', '--cache', 'orch:test'], cache: plan.directory },
        ])
        expect(existsSync(plan.directory)).toBe(true)
        expect(process.exitCode).toBe(3)
      }
    )
  })

  test('a lock that is refused falls back to the plain vp run, and the refused record is kept', async () => {
    const root = fixtureCheckout('main-refused')
    const log = join(scratch, 'main-refused.log')
    const cacheHomeDir = join(scratch, 'main-refused-home', '.cache', 'adea-vp')
    await withEnv(
      { FAKE_VP_LOG: log, FAKE_VP_EXIT: '0', ADEA_VP_CACHE_HOME: cacheHomeDir },
      async () => {
        const plan = planCache({
          root,
          env: { ...process.env },
          nodeVersion: process.version,
          platform: process.platform,
          arch: process.arch,
          vitePlusVersion: readVitePlusVersion(root),
          home: homedir(),
        })
        ensurePrivateDirectory(plan.cacheHome, plan.directory)
        writeFileSync(`${plan.directory}.lock.run`, 'garbage')
        await quietly(() => runCommand(['orch:test'], root))
        expect(calls(log)).toEqual([{ args: ['run', 'orch:test'], cache: null }])
        expect(readFileSync(`${plan.directory}.lock.run`, 'utf8')).toBe('garbage')
        expect(existsSync(`${plan.directory}.lock`)).toBe(false)
      }
    )
  })

  test('register records the group of the work, and a record of a live group keeps the lock held', async () => {
    const dir = join(scratch, 'register', 'cache')
    mkdirSync(join(scratch, 'register'), { recursive: true })
    const group = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      detached: true,
      stdio: 'ignore',
    })
    const exited = new Promise((done) => group.once('exit', done))
    await withLock(dir, async (register) => {
      register(group.pid)
    })
    const uuid = readFileSync(`${dir}.lock`, 'utf8').split('\n')[1]
    expect(readFileSync(`${dir}.lock.run`, 'utf8')).toBe(`${group.pid}\n${uuid}`)
    expect(existsSync(`${dir}.lock`)).toBe(true)
    process.kill(-group.pid, 'SIGKILL')
    await exited
    rmSync(`${dir}.lock`)
    rmSync(`${dir}.lock.run`)
  })

  test('runVp returns the exit code of vp when it runs without a process group', async () => {
    const root = fixtureCheckout('runvp-code')
    const log = join(scratch, 'runvp-code.log')
    const outcome = await runVp({
      root,
      env: { ...process.env, FAKE_VP_LOG: log, FAKE_VP_EXIT: '5' },
      args: ['run', 'x'],
    })
    expect(outcome).toEqual({ code: 5, signal: null })
    expect(calls(log)).toEqual([{ args: ['run', 'x'], cache: null }])
  })

  test('a signal that reaches the wrapper stops vp and is reported as the signal, with or without a process group', async () => {
    const root = fixtureCheckout('runvp-signal')
    const env = {
      ...process.env,
      FAKE_VP_LOG: join(scratch, 'runvp-signal.log'),
      FAKE_VP_SLEEP: '1',
    }
    const plain = runVp({ root, env, args: ['run'] })
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 300)
    const plainOutcome = await plain
    expect(plainOutcome.signal).toBe('SIGTERM')
    expect(exitCodeFor(plainOutcome)).toBe(143)

    let recorded
    const grouped = runVp({ root, env, args: ['run'], register: (pid) => (recorded = pid) })
    setTimeout(() => process.kill(process.pid, 'SIGINT'), 300)
    const groupedOutcome = await grouped
    expect(typeof recorded).toBe('number')
    expect(groupedOutcome.signal).toBe('SIGINT')
    expect(exitCodeFor(groupedOutcome)).toBe(130)
  })

  test('exit codes: a signal maps to 128 plus its number, otherwise the code, and a missing code is 1', () => {
    expect(exitCodeFor({ code: null, signal: 'SIGINT' })).toBe(130)
    expect(exitCodeFor({ code: null, signal: 'SIGTERM' })).toBe(143)
    expect(exitCodeFor({ code: 2, signal: null })).toBe(2)
    expect(exitCodeFor({ code: undefined, signal: null })).toBe(1)
  })

  test('readVitePlusVersion reads the installed version, or says it is absent', () => {
    const root = fixtureCheckout('vp-version')
    expect(readVitePlusVersion(root)).toBe('1.3.0')
    expect(readVitePlusVersion(checkout('vp-version-absent'))).toBe('absent')
  })
})
