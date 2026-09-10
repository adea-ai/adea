import { fileURLToPath } from 'node:url'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/postcss'
import { forbiddenClientModule, PUBLIC_ENV_NAMES } from './client-policy.mjs'

const root = fileURLToPath(new URL('.', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url)).replaceAll('\\', '/')

function protectClientGraph(): Plugin {
  return {
    name: 'adea-start-preview-client-boundary',
    apply: 'build',
    configResolved() {
      rmSync(new URL('./.checks/client-modules.json', import.meta.url), { force: true })
    },
    generateBundle(_options, bundle) {
      if (this.environment.name !== 'client') return
      const modules = new Set<string>()
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue
        for (const id of Object.keys(output.modules)) {
          if (forbiddenClientModule(id)) this.error(`Server-only or Next runtime in client: ${id}`)
          // Keep portable evidence, not absolute build-machine paths.
          modules.add(
            id
              .replaceAll('\\', '/')
              .replace(repositoryRoot, '<repository>/')
              .replace(/^.*\/node_modules\//, '<dependencies>/')
          )
        }
      }
      mkdirSync(new URL('./.checks/', import.meta.url), { recursive: true })
      writeFileSync(
        new URL('./.checks/client-modules.json', import.meta.url),
        JSON.stringify([...modules].toSorted())
      )
    },
  }
}

export default defineConfig({
  // Isolate .wrangler/deploy metadata as well as the Vite output. A preview
  // build must not change what the existing Next deployment commands target.
  root,
  // No automatic environment-variable prefixes: public values are enumerated below.
  envPrefix: [],
  publicDir: '../public',
  cacheDir: './node_modules/.vite',
  server: { host: '127.0.0.1', port: 3104, strictPort: true },
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      {
        find: /^next\/dynamic$/,
        replacement: fileURLToPath(
          new URL('../src/start-preview/lazy-component.tsx', import.meta.url)
        ),
      },
    ],
  },
  // Never stringify process.env or expose server credentials through VITE_*.
  // Read only explicitly allowlisted, already-public variables supplied by CI.
  define: Object.fromEntries(
    PUBLIC_ENV_NAMES.map((key) => [
      `process.env.${key}`,
      JSON.stringify(process.env[key]) ?? 'undefined',
    ])
  ),
  css: { postcss: { plugins: [tailwindcss()] } },
  build: { assetsDir: 'start-assets', sourcemap: false },
  plugins: [
    cloudflare({
      configPath: fileURLToPath(new URL('./wrangler.jsonc', import.meta.url)),
      viteEnvironment: { name: 'ssr' },
      persistState: { path: fileURLToPath(new URL('./.wrangler/state', import.meta.url)) },
      remoteBindings: false,
    }),
    tanstackStart({ srcDirectory: '../src/start-preview' }),
    viteReact(),
    protectClientGraph(),
  ],
})
