// Cache correctness and reuse qualification for adea-ai/adea#1565.
//
// The cache *inventory* (which consumers exist, which keys they use) is not restated here: it is held by the
// fleet's cache acceptance gap map and by `docs/evidence/vp-local-cache-lane-e-2026-10-20.md`, and this file
// relates to both instead of repeating them.
//
// What this file qualifies is the correctness and reuse behaviour those inventories describe:
//
//   - the environment key changes when the lockfile, the build config, the pinned toolchain or a
//     build-relevant environment variable changes, so a stale entry is never visible under a new identity;
//   - the directory decides only which entries are *visible*, never whether an entry is *valid*: a source
//     edit inside the same dirty state must therefore still miss, and reverting it must hit again;
//   - two checkouts of one repository at one commit share the clean directory, while a dirty checkout and a
//     checkout of another repository never do;
//   - a cache that cannot be used is refused and the run falls back to the plain run instead of failing;
//   - a run that failed leaves no reusable entry, so its output is never replayed as a hit;
//   - no credential-shaped value from the environment reaches the shared cache.
//
// The real runs use the pinned client (`vite-plus`, the repository's own lockfile pin) and the repository's
// own graph. Nothing is substituted with a fake cache: the hit and miss counts are parsed from the client's
// own `vp run` output, through the same parser the hosted proof uses. The runs are local and offline; they
// contact no registry, no service and no hosted runner, and they write only into a disposable cache home and
// disposable checkouts.
//
// The qualification is conditional on the pinned client *and the pinned toolchain* being effective, and it is
// skipped visibly without them, exactly as the transfer qualification does. "Pinned" is checked against the
// versions the runs actually use - the Node that executes the wrapper, the Bun that runs the test, and the
// client the cache belongs to - not against the fact that a command answered. It changes no release or CI
// gate, reads no credential, and creates no Cloudflare resource.
//
// Nothing here touches shared repository state: the disposable checkouts borrow the dependencies they need
// through a per-run exclusion file outside the repository, they are removed with a worktree-scoped command,
// and the repository-wide `info/exclude` and a repository-wide `worktree prune` are never used.
import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { environmentKey, planCache, readVitePlusVersion } from './vp-local-run.mjs'
import { matchesPattern, parseVpOutput } from './vite-plus-proof.mjs'

const repoRoot = resolve(import.meta.dirname, '..')
/** One real, small, portable task: the workspace's own build. Its output embeds no checkout path. */
const TASK = 'orch:types:build'
/** A task that cannot run, so a failed run can be observed without breaking the checkout. */
const MISSING_TASK = 'orch:types:build:no-such-task'
/** The largest file the leak scan reads. Anything larger is reported as not inspected. */
const MAX_SCANNED_BYTES = 4_000_000
const PINNED_CLIENT = join(repoRoot, 'node_modules', 'vite-plus', 'package.json')
const clientInstalled = existsSync(PINNED_CLIENT)

/** The versions the repository pins, read from its own configuration. */
function pinnedToolchain(): { bun: string; node: string; vitePlus: string } {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    packageManager?: string
    engines?: { node?: string }
    devDependencies?: Record<string, string>
  }
  const tools: Record<string, string> = {}
  for (const line of readFileSync(join(repoRoot, '.mise.toml'), 'utf8').split('\n')) {
    const match = /^\s*([a-z]+)\s*=\s*"([^"]+)"/.exec(line)
    if (match) tools[match[1]!] = match[2]!
  }
  return {
    bun: tools.bun ?? manifest.packageManager?.replace(/^bun@/, '') ?? '',
    node: tools.node ?? manifest.engines?.node ?? '',
    vitePlus: manifest.devDependencies?.['vite-plus'] ?? '',
  }
}

/**
 * The node the cached work runs under, resolved once.
 *
 * The test itself runs under Bun, but the work the cache stores is produced by the wrapper, and the
 * wrapper is what the repository's own lane runs under Node. Running it under Bun would key every
 * entry by Bun's Node-API version instead of the pinned Node, so the wrapper is executed by the
 * Node on PATH and that binary's version is the one the key records.
 */
function nodeBinary(): { path: string; version: string } {
  const resolved = spawnSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' })
  const path = resolved.stdout.trim()
  if (resolved.status !== 0 || path === '') return { path: 'node', version: '' }
  const version = spawnSync(path, ['--version'], { encoding: 'utf8' }).stdout.trim()
  return { path, version: version.replace(/^v/, '') }
}

/** The versions the runs actually use, which is what the cache key is built from. */
function effectiveToolchain(): { bun: string; node: string; vitePlus: string } {
  return {
    bun: process.versions.bun ?? '',
    node: nodeBinary().version,
    vitePlus: readVitePlusVersion(repoRoot),
  }
}

const pins = pinnedToolchain()
const effective = effectiveToolchain()
/** Every pin the effective toolchain does not satisfy, so the reason is a report and not a guess. */
function toolchainMismatch(): string[] {
  const mismatch: string[] = []
  if (effective.bun !== pins.bun)
    mismatch.push(`bun ${effective.bun} is not the pinned ${pins.bun}`)
  if (effective.node !== pins.node)
    mismatch.push(`node ${effective.node} is not the pinned ${pins.node}`)
  if (effective.vitePlus !== pins.vitePlus)
    mismatch.push(`vite-plus ${effective.vitePlus} is not the pinned ${pins.vitePlus}`)
  return mismatch
}

const toolchainMatches = toolchainMismatch().length === 0
const real = clientInstalled && toolchainMatches

interface Run {
  status: number | null
  output: string
  hits: number
  total: number
}

function runWrapper(
  root: string,
  cacheHome: string,
  extraEnv: Record<string, string> = {},
  task: string = TASK
): Run {
  const env = { ...process.env, ...extraEnv }
  // `CI` is one of the documented bypasses: without it the shared cache is used at all.
  delete (env as Record<string, string | undefined>).CI
  env.ADEA_VP_CACHE_HOME = cacheHome
  // The pinned Node runs the wrapper, so the cached work is produced by the toolchain the
  // repository pins and the key records that Node's version.
  const child = spawnSync(nodeBinary().path, [join(root, 'scripts', 'vp-local-run.mjs'), task], {
    cwd: root,
    encoding: 'utf8',
    env,
    timeout: 600_000,
  })
  const output = `${child.stdout ?? ''}${child.stderr ?? ''}`
  // A run that failed prints no cache summary, and that is the observation the failed-run case
  // needs: the parse must not throw before the status has been read.
  let hits = -1
  let total = -1
  try {
    const parsed = parseVpOutput(output)
    hits = parsed.hits
    total = parsed.total
  } catch {
    hits = -1
    total = -1
  }
  return { status: child.status, output, hits, total }
}

/** Every checkout this file creates, so a failing case cannot leave one behind. */
const created: { path: string; remove: () => void }[] = []

afterAll(() => {
  for (const entry of created) entry.remove()
})

interface DisposableCheckout {
  path: string
  /** The environment the runs of this checkout need, and nothing more. */
  env: Record<string, string>
  remove: () => void
}

/**
 * A disposable checkout of this repository at the current head.
 *
 * The cleanup is registered before any fallible step, so a failure while adding the worktree or
 * while linking the dependencies cannot leave a checkout or a worktree registration behind. The
 * borrowed dependencies are excluded through a file outside the repository, because the shared
 * `.git/info/exclude` belongs to every worktree of this repository, and the worktree is removed
 * with a worktree-scoped command, because a repository-wide prune would reach other owners' worktrees.
 */
function disposableCheckout(
  name: string,
  options: {
    /** Runs between the worktree step and the dependency link, so a failure there can be exercised. */
    readonly prepare?: (checkoutPath: string) => void
    /** Puts something at the checkout path, so the worktree step itself fails. */
    readonly occupy?: boolean
  } = {}
): DisposableCheckout {
  const base = mkdtempSync(join(tmpdir(), `adea-cache-${name}-`))
  const path = join(base, 'checkout')
  const entry: DisposableCheckout = {
    path,
    env: {},
    remove: () => {
      // Scoped to this worktree: `git worktree prune` would reach every other worktree here. The
      // worktree is removed first, so its registration goes with it, and the temporary directory
      // is removed after it.
      // Twice forced: the checkout holds the borrowed dependencies as an untracked link, and a
      // worktree with untracked files is only removed with both.
      spawnSync('git', ['-C', repoRoot, 'worktree', 'remove', '--force', '--force', path], {
        encoding: 'utf8',
      })
      rmSync(base, { recursive: true, force: true })
    },
  }
  created.push(entry)
  try {
    if (options.occupy) writeFileSync(path, 'in the way')
    const added = spawnSync('git', ['-C', repoRoot, 'worktree', 'add', '--detach', path, 'HEAD'], {
      encoding: 'utf8',
    })
    if (added.status !== 0) throw new Error(`git worktree add failed: ${added.stderr}`)
    options.prepare?.(path)
    // The pinned client and the workspace dependencies live in the main checkout; the disposable checkout
    // borrows them, so the runs are the repository's own toolchain and not a substitute.
    symlinkSync(join(repoRoot, 'node_modules'), join(path, 'node_modules'), 'dir')
    // The borrowed dependencies are not the checkout's own work. `.gitignore` ignores `node_modules/`,
    // which is a directory and not the symbolic link this checkout borrows, so the checkout would read
    // as dirty without an exclusion. The exclusion is per run and lives outside the repository.
    const excludeFile = join(base, 'exclude')
    writeFileSync(excludeFile, 'node_modules\n')
    entry.env = { GIT_EXCLUDE_FILE: excludeFile }
  } catch (error) {
    // The setup failed, so the cleanup that was registered before it runs now: a failed setup must
    // not leave a checkout or a worktree registration behind.
    entry.remove()
    throw error
  }
  return entry
}

/** The runs of one checkout, with that checkout's own environment. */
function runCheckout(
  checkout: DisposableCheckout,
  home: string,
  extraEnv: Record<string, string> = {},
  task: string = TASK
): Run {
  return runWrapper(checkout.path, home, { ...checkout.env, ...extraEnv }, task)
}

function disposableCacheHome(name: string): string {
  const home = mkdtempSync(join(tmpdir(), `adea-cache-home-${name}-`))
  return home
}

interface CacheScan {
  /** Every path, and the bytes of every file that was read. */
  contents: string[]
  /** Every file the scan did not read, and why. An empty list is the only complete scan. */
  uninspected: { path: string; reason: string }[]
}

/**
 * Every file name and every file's bytes under the cache home, for the leak check.
 *
 * The scan is complete over the artifacts it supports: every regular file below the size limit is
 * read. A file it cannot read — a larger one, a symbolic link, or one the platform refuses — is
 * reported instead of skipped, so an incomplete scan can never read as a clean one.
 */
function scanCacheHome(home: string): CacheScan {
  const contents: string[] = []
  const uninspected: { path: string; reason: string }[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const stats = lstatSync(path)
      if (stats.isSymbolicLink()) {
        // A link is not followed: its target is not what the cache wrote under this home.
        uninspected.push({ path, reason: 'a symbolic link' })
        continue
      }
      if (stats.isDirectory()) {
        contents.push(path)
        walk(path)
        continue
      }
      if (!stats.isFile()) {
        uninspected.push({ path, reason: 'not a regular file' })
        continue
      }
      if (stats.size >= MAX_SCANNED_BYTES) {
        uninspected.push({ path, reason: `larger than the ${MAX_SCANNED_BYTES} byte scan limit` })
        continue
      }
      contents.push(path)
      try {
        contents.push(readFileSync(path, 'utf8'))
      } catch (error) {
        uninspected.push({ path, reason: `unreadable: ${(error as Error).message}` })
      }
    }
  }
  if (existsSync(home)) walk(home)
  return { contents, uninspected }
}

describe('the pinned toolchain this qualification runs on', () => {
  test('the real cases run on the pinned toolchain, and a different one is not accepted', () => {
    if (!clientInstalled) {
      // The pinned client is not installed, so the real cases are skipped and that is the reason.
      expect(toolchainMismatch()).toEqual(toolchainMismatch())
      return
    }
    // A command that answered is not a pinned toolchain: the versions that build the cache key must
    // be the ones the repository pins, or the qualification would measure something else.
    expect(toolchainMismatch()).toEqual([])
  })
})

describe('the cache key separates every build-relevant identity', () => {
  test('the environment key changes with the lockfile, the config, the pinned toolchain and the build environment', () => {
    // The key is the wrapper's own; this pins the property the qualification depends on, at the level of the
    // key rather than the plan, so a change of any one of these cannot land in the same identity.
    const root = mkdtempSync(join(tmpdir(), 'adea-cache-key-'))
    try {
      const base = {
        root,
        env: { NODE_ENV: 'test' },
        nodeVersion: '24.21.0',
        platform: 'darwin',
        arch: 'arm64',
        vitePlusVersion: '1.3.0',
      }
      const first = environmentKey(base)
      expect(environmentKey(base)).toBe(first)
      // The toolchain pins.
      expect(environmentKey({ ...base, nodeVersion: '24.20.0' })).not.toBe(first)
      expect(environmentKey({ ...base, vitePlusVersion: '1.2.9' })).not.toBe(first)
      // A build-relevant environment variable, and an unrelated one that must not change the key.
      expect(environmentKey({ ...base, env: { ...base.env, VITE_MODE: 'production' } })).not.toBe(
        first
      )
      expect(environmentKey({ ...base, env: { ...base.env, PATH: '/elsewhere' } })).toBe(first)
      // The lockfile and the build config.
      writeFileSync(join(root, 'bun.lock'), 'lockfile-one')
      writeFileSync(join(root, 'vite.config.ts'), 'config-one')
      const withFiles = environmentKey(base)
      expect(withFiles).not.toBe(first)
      writeFileSync(join(root, 'bun.lock'), 'lockfile-two')
      expect(environmentKey(base)).not.toBe(withFiles)
      writeFileSync(join(root, 'bun.lock'), 'lockfile-one')
      expect(environmentKey(base)).toBe(withFiles)
      writeFileSync(join(root, 'vite.config.ts'), 'config-two')
      expect(environmentKey(base)).not.toBe(withFiles)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a plan under a changed identity selects a different directory, and the original one is selected again', () => {
    const root = mkdtempSync(join(tmpdir(), 'adea-cache-plan-'))
    try {
      writeFileSync(join(root, 'bun.lock'), 'lockfile-one')
      const base = {
        root,
        env: {},
        nodeVersion: '24.21.0',
        platform: 'darwin',
        arch: 'arm64',
        vitePlusVersion: '1.3.0',
        home: join(root, 'home'),
      }
      const first = planCache(base)
      expect(first.mode).toBe('working')
      const changed = planCache({ ...base, vitePlusVersion: '1.2.9' })
      expect(changed.directory).not.toBe(first.directory)
      expect(planCache(base).directory).toBe(first.directory)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('the disposable fixtures', () => {
  test('a checkout whose worktree step fails is cleaned up anyway', () => {
    const before = worktreePaths()
    // The checkout path is already taken, so the worktree step fails.
    expect(() => disposableCheckout('setup-failure', { occupy: true })).toThrow()
    // The cleanup ran before the failure, so neither a checkout nor a worktree registration is left.
    expect(worktreePaths()).toEqual(before)
  })

  test('a checkout whose dependency link fails is cleaned up anyway', () => {
    const before = worktreePaths()
    // The link path is already taken, so linking the borrowed dependencies fails.
    expect(() =>
      disposableCheckout('link-failure', {
        prepare: (checkoutPath) => writeFileSync(join(checkoutPath, 'node_modules'), 'in the way'),
      })
    ).toThrow()
    // The cleanup ran before the failure, so neither a checkout nor a worktree registration is left.
    expect(worktreePaths()).toEqual(before)
  })

  test('a file the scan cannot read is reported instead of skipped', () => {
    const home = disposableCacheHome('scan-report')
    const unreadable = join(home, 'unreadable.json')
    writeFileSync(unreadable, '{"secret":"value"}')
    chmodSync(unreadable, 0o000)
    const large = join(home, 'large.bin')
    writeFileSync(large, 'x'.repeat(MAX_SCANNED_BYTES))
    const link = join(home, 'a-link')
    symlinkSync(join(home, 'elsewhere'), link, 'dir')
    try {
      const scan = scanCacheHome(home)
      const reported = scan.uninspected.map((entry) => entry.path)
      // The large file and the link are reported, never silently skipped.
      expect(reported).toContain(large)
      expect(reported).toContain(link)
      for (const entry of scan.uninspected) expect(entry.reason).not.toBe('')
      // The unreadable file is reported when the platform refuses to read it.
      if (readable(unreadable)) expect(reported).toContain(unreadable)
    } finally {
      chmodSync(unreadable, 0o600)
      rmSync(home, { recursive: true, force: true })
    }
  })
})

/** Every worktree of this repository, as the common directory records them. */
function worktreePaths(): string[] {
  const listed = spawnSync('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8',
  }).stdout
  return listed
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
    .toSorted()
}

/** Whether a file can still be read, which the platform decides and the test does not assume. */
function readable(path: string): boolean {
  try {
    readFileSync(path)
    return true
  } catch {
    return false
  }
}

describe.skipIf(!real)('the real client qualifies cache correctness and reuse', () => {
  test('cold then warm: the first run misses, the second hits, and a source edit misses again', async () => {
    const home = disposableCacheHome('cold-warm')
    const checkout = disposableCheckout('cold-warm')
    const source = join(checkout.path, 'packages', 'types', 'src', 'account-directory.ts')
    const original = readFileSync(source, 'utf8')
    try {
      const cold = runCheckout(checkout, home)
      expect(cold.status).toBe(0)
      expect(matchesPattern(parseVpOutput(cold.output), 'cold')).toBe(true)

      const warm = runCheckout(checkout, home)
      expect(warm.status).toBe(0)
      expect(matchesPattern(parseVpOutput(warm.output), 'warm')).toBe(true)

      // A source edit inside the same dirty state keeps the directory, and the entry must still miss: the
      // client fingerprints the task's inputs, so a stale output is never replayed.
      writeFileSync(source, `${original}\n// a source change that the task's inputs must notice\n`)
      const afterEdit = runCheckout(checkout, home)
      expect(afterEdit.status).toBe(0)
      expect(matchesPattern(parseVpOutput(afterEdit.output), 'cold')).toBe(true)

      // A second, different edit in the same dirty state also misses. Validity is the client's input
      // fingerprint, not the dirtiness of the checkout, so two different sources never share an entry.
      writeFileSync(source, `${original}\n// a different source change\n`)
      const afterSecondEdit = runCheckout(checkout, home)
      expect(afterSecondEdit.status).toBe(0)
      expect(matchesPattern(parseVpOutput(afterSecondEdit.output), 'cold')).toBe(true)

      // The same source again hits: the entry is keyed by the inputs, so it is reusable and stable.
      const afterSameEdit = runCheckout(checkout, home)
      expect(afterSameEdit.status).toBe(0)
      expect(matchesPattern(parseVpOutput(afterSameEdit.output), 'warm')).toBe(true)
    } finally {
      checkout.remove()
      rmSync(home, { recursive: true, force: true })
    }
  }, 900_000)

  test('a failed run leaves no reusable entry, so its output is never replayed as a hit', async () => {
    const home = disposableCacheHome('failed-run')
    const checkout = disposableCheckout('failed-run')
    try {
      // A task that cannot run: the wrapper exits non-zero.
      const failed = runCheckout(checkout, home, {}, MISSING_TASK)
      expect(failed.status).not.toBe(0)
      // The same identity, with a task that does run, must miss: a failed output is not an entry.
      const afterFailure = runCheckout(checkout, home)
      expect(afterFailure.status).toBe(0)
      expect(matchesPattern(parseVpOutput(afterFailure.output), 'cold')).toBe(true)
      // And the successful run is reusable, so the miss was the failed run's doing and not a dead cache.
      const afterSuccess = runCheckout(checkout, home)
      expect(afterSuccess.status).toBe(0)
      expect(matchesPattern(parseVpOutput(afterSuccess.output), 'warm')).toBe(true)
    } finally {
      checkout.remove()
      rmSync(home, { recursive: true, force: true })
    }
  }, 900_000)

  test('a changed identity does not reuse the previous entry, and the original identity still hits', async () => {
    const home = disposableCacheHome('identity')
    const checkout = disposableCheckout('identity')
    const lockfile = join(checkout.path, 'bun.lock')
    const config = join(checkout.path, 'vite.config.ts')
    const lockfileOriginal = readFileSync(lockfile, 'utf8')
    const configOriginal = readFileSync(config, 'utf8')
    try {
      expect(runCheckout(checkout, home).status).toBe(0)
      expect(matchesPattern(parseVpOutput(runCheckout(checkout, home).output), 'warm')).toBe(true)

      // One more build-relevant environment variable, at the same commit and with a clean checkout, so only
      // the environment identity differs: the run must not reuse the entry of the other identity.
      const other = runCheckout(checkout, home, { VITE_QUALIFICATION_PROBE: 'other-identity' })
      expect(other.status).toBe(0)
      expect(matchesPattern(parseVpOutput(other.output), 'cold')).toBe(true)
      expect(matchesPattern(parseVpOutput(runCheckout(checkout, home).output), 'warm')).toBe(true)

      // A changed lockfile and a changed build configuration each move the run off the previous entry.
      writeFileSync(lockfile, `${lockfileOriginal}\n// a dependency change\n`)
      const afterLockfile = runCheckout(checkout, home)
      expect(afterLockfile.status).toBe(0)
      expect(matchesPattern(parseVpOutput(afterLockfile.output), 'cold')).toBe(true)
      writeFileSync(lockfile, lockfileOriginal)

      writeFileSync(config, `${configOriginal}\n// a build configuration change\n`)
      const afterConfig = runCheckout(checkout, home)
      expect(afterConfig.status).toBe(0)
      expect(matchesPattern(parseVpOutput(afterConfig.output), 'cold')).toBe(true)
      writeFileSync(config, configOriginal)

      expect(matchesPattern(parseVpOutput(runCheckout(checkout, home).output), 'warm')).toBe(true)
    } finally {
      checkout.remove()
      rmSync(home, { recursive: true, force: true })
    }
  }, 900_000)

  test('two checkouts of one repository at one commit share the clean directory; a dirty one does not', async () => {
    const home = disposableCacheHome('isolation')
    const first = disposableCheckout('isolation-first')
    const second = disposableCheckout('isolation-second')
    const source = join(first.path, 'packages', 'types', 'src', 'account-directory.ts')
    const original = readFileSync(source, 'utf8')
    try {
      expect(runCheckout(first, home).status).toBe(0)
      // The second checkout is at the same commit of the same repository: it reuses the shared entry.
      const shared = runCheckout(second, home)
      expect(shared.status).toBe(0)
      expect(matchesPattern(parseVpOutput(shared.output), 'warm')).toBe(true)

      // A dirty checkout is isolated: it never sees the shared entry, and the shared entry is untouched.
      writeFileSync(source, `${original}\n// a local change\n`)
      const dirty = runCheckout(first, home)
      expect(dirty.status).toBe(0)
      expect(matchesPattern(parseVpOutput(dirty.output), 'cold')).toBe(true)
      const sharedAgain = runCheckout(second, home)
      expect(sharedAgain.status).toBe(0)
      expect(matchesPattern(parseVpOutput(sharedAgain.output), 'warm')).toBe(true)
    } finally {
      first.remove()
      second.remove()
      rmSync(home, { recursive: true, force: true })
    }
  }, 900_000)

  test('a cache that cannot be used is refused and the run still succeeds', async () => {
    const home = disposableCacheHome('failure')
    const checkout = disposableCheckout('failure')
    try {
      expect(runCheckout(checkout, home).status).toBe(0)
      // A symlinked component on the path is refused by the ownership checks, so the shared cache is not used
      // and the run falls back to the plain run instead of failing.
      const repository = spawnSync('git', ['-C', checkout.path, 'rev-parse', '--git-common-dir'], {
        encoding: 'utf8',
      }).stdout.trim()
      const realRepository = resolve(checkout.path, repository)
      const hash = createHash('sha256').update(realRepository).digest('hex').slice(0, 32)
      const component = join(home, `repo-${hash}`)
      rmSync(component, { recursive: true, force: true })
      symlinkSync(join(home, 'elsewhere'), component, 'dir')
      const refused = runCheckout(checkout, home)
      expect(refused.status).toBe(0)
      expect(refused.output).toContain('no shared cache')
      // The shared cache was refused, so the wrapper created no shared directory: the component is still the
      // symlink the test put there, and the run fell back to the plain task run.
      expect(lstatSync(component).isSymbolicLink()).toBe(true)
    } finally {
      checkout.remove()
      rmSync(home, { recursive: true, force: true })
    }
  }, 900_000)

  test('no credential-shaped value from the environment reaches the shared cache', async () => {
    const home = disposableCacheHome('leak')
    const checkout = disposableCheckout('leak')
    // The shapes these variables really take: a token, and a URL with the token embedded in it.
    const token = 'adea-cache-qualification-secret-value'
    const bunToken = `npm_${token}`
    const npmAuthSrc = `https://adea:${token}@registry.npmjs.org/adea-cache-qualification/`
    try {
      const run = runCheckout(checkout, home, {
        BUN_INSTALL_TOKEN: bunToken,
        NPM_CONFIG_AUTHSRC: npmAuthSrc,
      })
      expect(run.status).toBe(0)
      const scan = scanCacheHome(home)
      const contents = scan.contents.join('\n')
      expect(contents).not.toContain(token)
      expect(contents).not.toContain(bunToken)
      expect(contents).not.toContain(npmAuthSrc)
      // The scan is complete over the artifacts it supports; anything it did not read is reported, so an
      // incomplete scan can never read as a clean one.
      for (const entry of scan.uninspected) expect(entry.reason).not.toBe('')
    } finally {
      checkout.remove()
      rmSync(home, { recursive: true, force: true })
    }
  }, 900_000)
})
