#!/usr/bin/env node
// Opt-in Vite+ cache proof for the real `orch:build` graph (vite.config.ts, scripts/orch-graph.mjs). It runs the build
// graph once and reports what the task cache did; it changes nothing the required lanes run.
//
//   node scripts/vite-plus-proof.mjs [options]
//     --expect cold|warm        assert the cache hit pattern: cold = no hit, warm = every cacheable task hit
//     --fresh                   assert no workspace has a `dist` before the run
//     --expect-manifest <sha>   assert the sha256 over every workspace's `dist` afterwards
//
// The toolchain identity is the graph's own: every task fingerprints `ORCH_TOOLCHAIN` (scripts/orch-toolchain.mjs),
// computed from the node and bun that `vp` runs, so this script adds none.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildTasks, discoverWorkspaces } from './orch-graph.mjs'
import { expectedId } from './orch-toolchain.mjs'

const callerRoot = resolve(fileURLToPath(import.meta.url), '../..')
export const TASK = 'orch:build'

/** Parse `vp run` output into the cache summary, the missed tasks, and the toolchain id the tasks fingerprinted. */
export function parseVpOutput(output) {
  const summary = /vp run: (\d+)\/(\d+) cache hit/.exec(output)
  if (!summary) throw new Error(`vp run ${TASK} printed no cache summary`)
  const missed = [...output.matchAll(/^(.+?) ○ cache miss: (.+?)(?:, executing)?$/gm)].map((m) => ({
    command: m[1].replace(/^.*\bORCH_TOOLCHAIN=\S+ env -u FORCE_COLOR /, ''),
    reason: m[2],
  }))
  const toolchain = /ORCH_TOOLCHAIN=(\S+)/.exec(output)?.[1] ?? null
  return { hits: Number(summary[1]), total: Number(summary[2]), missed, toolchain }
}

/**
 * The cacheable tasks of the build graph, derived from the graph itself.
 *
 * The count is a property of the workspaces and their scripts, not a constant: a
 * workspace that gains or loses a build script changes it, and so does a rule
 * that stops caching a build. Deriving the expectation keeps the qualification
 * honest — a literal would keep asserting a number the graph no longer has.
 */
export function graphExpectation(root, toolchainId, env = process.env) {
  const tasks = buildTasks(root, toolchainId, env)
  const group = tasks[TASK]
  if (!group) throw new Error(`the build graph has no ${TASK} task`)
  const names = (group.dependsOn ?? []).filter((name) => tasks[name]?.cache !== false)
  return {
    cacheableTasks: names.length,
    totalTasks: (group.dependsOn ?? []).length,
    taskNames: names,
  }
}

/** The cache summary a fully restored run prints, derived from the graph. */
export function expectedSummary(expectation) {
  return `${expectation.cacheableTasks}/${expectation.cacheableTasks} cache hit`
}

/**
 * Whether a run matches the expected cache pattern.
 *
 * `cold` allows no hit, `warm` needs every cacheable task to hit, and
 * `partial` is a restore that covered only some of them. When an expectation is
 * given, the run's own total must also be the graph's count: a run that reports
 * a different graph is not the graph under qualification.
 */
export function matchesPattern(result, pattern, expectation) {
  const total = expectation?.cacheableTasks ?? result.total
  if (pattern === 'cold') return result.hits === 0 && result.total === total && result.total > 0
  if (pattern === 'warm') return result.hits === total && result.total === total && result.total > 0
  if (pattern === 'partial')
    return result.hits > 0 && result.hits < result.total && result.total === total
  throw new Error(`unknown pattern ${pattern}`)
}

function distFiles(root, dir) {
  const dist = join(root, dir, 'dist')
  if (!existsSync(dist)) return []
  return readdirSync(dist, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .toSorted()
}

/** sha256 over the relative path and content of every workspace's `dist` output, plus the file count. */
export function distManifest(root) {
  const hash = createHash('sha256')
  let count = 0
  for (const { dir } of discoverWorkspaces(root))
    for (const file of distFiles(root, dir)) {
      hash.update(`${relative(root, file)}\0`)
      hash.update(readFileSync(file))
      hash.update('\0')
      count += 1
    }
  return { sha: hash.digest('hex'), count }
}

const withDist = (root) =>
  discoverWorkspaces(root).filter(({ dir }) => distFiles(root, dir).length > 0)

/**
 * The output directories the build graph declares for its cacheable build tasks.
 *
 * These are the outputs the qualification owns. Nothing else is read, compared or
 * removed: a file outside them belongs to the workspace, not to the cache.
 */
export function ownedOutputs(root, toolchainId, env = process.env) {
  const tasks = buildTasks(root, toolchainId, env)
  const group = tasks[TASK]
  const names = (group?.dependsOn ?? []).filter((name) => tasks[name]?.cache !== false)
  const directories = new Set()
  for (const name of names)
    for (const glob of tasks[name]?.cache?.output ?? []) {
      const [prefix] = glob.split('*')
      const directory = prefix.replace(/\/$/, '')
      if (directory) directories.add(directory)
    }
  return [...directories].toSorted()
}

/** Every file under one owned output directory, relative to the root. */
function ownedFiles(root, directory) {
  const base = join(root, directory)
  if (!existsSync(base)) return []
  return readdirSync(base, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .toSorted()
}

/** The manifest of exactly the declared owned outputs. */
export function ownedOutputManifest(root, toolchainId, env = process.env) {
  const hash = createHash('sha256')
  const files = []
  for (const directory of ownedOutputs(root, toolchainId, env))
    for (const file of ownedFiles(root, directory)) {
      const bytes = readFileSync(join(root, file))
      hash.update(`${file}\0`)
      hash.update(bytes)
      hash.update('\0')
      files.push({ path: file, sha: createHash('sha256').update(bytes).digest('hex') })
    }
  return {
    sha: hash.digest('hex'),
    count: files.length,
    outputs: ownedOutputs(root, toolchainId, env),
    files,
  }
}

/**
 * Removes the declared owned outputs, and nothing else.
 *
 * Only the directories the graph declares as its build outputs are removed, so
 * the workspace's own files are never touched. The count of the removed files is
 * returned, so a caller can tell a cleared tree from one that had no outputs.
 */
export function clearOwnedOutputs(root, toolchainId, env = process.env) {
  let removed = 0
  for (const directory of ownedOutputs(root, toolchainId, env)) {
    for (const file of ownedFiles(root, directory)) {
      rmSync(join(root, file), { force: true })
      removed += 1
    }
  }
  return removed
}

/**
 * Whether two recorded manifests describe the same bytes.
 *
 * Two empty manifests are not the same build: a manifest without outputs proves
 * nothing, so an empty one never matches.
 */
export function compareManifests(expected, actual) {
  const same = { identical: true, reason: '', missing: [], extra: [], differing: [] }
  if (!expected?.count || !actual?.count) {
    return { ...same, identical: false, reason: 'an empty manifest proves nothing' }
  }
  if (expected.sha === actual.sha) return same
  const expectedFiles = new Map((expected.files ?? []).map((file) => [file.path, file.sha]))
  const actualFiles = new Map((actual.files ?? []).map((file) => [file.path, file.sha]))
  return {
    identical: false,
    reason: `the outputs differ (${expected.sha} against ${actual.sha})`,
    missing: [...expectedFiles.keys()].filter((path) => !actualFiles.has(path)).toSorted(),
    extra: [...actualFiles.keys()].filter((path) => !expectedFiles.has(path)).toSorted(),
    differing: [...expectedFiles.keys()]
      .filter((path) => actualFiles.has(path) && actualFiles.get(path) !== expectedFiles.get(path))
      .toSorted(),
  }
}

/** Reads a recorded manifest file: the sha and the file count it holds. */
function readManifestFile(path) {
  const lines = readFileSync(path, 'utf8').trim().split('\n')
  const [sha, count] = (lines[0] ?? '').split(/\s+/)
  if (!sha || count === undefined) throw new Error(`${path} holds no manifest`)
  const files = lines.slice(1).flatMap((line) => {
    const [fileSha, ...rest] = line.split(/\s+/)
    return fileSha && rest.length ? [{ path: rest.join(' '), sha: fileSha }] : []
  })
  return { sha, count: Number(count), files }
}

/** The named differences, in a form a failing lane can report. */
function describeDifferences(result) {
  const parts = []
  if (result.missing.length) parts.push(`missing: ${result.missing.join(', ')}`)
  if (result.extra.length) parts.push(`extra: ${result.extra.join(', ')}`)
  if (result.differing.length) parts.push(`different bytes: ${result.differing.join(', ')}`)
  return parts.join('; ')
}

function check(label, condition, detail) {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) process.exitCode = 1
}

const SHA256 = /^[0-9a-f]{64}$/
const FLAGS = new Set([
  '--expect',
  '--expect-manifest',
  '--fresh',
  '--print-expectation',
  '--print-manifest',
  '--check-pass',
  '--log',
  '--clear-outputs',
  '--compare-manifest',
])
const PASS_PATTERNS = new Set(['cold', 'warm', 'partial', 'observed'])

function value(args, flag) {
  const index = args.indexOf(flag)
  if (index === -1) return null
  const found = args[index + 1]
  if (found === undefined || found.startsWith('--')) throw new Error(`${flag} needs a value`)
  return found
}

/**
 * Validate the command line before anything runs. A warm run must name the cold run's dist manifest: without it the
 * restored outputs would never be compared with what the cold run built, and a warm "proof" would only count hits.
 * A cold run needs no earlier manifest.
 */
export function parseArgs(args) {
  const unknown = args.filter((arg) => arg.startsWith('--') && !FLAGS.has(arg))
  if (unknown.length) throw new Error(`unknown option ${unknown.join(', ')}`)
  const wanted = value(args, '--expect')
  const manifest = value(args, '--expect-manifest')
  const pass = value(args, '--check-pass')
  const log = value(args, '--log')
  if (wanted !== null && wanted !== 'cold' && wanted !== 'warm')
    throw new Error(`--expect must be cold or warm, not ${wanted}`)
  if (manifest !== null && !SHA256.test(manifest))
    throw new Error('--expect-manifest must be a lowercase 64-character sha256')
  if (wanted === 'warm' && manifest === null)
    throw new Error('--expect warm requires --expect-manifest <the cold run sha256>')
  if (pass !== null && !PASS_PATTERNS.has(pass))
    throw new Error(`--check-pass must be one of ${[...PASS_PATTERNS].join(', ')}, not ${pass}`)
  if (pass !== null && log === null) throw new Error('--check-pass requires --log <the build log>')
  if (log !== null && pass === null) throw new Error('--log requires --check-pass')
  const printExpectation = args.includes('--print-expectation')
  const printManifest = args.includes('--print-manifest')
  const clearOutputs = args.includes('--clear-outputs')
  const compare = value(args, '--compare-manifest')
  const exclusive = [
    wanted !== null,
    pass !== null,
    printExpectation,
    printManifest,
    clearOutputs,
    compare !== null,
  ].filter(Boolean).length
  if (exclusive > 1) throw new Error('only one expectation may be asked for at a time')
  if (compare !== null && compare.split(',').length !== 2)
    throw new Error('--compare-manifest needs two manifest files, separated by a comma')
  return {
    wanted,
    manifest,
    fresh: args.includes('--fresh'),
    pass,
    log,
    printExpectation,
    printManifest,
    clearOutputs,
    compare,
  }
}

/** The manifest of the declared owned outputs, as it is recorded. */
function ownedManifest(root) {
  return ownedOutputManifest(root, expectedId(root))
}

/**
 * The manifest of the declared owned outputs, as it is recorded.
 *
 * A manifest without outputs proves nothing, so it is refused: two empty
 * manifests must never pass a comparison.
 */
export function recordedManifest(owned) {
  if (!owned || owned.count === 0) return null
  return { sha: owned.sha, count: owned.count }
}

function once(args) {
  const {
    wanted,
    manifest,
    fresh,
    pass,
    log,
    printExpectation,
    printManifest,
    clearOutputs,
    compare,
  } = parseArgs(args)
  if (clearOutputs) {
    // Only the outputs the graph declares are removed, so the workspace's own
    // files are never touched.
    const removed = clearOwnedOutputs(callerRoot, expectedId(callerRoot))
    console.log(`cleared ${removed} owned output files`)
    return
  }
  if (compare !== null) {
    const [left, right] = compare.split(',')
    const result = compareManifests(readManifestFile(left), readManifestFile(right))
    check(
      'the restored outputs are the same bytes',
      result.identical,
      [result.reason, describeDifferences(result)].filter(Boolean).join(' — ')
    )
    return
  }
  if (printExpectation) {
    // The expectation a fully restored run must reach, derived from the graph.
    const expectation = graphExpectation(callerRoot, expectedId(callerRoot))
    console.log(expectedSummary(expectation))
    return
  }
  if (printManifest) {
    // The manifest of the declared owned outputs, so two passes can be compared.
    // An empty manifest proves nothing, so it is refused: two empty manifests
    // must never pass a comparison.
    const owned = ownedManifest(callerRoot)
    const recorded = recordedManifest(owned)
    if (!recorded) {
      process.stderr.write('the declared owned outputs are empty; there is nothing to compare\n')
      process.exitCode = 1
      return
    }
    console.log(`${recorded.sha} ${recorded.count}`)
    for (const file of owned.files) console.log(`${file.sha}  ${file.path}`)
    return
  }
  if (pass) {
    // A recorded build log is checked against the graph, so a pass is judged by
    // the graph it ran and not by a number written down earlier.
    const output = readFileSync(log, 'utf8')
    const result = parseVpOutput(output)
    const expectation = graphExpectation(callerRoot, result.toolchain ?? expectedId(callerRoot))
    const detail = `${result.hits}/${result.total} of ${expectation.cacheableTasks} graph tasks`
    if (pass === 'observed') {
      console.log(`observed: ${detail}`)
      const missed = result.missed.map((m) => `${m.command} (${m.reason})`)
      if (missed.length) console.log(`misses:\n  ${missed.join('\n  ')}`)
      return
    }
    check(`expected ${pass}`, matchesPattern(result, pass, expectation), detail)
    return
  }
  if (fresh) {
    const built = withDist(callerRoot).map(({ dir }) => dir)
    check('no workspace has a dist before the run', built.length === 0, built.join(', '))
  }
  const run = spawnSync(join(callerRoot, 'node_modules/.bin/vp'), ['run', '--cache', TASK], {
    cwd: callerRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    maxBuffer: 64 * 1024 * 1024,
  })
  const output = `${run.stdout}${run.stderr}`
  // The raw `vp run` output stays in the job log, so a miss can be read without trusting the wrapper's summary.
  if (process.env.GITHUB_ACTIONS)
    console.log(`::group::raw vp run ${TASK} output\n${output}\n::endgroup::`)
  if (run.status !== 0) {
    process.stderr.write(output)
    throw new Error(`vp run ${TASK} failed (exit ${run.status})`)
  }
  const result = parseVpOutput(output)
  const dist = distManifest(callerRoot)
  const expectation = graphExpectation(callerRoot, result.toolchain ?? expectedId(callerRoot))
  console.log(`vite-plus proof (${TASK}): ${result.hits}/${result.total} cache hit`)
  console.log(`expected cache: ${expectedSummary(expectation)}`)
  console.log(`toolchain: ${result.toolchain}`)
  console.log(`dist outputs: ${dist.count} files, sha256 ${dist.sha}`)
  const missed = result.missed.map((m) => `${m.command} (${m.reason})`)
  if (missed.length) console.log(`misses:\n  ${missed.join('\n  ')}`)
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Vite+ proof, \`${TASK}\` (${wanted ?? 'observed'})\n\n- toolchain: \`${result.toolchain}\`\n- cache: ${result.hits}/${result.total} hit\n- dist: ${dist.count} files, sha256 \`${dist.sha}\`\n${missed.map((m) => `- miss: ${m}`).join('\n')}\n`
    )
  if (wanted)
    check(
      `expected ${wanted}`,
      matchesPattern(result, wanted, expectation),
      `${result.hits}/${result.total} of ${expectation.cacheableTasks} graph tasks`
    )
  if (manifest) check('dist manifest matches', dist.sha === manifest, dist.sha)
  check(
    'dist was emitted',
    dist.count > 0,
    `${dist.count} files in ${withDist(callerRoot).length} workspaces`
  )
}

// Importable for tests; only a direct run does anything.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  once(process.argv.slice(2))
