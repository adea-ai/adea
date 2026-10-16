#!/usr/bin/env node
// Opt-in Vite+ cache proof lane (vite.config.ts). Turbo stays the required
// runner; this only exercises the `proof` task graph.
//
//   node scripts/vite-plus-proof.mjs [--expect cold|warm|one-miss]   run the graph once
//   node scripts/vite-plus-proof.mjs --self-check           isolated cold/warm/invalidation checks
//
// Vite Task does not hash the node or bun binary that runs a task, so every
// task fingerprints ADEA_VP_TOOLCHAIN, computed here from the real toolchain.
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(import.meta.url), '../..')
const vp = join(root, 'node_modules/.bin/vp')
const bunOnlyFile = join(root, 'packages/types/tests/management.test.ts')

// Ask Vite+ which node and bun a task will actually execute: it resolves them
// from the `packageManager` pin and its own toolchain, which can differ from
// the `bun` first on PATH.
const executing = (tool) => {
  const result = spawnSync(vp, ['exec', tool, '--version'], { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`vp exec ${tool} --version failed: ${result.stderr}`)
  return result.stdout.trim().split('\n').at(-1).replace(/^v/, '')
}

function toolchainId() {
  const vitePlus = JSON.parse(
    readFileSync(join(root, 'node_modules/vite-plus/package.json'), 'utf8')
  ).version
  return [
    `node${executing('node')}`,
    `bun${executing('bun')}`,
    `vp${vitePlus}`,
    process.platform,
    process.arch,
  ].join('-')
}

/** Run a Vite+ task and return the cache summary parsed from its output. */
function run(task, env = {}) {
  const result = spawnSync(vp, ['run', '--cache', task], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ADEA_VP_TOOLCHAIN: toolchainId(), NO_COLOR: '1', ...env },
    maxBuffer: 64 * 1024 * 1024,
  })
  const output = `${result.stdout}${result.stderr}`
  const summary = /vp run: (\d+)\/(\d+) cache hit/.exec(output)
  if (result.status !== 0 || !summary) {
    process.stderr.write(output)
    throw new Error(`vp run ${task} failed (exit ${result.status})`)
  }
  const missed = [...output.matchAll(/^~?\/?(\S*)\$ (.+?) ○ cache miss: (.+?), executing$/gm)].map(
    (m) => `${m[1]}: ${m[2]} (${m[3]})`
  )
  return { hits: Number(summary[1]), total: Number(summary[2]), missed, output }
}

function expect(label, condition, detail) {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) process.exitCode = 1
}

function selfCheck() {
  const cache = mkdtempSync(join(tmpdir(), 'adea-vp-selfcheck-'))
  const original = readFileSync(bunOnlyFile, 'utf8')
  const env = { VITE_CACHE_PATH: cache }
  try {
    const cold = run('proof', env)
    expect('cold run executes every task', cold.hits === 0, `${cold.hits}/${cold.total}`)
    const warm = run('proof', env)
    expect('warm run replays every task', warm.hits === warm.total, `${warm.hits}/${warm.total}`)

    // The edited file is read only by `bun test`, never by tsc.
    appendFileSync(bunOnlyFile, '\n// vite-plus-proof: bun-only edit\n')
    const edited = run('proof', env)
    writeFileSync(bunOnlyFile, original)
    expect(
      'a Bun-only file edit misses exactly that test task',
      edited.hits === edited.total - 1 && edited.missed.length === 1,
      edited.missed.join('; ')
    )

    const other = run('proof', { ...env, ADEA_VP_TOOLCHAIN: `${toolchainId()}-other` })
    expect(
      'a different toolchain id misses every task',
      other.hits === 0,
      `${other.hits}/${other.total}`
    )

    // Control: the same test with automatic tracking only. Vite Task cannot
    // see files Bun loads, so a stale hit here is the documented limitation
    // the explicit globs above guard against; it is reported, not asserted.
    run('control:types-test-auto-only', env)
    appendFileSync(bunOnlyFile, '\n// vite-plus-proof: bun-only edit\n')
    const control = run('control:types-test-auto-only', env)
    writeFileSync(bunOnlyFile, original)
    const staleHit = control.missed.every((miss) => !miss.includes('bun test'))
    console.log(
      `INFO auto-only control after a Bun-only edit: ${staleHit ? 'stale cache hit (auto tracking misses Bun reads)' : 'cache miss (auto tracking now sees Bun reads)'}`
    )
  } finally {
    writeFileSync(bunOnlyFile, original)
    rmSync(cache, { recursive: true, force: true })
  }
}

const args = process.argv.slice(2)
if (args.includes('--self-check')) {
  selfCheck()
} else {
  const index = args.indexOf('--expect')
  const wanted = index === -1 ? null : args[index + 1]
  const result = run('proof')
  console.log(`vite-plus proof: ${result.hits}/${result.total} cache hit`)
  if (result.missed.length) console.log(`misses:\n  ${result.missed.join('\n  ')}`)
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Vite+ proof (${wanted ?? 'observed'})\n\n- toolchain: \`${toolchainId()}\`\n- cache: ${result.hits}/${result.total} hit\n${result.missed.map((m) => `- miss: ${m}`).join('\n')}\n`
    )
  const met = {
    cold: result.hits === 0,
    warm: result.hits === result.total,
    'one-miss': result.hits === result.total - 1,
  }
  if (wanted && !met[wanted]) {
    console.log(`FAIL expected ${wanted}, observed ${result.hits}/${result.total}`)
    process.exitCode = 1
  }
}
