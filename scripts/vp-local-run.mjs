#!/usr/bin/env node
// Runs a Vite+ task with a local task cache that lives outside every checkout, so a second worktree of the same
// repository at the same commit can replay what the first one built.
//
//   node scripts/vp-local-run.mjs [task] [-- vp-args...]        (default task: orch:build)
//
// Vite Task keeps one cache entry per task inside the directory `VITE_CACHE_PATH` names. This wrapper points that
// variable at a directory keyed by two things:
//   - the repository: the git common directory, shared by every worktree of one repository and by no other one;
//   - the environment: the Vite+ version, the lockfile and config bytes, platform and Node version, and the
//     build-relevant variables (NODE_ENV, VITE_*, ORCH_*, BUN_*, NPM_CONFIG_*, NODE_OPTIONS). Any change to one of
//     them selects another directory, so it starts cold and never overwrites the entries of the state it left.
// Keeping one directory per environment also means A, B, A replays the A entry instead of re-running (Vite Task
// holds a single entry per task).
//
// Vite Task still fingerprints the files, declared variables and `ORCH_TOOLCHAIN` (scripts/orch-toolchain.mjs) of
// every task, so the directory key only decides which entries are visible, never whether an entry is valid.
// Concurrent runs that resolve to one directory take a lock on it; a lock whose owner has exited is reclaimed.
//
// A `VITE_CACHE_PATH` already in the environment is honored as-is. In CI (`CI` set) the wrapper adds no `--cache`
// flag, so the hosted lanes run the same `vp run` they ran before this wrapper existed.
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_TASK = 'orch:build'
const SCHEMA = 'vp-local-run-v1'
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

const sha256 = (data) => createHash('sha256').update(data).digest('hex')

/** The shared git directory of the checkout, or the checkout itself when it is not a git repository. */
export function repositoryIdentity(root) {
  try {
    const common = execFileSync(
      'git',
      ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    ).trim()
    return realpathSync(common)
  } catch {
    return realpathSync(root)
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

/** Everything outside the input files that changes what a cached build means, hashed into one directory name. */
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
  return sha256(JSON.stringify(material)).slice(0, 32)
}

/** Where the cache for this checkout and environment lives. `cacheHome` must be absolute. */
export function cacheDirectory({ cacheHome, repository, environment }) {
  return join(cacheHome, sha256(repository).slice(0, 32), environment)
}

export function defaultCacheHome(env) {
  if (env.ADEA_VP_CACHE_HOME) return env.ADEA_VP_CACHE_HOME
  const base =
    env.XDG_CACHE_HOME && isAbsolute(env.XDG_CACHE_HOME)
      ? env.XDG_CACHE_HOME
      : join(homedir(), '.cache')
  return join(base, 'adea-vp')
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/**
 * Runs `work` while holding `<directory>.lock`. The lock file is published with a hard link from a private temporary
 * file, so it is never seen half-written and creating it is atomic. A lock held by a process that no longer exists
 * is reclaimed; a live one is waited for.
 */
export async function withLock(
  directory,
  work,
  { timeoutMs = LOCK_TIMEOUT_MS, pollMs = LOCK_POLL_MS } = {}
) {
  const lock = `${directory}.lock`
  mkdirSync(dirname(lock), { recursive: true })
  const started = Date.now()
  for (;;) {
    const staging = `${lock}.${process.pid}.${randomUUID()}`
    writeFileSync(staging, String(process.pid))
    try {
      linkSync(staging, lock)
      rmSync(staging, { force: true })
      break
    } catch (error) {
      rmSync(staging, { force: true })
      if (error.code !== 'EEXIST') throw error
      const owner = Number(readOwner(lock))
      if (Number.isInteger(owner) && owner > 0 && !alive(owner)) {
        rmSync(lock, { force: true })
        continue
      }
      if (Date.now() - started > timeoutMs)
        throw new Error(`timed out waiting for the cache lock ${lock}`, { cause: error })
      await sleep(pollMs)
    }
  }
  try {
    return await work()
  } finally {
    rmSync(lock, { force: true })
  }
}

function readOwner(lock) {
  try {
    return readFileSync(lock, 'utf8')
  } catch {
    return ''
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

/** The `vp run` arguments: `--cache` is added locally only, so CI runs the graph exactly as before. */
export function vpRunArguments({ task, passthrough, cacheEnabled }) {
  return ['run', ...(cacheEnabled ? ['--cache'] : []), task, ...passthrough]
}

export function readVitePlusVersion(root) {
  const manifest = join(root, 'node_modules', 'vite-plus', 'package.json')
  return existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')).version : 'absent'
}

function resolveRoot() {
  return realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
}

async function main(argv) {
  const root = resolveRoot()
  const { task, passthrough } = parseArgs(argv)
  const env = { ...process.env }
  const preset = env.VITE_CACHE_PATH
  if (preset !== undefined && !isAbsolute(preset))
    throw new Error('VITE_CACHE_PATH must be an absolute path')
  const ci = Boolean(env.CI)
  const cacheEnabled = !ci
  const directory =
    preset ??
    cacheDirectory({
      cacheHome: defaultCacheHome(env),
      repository: repositoryIdentity(root),
      environment: environmentKey({
        root,
        env,
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        vitePlusVersion: readVitePlusVersion(root),
      }),
    })
  if (preset === undefined) env.VITE_CACHE_PATH = directory
  const vp = join(root, 'node_modules', '.bin', 'vp')
  const args = vpRunArguments({ task, passthrough, cacheEnabled })

  // A signal that reached the wrapper is a cancellation even when `vp` exits 0 after stopping early, so the wrapper
  // never reports success for a run it was asked to stop.
  const runVp = () =>
    new Promise((done, fail) => {
      let received = null
      const forward = (signal) => {
        received = signal
        child.kill(signal)
      }
      const signals = ['SIGINT', 'SIGTERM']
      const child = spawn(vp, args, { cwd: root, env, stdio: 'inherit' })
      for (const signal of signals) process.on(signal, forward)
      child.on('error', fail)
      child.on('exit', (code, signal) => {
        for (const sig of signals) process.off(sig, forward)
        done({ code, signal: received ?? signal })
      })
    })

  console.log(`vp-local-run: ${task}, cache ${cacheEnabled ? directory : 'off (CI)'}`)
  const { code, signal } = await withLock(directory, runVp)
  if (signal) process.exitCode = 128 + (signal === 'SIGINT' ? 2 : 15)
  else process.exitCode = code ?? 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
