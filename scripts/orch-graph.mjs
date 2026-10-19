// Builds the `orch:*` Vite Task graph for the workspace from its manifests, so it cannot drift from them.
//
// The graph replaces `turbo.json` (`build`, `typecheck`, `lint`, `test`) and runs the same package scripts, so Bun
// keeps running the tests. Its rules are the Turbo ones:
//
//   build      after the `build` of every workspace dependency (`^build`); outputs `dist/**`
//   typecheck  after the `build` of every workspace dependency (`^build`)
//   lint       no dependencies
//   test       after the package's own `build` (`dependsOn: ["build"]`)
//
// Vite Task fingerprints a task's command, its declared `env`, and the files it reads. It sees only what `node`
// (`tsc`, `vite`) reads on its own. What `bun` loads (the script it starts, its imports, a test file, `bunfig.toml`
// and its preload) is not seen, so every task lists those as explicit `input` globs.
import { createHash } from 'node:crypto'
import {
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  existsSync,
  statSync,
} from 'node:fs'
import { join, resolve, sep } from 'node:path'

import { PUBLIC_ENV_NAMES } from '../apps/web/start/client-policy.mjs'

export const WORKSPACE_ROOTS = ['apps', 'packages']

/** Files every task depends on that no package directory contains. */
export const GLOBAL_INPUTS = [
  'bun.lock',
  'bunfig.toml',
  'tsconfig.base.json',
  // `tsconfig.base.json` extends this one. `tsc` reports the read to the runner; `bun check` would not.
  'packages/config/tsconfig.base.json',
  'tsconfig.json',
  '.oxlintrc.json',
]

/**
 * Vite's config loader writes the config it bundled to `<nearest node_modules>/.vite-temp/<name>.timestamp-<ms>-<hash>.mjs`
 * and deletes the file, but not the directory. Run under `vp`, Vite reports that directory to the runner as an ignored
 * input (`ignoreInput`); the web build unsets the runner's client address (see `buildUnsetEnv`), so the report never
 * arrives and the runner tracks the paths itself. The root `node_modules` directory is not an input (its listing gained
 * `.vite-temp` while a task ran), nor are `node_modules/.vite-temp` and the temporary file in it. The saved web-build
 * entry of the hosted cold run recorded both of those paths, and the fresh runner of the next run had neither
 * ("'.vite-temp' removed from 'node_modules'"). The exclusions are exact: the dependency files below `node_modules`
 * stay inputs, as do `bun.lock` and the toolchain id.
 */
export const VOLATILE_INPUTS = [
  '!node_modules',
  '!node_modules/.vite-temp',
  '!node_modules/.vite-temp/**',
]

/** `bunfig.toml` preloads these into every `bun test`; only the test tasks run them. */
export const TEST_INPUTS = ['scripts/test-target-preload.ts', 'scripts/test-target-guard.mjs']

/** Generated or volatile paths below a package. They are products of a run, never inputs. */
const GENERATED = [
  'node_modules',
  '.turbo',
  '.vite',
  '.wrangler',
  '.cache',
  'coverage',
  'test-results',
  'playwright-report',
]

/**
 * The Solid compile step the four Solid packages' tests run under (`bun test --preload`, see their `test` scripts):
 * a change to it changes the JSX every one of their tests executes, but it is outside every package directory.
 */
const SOLID_TEST_TRANSFORM = 'scripts/test-solid-transform.ts'

/**
 * Per-package facts the manifests cannot express. Each entry is something a task reads (or writes) that the
 * package directory glob does not already cover or must not include.
 */
export const PACKAGE_RULES = {
  'apps/desktop': {
    // Its tests spawn children with a scrubbed environment and assert that no loader variable reaches them
    // (supervision-env-contract, worktree-bootstrap-leases-templates). Vite Task tracks a cached task's file reads
    // with an `LD_PRELOAD` shim that it re-injects into every descendant process, so those two assertions fail
    // under a cached task. The suite runs uncached; Turbo cached it.
    uncachedTest: true,
  },
  'apps/web': {
    // `dist/` is the build output; `public/assets` is staged by `scripts/sync-assets.mjs` on every build;
    // `cloudflare-env.d.ts` is written by `wrangler types`; `dist-desktop` is the desktop build's output.
    generated: ['dist', 'dist-desktop', 'public/assets', 'cloudflare-env.d.ts', '.assets.*'],
    // `bun ../../scripts/sync-assets.mjs` copies these into `public/assets`, which `vite build` then reads; it
    // imports `scripts/pack-agent-sim.mjs`, which stages the Agent Sim engine pack into the same tree.
    build: [
      'scripts/sync-assets.mjs',
      'scripts/pack-agent-sim.mjs',
      'packages/spatial/data/**',
      // The build creates `.wrangler`, `dist`, `cloudflare-env.d.ts` and `public/assets` itself, so the directory
      // listings of `apps/web` and `apps/web/public` differ between the run that built them and a fresh checkout
      // ("'.wrangler' removed from 'apps/web'", "'assets' removed from 'apps/web/public'"). Only those two listings
      // are excluded; the files in them stay tracked.
      '!apps/web',
      '!apps/web/public',
    ],
    // Build-time values the web build reads. `vite.config.ts` substitutes the four `ADEA_PUBLIC_*` names
    // (`PUBLIC_ENV_NAMES`) into the browser code, and `pack-agent-sim.mjs` stages the pack at `ADEA_AGENT_SIM_DIST`.
    // A cached task is given only the variables it declares, so an undeclared name would never reach the build.
    buildEnv: [...PUBLIC_ENV_NAMES, 'ADEA_AGENT_SIM_DIST'],
    // The pack is a directory outside the workspace, so its contents are not an input glob. Its digest is written
    // into the command instead (see `agentSimPackDigest`).
    agentSimPack: true,
    // `dist` embeds the absolute paths of the checkout that built it, so its cache entry is keyed by that checkout's
    // canonical path too (`ORCH_CHECKOUT`, see `checkoutIdentity`). It then misses in every other checkout instead of
    // replaying a path that is not its own. The other packages' outputs are portable and are shared across checkouts.
    pathSensitive: true,
    // TanStack Start's `loadEnvPlugin` calls `loadEnv(mode, root, '')`, and under `vp run` Vite reports that to the
    // runner as a dependency on EVERY environment variable (`getEnvs({ prefix: '' })`), so any ambient variable
    // (`OLDPWD`, a CI run id) would be a cache miss. Without the runner's client address Vite reports nothing; the
    // build still reads the variables it needs (`VITE_*` is declared above), and the runner still tracks file reads.
    buildUnsetEnv: ['VP_RUN_NODE_CLIENT_PATH'],
    test: [
      'scripts/setup-source-contract-tests.mjs',
      // `desktop-local-content.test.ts` and `desktop-transcription.test.ts` read the desktop shell source;
      // `cloudflare-config.test.ts` reads the preview workflow.
      'apps/desktop/shell/src/**',
      '.github/workflows/cloudflare-preview.yml',
      SOLID_TEST_TRANSFORM,
    ],
  },
  'packages/data': {
    // `controller-audience.test.ts` reads the workspace controller source.
    test: ['packages/workspace-ui/src/**', SOLID_TEST_TRANSFORM],
  },
  'packages/dev-view': {
    test: [SOLID_TEST_TRANSFORM],
  },
  'packages/remote-content': {
    // Its `test` script runs `bun run build` first, so `dist` is rewritten by the task: it is a product of the
    // run, not an input (it is a function of `src`, which is an input).
    rebuildsDistInTest: true,
  },
  'packages/ui': {
    // `tests/shared-ui-boundary.test.ts` scans these sources.
    test: [
      'apps/web/src/**',
      'packages/workspace-nav/src/**',
      'packages/workspace-ui/src/**',
      SOLID_TEST_TRANSFORM,
    ],
  },
  'packages/workspace-ui': {
    test: [SOLID_TEST_TRANSFORM],
  },
}

export function discoverWorkspaces(root) {
  const found = []
  for (const group of WORKSPACE_ROOTS) {
    const groupDir = join(root, group)
    if (!existsSync(groupDir)) continue
    for (const entry of readdirSync(groupDir).toSorted()) {
      const manifestPath = join(groupDir, entry, 'package.json')
      if (!existsSync(manifestPath)) continue
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      found.push({ dir: `${group}/${entry}`, short: entry, name: manifest.name, manifest })
    }
  }
  const names = new Set(found.map((workspace) => workspace.name))
  for (const workspace of found) {
    const { manifest } = workspace
    workspace.dependencies = Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
      ...manifest.optionalDependencies,
    })
      .filter((name) => names.has(name))
      .toSorted()
    workspace.scripts = manifest.scripts ?? {}
  }
  return found
}

function closure(byName, workspace, seen = new Set()) {
  for (const name of workspace.dependencies) {
    if (seen.has(name)) continue
    seen.add(name)
    closure(byName, byName.get(name), seen)
  }
  return seen
}

const generatedGlobs = (dir, extra = []) =>
  [...GENERATED, ...extra].map((path) => `!${dir}/${path.includes('*') ? path : `${path}/**`}`)

/** The package's own files, without what a run generates. */
function own(workspace, { includeDist }) {
  const rule = PACKAGE_RULES[workspace.dir] ?? {}
  const generated = [...(rule.generated ?? ['dist'])]
  const kept = includeDist ? generated.filter((path) => path !== 'dist') : generated
  return [`${workspace.dir}/**`, ...generatedGlobs(workspace.dir, kept)]
}

/** A dependency as `tsc`, `vite` and `bun` see it: the built `dist` and its manifest. */
const builtDependency = (dir) => [`${dir}/dist/**`, `${dir}/package.json`]

/** Everything of a dependency that its dependents' tests can load (`dist`, and `src` through relative imports). */
const wholeDependency = (workspace) => [
  `${workspace.dir}/**`,
  ...generatedGlobs(
    workspace.dir,
    PACKAGE_RULES[workspace.dir]?.generated?.filter((p) => p !== 'dist') ?? []
  ),
]

const taskName = (workspace, task) => `orch:${workspace.short}:${task}`
const has = (workspace, script) => typeof workspace.scripts[script] === 'string'
const run = (workspace, script) => `bun run --cwd ${workspace.dir} ${script}`

/**
 * A task that only orders others: `vp` has no command-less tasks, so the command is a no-op that is never cached.
 * Its dependencies run concurrently, up to the concurrency limit.
 */
const group = (dependsOn) => ({ command: 'node -e 0', cache: false, dependsOn })

/**
 * Content digest of the Agent Sim engine pack `ADEA_AGENT_SIM_DIST` names: `none` when it is unset, `null` when the
 * pack cannot be digested completely.
 *
 * `scripts/pack-agent-sim.mjs` copies the pack into `apps/web/public/assets/agent-sim`, and `bun` runs it, so the
 * runner sees neither the read nor a glob that could name a directory outside the workspace. The digest is part of the
 * cached command: a different pack is a different key, the same pack is a hit. A relative path is resolved against
 * `apps/web`, as `packFromEnv` resolves it against the working directory of `bun run --cwd apps/web build`.
 *
 * The staging script follows symbolic links (`stat` and `readFile` of `engine.json` and `engine.js`) and copies the
 * rest with `cp`, which keeps links as links. So a link is digested by its own text and by the file it points to, and
 * a link is accepted only when it points to a file or directory inside the pack (the pack root, its links and their
 * targets are compared by real path), where the walk digests the target's contents at its own place. A link that
 * leaves the pack, a dangling link, an unreadable entry and anything that is not a file, directory or link make the
 * digest `null`; the web build then runs uncached, because a partial digest could replay stale output.
 */
export function agentSimPackDigest(root, env = process.env) {
  const configured = env.ADEA_AGENT_SIM_DIST
  if (!configured) return 'none'
  const hash = createHash('sha256')
  try {
    const pack = realpathSync(resolve(root, 'apps/web', configured))
    const inside = (path) => path === pack || path.startsWith(`${pack}${sep}`)
    const walk = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true }).toSorted((a, b) =>
        a.name < b.name ? -1 : 1
      )) {
        const path = join(directory, entry.name)
        const name = path.slice(pack.length)
        if (entry.isSymbolicLink()) {
          if (!inside(realpathSync(path))) return false
          hash.update(`link\0${name}\0${readlinkSync(path)}\0`)
        } else if (entry.isDirectory()) {
          hash.update(`dir\0${name}\0`)
          if (!walk(path)) return false
        } else if (entry.isFile()) {
          hash.update(`file\0${name}\0${statSync(path).size}\0`)
          hash.update(readFileSync(path))
        } else {
          return false
        }
      }
      return true
    }
    if (!walk(pack)) return null
  } catch {
    return null
  }
  return hash.digest('hex').slice(0, 16)
}

/**
 * The canonical path of the checkout, hashed: the identity a path-sensitive task carries in its command, so that its
 * cache entry is valid for this checkout only. Changing the checkout's location changes the identity.
 */
export function checkoutIdentity(root) {
  return createHash('sha256').update(realpathSync(root)).digest('hex').slice(0, 16)
}

const hasViteBuild = (workspace) => /\bvite build\b/.test(workspace.scripts.build ?? '')

/**
 * `toolchainId` names Node, Bun and the platform (see orch-toolchain.mjs): it is written into every cached command so
 * a different toolchain is a different key. `orch:toolchain` checks it on every invocation.
 */
export function buildTasks(root, toolchainId, env = process.env) {
  const workspaces = discoverWorkspaces(root)
  const byName = new Map(workspaces.map((workspace) => [workspace.name, workspace]))
  const cached = (command, dependsOn, cache) => ({
    // `vp` sets `FORCE_COLOR=1` for every cached task, which colours the stderr a test parses from a child
    // process (packages/db's factory-process test). Turbo passes no such variable, so it is removed.
    command: `ORCH_TOOLCHAIN=${toolchainId}${cache.prefix ? ` ${cache.prefix}` : ''} env ${['FORCE_COLOR', ...(cache.unsetEnv ?? [])].map((name) => `-u ${name}`).join(' ')} ${command}`,
    dependsOn: ['orch:toolchain', ...dependsOn],
    cache: {
      input: [{ auto: true }, ...GLOBAL_INPUTS, ...VOLATILE_INPUTS, ...cache.input],
      ...cache.rest,
    },
  })
  const buildsOf = (names) =>
    names.map((name) => byName.get(name)).filter((dep) => has(dep, 'build'))

  const tasks = {
    // Not cached: it runs on every invocation with the PATH the tasks get, and fails unless that PATH holds the
    // `node`, `bun` and platform named in the other tasks' commands. Then no dependent task runs or touches the cache.
    'orch:toolchain': {
      command: `node scripts/orch-toolchain.mjs --expect ${toolchainId}`,
      cache: false,
    },
  }
  const all = { build: [], typecheck: [], lint: [], test: [] }

  for (const workspace of workspaces) {
    const direct = buildsOf(workspace.dependencies)
    const transitive = [...closure(byName, workspace)].map((name) => byName.get(name))
    const rule = PACKAGE_RULES[workspace.dir] ?? {}
    const buildDeps = direct.map((dep) => taskName(dep, 'build'))
    const builtInputs = transitive.flatMap((dep) => builtDependency(dep.dir))
    const viteEnv = hasViteBuild(workspace) || workspace.dir === 'apps/web' ? ['VITE_*'] : []

    if (has(workspace, 'build')) {
      const name = taskName(workspace, 'build')
      const packDigest = rule.agentSimPack ? agentSimPackDigest(root, env) : undefined
      tasks[name] =
        packDigest === null
          ? {
              command: run(workspace, 'build'),
              dependsOn: ['orch:toolchain', ...buildDeps],
              cache: false,
            }
          : cached(run(workspace, 'build'), buildDeps, {
              unsetEnv: rule.buildUnsetEnv,
              prefix: [
                rule.pathSensitive ? `ORCH_CHECKOUT=${checkoutIdentity(root)}` : '',
                packDigest === undefined ? '' : `ORCH_AGENT_SIM_PACK=${packDigest}`,
              ]
                .filter(Boolean)
                .join(' '),
              input: [
                ...own(workspace, { includeDist: false }),
                ...builtInputs,
                ...(rule.build ?? []),
              ],
              rest: {
                output: [`${workspace.dir}/dist/**`],
                env: [...viteEnv, ...(rule.buildEnv ?? [])],
              },
            })
      all.build.push(name)
    }
    if (has(workspace, 'typecheck')) {
      const name = taskName(workspace, 'typecheck')
      tasks[name] = cached(run(workspace, 'typecheck'), buildDeps, {
        input: [...own(workspace, { includeDist: false }), ...builtInputs],
        rest: { env: viteEnv },
      })
      all.typecheck.push(name)
    }
    if (has(workspace, 'lint')) {
      const name = taskName(workspace, 'lint')
      // Turbo's `lint` has no dependencies and its hash holds only the package's files, so a dependency's
      // `dist` is neither an ordering nor an input here.
      tasks[name] = cached(run(workspace, 'lint'), [], {
        input: [
          ...own(workspace, { includeDist: false }),
          '!packages/*/dist/**',
          '!apps/*/dist/**',
        ],
        rest: {},
      })
      all.lint.push(name)
    }
    if (has(workspace, 'test')) {
      const name = taskName(workspace, 'test')
      // Turbo's `test` follows the package's own `build`. A package without one (apps/desktop) still imports its
      // dependencies' `dist` through their `exports`, so it waits for every build in its dependency closure rather
      // than racing them, including builds behind a dependency that has no build script itself.
      const selfBuild = has(workspace, 'build')
        ? [taskName(workspace, 'build')]
        : buildsOf([...closure(byName, workspace)]).map((dep) => taskName(dep, 'build'))
      tasks[name] = rule.uncachedTest
        ? {
            command: run(workspace, 'test'),
            dependsOn: ['orch:toolchain', ...selfBuild],
            cache: false,
          }
        : cached(run(workspace, 'test'), selfBuild, {
            input: [
              ...own(workspace, { includeDist: !rule.rebuildsDistInTest }),
              ...transitive.flatMap((dep) => wholeDependency(dep)),
              ...(rule.test ?? []),
              ...TEST_INPUTS,
            ],
            rest: {},
          })
      all.test.push(name)
    }
  }

  for (const kind of Object.keys(all)) tasks[`orch:${kind}`] = group(all[kind])
  // `turbo run build --filter=@adea-ai/web^...`: everything a package depends on, without the package.
  for (const workspace of workspaces) {
    const deps = buildsOf([...closure(byName, workspace)]).map((dep) => taskName(dep, 'build'))
    if (deps.length > 0) tasks[`orch:deps-of-${workspace.short}:build`] = group(deps)
  }
  return tasks
}
