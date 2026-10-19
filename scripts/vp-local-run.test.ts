import { afterAll, describe, expect, test } from 'bun:test'

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
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  checkoutState,
  defaultCacheHome,
  ensurePrivateDirectory,
  environmentKey,
  exitCodeFor,
  LockRefused,
  parseArgs,
  planCache,
  relevantEnvironment,
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
