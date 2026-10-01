import { afterEach, describe, expect, test } from 'bun:test'
import { createRequire } from 'node:module'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, relative, resolve } from 'node:path'

import tailwindcss from '@tailwindcss/postcss'
import viteSolid from 'vite-plugin-solid'
import {
  build as viteBuild,
  createServer as viteCreateServer,
  type Plugin,
  type ResolvedConfig,
} from 'vite'

import {
  assertLucideDevShimCoverage,
  collectUiSourceFiles,
  collectUiSourceGraph,
  formatUiSourceDirectives,
  missingLucideDevShimExports,
  selectiveUiSourcePlugin,
} from './ui-tailwind-sources'

type Postcss = (plugins: unknown[]) => {
  process(css: string, options: { from: string }): Promise<{ css: string }>
}

const postcss = createRequire(import.meta.resolve('@tailwindcss/postcss'))('postcss') as Postcss

interface Fixture {
  root: string
  entrypoint: string
  uiRoot: string
  uiSourceRoot: string
  linkedUiRoot: string
  cssPath: string
  resolveId(specifier: string, importer: string): Promise<string | undefined>
}

let fixtureRoot: string | undefined

afterEach(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
  fixtureRoot = undefined
})

function write(root: string, relativePath: string, content: string) {
  const path = join(root, relativePath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

function makeFixture(entrySource: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'adea-ui-tailwind-sources-'))
  fixtureRoot = root
  const uiRoot = join(root, 'shared-ui')
  const uiSourceRoot = join(uiRoot, 'src')
  const linkedUiRoot = join(root, 'apps/web/node_modules/@adea-ai/ui')
  const linkedTailwindRoot = join(root, 'apps/web/node_modules/tailwindcss')
  const entrypoint = write(root, 'apps/web/src/client.tsx', entrySource)
  const cssPath = join(root, 'apps/web/node_modules/.cache/ui-sources.css')

  mkdirSync(dirname(linkedUiRoot), { recursive: true })
  symlinkSync(uiRoot, linkedUiRoot, 'dir')
  symlinkSync(
    resolve(dirname(import.meta.dir), 'node_modules/tailwindcss'),
    linkedTailwindRoot,
    'dir'
  )
  write(uiRoot, 'package.json', JSON.stringify({ name: '@adea-ai/ui' }))
  write(
    uiRoot,
    'src/index.ts',
    "export { Button } from './components/ui/button'\nexport { Input } from './components/ui/input'\n"
  )
  write(uiRoot, 'src/components/ui/button/index.ts', "export { Button } from './button'\n")
  write(
    uiRoot,
    'src/components/ui/button/button.tsx',
    `import { Label } from '@adea-ai/ui/components/ui/label'
import { controlSize } from '#lib/variants'
export function Button() { return <button class="bg-[#123456] size-8" data-size={controlSize}><Label /></button> }
`
  )
  write(uiRoot, 'src/components/ui/label/index.ts', "export { Label } from './label'\n")
  write(
    uiRoot,
    'src/components/ui/label/label.tsx',
    `export function Label() { return <span class="text-[#135724]">Name</span> }
`
  )
  write(uiRoot, 'src/components/ui/input/index.ts', "export { Input } from './input'\n")
  write(
    uiRoot,
    'src/components/ui/input/input.tsx',
    `export function Input() { return <input class="border-[#654321]" /> }
`
  )
  write(uiRoot, 'src/lib/variants.ts', 'export const controlSize = "size-8"\n')
  write(
    root,
    'node_modules/lucide-solid/index.ts',
    'export const AppArrow = "AppArrow"\nexport const ArrowDownRight = "ArrowDownRight"\nexport const ArrowUpRight = "ArrowUpRight"\nexport const Calendar = "Calendar"\n'
  )

  async function resolveId(specifier: string, importer: string) {
    if (specifier === '@adea-ai/ui/package.json') return join(uiRoot, 'package.json')
    if (specifier === '@adea-ai/ui') return join(uiSourceRoot, 'index.ts')
    if (specifier.startsWith('@adea-ai/ui/'))
      return resolveFile(join(uiSourceRoot, specifier.slice('@adea-ai/ui/'.length)))
    if (specifier === '@vendor/engine')
      return resolveFile(join(root, 'node_modules/@vendor/engine/index.js'))
    if (specifier === 'lucide-solid')
      return resolveFile(join(root, 'node_modules/lucide-solid/index.ts'))
    if (specifier.startsWith('#lib/'))
      return resolveFile(join(uiSourceRoot, 'lib', specifier.slice(5)))
    if (specifier.startsWith('.')) return resolveFile(join(dirname(importer), specifier))
    return undefined
  }

  return { root, entrypoint, uiRoot, uiSourceRoot, linkedUiRoot, cssPath, resolveId }
}

function resolveFile(path: string): string | undefined {
  const candidates = [
    path,
    ...['.ts', '.tsx', '.js', '.jsx'].map((extension) => `${path}${extension}`),
    ...['index.ts', 'index.tsx', 'index.js', 'index.jsx'].map((name) => join(path, name)),
  ]
  return candidates.find((candidate) => extname(candidate) && existsSync(candidate))
}

async function collect(fixture: Fixture) {
  return collectUiSourceFiles({
    entrypoint: fixture.entrypoint,
    repositoryRoot: fixture.root,
    uiPackageRoot: fixture.uiRoot,
    uiSourceRoot: fixture.uiSourceRoot,
    resolveId: fixture.resolveId,
  })
}

async function resolvePluginConfig(
  plugin: Plugin,
  command: 'build' | 'serve',
  resolveId: Fixture['resolveId']
) {
  const hook = plugin.configResolved
  if (!hook) throw new Error('Expected the UI source plugin to register configResolved')
  const handler = typeof hook === 'function' ? hook : hook.handler
  const config = {
    command,
    createResolver: () => resolveId,
  } as unknown as ResolvedConfig
  await handler.call(plugin, config)
}

function directives(fixture: Fixture, files: string[], stablePackagePath = fixture.linkedUiRoot) {
  return formatUiSourceDirectives({
    files,
    uiPackageRoot: fixture.uiRoot,
    stablePackagePath,
    stylesheetPath: fixture.cssPath,
  })
}

async function renderCss(fixture: Fixture, sourceDirectives: string) {
  const input = `@import 'tailwindcss' source(none);\n${sourceDirectives}`
  mkdirSync(dirname(fixture.cssPath), { recursive: true })
  writeFileSync(fixture.cssPath, input)
  return (
    await postcss([tailwindcss({ base: fixture.root })]).process(input, { from: fixture.cssPath })
  ).css
}

async function bundleConsumer(
  fixture: Fixture,
  consumerSource = `import { Button } from '@adea-ai/ui'\nexport const consumer = Button\n`
): Promise<string> {
  const entrypoint = write(fixture.root, 'apps/web/src/consumer.tsx', consumerSource)
  const buildOutput = await viteBuild({
    configFile: false,
    logLevel: 'silent',
    mode: 'production',
    root: join(fixture.root, 'apps/web'),
    plugins: [viteSolid({ ssr: true })],
    resolve: {
      alias: [
        {
          find: /^@adea-ai\/ui$/,
          replacement: join(fixture.uiSourceRoot, 'index.ts'),
        },
        {
          find: /^@adea-ai\/ui\//,
          replacement: `${fixture.uiSourceRoot}/`,
        },
        {
          find: /^#lib\//,
          replacement: `${fixture.uiSourceRoot}/lib/`,
        },
      ],
      conditions: ['solid', 'development'],
    },
    build: {
      write: false,
      emptyOutDir: false,
      minify: false,
      lib: { entry: entrypoint, formats: ['es'] },
      rollupOptions: { external: ['solid-js', 'solid-js/web'] },
    },
  })
  if (!Array.isArray(buildOutput) && !('output' in buildOutput))
    throw new Error('Vite returned a watcher instead of a production build result')
  const outputs = Array.isArray(buildOutput) ? buildOutput : [buildOutput]
  return outputs
    .flatMap((output) => output.output)
    .filter((output) => output.type === 'chunk')
    .map((chunk) => chunk.code)
    .join('\n')
}

describe('selective shared UI Tailwind sources', () => {
  test('follows value imports, nested component dependencies, and literal dynamic imports while skipping type-only imports', async () => {
    const fixture = makeFixture(`import { Button } from '@adea-ai/ui'
import type { ButtonProps } from '@adea-ai/ui'
const loadInput = () => import('@adea-ai/ui/components/ui/input').then((module) => ({ default: module.Input }))
export const controls = [Button, loadInput]
`)

    write(
      fixture.uiRoot,
      'src/components/ui/type-only/type-only.tsx',
      'export interface ButtonProps {}\n'
    )
    const files = await collect(fixture)
    const relativeFiles = files
      .map((file) => file.replaceAll('\\', '/'))
      .map((file) => file.slice(file.indexOf('/shared-ui/')))
      .toSorted()

    expect(relativeFiles).toContain('/shared-ui/src/components/ui/button/button.tsx')
    expect(relativeFiles).toContain('/shared-ui/src/components/ui/label/label.tsx')
    expect(relativeFiles).toContain('/shared-ui/src/components/ui/input/input.tsx')
    expect(relativeFiles).toContain('/shared-ui/src/lib/variants.ts')
    expect(relativeFiles.some((file) => file.includes('/type-only/'))).toBe(false)
  })

  // This regression runs two Tailwind compiles and two production Vite builds.
  test('does not grow the source list or Tailwind output when an unused UI export is added', async () => {
    const consumerSource = `import { Button, Input } from '@adea-ai/ui'
export const controls = [Button, Input]
`
    const fixture = makeFixture(consumerSource)
    const beforeFiles = await collect(fixture)
    const beforeSources = directives(fixture, beforeFiles)
    expect(beforeSources).toContain("@source '../@adea-ai/ui/src/components/ui/button/button.tsx';")
    expect(beforeSources).toContain("@source '../@adea-ai/ui/src/components/ui/input/input.tsx';")
    expect(beforeSources).not.toContain(fixture.uiRoot)
    const [beforeCss, beforeJs] = await Promise.all([
      renderCss(fixture, beforeSources),
      bundleConsumer(fixture, consumerSource),
    ])

    write(
      fixture.uiRoot,
      'src/components/ui/calendar/index.ts',
      "export { Calendar } from './calendar'\n"
    )
    write(
      fixture.uiRoot,
      'src/components/ui/calendar/calendar.tsx',
      `export function Calendar() { return <div class="bg-[#c0ffee]">UNUSED_CALENDAR_MARKER</div> }\n`
    )
    write(
      fixture.uiRoot,
      'src/index.ts',
      "export { Button } from './components/ui/button'\nexport { Input } from './components/ui/input'\nexport { Calendar } from './components/ui/calendar'\n"
    )

    const afterFiles = await collect(fixture)
    const afterSources = directives(fixture, afterFiles)
    const [afterCss, afterJs] = await Promise.all([
      renderCss(fixture, afterSources),
      bundleConsumer(fixture, consumerSource),
    ])

    expect(afterFiles).toEqual(beforeFiles)
    expect(afterSources).toBe(beforeSources)
    expect(afterCss).toBe(beforeCss)
    expect(afterJs).toBe(beforeJs)
    expect(beforeJs).toContain('#123456')
    expect(beforeJs).toContain('#654321')
    expect(beforeCss).toContain('#123456')
    expect(beforeCss).toContain('#654321')
    expect(beforeCss).toContain('#135724')
    expect(beforeCss).toContain('.size-8')
    expect(afterJs).not.toContain('UNUSED_CALENDAR_MARKER')
    expect(afterJs).not.toContain('#c0ffee')
    expect(afterCss).toContain('#123456')
    expect(afterCss).toContain('#654321')
    expect(afterCss).toContain('#135724')
    expect(afterCss).toContain('.size-8')
    expect(afterCss.length).toBeGreaterThan(4_000)
    expect(afterCss).not.toContain('#c0ffee')
  }, 30_000)

  test('preserves runtime imports reached through a side-effect-only module', async () => {
    const fixture = makeFixture(`import './registration'\nexport const ready = true\n`)
    write(
      fixture.root,
      'apps/web/src/registration.ts',
      `import { Button } from '@adea-ai/ui'
globalThis.__ADEA_UI_SIDE_EFFECT__ = Button
`
    )

    const files = await collect(fixture)
    const javascript = await bundleConsumer(
      fixture,
      `import './registration'\nexport const ready = true\n`
    )
    expect(files.some((file) => file.includes('/components/ui/button/button.tsx'))).toBe(true)
    expect(javascript).toContain('__ADEA_UI_SIDE_EFFECT__')
    expect(javascript).toContain('#123456')
  })

  test('does not traverse unrelated vendor modules with opaque dynamic imports', async () => {
    const fixture = makeFixture(`import { engine } from '@vendor/engine'
import { Button } from '@adea-ai/ui'
export const controls = [engine, Button]
`)
    write(
      fixture.root,
      'node_modules/@vendor/engine/index.js',
      `export function engine(specifier) { return import(specifier) }\n`
    )

    const files = await collect(fixture)
    expect(files.some((file) => file.includes('/components/ui/button/button.tsx'))).toBe(true)
  })

  test('fails closed on opaque dynamic imports in first-party source', async () => {
    const fixture = makeFixture(`import './registration'\nexport const ready = true\n`)
    write(
      fixture.root,
      'apps/web/src/registration.ts',
      `export function loadModule(specifier: string) { return import(specifier) }\n`
    )

    await expect(collect(fixture)).rejects.toThrow(/non-literal runtime import/)
  })

  test('fails closed when a runtime UI import cannot be resolved', async () => {
    const fixture = makeFixture(`import { Missing } from '@adea-ai/ui/components/ui/missing'
export const control = Missing
`)

    await expect(collect(fixture)).rejects.toThrow(
      /unable to resolve runtime import.*@adea-ai\/ui/i
    )
  })

  test('keeps static namespace property use selective and treats opaque namespace use conservatively', async () => {
    const fixture = makeFixture(`import * as UI from '@adea-ai/ui'
export const control = UI.Button
`)
    const staticFiles = await collect(fixture)
    expect(staticFiles.some((file) => file.includes('/components/ui/button/button.tsx'))).toBe(true)
    expect(staticFiles.some((file) => file.includes('/components/ui/input/input.tsx'))).toBe(false)

    writeFileSync(
      fixture.entrypoint,
      `import * as UI from '@adea-ai/ui'
export const allControls = Object.values(UI)
`
    )
    const opaqueFiles = await collect(fixture)
    expect(opaqueFiles.some((file) => file.includes('/components/ui/input/input.tsx'))).toBe(true)

    writeFileSync(
      fixture.entrypoint,
      `import * as UI from '@adea-ai/ui'
export const control = UI.Button
function shadow(UI: { Input: unknown }) { return UI.Input }
`
    )
    const shadowedFiles = await collect(fixture)
    expect(shadowedFiles.some((file) => file.includes('/components/ui/input/input.tsx'))).toBe(true)
  })

  test('resolves local named-export aliases for direct and opaque namespace use', async () => {
    const fixture = makeFixture(`import { Primary } from '@adea-ai/ui'
export const control = Primary
`)
    write(
      fixture.uiRoot,
      'src/index.ts',
      `import { Button } from './components/ui/button'
export { Button as Primary }
export { Input } from './components/ui/input'
`
    )

    const namedFiles = await collect(fixture)
    expect(namedFiles.some((file) => file.includes('/components/ui/button/button.tsx'))).toBe(true)
    expect(namedFiles.some((file) => file.includes('/components/ui/input/input.tsx'))).toBe(false)

    writeFileSync(
      fixture.entrypoint,
      `import * as UI from '@adea-ai/ui'
export const controls = Object.values(UI)
`
    )
    const opaqueFiles = await collect(fixture)
    expect(opaqueFiles.some((file) => file.includes('/components/ui/button/button.tsx'))).toBe(true)
    expect(opaqueFiles.some((file) => file.includes('/components/ui/input/input.tsx'))).toBe(true)
  })

  test('separates ESM dev barrel links from selected-export CSS discovery', async () => {
    const fixture = makeFixture(`import { AppArrow } from 'lucide-solid'
import { PropertyList } from '@adea-ai/ui'
export const appIcon = AppArrow
export const details = PropertyList
`)
    write(
      fixture.uiRoot,
      'src/index.ts',
      `export { Button } from './components/ui/button'
export { Input } from './components/ui/input'
export { PropertyList, Stat } from './components/composites/stat'
`
    )
    write(
      fixture.uiRoot,
      'src/components/composites/stat/index.ts',
      "export { PropertyList, Stat } from './stat'\n"
    )
    const statPath = realpathSync(
      write(
        fixture.uiRoot,
        'src/components/composites/stat/stat.tsx',
        `import { ArrowDownRight as Down, ArrowUpRight as Up } from 'lucide-solid'
export function PropertyList() { return null }
export function Stat() { return [Down, Up] }
`
      )
    )
    write(
      fixture.uiRoot,
      'src/components/ui/calendar/index.ts',
      "export { Calendar } from './calendar'\n"
    )
    const calendarPath = realpathSync(
      write(
        fixture.uiRoot,
        'src/components/ui/calendar/calendar.tsx',
        `import { Calendar as CalendarIcon } from 'lucide-solid'
export function Calendar() { return CalendarIcon }
`
      )
    )

    const before = await collectUiSourceGraph({
      entrypoint: fixture.entrypoint,
      repositoryRoot: fixture.root,
      uiPackageRoot: fixture.uiRoot,
      uiSourceRoot: fixture.uiSourceRoot,
      resolveId: fixture.resolveId,
    })
    expect(before.uiSourceFiles).toContain(statPath)
    expect(before.uiSourceFiles).not.toContain(calendarPath)
    expect(before.devLucideImports.some(({ file }) => file === calendarPath)).toBe(false)
    expect(before.devLucideImports).toEqual([
      { file: statPath, names: ['ArrowDownRight', 'ArrowUpRight'] },
    ])
    expect(
      missingLucideDevShimExports(
        before.devLucideImports,
        `export {
  default as ArrowUpRight
} from 'lucide-solid/icons/arrow-up-right'
`
      )
    ).toEqual([{ file: statPath, names: ['ArrowDownRight'] }])
    expect(() =>
      assertLucideDevShimCoverage(
        before.devLucideImports,
        "export { default as ArrowUpRight } from 'lucide-solid/icons/arrow-up-right'\n",
        realpathSync(fixture.root)
      )
    ).toThrow(/components\/composites\/stat\/stat\.tsx: ArrowDownRight/)

    write(fixture.root, 'apps/web/src/start/client.tsx', 'export const clientReady = true\n')
    write(
      fixture.root,
      'apps/web/src/start/router.tsx',
      `import { PropertyList } from '@adea-ai/ui'
export const route = PropertyList
`
    )
    write(
      fixture.root,
      'apps/web/start/lucide-solid-dev-shim.jsx',
      "export { default as ArrowUpRight } from 'lucide-solid/icons/arrow-up-right'\n"
    )
    const plugin = selectiveUiSourcePlugin(join(fixture.root, 'apps/web'), {
      checkLucideDevShim: true,
    })
    await expect(resolvePluginConfig(plugin, 'serve', fixture.resolveId)).rejects.toThrow(
      /components\/composites\/stat\/stat\.tsx: ArrowDownRight/
    )
    await resolvePluginConfig(plugin, 'build', fixture.resolveId)

    write(
      fixture.uiRoot,
      'src/index.ts',
      `export { Button } from './components/ui/button'
export { Input } from './components/ui/input'
export { PropertyList, Stat } from './components/composites/stat'
export { Calendar } from './components/ui/calendar'
`
    )
    const viteServer = await viteCreateServer({
      configFile: false,
      logLevel: 'silent',
      root: fixture.root,
      optimizeDeps: { exclude: ['@adea-ai/ui'], noDiscovery: true },
      server: { middlewareMode: true },
    })
    try {
      const uiRootUrl = `/${relative(fixture.root, join(fixture.uiSourceRoot, 'index.ts')).replaceAll('\\', '/')}`
      const transformed = await viteServer.transformRequest(uiRootUrl)
      expect(transformed?.code).toContain('components/ui/calendar')
      const rootModule = await viteServer.moduleGraph.getModuleByUrl(uiRootUrl)
      expect(
        [...rootModule.importedModules].some((module) => module.url.includes('/calendar/'))
      ).toBe(true)
    } finally {
      await viteServer.close()
    }

    const after = await collectUiSourceGraph({
      entrypoint: fixture.entrypoint,
      repositoryRoot: fixture.root,
      uiPackageRoot: fixture.uiRoot,
      uiSourceRoot: fixture.uiSourceRoot,
      resolveId: fixture.resolveId,
    })
    expect(after.uiSourceFiles).not.toContain(calendarPath)
    expect(after.devLucideImports).toEqual([
      { file: statPath, names: ['ArrowDownRight', 'ArrowUpRight'] },
      { file: calendarPath, names: ['Calendar'] },
    ])

    write(
      fixture.root,
      'apps/web/start/lucide-solid-dev-shim.jsx',
      `export { default as ArrowDownRight } from 'lucide-solid/icons/arrow-down-right'
export { default as ArrowUpRight } from 'lucide-solid/icons/arrow-up-right'
`
    )
    const calendarPlugin = selectiveUiSourcePlugin(join(fixture.root, 'apps/web'), {
      checkLucideDevShim: true,
    })
    await expect(resolvePluginConfig(calendarPlugin, 'serve', fixture.resolveId)).rejects.toThrow(
      /components\/ui\/calendar\/calendar\.tsx: Calendar/
    )
  })

  test('fails closed when a reached shared UI module uses an opaque Lucide namespace', async () => {
    const fixture = makeFixture(`import { Button } from '@adea-ai/ui'
export const control = Button
`)
    write(
      fixture.uiRoot,
      'src/components/ui/button/button.tsx',
      `import * as Icons from 'lucide-solid'
export function Button() { return Object.values(Icons) }
`
    )

    await expect(
      collectUiSourceGraph({
        entrypoint: fixture.entrypoint,
        repositoryRoot: fixture.root,
        uiPackageRoot: fixture.uiRoot,
        uiSourceRoot: fixture.uiSourceRoot,
        resolveId: fixture.resolveId,
      })
    ).rejects.toThrow(/opaque or namespace runtime import of 'lucide-solid'/)
  })

  test('preflights literal lazy shared UI imports without loading them', async () => {
    const fixture = makeFixture("void import('@adea-ai/ui/components/ui/calendar')\n")
    write(
      fixture.uiRoot,
      'src/components/ui/calendar/index.ts',
      "export { Calendar } from './calendar'\n"
    )
    const calendarPath = realpathSync(
      write(
        fixture.uiRoot,
        'src/components/ui/calendar/calendar.tsx',
        [
          "import { Calendar as CalendarIcon } from 'lucide-solid'",
          'export function Calendar() { return CalendarIcon }',
          '',
        ].join('\n')
      )
    )

    const graph = await collectUiSourceGraph({
      entrypoint: fixture.entrypoint,
      repositoryRoot: fixture.root,
      uiPackageRoot: fixture.uiRoot,
      uiSourceRoot: fixture.uiSourceRoot,
      resolveId: fixture.resolveId,
    })

    expect(graph.uiSourceFiles).toContain(calendarPath)
    expect(graph.devLucideImports).toEqual([{ file: calendarPath, names: ['Calendar'] }])
  })

  test('preflights Lucide icons from a lazy app import of shared PropertyList', async () => {
    const fixture = makeFixture('export const clientReady = true\n')
    write(
      fixture.uiRoot,
      'src/index.ts',
      "export { PropertyList, Stat } from './components/composites/stat'\n"
    )
    write(
      fixture.uiRoot,
      'src/components/composites/stat/index.ts',
      "export { PropertyList, Stat } from './stat'\n"
    )
    const statPath = realpathSync(
      write(
        fixture.uiRoot,
        'src/components/composites/stat/stat.tsx',
        [
          "import { ArrowDownRight as Down, ArrowUpRight as Up } from 'lucide-solid'",
          'export function PropertyList() { return null }',
          'export function Stat() { return [Down, Up] }',
          '',
        ].join('\n')
      )
    )
    const lazyEntry = write(
      fixture.root,
      'apps/web/src/start/client.tsx',
      "void import('@adea-ai/ui').then(({ PropertyList }) => PropertyList)\n"
    )
    write(fixture.root, 'apps/web/src/start/router.tsx', 'export const routeReady = true\n')
    write(
      fixture.root,
      'apps/web/start/lucide-solid-dev-shim.jsx',
      "export { default as ArrowUpRight } from 'lucide-solid/icons/arrow-up-right'\n"
    )

    const graph = await collectUiSourceGraph({
      entrypoint: lazyEntry,
      repositoryRoot: fixture.root,
      uiPackageRoot: fixture.uiRoot,
      uiSourceRoot: fixture.uiSourceRoot,
      resolveId: fixture.resolveId,
    })
    expect(graph.devLucideImports).toEqual([
      { file: statPath, names: ['ArrowDownRight', 'ArrowUpRight'] },
    ])

    const plugin = selectiveUiSourcePlugin(join(fixture.root, 'apps/web'), {
      checkLucideDevShim: true,
    })
    await expect(resolvePluginConfig(plugin, 'serve', fixture.resolveId)).rejects.toThrow(
      /components\/composites\/stat\/stat\.tsx: ArrowDownRight/
    )
  })
})
