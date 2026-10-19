#!/usr/bin/env node
// Runs a Vite+ task with a local task cache that lives outside every checkout, so a second clean worktree at the same
// commit can replay what the first one built.
//
//   node scripts/vp-local-run.mjs [task] [-- vp-args...]        (default task: orch:build)
//
// Vite Task keeps one cache entry per task inside the directory `VITE_CACHE_PATH` names, so the wrapper picks that
// directory from the state of the run:
//   - shared:   a clean checkout. The directory is keyed by the git common directory (every worktree of one repository,
//               and no other), the commit, and the build-relevant environment. Clean worktrees at one commit share it.
//   - isolated: a checkout with local changes, untracked files or no commit. Its directory is keyed by the checkout
//               path as well, so no other worktree reads or overwrites its entries.
//   - bypass:   `CI` is set, or `VITE_CACHE_PATH` is already in the environment, or the cache directory cannot be made
//               private. The run is the plain `vp run <task>` it was before this wrapper existed; nothing is created,
//               locked or added to the command.
// Within a shared or isolated directory, one directory per environment means A, B, A replays the A entries instead of
// re-running (Vite Task holds one entry per task).
//
// Vite Task still fingerprints the files, declared variables and `ORCH_TOOLCHAIN` (scripts/orch-toolchain.mjs) of every
// task, so the directory only decides which entries are visible, never whether an entry is valid.
// Runs that share a directory take `<directory>.lock`; a lock whose owner has exited is reclaimed under a reclaim mutex
// (see `withLock`).
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_TASK = 'orch:build'
const SCHEMA = 'vp-local-run-v2'
const ENV_PREFIXES = [
  'NODE_ENV',
  'NODE_OPTIONS',
  'BUN_',
  'VITE_',
  'ORCH_',
  'NPM_CONFIG_',
  'npm_config_',
]
const LOCK_TIMEOUT_MS = 60 * 60_000
const LOCK_POLL_MS = 100
// The reclaim mutex is held for one read and one unlink. A mutex older than this belongs to a reclaimer that died.
const RECLAIM_STALE_MS = 30_000

const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const shortHash = (value) => sha256(value).slice(0, 32)
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

/** The shared git directory of the checkout, or the checkout itself when it is not a git repository. */
export function repositoryIdentity(root) {
  try {
    return realpathSync(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']))
  } catch {
    return realpathSync(root)
  }
}

/** The commit the checkout is at, and whether it has changes that commit does not record (untracked files count). */
export function checkoutState(root) {
  try {
    const head = git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])
    const dirty = git(root, ['status', '--porcelain', '--untracked-files=all']) !== ''
    return { head: /^[0-9a-f]{40,64}$/.test(head) ? head : null, dirty }
  } catch {
    return { head: null, dirty: true }
  }
}

function fileDigest(file) {
  return existsSync(file) ? sha256(readFileSync(file)) : 'absent'
}

/** The build-relevant environment, as sorted pairs. Variables outside the prefixes never affect the key. */
export function relevantEnvironment(env) {
  return Object.keys(env)
    .filter(
      (name) => name !== 'VITE_CACHE_PATH' && ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
    )
    .toSorted()
    .map((name) => [name, env[name]])
}

/** Everything outside the commit and the input files that changes what a cached build means, hashed into one name. */
export function environmentKey({ root, env, nodeVersion, platform, arch, vitePlusVersion }) {
  const material = {
    schema: SCHEMA,
    vitePlus: vitePlusVersion,
    node: nodeVersion,
    platform,
    arch,
    lockfile: fileDigest(join(root, 'bun.lock')) + fileDigest(join(root, 'bun.lockb')),
    config: fileDigest(join(root, 'vite.config.ts')),
    env: relevantEnvironment(env),
  }
  return shortHash(JSON.stringify(material))
}

/** The cache home: ADEA_VP_CACHE_HOME, else $XDG_CACHE_HOME/adea-vp, else ~/.cache/adea-vp. Only absolute paths count. */
export function defaultCacheHome(env, home = homedir()) {
  if (env.ADEA_VP_CACHE_HOME && isAbsolute(env.ADEA_VP_CACHE_HOME)) return env.ADEA_VP_CACHE_HOME
  if (env.XDG_CACHE_HOME && isAbsolute(env.XDG_CACHE_HOME))
    return join(env.XDG_CACHE_HOME, 'adea-vp')
  if (home && isAbsolute(home)) return join(home, '.cache', 'adea-vp')
  return null
}

/**
 * Chooses the cache for one run. See the header for the three modes. Nothing is created here; `ensurePrivateDirectory`
 * does that and can still refuse the directory, in which case the run falls back to bypass.
 */
export function planCache({ root, env, nodeVersion, platform, arch, vitePlusVersion, home }) {
  if (env.CI) return { mode: 'bypass', reason: 'CI is set' }
  if (env.VITE_CACHE_PATH !== undefined)
    return { mode: 'bypass', reason: 'VITE_CACHE_PATH is already set' }
  const cacheHome = defaultCacheHome(env, home)
  if (cacheHome === null) return { mode: 'bypass', reason: 'no absolute cache home' }
  const repository = shortHash(repositoryIdentity(root))
  const environment = environmentKey({ root, env, nodeVersion, platform, arch, vitePlusVersion })
  const state = checkoutState(root)
  if (state.head && !state.dirty)
    return {
      mode: 'shared',
      cacheHome,
      directory: join(cacheHome, repository, `head-${state.head}`, environment),
    }
  return {
    mode: 'isolated',
    reason: state.head ? 'local changes or untracked files' : 'no commit',
    cacheHome,
    directory: join(
      cacheHome,
      repository,
      `checkout-${shortHash(realpathSync(root))}`,
      environment
    ),
  }
}

function lstatOrNull(path) {
  try {
    return lstatSync(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function assertPrivateDirectory(path, stats) {
  if (stats.isSymbolicLink()) throw new Error(`${path} is a symbolic link`)
  if (!stats.isDirectory()) throw new Error(`${path} is not a directory`)
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid())
    throw new Error(`${path} is owned by another user`)
  if (stats.mode & 0o002) throw new Error(`${path} is writable by others`)
}

/**
 * Creates `directory` under `home`, checking every component on the way: none may be a symbolic link, each must be a
 * directory owned by the current user and not writable by others. Nothing that exists is changed.
 */
export function ensurePrivateDirectory(home, directory) {
  const inside = relative(home, directory)
  if (inside.startsWith('..') || isAbsolute(inside))
    throw new Error(`${directory} is outside the cache home`)
  if (lstatOrNull(home) === null) mkdirSync(home, { recursive: true, mode: 0o700 })
  let current = home
  for (const part of ['', ...inside.split(sep).filter(Boolean)]) {
    if (part) current = join(current, part)
    let stats = lstatOrNull(current)
    if (stats === null) {
      mkdirSync(current, { mode: 0o700 })
      stats = lstatSync(current)
    }
    assertPrivateDirectory(current, stats)
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

const token = () => `${process.pid}\n${randomUUID()}`
const ownerOf = (content) => Number(content.split('\n')[0])

/** Publishes `content` at `path` only if nothing is there. The file is complete before it gets its name. */
function tryCreate(path, content) {
  const staging = `${path}.${process.pid}.${randomUUID()}`
  writeFileSync(staging, content)
  try {
    linkSync(staging, path)
    return true
  } catch (error) {
    if (error.code === 'EEXIST') return false
    throw error
  } finally {
    rmSync(staging, { force: true })
  }
}

function readIfPresent(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

/**
 * Removes the lock `observed` only while the reclaim mutex is held, and only if the lock still holds exactly the bytes
 * that were read and their owner is gone. A successor's lock is never unlinked: it has different bytes, and it can only
 * appear after a reclaimer removed the dead one, which required the same mutex.
 */
async function reclaim(lock, observed, { pollMs, hooks }) {
  const mutex = `${lock}.reclaim`
  const mine = token()
  if (!tryCreate(mutex, mine)) {
    const age = Date.now() - (statOrZero(mutex) ?? Date.now())
    if (age > RECLAIM_STALE_MS) rmSync(mutex, { force: true })
    await sleep(pollMs)
    return
  }
  try {
    await hooks.reclaimLocked?.()
    if (readIfPresent(lock) === observed && !alive(ownerOf(observed))) rmSync(lock, { force: true })
  } finally {
    if (readIfPresent(mutex) === mine) rmSync(mutex, { force: true })
  }
}

function statOrZero(path) {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

/**
 * Runs `work` while holding `<directory>.lock`. A lock whose owner process has exited is reclaimed (see `reclaim`); a
 * live one is waited for until `timeoutMs`. The lock is released only if it still holds this run's bytes.
 * `hooks.staleObserved` runs after a run has read a dead owner and before it reclaims; `hooks.reclaimLocked` runs while
 * a reclaimer holds the reclaim mutex. Tests use them to force an interleaving.
 */
export async function withLock(
  directory,
  work,
  { timeoutMs = LOCK_TIMEOUT_MS, pollMs = LOCK_POLL_MS, hooks = {} } = {}
) {
  const lock = `${directory}.lock`
  mkdirSync(dirname(directory), { recursive: true, mode: 0o700 })
  const mine = token()
  const started = Date.now()
  while (!tryCreate(lock, mine)) {
    const observed = readIfPresent(lock)
    if (observed === null) continue
    const owner = ownerOf(observed)
    if (!Number.isInteger(owner) || owner <= 0 || !alive(owner)) {
      await hooks.staleObserved?.()
      await reclaim(lock, observed, { pollMs, hooks })
      continue
    }
    if (Date.now() - started > timeoutMs)
      throw new Error(`timed out waiting for the cache lock ${lock}`)
    await sleep(pollMs)
  }
  try {
    return await work()
  } finally {
    if (readIfPresent(lock) === mine) rmSync(lock, { force: true })
  }
}

/** Argument parsing: an optional task name, then everything after `--` goes to `vp run` unchanged. */
export function parseArgs(argv) {
  const separator = argv.indexOf('--')
  const head = separator === -1 ? argv : argv.slice(0, separator)
  const passthrough = separator === -1 ? [] : argv.slice(separator + 1)
  if (head.length > 1) throw new Error(`expected at most one task name, got ${head.join(' ')}`)
  const [task = DEFAULT_TASK] = head
  if (!/^[\w:.-]+$/.test(task)) throw new Error(`task name ${task} is not a plain task name`)
  return { task, passthrough }
}

/** The `vp run` arguments: `--cache` is added only when a shared or isolated cache is in use. */
export function vpRunArguments({ task, passthrough, cacheEnabled }) {
  return ['run', ...(cacheEnabled ? ['--cache'] : []), task, ...passthrough]
}

export function readVitePlusVersion(root) {
  const manifest = join(root, 'node_modules', 'vite-plus', 'package.json')
  return existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')).version : 'absent'
}

/** Runs `vp` with the given arguments. A signal that reaches the wrapper is reported even if `vp` exits 0 after it. */
export function runVp({ root, env, args }) {
  return new Promise((done, fail) => {
    let received = null
    const signals = ['SIGINT', 'SIGTERM']
    const child = spawn(join(root, 'node_modules', '.bin', 'vp'), args, {
      cwd: root,
      env,
      stdio: 'inherit',
    })
    const forward = (signal) => {
      received = signal
      child.kill(signal)
    }
    for (const signal of signals) process.on(signal, forward)
    child.on('error', fail)
    child.on('exit', (code, signal) => {
      for (const sig of signals) process.off(sig, forward)
      done({ code, signal: received ?? signal })
    })
  })
}

export function exitCodeFor({ code, signal }) {
  if (signal) return 128 + (signal === 'SIGINT' ? 2 : 15)
  return code ?? 1
}

function resolveRoot() {
  return realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
}

async function main(argv) {
  const root = resolveRoot()
  const { task, passthrough } = parseArgs(argv)
  const env = { ...process.env }
  let plan = planCache({
    root,
    env,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    vitePlusVersion: readVitePlusVersion(root),
    home: homedir(),
  })
  if (plan.mode !== 'bypass') {
    try {
      ensurePrivateDirectory(plan.cacheHome, plan.directory)
    } catch (error) {
      console.warn(`vp-local-run: not using a shared cache: ${error.message}`)
      plan = { mode: 'bypass', reason: 'cache directory refused' }
    }
  }
  if (plan.mode === 'bypass') {
    console.log(`vp-local-run: ${task}, no shared cache (${plan.reason})`)
    const args = vpRunArguments({ task, passthrough, cacheEnabled: false })
    process.exitCode = exitCodeFor(await runVp({ root, env, args }))
    return
  }
  env.VITE_CACHE_PATH = plan.directory
  const args = vpRunArguments({ task, passthrough, cacheEnabled: true })
  console.log(
    `vp-local-run: ${task}, ${plan.mode} cache ${plan.directory} (${plan.reason ?? 'clean checkout'})`
  )
  process.exitCode = exitCodeFor(await withLock(plan.directory, () => runVp({ root, env, args })))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
