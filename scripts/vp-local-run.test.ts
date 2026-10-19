import { afterAll, describe, expect, test } from 'bun:test'

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
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
  parseArgs,
  planCache,
  relevantEnvironment,
  repositoryIdentity,
  vpRunArguments,
  withLock,
} from './vp-local-run.mjs'

const scratch = mkdtempSync(join(tmpdir(), 'vp-local-run-'))
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

const planFor = (root: string, env: Record<string, string> = {}) =>
  planCache({ root, env: { ADEA_VP_CACHE_HOME: '/cache/home', ...env }, ...toolchain })

describe('repositoryIdentity', () => {
  test('two worktrees of one repository share an identity; an unrelated repository does not', () => {
    const main = checkout('identity-main')
    const worktree = join(scratch, 'identity-worktree')
    git(main, 'worktree', 'add', '-q', worktree, '-b', 'feature')
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
    expect(plan.mode).toBe('shared')
    expect(plan.directory).toContain(`head-${head}`)
    expect(plan.directory.startsWith('/cache/home/')).toBe(true)
  })

  test('clean worktrees at one commit share a directory; a later commit gets its own', () => {
    const main = checkout('plan-share')
    const worktree = join(scratch, 'plan-share-worktree')
    git(main, 'worktree', 'add', '-q', '--detach', worktree)
    expect(planFor(worktree).directory).toBe(planFor(main).directory)

    writeFileSync(join(main, 'next.txt'), 'n')
    commitAll(main, 'next')
    expect(planFor(main).directory).not.toBe(planFor(worktree).directory)
    expect(planFor(main).mode).toBe('shared')
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
    expect(dirty.mode).toBe('isolated')
    expect(dirty.reason).toBe('local changes or untracked files')
    expect(dirty.directory).not.toBe(shared)

    git(main, 'checkout', '--', 'bun.lock')
    writeFileSync(join(main, 'scratch.txt'), 'x')
    expect(planFor(main).mode).toBe('isolated')
    rmSync(join(main, 'scratch.txt'))
    expect(planFor(main).directory).toBe(shared)
  })

  test('two checkouts in the same dirty state never share an isolated directory', () => {
    const first = checkout('plan-iso-a')
    const second = checkout('plan-iso-b')
    writeFileSync(join(first, 'scratch.txt'), 'x')
    writeFileSync(join(second, 'scratch.txt'), 'x')
    expect(planFor(first).directory).not.toBe(planFor(second).directory)
  })

  test('a checkout with no commit is isolated and says so', () => {
    const plain = join(scratch, 'plan-no-commit')
    mkdirSync(plain, { recursive: true })
    const plan = planFor(plain)
    expect(plan.mode).toBe('isolated')
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

  test('refuses a directory that other users can write to', () => {
    const home = join(scratch, 'ensure-open')
    mkdirSync(join(home, 'repo'), { recursive: true })
    chmodSync(join(home, 'repo'), 0o777)
    expect(() => ensurePrivateDirectory(home, join(home, 'repo', 'x'))).toThrow(
      'writable by others'
    )
    chmodSync(join(home, 'repo'), 0o700)
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
    writeFileSync(`${dir}.lock`, `${deadPid()}\nstale`)

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
    const held = `${process.pid}\nheld-elsewhere`
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

  test('a reclaimer that read a dead owner before a successor took the lock never unlinks that successor', async () => {
    const dir = join(scratch, 'successor', 'cache')
    mkdirSync(join(scratch, 'successor'), { recursive: true })
    const stale = `${deadPid()}\nstale`
    writeFileSync(`${dir}.lock`, stale)

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
    }).then(
      (value) => value,
      (error: Error) => error
    )
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

  test('separate processes contending on one directory, starting from a dead owner, never overlap', async () => {
    const dir = join(scratch, 'multi', 'cache')
    mkdirSync(join(scratch, 'multi'), { recursive: true })
    writeFileSync(`${dir}.lock`, `${deadPid()}\nstale`)
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
