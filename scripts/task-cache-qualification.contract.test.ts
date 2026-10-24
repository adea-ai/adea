// The contract between the cache qualification workflow and the proof it runs.
//
// The workflow must not assert a cache count written down when the graph was
// smaller: the number of cacheable tasks is a property of the build graph, so
// the expectation is derived from it. The workflow must also prove that the
// restored build reproduces the same output bytes as an independent cold build,
// and it must keep the rules that decide who may write the cache, which readers
// may read it, when the billing pause applies and which actions are pinned.
//
// The lane's runner has the same kind of contract: a token that may only read,
// a checkout that leaves no credentials behind, and a setup action that may not
// manage a cache beside the one this lane qualifies. Each of those guards reads
// the workflow as text, so a weakened copy can be put through the same function
// and the mutation control below fails when a guard stops biting.
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

  test('the baseline is an independent uncached build', () => {
    // An empty cache directory: the baseline cannot restore anything, so it is
    // not the restored cache measured against itself.
    expect(workflow).toContain('mkdir -p "$RUNNER_TEMP/cold-cache"')
    expect(workflow).toContain('VITE_CACHE_PATH="$RUNNER_TEMP/cold-cache" bun run build')
    // The baseline really was cold.
    expect(workflow).toContain('--check-pass cold --log "$RUNNER_TEMP/build-cold.log"')
  })

  test('the owned outputs are cleared, so the restored pass measures the restore', () => {
    expect(workflow).toContain('node scripts/vite-plus-proof.mjs --clear-outputs')
    const clears = workflow.match(/--clear-outputs/g) ?? []
    // Once before the cold baseline and once before the restored pass.
    expect(clears.length).toBeGreaterThanOrEqual(2)
  })

  test('the restored outputs are compared with the cold baseline', () => {
    expect(workflow).toContain('node scripts/vite-plus-proof.mjs --print-manifest')
    expect(workflow).toContain(
      'node scripts/vite-plus-proof.mjs --compare-manifest "$RUNNER_TEMP/manifest-cold.txt,$RUNNER_TEMP/manifest-restored.txt"'
    )
    expect(workflow).toContain(
      'node scripts/vite-plus-proof.mjs --compare-manifest "$RUNNER_TEMP/manifest-cold.txt,$RUNNER_TEMP/manifest-warm.txt"'
    )
  })

  test('the warm pass must run warm, and the restored pass depends on the restore', () => {
    // The last pass runs on the cache the restored pass wrote.
    expect(workflow).toContain('--check-pass warm --log "$RUNNER_TEMP/build-warm.log"')
    // A complete restore for the same head hits every task on the restored pass too.
    expect(workflow).toContain('if test "$previous" = "$head"; then')
    expect(workflow).toContain('--check-pass warm --log "$RUNNER_TEMP/build-restored.log"')
    // An incomplete or stale restore is reported, and the bytes are compared instead.
    expect(workflow).toContain('--check-pass observed --log "$RUNNER_TEMP/build-restored.log"')
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
    expect(workflow).toContain('bun-version: 1.4.4')
    expect(workflow).toContain('node-version: 24.21.0')
    // The cache key names the toolchain, so a different toolchain is a different entry.
    expect(workflow).toContain('node24.21.0-bun1.4.4-vp1.3.0')
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

/**
 * Every `permissions:` block in the workflow, top-level or nested, in the
 * scalar (`permissions: write-all`) and mapping (`permissions:` plus indented
 * grants) forms.
 */
function permissionsBlocks(text: string): string[] {
  const lines = text.split('\n')
  const blocks: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const block = /^(\s*)permissions:(.*)$/.exec(lines[index])
    if (!block) continue
    const [, indent, inline] = block
    if (inline.trim() !== '') {
      blocks.push(lines[index])
      continue
    }
    let end = index + 1
    while (
      end < lines.length &&
      lines[end].trim() !== '' &&
      lines[end].search(/\S/) > indent.length
    )
      end += 1
    blocks.push(lines.slice(index, end).join('\n'))
    index = end - 1
  }
  return blocks
}

/**
 * The body of every step that uses `uses`, from its `- uses:` line to the next
 * step of the same job, so a guard reads one step's `with:` and not another's.
 */
function stepBlocks(text: string, uses: string): string[][] {
  const lines = text.split('\n')
  const marker = `- uses: ${uses}`
  const blocks: string[][] = []
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trimStart().startsWith(marker)) continue
    const indent = lines[index].search(/\S/)
    let end = index + 1
    while (end < lines.length) {
      const line = lines[end]
      if (line.trimStart().startsWith('- ') && line.search(/\S/) <= indent) break
      end += 1
    }
    blocks.push(lines.slice(index, end))
    index = end - 1
  }
  return blocks
}

/** The ways the lane's token stops being read-only. */
function permissionsViolations(text: string): string[] {
  const blocks = permissionsBlocks(text)
  const violations: string[] = []
  const topLevel = blocks.find((block) => block.startsWith('permissions:'))
  if (topLevel === undefined)
    violations.push(
      'the workflow declares no top-level permissions block, so the token scope falls back to the repository default'
    )
  else if (!/^\s+contents:\s*read\s*$/m.test(topLevel))
    violations.push("the top-level permissions block does not pin contents to 'read'")
  // A write grant anywhere, including a job's own block, widens that default.
  for (const block of blocks) {
    if (/\bwrite-all\b/.test(block)) violations.push('a permissions block grants write-all')
    else if (/^\s+[A-Za-z][\w-]*:\s*write\s*$/m.test(block))
      violations.push('a permissions block grants a write scope')
  }
  return violations
}

/** The ways the checkout leaves a write credential in the runner workspace. */
function checkoutViolations(text: string): string[] {
  const steps = stepBlocks(text, 'actions/checkout@')
  if (steps.length === 0) return ['the lane has no checkout step']
  const violations: string[] = []
  for (const step of steps) {
    const settings = step.filter((line) => line.trimStart().startsWith('persist-credentials:'))
    if (settings.length !== 1 || settings[0].trim() !== 'persist-credentials: false')
      violations.push('the checkout step does not set persist-credentials: false')
  }
  return violations
}

/** The ways setup-bun starts managing a cache beside the qualified one. */
function bunSetupViolations(text: string): string[] {
  const steps = stepBlocks(text, 'oven-sh/setup-bun@')
  if (steps.length === 0) return ['the lane has no setup-bun step']
  const violations: string[] = []
  for (const step of steps) {
    const settings = step.filter((line) => line.trimStart().startsWith('no-cache:'))
    if (settings.length !== 1 || settings[0].trim() !== 'no-cache: true')
      violations.push('the setup-bun step does not set no-cache: true')
  }
  return violations
}

describe('the runner this lane runs on', () => {
  test('the workflow grants read permissions only', () => {
    // The whole lane runs with this token; the block is declared and read-only
    // rather than left to whatever the repository default happens to be.
    expect(workflow).toContain('permissions:\n  contents: read')
    expect(permissionsViolations(workflow)).toEqual([])
  })

  test('the checkout leaves no credentials behind', () => {
    // A persisted credential is a write token for everything that runs after
    // the checkout in the same workspace.
    expect(workflow).toContain('persist-credentials: false')
    expect(checkoutViolations(workflow)).toEqual([])
  })

  test('setup-bun keeps its hands off the cache', () => {
    // The lane qualifies exactly one cache: a second, action-managed bun cache
    // would restore bytes this workflow never qualified.
    expect(workflow).toContain('no-cache: true')
    expect(bunSetupViolations(workflow)).toEqual([])
  })

  test('the mutation control bites: every weakened guard reports itself', () => {
    const mutants: {
      name: string
      guard: (text: string) => string[]
      mutated: string
      reported: string
    }[] = [
      {
        name: 'the token may write contents',
        guard: permissionsViolations,
        mutated: workflow.replace(
          'permissions:\n  contents: read',
          'permissions:\n  contents: write'
        ),
        reported: 'a permissions block grants a write scope',
      },
      {
        name: 'the permissions block grants write-all',
        guard: permissionsViolations,
        mutated: workflow.replace('permissions:\n  contents: read', 'permissions: write-all'),
        reported: 'a permissions block grants write-all',
      },
      {
        name: 'the permissions block is gone, so the repository default applies',
        guard: permissionsViolations,
        mutated: workflow.replace('permissions:\n  contents: read\n\n', ''),
        reported:
          'the workflow declares no top-level permissions block, so the token scope falls back to the repository default',
      },
      {
        name: 'a job re-declares a write grant beneath the read-only top level',
        guard: permissionsViolations,
        mutated: workflow.replace(
          '    runs-on: ubuntu-latest',
          '    permissions:\n      contents: write\n    runs-on: ubuntu-latest'
        ),
        reported: 'a permissions block grants a write scope',
      },
      {
        name: 'the checkout persists its credentials',
        guard: checkoutViolations,
        mutated: workflow.replace('persist-credentials: false', 'persist-credentials: true'),
        reported: 'the checkout step does not set persist-credentials: false',
      },
      {
        name: 'the checkout stops disabling credential persistence',
        guard: checkoutViolations,
        mutated: workflow.replace(/\n\s+persist-credentials: false/, ''),
        reported: 'the checkout step does not set persist-credentials: false',
      },
      {
        name: 'setup-bun manages a cache again',
        guard: bunSetupViolations,
        mutated: workflow.replace('no-cache: true', 'no-cache: false'),
        reported: 'the setup-bun step does not set no-cache: true',
      },
      {
        name: 'the bun cache setting is left out',
        guard: bunSetupViolations,
        mutated: workflow.replace(/\n\s+no-cache: true/, ''),
        reported: 'the setup-bun step does not set no-cache: true',
      },
    ]
    for (const { name, guard, mutated, reported } of mutants) {
      // The mutation lives in memory only: the workflow on disk is untouched.
      expect({ name, changed: mutated !== workflow }).toEqual({ name, changed: true })
      expect({ name, violations: guard(mutated) }).toEqual({
        name,
        violations: expect.arrayContaining([reported]),
      })
    }
  })
})
