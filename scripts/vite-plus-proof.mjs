#!/usr/bin/env node
// Opt-in Vite+ cache proof lane (vite.config.ts). Turbo stays the required
// runner; this only exercises the `proof` task graph.
//
//   node scripts/vite-plus-proof.mjs [options]   run the graph once in this checkout
//     --expect cold|warm|one-miss   assert the cache hit pattern
//     --miss <task>                 with one-miss: the lone miss must be exactly <task>, e.g. types:test
//     --fresh                       assert every package's dist is absent before the run
//     --expect-manifest <sha>       assert the sha256 of all dist outputs afterwards
//   node scripts/vite-plus-proof.mjs --self-check    isolated checks in a disposable worktree
//   node scripts/vite-plus-proof.mjs --toolchain-id  print the toolchain id
//   node scripts/vite-plus-proof.mjs --cache-path    print the absolute VITE_CACHE_PATH, or nothing
//
// Always go through this wrapper. Vite Task does not hash the node or bun
// binary that runs a task, so every task fingerprints ADEA_VP_TOOLCHAIN, and
// the wrapper computes it from the node and bun that `vp` will really run.
// A hand-set value (ADEA_VP_TOOLCHAIN=local) bypasses that identity; the
// wrapper always overrides one inherited from the environment.
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const callerRoot = resolve(fileURLToPath(import.meta.url), '../..')
// Keep in sync with the packages in vite.config.ts.
const packages = ['types', 'state', 'api-client', 'app-core', 'auth', 'spatial']
const bunOnlyFile = 'packages/types/tests/management.test.ts'
// The proof graph: one build and one test task per package.
const expectedTasks = packages.length * 2
// What the Bun-only edit above must invalidate, and nothing else.
const bunOnlyMiss = 'types:test'

// Vite+ reads these to configure remote cache access. The isolated self-check
// must never inherit credentials or endpoints from its caller.
export function withoutVpRemoteCache(env) {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !name.startsWith('VP_REMOTE_CACHE'))
  )
}

// Ask Vite+ which node and bun a task will actually execute: it resolves them
// from the `packageManager` pin and its own toolchain, which can differ from
// the `bun` first on PATH.
function executing(root, tool, env = process.env) {
  const result = spawnSync(join(root, 'node_modules/.bin/vp'), ['exec', tool, '--version'], {
    cwd: root,
    encoding: 'utf8',
    env,
  })
  if (result.status !== 0) throw new Error(`vp exec ${tool} --version failed: ${result.stderr}`)
  return result.stdout.trim().split('\n').at(-1).replace(/^v/, '')
}

/** The relocated task cache directory (VITE_CACHE_PATH) from any environment source. */
function cachePath(env = process.env) {
  return env.VITE_CACHE_PATH ? resolve(env.VITE_CACHE_PATH) : ''
}

function toolchainId(root, env = process.env) {
  const vitePlus = JSON.parse(
    readFileSync(join(root, 'node_modules/vite-plus/package.json'), 'utf8')
  ).version
  return [
    `node${executing(root, 'node', env)}`,
    `bun${executing(root, 'bun', env)}`,
    `vp${vitePlus}`,
    process.platform,
    process.arch,
  ].join('-')
}

/** Run a Vite+ task in `root` and return the cache summary parsed from its output. */
function run(root, task, env = {}, toolchain, baseEnv = process.env) {
  const childEnv = { ...baseEnv, NO_COLOR: '1', ...env }
  const identity = toolchain ?? toolchainId(root, childEnv)
  const result = spawnSync(join(root, 'node_modules/.bin/vp'), ['run', '--cache', task], {
    cwd: root,
    encoding: 'utf8',
    env: { ...childEnv, ADEA_VP_TOOLCHAIN: identity },
    maxBuffer: 64 * 1024 * 1024,
  })
  const output = `${result.stdout}${result.stderr}`
  try {
    if (result.status !== 0) throw new Error(`vp run ${task} failed (exit ${result.status})`)
    return parseVpOutput(output, task)
  } catch (error) {
    process.stderr.write(output)
    throw error
  }
}

/** Parse `vp run` output into the cache summary and the missed tasks, by task name. */
export function parseVpOutput(output, task) {
  const summary = /vp run: (\d+)\/(\d+) cache hit/.exec(output)
  if (!summary) throw new Error(`vp run ${task} printed no cache summary`)
  // `vp` prints each miss as "<cwd>$ <command> ○ cache miss: <reason>"; map the
  // working directory and command back to the task names in vite.config.ts.
  const missed = [...output.matchAll(/^~?\/?(\S*)\$ (.+?) ○ cache miss: (.+?), executing$/gm)].map(
    (m) => ({ task: taskName(m[1], m[2]), reason: m[3] })
  )
  const total = Number(summary[2])
  if (task === 'proof' && total !== expectedTasks)
    throw new Error(`expected a ${expectedTasks}-task graph, vp ran ${total}`)
  return { hits: Number(summary[1]), total, missed }
}

/** True when exactly one task missed and it is `task` (a name such as types:test). */
export const loneMiss = (result, task) =>
  result.missed.length === 1 && result.missed[0].task === task

function taskName(cwd, command) {
  const pkg = packages.find((name) => cwd.replace(/\/$/, '') === `packages/${name}`)
  if (!pkg) return `${cwd || '.'}: ${command}`
  return command.startsWith('tsc ') ? `${pkg}:build` : `${pkg}:test`
}

const missedNames = (result) => result.missed.map((miss) => miss.task)

function distFiles(root, pkg) {
  const dist = join(root, 'packages', pkg, 'dist')
  if (!existsSync(dist)) return []
  return readdirSync(dist, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
}

/** sha256 over the relative path and content of every dist output, plus the file count. */
function distManifest(root) {
  const hash = createHash('sha256')
  let count = 0
  for (const pkg of packages)
    for (const file of distFiles(root, pkg).toSorted()) {
      hash.update(`${relative(root, file)}\0`)
      hash.update(readFileSync(file))
      hash.update('\0')
      count += 1
    }
  return { sha: hash.digest('hex'), count }
}

const missingDist = (root) => packages.filter((pkg) => distFiles(root, pkg).length === 0)

function removeDist(root) {
  for (const pkg of packages)
    rmSync(join(root, 'packages', pkg, 'dist'), { recursive: true, force: true })
}

function check(label, condition, detail) {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) process.exitCode = 1
}

/**
 * A disposable checkout of HEAD with its own install. Every mutation happens
 * there, so success, failure or a killed process cannot change the caller's
 * checkout (the worst case is a stray temp directory).
 */
function withWorktree(fn, env = process.env) {
  const dir = mkdtempSync(join(tmpdir(), 'adea-vp-selfcheck-'))
  try {
    execFileSync('git', ['-C', callerRoot, 'worktree', 'add', '--detach', dir, 'HEAD'], {
      stdio: 'ignore',
      env,
    })
    execFileSync('bun', ['install', '--frozen-lockfile'], { cwd: dir, stdio: 'ignore', env })
    return fn(dir)
  } finally {
    spawnSync('git', ['-C', callerRoot, 'worktree', 'remove', '--force', dir], {
      stdio: 'ignore',
      env,
    })
    rmSync(dir, { recursive: true, force: true })
  }
}

function selfCheck() {
  const childEnv = withoutVpRemoteCache(process.env)
  withWorktree((root) => {
    // A cache directory of our own: a VITE_CACHE_PATH set by the caller is
    // neither read nor modified.
    const env = { VITE_CACHE_PATH: join(root, '.selfcheck-cache') }
    const cold = run(root, 'proof', env, undefined, childEnv)
    const built = distManifest(root)
    check(
      'the task cache is written to VITE_CACHE_PATH',
      existsSync(env.VITE_CACHE_PATH) && readdirSync(env.VITE_CACHE_PATH).length > 0
    )
    check(
      `cold run executes all ${expectedTasks} tasks`,
      cold.hits === 0 && cold.total === expectedTasks,
      `${cold.hits}/${cold.total}`
    )
    check(
      'cold run emits dist for every package',
      missingDist(root).length === 0,
      `${built.count} files`
    )

    // Hit counts alone do not show artifact replay: delete every generated
    // output and require the cache to bring back identical bytes.
    removeDist(root)
    check('dist is gone before the replay run', missingDist(root).length === packages.length)
    const replay = run(root, 'proof', env, undefined, childEnv)
    const replayed = distManifest(root)
    check(
      'replay run hits every task',
      replay.hits === replay.total,
      `${replay.hits}/${replay.total}`
    )
    check(
      'cache replay restores identical dist outputs',
      replayed.sha === built.sha && replayed.count === built.count,
      `${replayed.count} files, sha256 ${replayed.sha.slice(0, 12)}`
    )

    // The edited file is read only by `bun test`, never by tsc.
    const edit = () =>
      appendFileSync(join(root, bunOnlyFile), '\n// vite-plus-proof: bun-only edit\n')
    edit()
    const edited = run(root, 'proof', env, undefined, childEnv)
    check(
      `a Bun-only file edit misses exactly ${bunOnlyMiss}`,
      edited.hits === expectedTasks - 1 && missedNames(edited).join() === bunOnlyMiss,
      missedNames(edited).join(', ')
    )
    execFileSync('git', ['checkout', '--', bunOnlyFile], { cwd: root, env: childEnv })

    const other = run(root, 'proof', env, `${toolchainId(root, childEnv)}-other`, childEnv)
    check(
      'a different toolchain id misses every task',
      other.hits === 0,
      `${other.hits}/${other.total}`
    )

    // Control: the same test with automatic tracking only. Vite Task cannot
    // see files Bun loads, so a stale hit here is the documented limitation
    // the explicit globs above guard against; it is reported, not asserted.
    run(root, 'control:types-test-auto-only', env, undefined, childEnv)
    edit()
    const control = run(root, 'control:types-test-auto-only', env, undefined, childEnv)
    const stale = control.missed.length === 0
    console.log(
      `INFO auto-only control after a Bun-only edit: ${stale ? 'stale cache hit (auto tracking misses Bun reads)' : 'cache miss (auto tracking now sees Bun reads)'}`
    )
  }, childEnv)
}

function value(args, flag) {
  const index = args.indexOf(flag)
  return index === -1 ? null : args[index + 1]
}

function once(args) {
  const wanted = value(args, '--expect')
  const miss = value(args, '--miss') // a task name, e.g. types:test
  const manifest = value(args, '--expect-manifest')
  if (args.includes('--fresh'))
    check('every dist is absent before the run', missingDist(callerRoot).length === packages.length)
  const result = run(callerRoot, 'proof')
  const dist = distManifest(callerRoot)
  console.log(`vite-plus proof: ${result.hits}/${result.total} cache hit`)
  console.log(`dist outputs: ${dist.count} files, sha256 ${dist.sha}`)
  const missed = result.missed.map((m) => `${m.task} (${m.reason})`)
  if (missed.length) console.log(`misses:\n  ${missed.join('\n  ')}`)
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Vite+ proof (${wanted ?? 'observed'})\n\n- toolchain: \`${toolchainId(callerRoot)}\`\n- cache: ${result.hits}/${result.total} hit\n- dist: ${dist.count} files, sha256 \`${dist.sha}\`\n${missed.map((m) => `- miss: ${m}`).join('\n')}\n`
    )
  const met = {
    cold: result.hits === 0,
    warm: result.hits === result.total,
    'one-miss': result.hits === expectedTasks - 1,
  }
  if (wanted) check(`expected ${wanted}`, met[wanted], `${result.hits}/${result.total}`)
  if (miss) check(`the lone miss is ${miss}`, loneMiss(result, miss), missed.join('; '))
  if (manifest) check('dist manifest matches', dist.sha === manifest, dist.sha)
  check('every package emitted dist', missingDist(callerRoot).length === 0)
}

// Importable for tests; only a direct run does anything.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.includes('--toolchain-id')) console.log(toolchainId(callerRoot))
  else if (args.includes('--cache-path')) console.log(cachePath())
  else if (args.includes('--self-check')) selfCheck()
  else once(args)
}
