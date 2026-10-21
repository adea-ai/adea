import { describe, expect, spyOn, test } from 'bun:test'

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as childProcess from 'node:child_process'

import {
  distManifest,
  expectedSummary,
  graphExpectation,
  matchesPattern,
  parseArgs,
  parseVpOutput,
} from './vite-plus-proof.mjs'
import { expectedId } from './orch-toolchain.mjs'

const repoRoot = resolve(import.meta.dir, '..')
const coldManifest = 'a'.repeat(64)

const miss =
  "$ ORCH_TOOLCHAIN=linux-x64.node22.bun1.4.0-abc env -u FORCE_COLOR bun run --cwd packages/types build ○ cache miss: env 'ORCH_TOOLCHAIN' changed, executing"

// Every fixture is built from the graph, so a graph that gains or loses a task
// moves the fixtures with it and no expectation is ever a number written down.
const expectation = graphExpectation(repoRoot, expectedId(repoRoot))
const tasks = expectation.cacheableTasks

describe('parseVpOutput', () => {
  test('reads the summary, the misses and the toolchain id', () => {
    const result = parseVpOutput(`${miss}\n\n---\nvp run: 14/15 cache hit (93%), 17/17 successful`)
    expect(result.hits).toBe(14)
    expect(result.total).toBe(15)
    expect(result.toolchain).toBe('linux-x64.node22.bun1.4.0-abc')
    expect(result.missed).toEqual([
      { command: 'bun run --cwd packages/types build', reason: "env 'ORCH_TOOLCHAIN' changed" },
    ])
  })

  test('refuses output with no cache summary', () => {
    expect(() => parseVpOutput('nothing here')).toThrow('printed no cache summary')
  })
})

describe('graphExpectation', () => {
  test("the cacheable count is the graph's own, never a constant", () => {
    expect(expectation.cacheableTasks).toBe(expectation.taskNames.length)
    expect(expectation.cacheableTasks).toBeGreaterThan(0)
    expect(expectation.totalTasks).toBeGreaterThanOrEqual(expectation.cacheableTasks)
    // Every named task is a build task of the graph.
    expect(expectation.taskNames.every((name) => name.startsWith('orch:'))).toBe(true)
  })

  test("the expected summary names the graph's count", () => {
    expect(expectedSummary(expectation)).toBe(`${tasks}/${tasks} cache hit`)
  })

  test('a workspace that gains a build script changes the expectation', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'adea-proof-graph-'))
    try {
      for (const [name, scripts] of [
        ['alpha', { build: 'tsc' }],
        ['beta', {}],
      ]) {
        mkdirSync(join(fixture, 'packages', name), { recursive: true })
        writeFileSync(
          join(fixture, 'packages', name, 'package.json'),
          JSON.stringify({ name: `@fixture/${name}`, scripts })
        )
      }
      const withoutBuild = graphExpectation(fixture, 'fixture-toolchain')
      expect(withoutBuild.cacheableTasks).toBe(1)
      expect(withoutBuild.taskNames).toEqual(['orch:alpha:build'])
      // The same graph with one more build script has one more cacheable task.
      writeFileSync(
        join(fixture, 'packages', 'beta', 'package.json'),
        JSON.stringify({ name: '@fixture/beta', scripts: { build: 'tsc' } })
      )
      expect(graphExpectation(fixture, 'fixture-toolchain').cacheableTasks).toBe(2)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})

describe('matchesPattern', () => {
  test('cold allows no hit and warm needs every task to hit', () => {
    expect(matchesPattern({ hits: 0, total: 15, missed: [], toolchain: null }, 'cold')).toBe(true)
    expect(matchesPattern({ hits: 1, total: 15, missed: [], toolchain: null }, 'cold')).toBe(false)
    expect(matchesPattern({ hits: 15, total: 15, missed: [], toolchain: null }, 'warm')).toBe(true)
    expect(matchesPattern({ hits: 14, total: 15, missed: [], toolchain: null }, 'warm')).toBe(false)
  })

  test('an empty graph is neither cold nor warm', () => {
    expect(matchesPattern({ hits: 0, total: 0, missed: [], toolchain: null }, 'cold')).toBe(false)
    expect(matchesPattern({ hits: 0, total: 0, missed: [], toolchain: null }, 'warm')).toBe(false)
  })

  test('an expectation makes the run report the graph it ran', () => {
    const graph = { cacheableTasks: 15, totalTasks: 15, taskNames: [] }
    // A run that reports fewer tasks than the graph is not the graph under qualification.
    expect(
      matchesPattern({ hits: 15, total: 15, missed: [], toolchain: null }, 'warm', graph)
    ).toBe(true)
    expect(
      matchesPattern({ hits: 14, total: 14, missed: [], toolchain: null }, 'warm', graph)
    ).toBe(false)
    expect(matchesPattern({ hits: 0, total: 14, missed: [], toolchain: null }, 'cold', graph)).toBe(
      false
    )
  })

  test('a partial restore is told apart from a complete one', () => {
    const graph = { cacheableTasks: 15, totalTasks: 15, taskNames: [] }
    expect(
      matchesPattern({ hits: 9, total: 15, missed: [], toolchain: null }, 'partial', graph)
    ).toBe(true)
    expect(
      matchesPattern({ hits: 0, total: 15, missed: [], toolchain: null }, 'partial', graph)
    ).toBe(false)
    expect(
      matchesPattern({ hits: 15, total: 15, missed: [], toolchain: null }, 'partial', graph)
    ).toBe(false)
  })
})

describe('parseArgs', () => {
  test('a cold run needs no earlier manifest', () => {
    expect(parseArgs(['--fresh', '--expect', 'cold'])).toEqual({
      wanted: 'cold',
      manifest: null,
      fresh: true,
      pass: null,
      log: null,
      printExpectation: false,
      printManifest: false,
    })
    expect(parseArgs([])).toEqual({
      wanted: null,
      manifest: null,
      fresh: false,
      pass: null,
      log: null,
      printExpectation: false,
      printManifest: false,
    })
  })

  test('a warm run must name the cold manifest', () => {
    expect(() => parseArgs(['--fresh', '--expect', 'warm'])).toThrow('requires --expect-manifest')
    expect(parseArgs(['--expect', 'warm', '--expect-manifest', coldManifest]).manifest).toBe(
      coldManifest
    )
  })

  test('refuses a manifest that is not a lowercase sha256', () => {
    for (const bad of ['', 'abc', 'A'.repeat(64), 'g'.repeat(64), `${coldManifest}0`])
      expect(() => parseArgs(['--expect', 'warm', '--expect-manifest', bad])).toThrow()
    expect(() => parseArgs(['--expect', 'cold', '--expect-manifest', 'abc'])).toThrow('sha256')
  })

  test('refuses a flag with no value, an unknown pattern and an unknown option', () => {
    expect(() => parseArgs(['--expect'])).toThrow('needs a value')
    expect(() => parseArgs(['--expect', '--fresh'])).toThrow('needs a value')
    expect(() => parseArgs(['--expect', 'one-miss'])).toThrow('cold or warm')
    expect(() => parseArgs(['--self-check'])).toThrow('unknown option')
  })

  test('a checked pass needs its log, and only one expectation may be asked for', () => {
    expect(() => parseArgs(['--check-pass', 'warm'])).toThrow('requires --log')
    expect(() => parseArgs(['--log', 'build.log'])).toThrow('requires --check-pass')
    expect(() => parseArgs(['--check-pass', 'half', '--log', 'build.log'])).toThrow(
      '--check-pass must be'
    )
    expect(parseArgs(['--check-pass', 'warm', '--log', 'build.log']).pass).toBe('warm')
    expect(() =>
      parseArgs(['--check-pass', 'warm', '--log', 'b.log', '--print-expectation'])
    ).toThrow('only one expectation')
  })
})

test('dist manifests bind relative paths and bytes, skip absent output and ignore creation order', () => {
  const roots = [
    mkdtempSync(join(tmpdir(), 'adea-proof-dist-')),
    mkdtempSync(join(tmpdir(), 'adea-proof-dist-')),
  ]
  try {
    for (const [index, root] of roots.entries()) {
      for (const name of ['a', 'empty']) {
        mkdirSync(join(root, 'packages', name), { recursive: true })
        writeFileSync(
          join(root, 'packages', name, 'package.json'),
          JSON.stringify({ name: `@fixture/${name}` })
        )
      }
      const dist = join(root, 'packages/a/dist')
      mkdirSync(join(dist, 'nested'), { recursive: true })
      for (const name of index ? ['nested/b.js', 'a.js'] : ['a.js', 'nested/b.js'])
        writeFileSync(join(dist, name), name)
    }
    const first = distManifest(roots[0])
    expect(first.count).toBe(2)
    expect(distManifest(roots[1])).toEqual(first)
    writeFileSync(join(roots[1], 'packages/a/dist/a.js'), 'changed bytes')
    expect(distManifest(roots[1]).sha).not.toBe(first.sha)
    renameSync(join(roots[0], 'packages/a/dist/a.js'), join(roots[0], 'packages/a/dist/renamed.js'))
    expect(distManifest(roots[0]).sha).not.toBe(first.sha)
    expect(() => matchesPattern({ hits: 0, total: 2 }, 'unknown')).toThrow('unknown pattern')
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  }
})

async function proofEntry(
  args: string[],
  reply: { status: number; stdout: string; stderr: string }
) {
  const script = fileURLToPath(new URL('./vite-plus-proof.mjs', import.meta.url))
  const directory = mkdtempSync(join(tmpdir(), 'adea-proof-cli-'))
  const dist = join(repoRoot, 'packages/types/dist')
  const existed = existsSync(dist)
  mkdirSync(dist, { recursive: true })
  const fixture = join(dist, `canvas-proof-${crypto.randomUUID()}.txt`)
  writeFileSync(fixture, 'owned unit-only proof output')
  const summary = join(directory, 'summary')
  writeFileSync(summary, '')
  const manifest = distManifest(repoRoot)
  const previous = { argv: process.argv, env: process.env, exitCode: process.exitCode }
  const command = spyOn(childProcess, 'spawnSync').mockReturnValue(reply as never)
  const output = spyOn(console, 'log').mockImplementation(() => {})
  const errors = spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    // Exercise the original CLI and its real manifest reader. Only the vp
    // process is faked; no task/build command runs and no cache proof is claimed.
    process.argv = [
      process.execPath,
      script,
      ...args.map((arg) => (arg === 'CURRENT_MANIFEST' ? manifest.sha : arg)),
    ]
    process.env = { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary }
    process.exitCode = 0
    await import(`./vite-plus-proof.mjs?entry=${crypto.randomUUID()}`)
    return {
      status: process.exitCode,
      output: output.mock.calls.flat().join('\n'),
      summary: readFileSync(summary, 'utf8'),
      calls: [...command.mock.calls],
    }
  } finally {
    process.argv = previous.argv
    process.env = previous.env
    process.exitCode = previous.exitCode ?? 0
    command.mockRestore()
    output.mockRestore()
    errors.mockRestore()
    rmSync(fixture, { force: true })
    if (!existed && readdirSync(dist).length === 0) rmdirSync(dist)
    rmSync(directory, { recursive: true, force: true })
  }
}

const warmReply = {
  status: 0,
  stdout: `$ ORCH_TOOLCHAIN=fixture-key env -u FORCE_COLOR bun run build\nvp run: ${tasks}/${tasks} cache hit (100%), ${tasks}/${tasks} successful`,
  stderr: '',
}
const coldReply = {
  status: 0,
  stdout: `${miss}\nvp run: 0/${tasks} cache hit (0%), ${tasks}/${tasks} successful`,
  stderr: '',
}
const staleReply = {
  status: 0,
  stdout: `vp run: ${tasks - 1}/${tasks - 1} cache hit (100%), ${tasks - 1}/${tasks - 1} successful`,
  stderr: '',
}

test('proof CLI validates fixture warm counts, output identity and workflow reporting', async () => {
  const result = await proofEntry(
    ['--expect', 'warm', '--expect-manifest', 'CURRENT_MANIFEST'],
    warmReply
  )
  expect(result.status).toBe(0)
  expect(result.calls).toHaveLength(1)
  expect(result.calls[0]?.[1]).toEqual(['run', '--cache', 'orch:build'])
  expect(result.output).toContain('PASS expected warm')
  expect(result.output).toContain('PASS dist manifest matches')
  expect(result.output).toContain('::group::raw vp run')
  expect(result.summary).toContain(`cache: ${tasks}/${tasks} hit`)
  // The expectation the run was judged against comes from the graph.
  expect(result.output).toContain(`expected cache: ${tasks}/${tasks} cache hit`)
})

test('proof CLI reports cold misses and fails freshness or mismatched manifest assertions', async () => {
  const coldResult = await proofEntry(['--expect', 'cold'], coldReply)
  expect(coldResult.status).toBe(0)
  expect(coldResult.output).toContain('misses:')
  const failed = await proofEntry(['--fresh', '--expect-manifest', '0'.repeat(64)], warmReply)
  expect(failed.status).toBe(1)
  expect(failed.output).toContain('FAIL no workspace has a dist before the run')
  expect(failed.output).toContain('FAIL dist manifest matches')
  await expect(
    proofEntry([], { status: 2, stdout: '', stderr: 'fixture build failed' })
  ).rejects.toThrow('vp run orch:build failed (exit 2)')
})

test('the CLI prints the graph-derived expectation and the output manifest', async () => {
  const printed = await proofEntry(['--print-expectation'], coldReply)
  expect(printed.status).toBe(0)
  expect(printed.output.trim()).toBe(`${tasks}/${tasks} cache hit`)
  expect(printed.calls).toHaveLength(0)

  const manifest = await proofEntry(['--print-manifest'], coldReply)
  expect(manifest.status).toBe(0)
  expect(manifest.output.trim()).toMatch(/^[0-9a-f]{64} \d+$/)
})

test('a recorded pass is checked against the graph, not against a written-down count', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'adea-proof-pass-'))
  try {
    const warm = join(directory, 'warm.log')
    const stale = join(directory, 'stale.log')
    const coldLog = join(directory, 'cold.log')
    writeFileSync(warm, warmReply.stdout)
    writeFileSync(stale, staleReply.stdout)
    writeFileSync(coldLog, coldReply.stdout)

    const warmResult = await proofEntry(['--check-pass', 'warm', '--log', warm], coldReply)
    expect(warmResult.status).toBe(0)
    expect(warmResult.output).toContain('PASS expected warm')

    // A run that reports a different graph is not the graph under qualification.
    const staleResult = await proofEntry(['--check-pass', 'warm', '--log', stale], coldReply)
    expect(staleResult.status).toBe(1)
    expect(staleResult.output).toContain('FAIL expected warm')

    // An incomplete restore is reported, not asserted: the outputs are compared instead.
    const observed = await proofEntry(['--check-pass', 'observed', '--log', coldLog], coldReply)
    expect(observed.status).toBe(0)
    expect(observed.output).toContain(`observed: 0/${tasks} of ${tasks} graph tasks`)
    expect(observed.output).toContain('misses:')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
