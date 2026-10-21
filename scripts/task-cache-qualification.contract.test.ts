// The contract between the cache qualification workflow and the proof it runs.
//
// The workflow must not assert a cache count written down when the graph was
// smaller: the number of cacheable tasks is a property of the build graph, so
// the expectation is derived from it. The workflow must also prove that a
// restored build reproduces the same output bytes, and it must keep the rules
// that decide who may write the cache, which readers may read it, when the
// billing pause applies and which actions are pinned.
import { describe, expect, test } from 'bun:test'

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { buildTasks } from './orch-graph.mjs'
import { expectedId } from './orch-toolchain.mjs'

const root = resolve(import.meta.dir, '..')
const workflow = readFileSync(join(root, '.github/workflows/task-cache-qualification.yml'), 'utf8')

describe('the cache qualification workflow', () => {
  test('asserts no cache count of its own', () => {
    // A literal count is what rots: the graph changes, the literal does not.
    expect(workflow).not.toMatch(/\d+\/\d+ cache hit/)
    expect(workflow).not.toMatch(/grep -Fq '\d+\/\d+/)
  })

  test('derives its expectation from the build graph', () => {
    expect(workflow).toContain('node scripts/vite-plus-proof.mjs --print-expectation')
    expect(workflow).toContain('expected="$(node scripts/vite-plus-proof.mjs --print-expectation)"')
  })

  test('proves that the restored outputs are byte-identical', () => {
    expect(workflow).toContain('node scripts/vite-plus-proof.mjs --print-manifest')
    expect(workflow).toContain(
      'cmp "$RUNNER_TEMP/manifest-first.txt" "$RUNNER_TEMP/manifest-second.txt"'
    )
  })

  test('the second pass must run warm, and the first pass depends on the restore', () => {
    // The second pass runs on the cache the first pass left.
    expect(workflow).toContain('--check-pass warm --log "$RUNNER_TEMP/build-second.log"')
    // A complete restore for the same head hits every task on the first pass too.
    expect(workflow).toContain('if test "$previous" = "$head"; then')
    expect(workflow).toContain('--check-pass warm --log "$RUNNER_TEMP/build-first.log"')
    // An incomplete or stale restore is reported, and the bytes are compared instead.
    expect(workflow).toContain('--check-pass observed --log "$RUNNER_TEMP/build-first.log"')
  })

  test('only the default branch may write the cache', () => {
    expect(workflow).toContain(
      "if: success() && github.event_name != 'pull_request' && github.ref == format('refs/heads/{0}', github.event.repository.default_branch)"
    )
    // A pull request reads the cache and never writes it.
    expect(workflow).toContain('github.event.pull_request.draft == false')
  })

  test('the billing pause still stops the lane', () => {
    expect(workflow).toContain("vars.CI_BILLING_PAUSED != 'true'")
  })

  test('every action and toolchain in the lane is pinned', () => {
    for (const pin of [
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
      'oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2',
      'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0',
      'actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0',
      'actions/cache/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0',
    ])
      expect(workflow).toContain(pin)
    expect(workflow).toContain('bun-version: 1.4.3')
    expect(workflow).toContain('node-version: 24.21.0')
    // The cache key names the toolchain, so a different toolchain is a different entry.
    expect(workflow).toContain('node24.21.0-bun1.4.3-vp1.3.0')
  })

  test('the cache key covers the config and the lockfile, and the graph covers the source', () => {
    // A changed config or lockfile is a different cache entry.
    expect(workflow).toContain("${{ hashFiles('bun.lock', 'vite.config.ts') }}")
    // A changed source file is a different task key: every build task's own
    // workspace files are inputs of that task.
    const tasks = buildTasks(root, expectedId(root))
    const build = tasks['orch:types:build']
    expect(build).toBeDefined()
    expect(build?.cache?.input).toContain('packages/types/**')
  })

  test('the toolchain invalidates every cached task', () => {
    const tasks = buildTasks(root, expectedId(root))
    const build = tasks['orch:types:build']
    // The toolchain identity is part of the cached command, so a different node,
    // bun or platform is a different key.
    expect(build?.command).toContain('ORCH_TOOLCHAIN=')
  })
})
