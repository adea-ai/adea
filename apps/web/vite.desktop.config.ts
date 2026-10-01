import { fileURLToPath } from 'node:url'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'
import { tanstackStart } from '@tanstack/solid-start/plugin/vite'
import viteSolid from 'vite-plugin-solid'
import tailwindcss from '@tailwindcss/postcss'
import { forbiddenClientModule, PUBLIC_ENV_NAMES } from './start/client-policy.mjs'
import { selectiveUiSourcePlugin } from './start/ui-tailwind-sources'

const root = fileURLToPath(new URL('.', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/')

function protectClientGraph(): Plugin {
  return {
    name: 'adea-start-client-boundary',
    apply: 'build',
    configResolved() {
      rmSync(new URL('./dist-desktop/.checks/client-modules.json', import.meta.url), {
        force: true,
      })
      rmSync(new URL('./dist-desktop/.checks/client-rendered-modules.json', import.meta.url), {
        force: true,
      })
    },
    generateBundle(_options, bundle) {
      if (this.environment.name !== 'client') return
      const modules = new Set<string>()
      const renderedModules = new Set<string>()
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue
        for (const [id, module] of Object.entries(output.modules)) {
          if (forbiddenClientModule(id))
            this.error(`Server-only or framework-server module in client: ${id}`)
          // Keep portable evidence, not absolute build-machine paths.
          const portableId = id
            .replaceAll('\\', '/')
            .replace(repositoryRoot, '<repository>/')
            .replace(/^.*\/node_modules\//, '<dependencies>/')
          modules.add(portableId)
          // Rolldown also records wholly tree-shaken modules with zero bytes.
          if (module.renderedLength > 0) renderedModules.add(portableId)
        }
      }
      mkdirSync(new URL('./dist-desktop/.checks/', import.meta.url), { recursive: true })
      writeFileSync(
        new URL('./dist-desktop/.checks/client-modules.json', import.meta.url),
        JSON.stringify([...modules].toSorted())
      )
      writeFileSync(
        new URL('./dist-desktop/.checks/client-rendered-modules.json', import.meta.url),
        JSON.stringify([...renderedModules].toSorted())
      )
    },
  }
}

/**
 * Desktop build of the single UI. The shell serves this static TanStack Start
 * SPA output from loopback (`http://127.0.0.1:4789`), which is the trusted
 * desktop origin. It is the same source, styles, and router as the deployed web
 * app. The desktop build retains native workspace components and supplies the
 * cloud origin constant used for its API base and session broker.
 *
 * `ADEA_DESKTOP_CLOUD_ORIGIN` is required: `apps/desktop/scripts/client.mjs`
 * validates it from the canonical `cloud-config.mjs` before invoking this
 * config, so no build can silently bake an unapproved origin.
 */
export default defineConfig(({ mode }) => {
  const cloudOrigin = process.env.ADEA_DESKTOP_CLOUD_ORIGIN ?? ''
  if (mode === 'production' && !cloudOrigin) {
    throw new Error(
      'ADEA_DESKTOP_CLOUD_ORIGIN is required for the desktop client build (run it through apps/desktop)'
    )
  }
  return {
    root,
    // No automatic environment-variable prefixes: public values are enumerated below.
    envPrefix: [],
    publicDir: 'public',
    // The Cloudflare plugin externalizes `ssr` dependencies; without it the
    // prerender environment has to bundle them itself (the same `noExternal`
    // setting that plugin applies), or CSS `@import` resolution fails.
    ssr: { noExternal: true },
    resolve: {
      dedupe: ['solid-js'],
      alias: [
        {
          find: /^server-only$/,
          replacement: fileURLToPath(new URL('./src/start/server-only-shim.mjs', import.meta.url)),
        },
      ],
    },
    define: {
      ...Object.fromEntries(
        PUBLIC_ENV_NAMES.map((key) => [
          `process.env.${key}`,
          JSON.stringify(process.env[key]) ?? 'undefined',
        ])
      ),
      __ADEA_DESKTOP_CLOUD_ORIGIN__: JSON.stringify(cloudOrigin),
      __ADEA_DESKTOP_COMPONENTS__: true,
    },
    css: { postcss: { plugins: [tailwindcss()] } },
    build: {
      outDir: 'dist-desktop',
      assetsDir: 'start-assets',
      sourcemap: false,
      emptyOutDir: true,
    },
    plugins: [
      // SPA mode prerenders the static shell the shell's local server serves;
      // the router hydrates it client-side with no server runtime.
      tanstackStart({
        srcDirectory: './src/start',
        spa: { enabled: true, maskPath: '/', prerender: { enabled: true, outputPath: '/index' } },
      }),
      viteSolid({ ssr: true }),
      selectiveUiSourcePlugin(root),
      protectClientGraph(),
    ],
  }
})
