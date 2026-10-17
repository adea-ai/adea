import { describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'

import { PUBLIC_ENV_NAMES } from '../apps/web/start/client-policy.mjs'
import {
  agentSimPackDigest,
  buildTasks,
  discoverWorkspaces,
  GLOBAL_INPUTS,
  PACKAGE_RULES,
  TEST_INPUTS,
  VOLATILE_INPUTS,
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

  test('lint has no dependencies; test waits for the own build, or the dependency builds when there is none', () => {
    for (const workspace of scripted('lint')) {
      expect(tasks[task(workspace, 'lint')]!.dependsOn, workspace.name).toEqual(['orch:toolchain'])
    }
    for (const workspace of scripted('test')) {
      // apps/desktop has no build but imports its dependencies' dist, so the race with their builds is closed.
      const expected = workspace.scripts.build
        ? [task(workspace, 'build')]
        : [...transitive(workspace.name)]
            .map((name) => byName.get(name)!)
            .filter((dep) => dep.scripts.build)
            .map((dep) => task(dep, 'build'))
            .toSorted()
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
      expect(definition.command, name).toMatch(
        new RegExp(
          `^ORCH_TOOLCHAIN=${toolchain}( ORCH_AGENT_SIM_PACK=[0-9a-z]+)? env -u FORCE_COLOR `
        )
      )
    }
  })

  test('builds restore dist, and the desktop suite stays uncached for its loader assertions', () => {
    for (const workspace of scripted('build')) {
      const cache = tasks[task(workspace, 'build')]!.cache
      expect(cache && cache.output, workspace.name).toEqual([`${workspace.dir}/dist/**`])
    }
    expect(tasks['orch:desktop:test']!.cache).toBe(false)
    expect(tasks['orch:desktop:test']!.dependsOn).toContain('orch:dev-view:build')
    expect(PACKAGE_RULES['apps/desktop']!.uncachedTest).toBe(true)
  })

  test('a test script that preloads the Solid transform lists it as an input of its test task', () => {
    for (const workspace of scripted('test')) {
      if (!workspace.scripts.test!.includes('scripts/test-solid-transform.ts')) continue
      const cache = tasks[task(workspace, 'test')]!.cache
      expect(cache && cache.input, workspace.name).toContain('scripts/test-solid-transform.ts')
    }
  })

  test('a build-less test consumer waits for builds behind a build-less dependency', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'orch-buildless-'))
    try {
      const write = (dir: string, manifest: object) => {
        mkdirSync(join(fixture, dir), { recursive: true })
        writeFileSync(join(fixture, dir, 'package.json'), JSON.stringify(manifest))
      }
      write('packages/lib', { name: '@fixture/lib', scripts: { build: 'true', test: 'true' } })
      write('packages/glue', { name: '@fixture/glue', dependencies: { '@fixture/lib': '*' } })
      write('apps/shell', {
        name: '@fixture/shell',
        dependencies: { '@fixture/glue': '*' },
        scripts: { test: 'true' },
      })
      const graph = buildTasks(fixture, toolchain) as typeof tasks
      expect(graph['orch:shell:test']!.dependsOn).toContain('orch:lib:build')
      expect(graph['orch:shell:test']!.dependsOn).toContain('orch:toolchain')
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
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

  test('the web build leaves out only the listings of the directories it generates into', () => {
    const inputs = inputsOf('orch:web:build')
    // Exact directory paths only; the `/**` exclusions are the generated files below them.
    const exact = inputs.filter((input) => input.startsWith('!') && !input.includes('*'))
    expect(exact.toSorted()).toEqual([
      '!apps/web',
      '!apps/web/public',
      '!node_modules',
      '!node_modules/.vite-temp',
    ])
    // The files stay inputs: only the exact directory paths are excluded.
    for (const path of ['scripts/sync-assets.mjs', 'scripts/pack-agent-sim.mjs', 'bun.lock'])
      expect(inputs).toContain(path)
    expect(inputsOf('orch:ui:build').some((input) => input.startsWith('!apps/web'))).toBe(false)
  })

  test('the volatile node_modules paths are excluded from every cached task, and nothing else is', () => {
    expect(VOLATILE_INPUTS).toEqual([
      '!node_modules',
      '!node_modules/.vite-temp',
      '!node_modules/.vite-temp/**',
    ])
    for (const [name, definition] of Object.entries(tasks)) {
      if (!definition.cache || name === 'orch:toolchain') continue
      for (const path of VOLATILE_INPUTS) expect(inputsOf(name), name).toContain(path)
      expect(inputsOf(name), name).toContain('bun.lock')
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

const withPack = (build: (pack: string, outside: string) => void) => {
  const base = mkdtempSync(join(tmpdir(), 'orch-pack-link-'))
  const pack = join(base, 'pack')
  const outside = join(base, 'outside')
  mkdirSync(pack)
  mkdirSync(outside)
  try {
    build(pack, outside)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}
const digestOf = (pack: string) => agentSimPackDigest(root, { ADEA_AGENT_SIM_DIST: pack })

describe('the web build declares everything it reads that no glob can see', () => {
  const web = 'orch:web:build'
  const declaredEnv = () => {
    const cache = tasks[web]!.cache
    if (!cache) throw new Error('uncached')
    return cache.env ?? []
  }

  test('every build-time public value and the Agent Sim pack path are declared env', () => {
    for (const name of PUBLIC_ENV_NAMES) expect(declaredEnv(), name).toContain(name)
    expect(declaredEnv()).toContain('ADEA_AGENT_SIM_DIST')
  })

  test('every module the asset staging scripts import is an input of the web build', () => {
    const inputs = new Set(inputsOf(web))
    const seen = new Set<string>()
    const visit = (file: string) => {
      if (seen.has(file)) return
      seen.add(file)
      const source = readFileSync(join(root, file), 'utf8')
      for (const match of source.matchAll(/(?:from\s+|import\()\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
        visit(relative(root, resolve(root, dirname(file), match[1]!)))
      }
    }
    visit('scripts/sync-assets.mjs')
    expect(seen.has('scripts/pack-agent-sim.mjs')).toBe(true)
    for (const file of seen) expect(inputs.has(file), file).toBe(true)
  })

  test('the pack digest is written into the web build command and follows the pack contents', () => {
    const pack = mkdtempSync(join(tmpdir(), 'orch-pack-'))
    try {
      writeFileSync(join(pack, 'engine.json'), '{"version":"1.0.0"}')
      mkdirSync(join(pack, 'nested'))
      writeFileSync(join(pack, 'engine.js'), 'a')
      writeFileSync(join(pack, 'nested', 'asset.bin'), 'b')
      const env = { ADEA_AGENT_SIM_DIST: pack }
      const first = agentSimPackDigest(root, env)
      expect(first).toMatch(/^[0-9a-f]{16}$/)
      expect(agentSimPackDigest(root, env)).toBe(first)
      expect(buildTasks(root, toolchain, env)[web]!.command).toContain(
        `ORCH_AGENT_SIM_PACK=${first} `
      )

      writeFileSync(join(pack, 'nested', 'asset.bin'), 'c')
      expect(agentSimPackDigest(root, env)).not.toBe(first)
      writeFileSync(join(pack, 'nested', 'asset.bin'), 'b')
      expect(agentSimPackDigest(root, env)).toBe(first)
      writeFileSync(join(pack, 'extra.txt'), '')
      expect(agentSimPackDigest(root, env)).not.toBe(first)
    } finally {
      rmSync(pack, { recursive: true, force: true })
    }
  })

  test('an unset pack is cached under its own digest', () => {
    expect(agentSimPackDigest(root, {})).toBe('none')
    expect(buildTasks(root, toolchain, {})[web]!.command).toContain('ORCH_AGENT_SIM_PACK=none ')
  })

  describe('links in the pack follow the staging script, which follows links and copies the rest as links', () => {
    test('a linked engine file changes the digest when its target changes or the link is retargeted', () => {
      withPack((pack) => {
        writeFileSync(join(pack, 'engine.json'), '{"version":"1.0.0"}')
        writeFileSync(join(pack, 'real-a.js'), 'a')
        writeFileSync(join(pack, 'real-b.js'), 'a')
        symlinkSync('real-a.js', join(pack, 'engine.js'))
        const first = digestOf(pack)
        expect(first).toMatch(/^[0-9a-f]{16}$/)

        writeFileSync(join(pack, 'real-a.js'), 'changed')
        const edited = digestOf(pack)
        expect(edited).not.toBe(first)

        writeFileSync(join(pack, 'real-a.js'), 'a')
        expect(digestOf(pack)).toBe(first)
        rmSync(join(pack, 'engine.js'))
        symlinkSync('real-b.js', join(pack, 'engine.js'))
        expect(digestOf(pack)).not.toBe(first)
      })
    })

    test('a linked engine.json and a linked directory are digested through their targets', () => {
      withPack((pack) => {
        mkdirSync(join(pack, 'data'))
        writeFileSync(join(pack, 'data', 'engine.json'), '{"version":"1.0.0"}')
        writeFileSync(join(pack, 'engine.js'), 'a')
        symlinkSync('data/engine.json', join(pack, 'engine.json'))
        symlinkSync('data', join(pack, 'data-link'))
        const first = digestOf(pack)
        writeFileSync(join(pack, 'data', 'engine.json'), '{"version":"2.0.0"}')
        expect(digestOf(pack)).not.toBe(first)
      })
    })

    test('a link cycle inside the pack terminates', () => {
      withPack((pack) => {
        mkdirSync(join(pack, 'sub'))
        writeFileSync(join(pack, 'engine.json'), '{}')
        symlinkSync('..', join(pack, 'sub', 'up'))
        expect(digestOf(pack)).toMatch(/^[0-9a-f]{16}$/)
      })
    })

    test('a link that leaves the pack, or points nowhere, leaves the digest unknown and the build uncached', () => {
      withPack((pack, outside) => {
        writeFileSync(join(outside, 'engine.js'), 'x')
        writeFileSync(join(pack, 'engine.json'), '{}')
        symlinkSync(join(outside, 'engine.js'), join(pack, 'engine.js'))
        expect(digestOf(pack)).toBeNull()
        const definition = buildTasks(root, toolchain, { ADEA_AGENT_SIM_DIST: pack })[web]!
        expect(definition.cache).toBe(false)
        expect(definition.dependsOn).toContain('orch:toolchain')
        expect(definition.command).toBe('bun run --cwd apps/web build')

        rmSync(join(pack, 'engine.js'))
        symlinkSync('missing.js', join(pack, 'engine.js'))
        expect(digestOf(pack)).toBeNull()
      })
      expect(
        agentSimPackDigest(root, { ADEA_AGENT_SIM_DIST: '/nonexistent/agent-sim-pack' })
      ).toBeNull()
    })

    test('a pack path that is itself a link is digested through its target', () => {
      withPack((pack, outside) => {
        writeFileSync(join(pack, 'engine.json'), '{}')
        const linked = join(outside, 'linked-pack')
        symlinkSync(pack, linked)
        expect(digestOf(linked)).toBe(digestOf(pack))
      })
    })
  })
})

const stripJsonc = (text: string) => text.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1')
// The tsconfig each workspace's `typecheck` script names (`-p` or the package default).
const configOf = (workspace: { dir: string; scripts: Record<string, string> }) => {
  const project = /-p\s+(\S+)/.exec(workspace.scripts.typecheck ?? '')?.[1]
  return join(workspace.dir, project ?? 'tsconfig.json')
}

const chain = (file: string, seen = new Set<string>()): Set<string> => {
  if (seen.has(file)) return seen
  seen.add(file)
  const parsed = JSON.parse(stripJsonc(readFileSync(join(root, file), 'utf8'))) as {
    extends?: string | string[]
  }
  for (const parent of [parsed.extends ?? []].flat()) {
    if (!parent.startsWith('.')) continue
    chain(relative(root, resolve(root, dirname(file), parent)), seen)
  }
  return seen
}

describe('every tsconfig a typecheck loads is an explicit input (a Bun-run checker does not report its reads)', () => {
  test('the extends chain of each typechecked workspace is covered by the task inputs', () => {
    for (const workspace of scripted('typecheck')) {
      const config = configOf(workspace)
      if (!existsSync(join(root, config))) continue
      const inputs = new Set(inputsOf(task(workspace, 'typecheck')))
      for (const file of chain(config)) {
        const inPackage = file.startsWith(`${workspace.dir}/`)
        expect(inPackage || inputs.has(file), `${workspace.name}: ${file}`).toBe(true)
      }
    }
  })
})
