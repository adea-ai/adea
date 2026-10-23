#!/usr/bin/env node
// Runs a Vite+ task with a local task cache that lives outside every checkout.
//
//   node scripts/vp-local-run.mjs [task] [-- vp-args...]        (default task: orch:build)
//
// Vite Task keeps one cache entry per task inside the directory `VITE_CACHE_PATH` names, and one `vp run` uses one
// directory. The directory is chosen by the state of the checkout:
//   - clean:   no local changes and no untracked files. The directory is shared by every clean checkout of the same
//              repository at the same commit (`repo-<repository>/head-<commit>/<environment>`).
//   - working: local changes, untracked files, or no commit. The directory belongs to this checkout alone
//              (`checkout-<path>/state-*/<environment>`), so its files are never replayed anywhere else.
// The environment part is the build-relevant environment (see `environmentKey`), so A, B, A replays the A entries.
//
// Sharing across checkouts is only as safe as the outputs are portable. Vite Task fingerprints the inputs of every task,
// including `ORCH_TOOLCHAIN` (scripts/orch-toolchain.mjs), and a task whose output embeds the absolute path of the checkout
// that built it carries that checkout's canonical path in its command (`ORCH_CHECKOUT`, see scripts/orch-graph.mjs). A
// different checkout therefore misses and rebuilds rather than replaying a path that is not its own. The directory only
// decides which entries are visible, never whether an entry is valid.
//
// Modes:
//   - bypass: `CI` is set, `VITE_CACHE_PATH` is already in the environment, the cache home is not absolute, the cache
//             directory fails the checks in `ensurePrivateDirectory`, the lock is malformed or foreign, or the checkout
//             changed while the run waited for the lock. The run is the plain `vp run <task>` it was before this wrapper.
//   - clean, working: the two shared-directory modes above, with `--cache`.
//
// Locking (`withLock`): a run holds `<directory>.lock`, and records the process group it started at `<directory>.lock.run`.
// A lock whose owner has exited is reclaimed only when no recorded group is still running. Reclaiming takes the
// `<directory>.lock.reclaim` mutex, which is never broken by age or guessed ownership: if it is held, the wait is bounded
// and the run fails with a message naming it. Malformed, symlinked or foreign lock files are never deleted.
//
// A lock that is released while another run is reading it is absent to that reader, not a failure: the reader waits for
// the lock again. The lock file's existence is what excludes a second holder, so a reader that finds it gone waits rather
// than runs, and a run that created the lock itself is the only one that may hold it.
//
// After the lock is acquired, `runUnderLock` plans the directory again. A checkout can change during a long wait, so if its
// commit, cleanliness or cache directory no longer matches the plan, nothing is launched against the shared directory.
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_TASK = 'orch:build'
const SCHEMA = 'vp-local-run-v3'
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
const TOKEN = /^([1-9]\d*)\n([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/

/** A lock or run record that is not in the expected form. It is preserved and the run falls back to bypass. */
export class LockRefused extends Error {}

/** A refusal of the shared cache directory by its safety checks. Its message may name an environment-derived path. */
export class CacheRefusal extends Error {}

/** A rejected command line. Its message repeats the arguments it rejects. */
export class UsageError extends Error {}

/**
 * The only text the wrapper prints about a failure. Messages can name paths taken from the environment (the cache home)
 * or from the arguments, so no error message is printed; a failure is reported by its fixed category.
 */
export const CATEGORY = {
  refused: 'the shared cache directory failed its safety checks',
  unprepared: 'the shared cache directory could not be prepared',
  lockRecord: 'the shared cache lock record was refused',
  usage: 'usage: vp-local-run.mjs [task] [-- arguments]',
  failed: 'the command failed',
}

/** The fixed category for a failure to prepare the cache directory. */
export function directoryCategory(error) {
  return error instanceof CacheRefusal ? CATEGORY.refused : CATEGORY.unprepared
}

/** The fixed category for a failure of the command as a whole. */
export function failureCategory(error) {
  return error instanceof UsageError ? CATEGORY.usage : CATEGORY.failed
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const shortHash = (value) => sha256(value).slice(0, 32)
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
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

/** The canonical git common directory: every worktree of one repository names the same one. `null` if there is none. */
export function repositoryDirectory(root) {
  try {
    return realpathSync(resolve(root, git(root, ['rev-parse', '--git-common-dir'])))
  } catch {
    return null
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
 * Chooses the cache for one run (see the header). Nothing is created here; `ensurePrivateDirectory` does that and can
 * still refuse the directory, in which case the run falls back to bypass.
 */
export function planCache({ root, env, nodeVersion, platform, arch, vitePlusVersion, home }) {
  if (env.CI) return { mode: 'bypass', reason: 'CI is set' }
  if (env.VITE_CACHE_PATH !== undefined)
    return { mode: 'bypass', reason: 'VITE_CACHE_PATH is already set' }
  const cacheHome = defaultCacheHome(env, home)
  if (cacheHome === null) return { mode: 'bypass', reason: 'no absolute cache home' }
  const environment = environmentKey({ root, env, nodeVersion, platform, arch, vitePlusVersion })
  const state = checkoutState(root)
  const repository = repositoryDirectory(root)
  if (state.head && !state.dirty && repository !== null)
    return {
      mode: 'clean',
      reason: 'clean checkout, shared by the repository at this commit',
      cacheHome,
      directory: join(
        cacheHome,
        `repo-${shortHash(repository)}`,
        `head-${state.head}`,
        environment
      ),
    }
  const checkout = `checkout-${shortHash(realpathSync(root))}`
  const reason = !state.head
    ? 'no commit'
    : state.dirty
      ? 'local changes or untracked files'
      : 'no git repository'
  return {
    mode: 'working',
    reason,
    cacheHome,
    directory: join(
      cacheHome,
      checkout,
      state.head ? 'state-changed' : 'state-no-commit',
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

/** Components above the cache home may be system directories: owned by the user or root, not writable by others. */
function assertAncestor(path, stats, uid) {
  if (stats.isSymbolicLink()) throw new CacheRefusal(`${path} is a symbolic link`)
  if (!stats.isDirectory()) throw new CacheRefusal(`${path} is not a directory`)
  if (uid !== null && stats.uid !== uid && stats.uid !== 0)
    throw new CacheRefusal(`${path} is owned by another user`)
  if (stats.mode & 0o022 && !(stats.mode & 0o1000))
    throw new CacheRefusal(`${path} is writable by group or others`)
}

/** Components under the cache home belong to the current user and are writable by no one else. */
function assertOwned(path, stats, uid) {
  if (stats.isSymbolicLink()) throw new CacheRefusal(`${path} is a symbolic link`)
  if (!stats.isDirectory()) throw new CacheRefusal(`${path} is not a directory`)
  if (uid !== null && stats.uid !== uid) throw new CacheRefusal(`${path} is owned by another user`)
  if (stats.mode & 0o022) throw new CacheRefusal(`${path} is writable by group or others`)
}

/** Checks every ancestor of `home` that exists: a real directory, not writable by others unless sticky. */
function checkAncestors(home, uid) {
  for (let ancestor = dirname(home); ancestor !== dirname(ancestor); ancestor = dirname(ancestor)) {
    const stats = lstatOrNull(ancestor)
    if (stats !== null) assertAncestor(ancestor, stats, uid)
  }
}

/**
 * Creates `directory` under `home`. Every ancestor of the home must be a real directory that is not writable by others
 * (sticky directories excepted); the home and everything below it must be real directories owned by the current user,
 * not writable by group or others; and the directory must be its own real path. Existing directories are never changed.
 *
 * Two runs that start at the same time can reach the same missing component. The one that creates it wins the race and
 * the other finds it there, so the loser of the race uses the directory the winner made and judges it by what it is.
 * `beforeCreate` is a test seam that runs after a component has been found missing and before it is created.
 */
export function ensurePrivateDirectory(home, directory, { beforeCreate } = {}) {
  if (!isAbsolute(home) || !isAbsolute(directory))
    throw new CacheRefusal('cache home and directory must be absolute')
  const inside = relative(home, directory)
  if (inside.startsWith('..') || isAbsolute(inside))
    throw new CacheRefusal(`${directory} is outside the cache home`)
  const uid = typeof process.getuid === 'function' ? process.getuid() : null

  // Existing ancestors are checked before anything is created. Missing ones are created with owner-only mode, and every
  // ancestor is checked again afterwards, so a component that appeared meanwhile is judged by what it is.
  checkAncestors(home, uid)
  if (lstatOrNull(home) === null) mkdirSync(home, { recursive: true, mode: 0o700 })
  checkAncestors(home, uid)
  let current = home
  for (const part of ['', ...inside.split(sep).filter(Boolean)]) {
    if (part) current = join(current, part)
    let stats = lstatOrNull(current)
    if (stats === null) {
      beforeCreate?.(current)
      try {
        mkdirSync(current, { mode: 0o700 })
      } catch (error) {
        // Another run created it first. It is judged by what it is, not by which run made it.
        if (error.code !== 'EEXIST') throw error
      }
      stats = lstatOrNull(current)
      if (stats === null) throw new CacheRefusal(`${current} could not be created`)
    }
    assertOwned(current, stats, uid)
  }
  if (realpathSync(directory) !== directory)
    throw new CacheRefusal(`${directory} is not its own real path`)
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/** Whether any process is still running in the process group `pgid`. */
function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

const newToken = () => `${process.pid}\n${randomUUID()}`
const parseToken = (content) => {
  const match = TOKEN.exec(content)
  return match ? { pid: Number(match[1]), uuid: match[2], text: content } : null
}

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

/** Replaces `path` with `content` atomically. Used only by the owner of a lock, for its own run record. */
function replace(path, content) {
  const staging = `${path}.${process.pid}.${randomUUID()}`
  writeFileSync(staging, content)
  renameSync(staging, path)
}

/**
 * The content of a regular file, `null` when absent. A symbolic link or other non-file is refused, never followed.
 *
 * The check and the read are two operations, and the file can disappear between them: the owner of a lock removes it
 * when its run ends, and a reader that is looking at it then reads a file that is no longer there. That is the file
 * being absent, not a failure, so the read reports `null` and the caller waits for the lock again. The check is what
 * refuses a symbolic link before it is followed, so it stays in front of the read.
 */
function readRegular(path, beforeRead) {
  const stats = lstatOrNull(path)
  if (stats === null) return null
  if (!stats.isFile()) throw new LockRefused(`${path} is not a regular file`)
  beforeRead?.(path)
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

/**
 * Whether the lock's owner is gone. `live` = the owner process runs, or a process group it recorded is still running;
 * `dead` = neither; a malformed lock or run record is refused rather than judged.
 */
function ownerState(lock, content, hooks = {}) {
  const owner = parseToken(content)
  if (owner === null) throw new LockRefused(`${lock} is not a recognised lock record`)
  if (alive(owner.pid)) return { state: 'live', owner }
  const run = readRegular(`${lock}.run`, hooks.beforeRead)
  if (run === null) return { state: 'dead', owner }
  const record = parseToken(run)
  if (record === null) throw new LockRefused(`${lock}.run is not a recognised run record`)
  if (record.uuid !== owner.uuid) return { state: 'dead', owner }
  return { state: groupAlive(record.pid) ? 'live' : 'dead', owner }
}

/**
 * Removes the dead lock `observed` while holding the reclaim mutex, after checking under the mutex that it still holds
 * the same bytes and is still dead. A held mutex is never broken: the caller waits, bounded by its timeout.
 */
async function reclaimDead(lock, observed, owner, hooks) {
  const mutex = `${lock}.reclaim`
  const mine = newToken()
  if (!tryCreate(mutex, mine)) return false
  try {
    await hooks.reclaimLocked?.()
    if (readRegular(lock, hooks.beforeRead) !== observed) return false
    if (ownerState(lock, observed, hooks).state !== 'dead') return false
    // The stale lock still excludes every successor, so its run record is removed first: no successor can register
    // a new run record that this removal could then take away. The lock goes last.
    const run = readRegular(`${lock}.run`, hooks.beforeRead)
    if (run !== null && parseToken(run)?.uuid === owner.uuid) rmSync(`${lock}.run`, { force: true })
    await hooks.reclaimRunRemoved?.()
    rmSync(lock, { force: true })
    return true
  } finally {
    if (readRegular(mutex, hooks.beforeRead) === mine) rmSync(mutex, { force: true })
  }
}

/**
 * Releases `lock` if it still holds this run's bytes and no process group recorded by this run is running. Otherwise the
 * lock is left in place: the next run finds its owner dead, sees the group still running, and waits. A malformed or foreign
 * file is left alone too.
 */
function release(lock, run, mine, uuid, hooks = {}) {
  try {
    if (readRegular(lock, hooks.beforeRead) !== mine) return
    const record = parseToken(readRegular(run, hooks.beforeRead) ?? '')
    if (record !== null && record.uuid === uuid && groupAlive(record.pid)) return
    if (record !== null && record.uuid === uuid) rmSync(run, { force: true })
    rmSync(lock, { force: true })
  } catch (error) {
    if (!(error instanceof LockRefused)) throw error
  }
}

/**
 * Runs `work(register)` while holding `<directory>.lock`. `register(pid)` records the process group the work started, so
 * that a later run does not reclaim the lock while that group still runs.
 *
 * Every wait is bounded by `timeoutMs`. Malformed, symlinked or foreign lock files raise `LockRefused` and are never deleted.
 * `hooks.staleObserved` runs after a dead owner was read and before the reclaim; `hooks.reclaimLocked` runs while a reclaimer
 * holds the reclaim mutex; `hooks.reclaimRunRemoved` runs after a stale run record is removed and before the stale lock is.
 * `hooks.beforeRead` runs after a lock or run record has been checked and before it is read, so a test can remove it in
 * that window and prove what the run does when the file it was reading is released. Tests use them to force interleavings.
 */
export async function withLock(
  directory,
  work,
  { timeoutMs = LOCK_TIMEOUT_MS, pollMs = LOCK_POLL_MS, hooks = {} } = {}
) {
  const lock = `${directory}.lock`
  const run = `${lock}.run`
  mkdirSync(dirname(directory), { recursive: true, mode: 0o700 })
  const mine = newToken()
  const { uuid } = parseToken(mine)
  const deadline = Date.now() + timeoutMs
  let waiting = 'the owner is live'
  for (;;) {
    if (tryCreate(lock, mine)) break
    if (Date.now() >= deadline)
      throw new Error(`timed out waiting for the cache lock ${lock} (${waiting})`)
    const observed = readRegular(lock, hooks.beforeRead)
    if (observed === null) continue
    const { state, owner } = ownerState(lock, observed, hooks)
    if (state === 'dead') {
      await hooks.staleObserved?.()
      if (await reclaimDead(lock, observed, owner, hooks)) continue
      waiting = `the reclaim mutex ${lock}.reclaim is held`
    } else {
      waiting = `owner ${owner.pid} is live`
    }
    await sleep(pollMs)
  }
  // A run record present when a lock is newly acquired was left by something other than a clean release, and it may
  // describe a group that is still running. It is preserved, never overwritten, and nothing is run.
  let leftover
  try {
    leftover = readRegular(run, hooks.beforeRead)
  } catch (error) {
    if (readRegular(lock, hooks.beforeRead) === mine) rmSync(lock, { force: true })
    throw error
  }
  if (leftover !== null) {
    if (readRegular(lock, hooks.beforeRead) === mine) rmSync(lock, { force: true })
    throw new LockRefused(`${run} is left from an earlier run; it is kept and nothing was run`)
  }
  try {
    return await work((pid) => replace(run, `${pid}\n${uuid}`))
  } finally {
    release(lock, run, mine, uuid, hooks)
  }
}

/**
 * Runs `run(register)` for `plan` while holding its lock. Under the lock the checkout is planned again: if its commit,
 * its cleanliness or its cache directory no longer matches `plan`, nothing is launched and `{ replanned: true }` is
 * returned, so the caller can run without the shared directory.
 */
export async function runUnderLock({ plan, replan, run }) {
  return withLock(plan.directory, async (register) => {
    const current = replan()
    if (current.mode !== plan.mode || current.directory !== plan.directory)
      return { replanned: true, reason: 'the checkout changed while waiting for the cache lock' }
    try {
      ensurePrivateDirectory(current.cacheHome, current.directory)
    } catch (error) {
      return { replanned: true, reason: directoryCategory(error) }
    }
    return { replanned: false, value: await run(register) }
  })
}

/** Argument parsing: an optional task name, then everything after `--` goes to `vp run` unchanged. */
export function parseArgs(argv) {
  const separator = argv.indexOf('--')
  const head = separator === -1 ? argv : argv.slice(0, separator)
  const passthrough = separator === -1 ? [] : argv.slice(separator + 1)
  if (head.length > 1) throw new UsageError(`expected at most one task name, got ${head.join(' ')}`)
  const [task = DEFAULT_TASK] = head
  if (!/^[\w:.-]+$/.test(task)) throw new UsageError(`task name ${task} is not a plain task name`)
  return { task, passthrough }
}

/** The `vp run` arguments: `--cache` is added only when a shared cache is in use. */
export function vpRunArguments({ task, passthrough, cacheEnabled }) {
  return ['run', ...(cacheEnabled ? ['--cache'] : []), task, ...passthrough]
}

/** Add one per-process Git config entry without replacing entries supplied by the caller. */
export function withGitExcludesFile(env, excludeFile) {
  if (typeof excludeFile !== 'string' || excludeFile === '')
    throw new TypeError('the Git exclusion file must be a non-empty path')
  const count = env.GIT_CONFIG_COUNT === undefined ? 0 : Number(env.GIT_CONFIG_COUNT)
  if (!Number.isSafeInteger(count) || count < 0)
    throw new TypeError('GIT_CONFIG_COUNT must be a non-negative integer')
  return {
    ...env,
    GIT_CONFIG_COUNT: String(count + 1),
    [`GIT_CONFIG_KEY_${count}`]: 'core.excludesFile',
    [`GIT_CONFIG_VALUE_${count}`]: excludeFile,
  }
}

export function readVitePlusVersion(root) {
  const manifest = join(root, 'node_modules', 'vite-plus', 'package.json')
  return existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')).version : 'absent'
}

/**
 * Runs `vp`. With `register`, `vp` starts in its own process group, which is recorded through `register` so the lock
 * stays held while it runs, and signals go to the whole group. A signal that reaches the wrapper is reported even when
 * `vp` exits 0 after it.
 */
export function runVp({ root, env, args, register }) {
  return new Promise((done, fail) => {
    let received = null
    const signals = ['SIGINT', 'SIGTERM']
    const child = spawn(join(root, 'node_modules', '.bin', 'vp'), args, {
      cwd: root,
      env,
      stdio: 'inherit',
      detached: register !== undefined,
    })
    if (register && child.pid !== undefined) register(child.pid)
    const forward = (signal) => {
      received = signal
      try {
        if (register) process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch {
        // the group has already exited
      }
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

/** The command: `argv` after the script name. `root` defaults to the checkout the script lives in. */
export async function main(argv, root = resolveRoot()) {
  const { task, passthrough } = parseArgs(argv)
  const env = { ...process.env }
  const replan = () =>
    planCache({
      root,
      env,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      vitePlusVersion: readVitePlusVersion(root),
      home: homedir(),
    })
  let plan = replan()
  if (plan.mode !== 'bypass') {
    try {
      ensurePrivateDirectory(plan.cacheHome, plan.directory)
    } catch (error) {
      console.warn(`vp-local-run: not using a shared cache: ${directoryCategory(error)}`)
      plan = { mode: 'bypass', reason: 'cache directory refused' }
    }
  }
  const bypassArgs = vpRunArguments({ task, passthrough, cacheEnabled: false })
  const bypass = async (reason) => {
    console.log(`vp-local-run: ${task}, no shared cache (${reason})`)
    process.exitCode = exitCodeFor(await runVp({ root, env, args: bypassArgs }))
  }
  if (plan.mode === 'bypass') return bypass(plan.reason)

  const cachedEnv = { ...env, VITE_CACHE_PATH: plan.directory }
  const args = vpRunArguments({ task, passthrough, cacheEnabled: true })
  console.log(`vp-local-run: ${task}, ${plan.mode} cache (${plan.reason})`)
  let outcome
  try {
    outcome = await runUnderLock({
      plan,
      replan,
      run: (register) => runVp({ root, env: cachedEnv, args, register }),
    })
  } catch (error) {
    if (!(error instanceof LockRefused)) throw error
    console.warn(`vp-local-run: not using a shared cache: ${CATEGORY.lockRecord}`)
    return bypass('lock refused')
  }
  if (outcome.replanned) {
    console.warn(`vp-local-run: ${outcome.reason}; running without the shared cache`)
    return bypass('checkout changed')
  }
  process.exitCode = exitCodeFor(outcome.value)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(failureCategory(error))
    process.exitCode = 1
  })
}
