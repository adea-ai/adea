#!/usr/bin/env node
// Opt-in Vite+ cache proof for the real `orch:build` graph (vite.config.ts, scripts/orch-graph.mjs). Turbo stays the
// required runner; this only runs the build graph once and reports what the task cache did.
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
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { discoverWorkspaces } from './orch-graph.mjs'

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

/** Whether a run matches the expected cache pattern. `cold` allows no hit; `warm` needs every cacheable task to hit. */
export function matchesPattern(result, pattern) {
  if (pattern === 'cold') return result.hits === 0 && result.total > 0
  if (pattern === 'warm') return result.hits === result.total && result.total > 0
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

function check(label, condition, detail) {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) process.exitCode = 1
}

function value(args, flag) {
  const index = args.indexOf(flag)
  return index === -1 ? null : args[index + 1]
}

function once(args) {
  const wanted = value(args, '--expect')
  const manifest = value(args, '--expect-manifest')
  if (args.includes('--fresh')) {
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
  if (run.status !== 0) {
    process.stderr.write(output)
    throw new Error(`vp run ${TASK} failed (exit ${run.status})`)
  }
  const result = parseVpOutput(output)
  const dist = distManifest(callerRoot)
  console.log(`vite-plus proof (${TASK}): ${result.hits}/${result.total} cache hit`)
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
    check(`expected ${wanted}`, matchesPattern(result, wanted), `${result.hits}/${result.total}`)
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
