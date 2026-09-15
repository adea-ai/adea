import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')

function manifest(path: string) {
  return JSON.parse(readFileSync(resolve(root, path), 'utf8')) as {
    scripts?: Record<string, string>
    devDependencies?: Record<string, string>
  }
}

function workspaceManifests() {
  const paths: string[] = []
  for (const group of ['apps', 'packages']) {
    for (const entry of readdirSync(resolve(root, group), { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        paths.push(`${group}/${entry.name}/package.json`)
      }
    }
  }
  return paths
}

// Decision 0008 (docs/decisions/0008-build-bundler-vite-vs-bun.md) settled the
// build and bundler question by measurement: Vite 8 (Rolldown) for the app and
// library builds, `tsc` for declarations and type-only packages, Turborepo for
// task caching. Bun keeps install, scripts, tests, and the Electrobun shell; its
// bundler was rejected on every surface. These assertions keep a second,
// dormant build path from reappearing next to the shipping one.
describe('build and bundler boundary', () => {
  test('compiles the Solid library packages with Vite and declares them with tsc', () => {
    for (const name of ['ui', 'workspace-ui', 'audio', 'data', 'dev-view']) {
      const pkg = manifest(`packages/${name}/package.json`)
      expect(pkg.scripts?.build).toBe('vite build && tsc -p tsconfig.json --emitDeclarationOnly')
      expect(pkg.scripts?.dev).toBe('vite build --watch')
      expect(pkg.devDependencies?.vite).toBeDefined()
      expect(pkg.devDependencies?.['vite-plugin-solid']).toBeDefined()

      const viteConfig = readFileSync(resolve(root, `packages/${name}/vite.config.ts`), 'utf8')
      expect(viteConfig).toContain("from 'vite-plugin-solid'")
      // The published tree mirrors `src`; a chunking bundler cannot express it.
      expect(viteConfig).toContain('preserveModules: true')
    }
  })

  test('builds the app and desktop surfaces through the framework Vite pipeline', () => {
    const web = manifest('apps/web/package.json')
    expect(web.scripts?.build).toContain('vite build')
    expect(web.scripts?.['desktop:build']).toContain('vite build --config vite.desktop.config.ts')

    // Both app surfaces are the Start plugin pipeline; the desktop config is
    // the same pipeline in SPA/prerender mode, not a second bundler.
    const serverConfig = readFileSync(resolve(root, 'apps/web/vite.config.ts'), 'utf8')
    expect(serverConfig).toContain("from '@tanstack/solid-start/plugin/vite'")
    expect(serverConfig).toContain("from '@cloudflare/vite-plugin'")
    expect(serverConfig).toContain("from 'vite-plugin-solid'")
    const desktopConfig = readFileSync(resolve(root, 'apps/web/vite.desktop.config.ts'), 'utf8')
    expect(desktopConfig).toContain("from '@tanstack/solid-start/plugin/vite'")
    expect(desktopConfig).toContain('spa:')

    const desktopClient = readFileSync(resolve(root, 'apps/desktop/scripts/client.mjs'), 'utf8')
    expect(desktopClient).toContain("'desktop:build'")
    // The desktop lane validates the cloud origin and invokes the web build.
    expect(desktopClient).not.toContain('bun build')
  })

  test('keeps Bun out of the bundler role across every workspace', () => {
    for (const path of workspaceManifests()) {
      const pkg = manifest(path)
      for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
        expect(`${path}#${name}: ${command}`).not.toMatch(/\bbun build\b/)
      }
    }
    for (const entry of readdirSync(resolve(root, 'scripts'), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue
      const source = readFileSync(resolve(root, 'scripts', entry.name), 'utf8')
      expect(source).not.toContain('Bun.build(')
    }
  })

  test('records the decision next to the stack it governs', () => {
    const decision = readFileSync(
      resolve(root, 'docs/decisions/0008-build-bundler-vite-vs-bun.md'),
      'utf8'
    )
    expect(decision).toContain('Vite 8')
    expect(decision).toContain('Bun')
    expect(decision).toMatch(/rejected configurations/i)
    expect(readFileSync(resolve(root, 'README.md'), 'utf8')).toContain(
      'docs/decisions/0008-build-bundler-vite-vs-bun.md'
    )
  })
})
