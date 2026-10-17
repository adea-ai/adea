import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

import {
  buildTasks,
  discoverWorkspaces,
  GLOBAL_INPUTS,
  PACKAGE_RULES,
  TEST_INPUTS,
} from './orch-graph.mjs'

const root = resolve(import.meta.dir, '..')
const toolchain = 'test-toolchain'
const tasks = buildTasks(root, toolchain) as Record<
  string,
  {
    command: string
    dependsOn?: string[]
    cache: false | { input: unknown[]; output?: string[]; env?: string[] }
  }
>
const workspaces = discoverWorkspaces(root)
const byName = new Map(workspaces.map((workspace) => [workspace.name, workspace]))

/** The manifests' own workspace dependencies, read independently of the generator. */
function directDependencies(dir: string): string[] {
  const manifest = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'))
  return Object.keys({
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.peerDependencies,
    ...manifest.optionalDependencies,
  }).filter((name) => byName.has(name))
}

function transitive(name: string, seen = new Set<string>()): Set<string> {
  for (const dependency of directDependencies(byName.get(name)!.dir)) {
    if (seen.has(dependency)) continue
    seen.add(dependency)
    transitive(dependency, seen)
  }
  return seen
}

const scripted = (script: string) => workspaces.filter((workspace) => workspace.scripts[script])
const task = (workspace: { short: string }, name: string) => `orch:${workspace.short}:${name}`
const inputsOf = (name: string) => {
  const cache = tasks[name]!.cache
  if (!cache) throw new Error(`${name} is uncached`)
  return cache.input.filter((entry): entry is string => typeof entry === 'string')
}

describe('orch task graph mirrors the package manifests', () => {
  test('has a build, typecheck, lint and test task for exactly the packages that define the script', () => {
    for (const script of ['build', 'typecheck', 'lint', 'test']) {
      const expected = scripted(script).map((workspace) => task(workspace, script))
      const actual = Object.keys(tasks).filter((name) =>
        new RegExp(`^orch:(?!deps-of-)[^:]+:${script}$`).test(name)
      )
      expect(actual.toSorted(), script).toEqual(expected.toSorted())
      expect(tasks[`orch:${script}`], script).toMatchObject({ command: 'node -e 0', cache: false })
      expect(tasks[`orch:${script}`]!.dependsOn!.toSorted(), script).toEqual(expected.toSorted())
    }
  })

  test('build and typecheck wait for the build of every workspace dependency (^build)', () => {
    for (const script of ['build', 'typecheck']) {
      for (const workspace of scripted(script)) {
        const expected = directDependencies(workspace.dir)
          .map((name) => byName.get(name)!)
          .filter((dependency) => dependency.scripts.build)
          .map((dependency) => task(dependency, 'build'))
        const dependsOn = tasks[task(workspace, script)]!.dependsOn!
        expect(
          dependsOn.filter((name) => name !== 'orch:toolchain').toSorted(),
          workspace.name
        ).toEqual(expected.toSorted())
      }
    }
  })

  test('lint has no dependencies and test waits for the package own build', () => {
    for (const workspace of scripted('lint')) {
      expect(tasks[task(workspace, 'lint')]!.dependsOn, workspace.name).toEqual(['orch:toolchain'])
    }
    for (const workspace of scripted('test')) {
      const expected = workspace.scripts.build ? [task(workspace, 'build')] : []
      const dependsOn = tasks[task(workspace, 'test')]!.dependsOn!
      expect(
        dependsOn.filter((name) => name !== 'orch:toolchain').toSorted(),
        workspace.name
      ).toEqual(expected)
    }
  })

  test('every cached task is gated by the toolchain check and carries its id', () => {
    expect(tasks['orch:toolchain']).toMatchObject({ cache: false })
    for (const [name, definition] of Object.entries(tasks)) {
      if (!definition.cache || name === 'orch:toolchain') continue
      expect(definition.dependsOn, name).toContain('orch:toolchain')
      expect(definition.command, name).toStartWith(
        `ORCH_TOOLCHAIN=${toolchain} env -u FORCE_COLOR `
      )
    }
  })

  test('builds restore dist, and the desktop suite stays uncached for its loader assertions', () => {
    for (const workspace of scripted('build')) {
      const cache = tasks[task(workspace, 'build')]!.cache
      expect(cache && cache.output, workspace.name).toEqual([`${workspace.dir}/dist/**`])
    }
    expect(tasks['orch:desktop:test']!.cache).toBe(false)
    expect(PACKAGE_RULES['apps/desktop']!.uncachedTest).toBe(true)
  })

  test('deps-of tasks build exactly the transitive workspace dependencies', () => {
    for (const workspace of workspaces) {
      const expected = [...transitive(workspace.name)]
        .map((name) => byName.get(name)!)
        .filter((dependency) => dependency.scripts.build)
        .map((dependency) => task(dependency, 'build'))
      const aggregate = tasks[`orch:deps-of-${workspace.short}:build`]
      if (expected.length === 0) expect(aggregate, workspace.name).toBeUndefined()
      else expect(aggregate!.dependsOn!.toSorted(), workspace.name).toEqual(expected.toSorted())
    }
    // The set `turbo run build --filter=@adea-ai/web^...` selected, which the lanes still build first.
    expect(tasks['orch:deps-of-web:build']!.dependsOn).not.toContain('orch:web:build')
  })

  test('the Bun-loaded files every test depends on are inputs of every cached task', () => {
    for (const path of ['bunfig.toml', 'bun.lock']) expect(GLOBAL_INPUTS).toContain(path)
    expect(TEST_INPUTS).toContain('scripts/test-target-preload.ts')
    for (const workspace of scripted('test')) {
      const name = task(workspace, 'test')
      if (!tasks[name]!.cache) continue
      for (const path of TEST_INPUTS) expect(inputsOf(name), name).toContain(path)
    }
    for (const [name, definition] of Object.entries(tasks)) {
      if (!definition.cache || name === 'orch:toolchain') continue
      for (const path of GLOBAL_INPUTS) expect(inputsOf(name), name).toContain(path)
    }
  })
})

function testFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of existsSync(dir) ? readdirSync(dir) : []) {
    if (entry === 'node_modules' || entry === 'dist') continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) found.push(...testFiles(path))
    else if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry)) found.push(path)
  }
  return found
}

describe('a package test task lists what its tests read outside the package', () => {
  // Bun's reads are invisible to Vite Task's tracking, so a relative path that leaves the package must be
  // covered by the test task's explicit inputs, or an edit there would replay a stale result.
  test('relative paths out of a package are covered by its test inputs', () => {
    const uncovered: string[] = []
    for (const workspace of scripted('test')) {
      if (!tasks[task(workspace, 'test')]!.cache) continue
      const globs = inputsOf(task(workspace, 'test')).filter((entry) => !entry.startsWith('!'))
      const excluded = inputsOf(task(workspace, 'test'))
        .filter((entry) => entry.startsWith('!'))
        .map((entry) => new Bun.Glob(entry.slice(1)))
      const included = globs.map((entry) => new Bun.Glob(entry))
      const covered = (path: string) =>
        included.some((glob) => glob.match(path)) && !excluded.some((glob) => glob.match(path))
      for (const dirName of ['test', 'tests', 'start']) {
        for (const file of testFiles(join(root, workspace.dir, dirName))) {
          // Integration suites need a database and are not part of the `test` script.
          if (file.includes('/integration/')) continue
          const source = readFileSync(file, 'utf8')
          const targets = new Set<string>()
          // `../x` from the test file, and `apps/x`, `packages/x`, ... from the repository root.
          for (const [, literal] of source.matchAll(/['"`](\.\.\/[^'"`\s$]*)['"`]/g)) {
            const resolved = resolve(dirname(file), literal!)
            if (existsSync(resolved)) targets.add(relative(root, resolved))
          }
          for (const [, literal] of source.matchAll(
            /['"`]((?:apps|packages|scripts|docs|infra|\.github)\/[\w./@-]*)/g
          )) {
            if (existsSync(resolve(root, literal!))) targets.add(literal!.replace(/\/$/, ''))
          }
          for (const target of targets) {
            if (target === '' || target.startsWith('..') || target.startsWith(`${workspace.dir}/`))
              continue
            // A directory target is covered when a file below it is.
            const probe = /\.[a-z]+$/.test(target) ? target : `${target}/x`
            if (!covered(probe) && !covered(target))
              uncovered.push(`${relative(root, file)} -> ${target}`)
          }
        }
      }
    }
    expect(uncovered).toEqual([])
  })

  test('the ui boundary test sources are explicit inputs', () => {
    const inputs = inputsOf('orch:ui:test')
    for (const path of PACKAGE_RULES['packages/ui']!.test!) expect(inputs).toContain(path)
  })
})
