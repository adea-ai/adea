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
//   - no credential-shaped value from the environment reaches the shared cache.
//
// The real runs use the pinned client (`vite-plus`, the repository's own lockfile pin) and the repository's
// own graph. Nothing is substituted with a fake cache: the hit and miss counts are parsed from the client's
// own `vp run` output, through the same parser the hosted proof uses. The runs are local and offline; they
// contact no registry, no service and no hosted runner, and they write only into a disposable cache home and
// disposable checkouts.
//
// The qualification is conditional on the pinned client and the pinned toolchain being present, and it is
// skipped visibly without them, exactly as the transfer qualification does. It changes no release or CI gate,
// reads no credential, and creates no Cloudflare resource.
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
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
import { isAbsolute, join, resolve } from 'node:path'
import { environmentKey, planCache } from './vp-local-run.mjs'
import { matchesPattern, parseVpOutput } from './vite-plus-proof.mjs'

const repoRoot = resolve(import.meta.dirname, '..')
/** One real, small, portable task: the workspace's own build. Its output embeds no checkout path. */
const TASK = 'orch:types:build'
const PINNED_CLIENT = join(repoRoot, 'node_modules', 'vite-plus', 'package.json')
const clientInstalled = existsSync(PINNED_CLIENT)
const toolchainAvailable = spawnSync('bun', ['--version'], { encoding: 'utf8' }).status === 0
const real = clientInstalled && toolchainAvailable

interface Run {
  status: number | null
  output: string
  hits: number
  total: number
}

function runWrapper(root: string, cacheHome: string, extraEnv: Record<string, string> = {}): Run {
  const env = { ...process.env, ...extraEnv }
  // `CI` is one of the documented bypasses: without it the shared cache is used at all.
  delete (env as Record<string, string | undefined>).CI
  env.ADEA_VP_CACHE_HOME = cacheHome
  const child = spawnSync(process.execPath, [join(root, 'scripts', 'vp-local-run.mjs'), TASK], {
    cwd: root,
    encoding: 'utf8',
    env,
    timeout: 600_000,
  })
  const output = `${child.stdout ?? ''}${child.stderr ?? ''}`
  const parsed = parseVpOutput(output)
  return { status: child.status, output, hits: parsed.hits, total: parsed.total }
}

function disposableCheckout(name: string): { path: string; remove: () => void } {
  const base = mkdtempSync(join(tmpdir(), `adea-cache-${name}-`))
  const path = join(base, 'checkout')
  const added = spawnSync('git', ['-C', repoRoot, 'worktree', 'add', '--detach', path, 'HEAD'], {
    encoding: 'utf8',
  })
  if (added.status !== 0) throw new Error(`git worktree add failed: ${added.stderr}`)
  // The pinned client and the workspace dependencies live in the main checkout; the disposable checkout
  // borrows them, so the runs are the repository's own toolchain and not a substitute.
  symlinkSync(join(repoRoot, 'node_modules'), join(path, 'node_modules'), 'dir')
  // The borrowed dependencies are not the checkout's own work: they are excluded from its status, so the
  // checkout is clean and the wrapper selects the shared directory the isolation cases depend on.
  const exclude = spawnSync('git', ['-C', path, 'rev-parse', '--git-path', 'info/exclude'], {
    encoding: 'utf8',
  }).stdout.trim()
  appendFileSync(isAbsolute(exclude) ? exclude : join(repoRoot, exclude), 'node_modules\n')
  return {
    path,
    remove: () => {
      rmSync(base, { recursive: true, force: true })
      spawnSync('git', ['-C', repoRoot, 'worktree', 'prune'], { encoding: 'utf8' })
    },
  }
}

function disposableCacheHome(name: string): string {
  const home = mkdtempSync(join(tmpdir(), `adea-cache-home-${name}-`))
  return home
}

/** Every file name and every file's bytes under the cache home, for the leak check. */
function cacheHomeContents(home: string): string[] {
  const found: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        found.push(path)
        walk(path)
        continue
      }
      found.push(path)
      if (entry.isFile() && lstatSync(path).size < 4_000_000) {
        found.push(readFileSync(path, 'utf8'))
      }
    }
  }
  if (existsSync(home)) walk(home)
  return found
}

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

describe.skipIf(!real)('the real client qualifies cache correctness and reuse', () => {
  test('cold then warm: the first run misses, the second hits, and a source edit misses again', async () => {
    const home = disposableCacheHome('cold-warm')
    const checkout = disposableCheckout('cold-warm')
    const source = join(checkout.path, 'packages', 'types', 'src', 'account-directory.ts')
    const original = readFileSync(source, 'utf8')
    try {
      const cold = runWrapper(checkout.path, home)
      expect(cold.status).toBe(0)
      expect(matchesPattern(parseVpOutput(cold.output), 'cold')).toBe(true)

      const warm = runWrapper(checkout.path, home)
      expect(warm.status).toBe(0)
      expect(matchesPattern(parseVpOutput(warm.output), 'warm')).toBe(true)

      // A source edit inside the same dirty state keeps the directory, and the entry must still miss: the
      // client fingerprints the task's inputs, so a stale output is never replayed.
      writeFileSync(source, `${original}\n// a source change that the task's inputs must notice\n`)
      const afterEdit = runWrapper(checkout.path, home)
      expect(afterEdit.status).toBe(0)
      expect(matchesPattern(parseVpOutput(afterEdit.output), 'cold')).toBe(true)

      // A second, different edit in the same dirty state also misses. Validity is the client's input
      // fingerprint, not the dirtiness of the checkout, so two different sources never share an entry.
      writeFileSync(source, `${original}\n// a different source change\n`)
      const afterSecondEdit = runWrapper(checkout.path, home)
      expect(afterSecondEdit.status).toBe(0)
      expect(matchesPattern(parseVpOutput(afterSecondEdit.output), 'cold')).toBe(true)

      // The same source again hits: the entry is keyed by the inputs, so it is reusable and stable.
      const afterSameEdit = runWrapper(checkout.path, home)
      expect(afterSameEdit.status).toBe(0)
      expect(matchesPattern(parseVpOutput(afterSameEdit.output), 'warm')).toBe(true)
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
      expect(runWrapper(checkout.path, home).status).toBe(0)
      expect(matchesPattern(parseVpOutput(runWrapper(checkout.path, home).output), 'warm')).toBe(
        true
      )

      // One more build-relevant environment variable, at the same commit and with a clean checkout, so only
      // the environment identity differs: the run must not reuse the entry of the other identity.
      const other = runWrapper(checkout.path, home, { VITE_QUALIFICATION_PROBE: 'other-identity' })
      expect(other.status).toBe(0)
      expect(matchesPattern(parseVpOutput(other.output), 'cold')).toBe(true)
      expect(matchesPattern(parseVpOutput(runWrapper(checkout.path, home).output), 'warm')).toBe(
        true
      )

      // A changed lockfile and a changed build configuration each move the run off the previous entry.
      writeFileSync(lockfile, `${lockfileOriginal}\n// a dependency change\n`)
      const afterLockfile = runWrapper(checkout.path, home)
      expect(afterLockfile.status).toBe(0)
      expect(matchesPattern(parseVpOutput(afterLockfile.output), 'cold')).toBe(true)
      writeFileSync(lockfile, lockfileOriginal)

      writeFileSync(config, `${configOriginal}\n// a build configuration change\n`)
      const afterConfig = runWrapper(checkout.path, home)
      expect(afterConfig.status).toBe(0)
      expect(matchesPattern(parseVpOutput(afterConfig.output), 'cold')).toBe(true)
      writeFileSync(config, configOriginal)

      expect(matchesPattern(parseVpOutput(runWrapper(checkout.path, home).output), 'warm')).toBe(
        true
      )
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
      expect(runWrapper(first.path, home).status).toBe(0)
      // The second checkout is at the same commit of the same repository: it reuses the shared entry.
      const shared = runWrapper(second.path, home)
      expect(shared.status).toBe(0)
      expect(matchesPattern(parseVpOutput(shared.output), 'warm')).toBe(true)

      // A dirty checkout is isolated: it never sees the shared entry, and the shared entry is untouched.
      writeFileSync(source, `${original}\n// a local change\n`)
      const dirty = runWrapper(first.path, home)
      expect(dirty.status).toBe(0)
      expect(matchesPattern(parseVpOutput(dirty.output), 'cold')).toBe(true)
      const sharedAgain = runWrapper(second.path, home)
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
      expect(runWrapper(checkout.path, home).status).toBe(0)
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
      const refused = runWrapper(checkout.path, home)
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
    const secret = 'adea-cache-qualification-secret-value'
    try {
      const run = runWrapper(checkout.path, home, {
        BUN_INSTALL_TOKEN: secret,
        NPM_CONFIG_AUTHSRC: secret,
      })
      expect(run.status).toBe(0)
      const contents = cacheHomeContents(home).join('\n')
      expect(contents).not.toContain(secret)
    } finally {
      checkout.remove()
      rmSync(home, { recursive: true, force: true })
    }
  }, 900_000)
})
