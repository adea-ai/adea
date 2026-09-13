import { fileURLToPath } from 'node:url'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/postcss'
import { forbiddenClientModule, PUBLIC_ENV_NAMES } from './start/client-policy.mjs'

const root = fileURLToPath(new URL('.', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/')

function protectClientGraph(): Plugin {
  return {
    name: 'adea-start-client-boundary',
    apply: 'build',
    configResolved() {
      rmSync(new URL('./dist/.checks/client-modules.json', import.meta.url), { force: true })
    },
    generateBundle(_options, bundle) {
      if (this.environment.name !== 'client') return
      const modules = new Set<string>()
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue
        for (const id of Object.keys(output.modules)) {
          if (forbiddenClientModule(id))
            this.error(`Server-only or framework-server module in client: ${id}`)
          // Keep portable evidence, not absolute build-machine paths.
          modules.add(
            id
              .replaceAll('\\', '/')
              .replace(repositoryRoot, '<repository>/')
              .replace(/^.*\/node_modules\//, '<dependencies>/')
          )
        }
      }
      mkdirSync(new URL('./dist/.checks/', import.meta.url), { recursive: true })
      writeFileSync(
        new URL('./dist/.checks/client-modules.json', import.meta.url),
        JSON.stringify([...modules].toSorted())
      )
    },
  }
}

export default defineConfig({
  root,
  // No automatic environment-variable prefixes: public values are enumerated below.
  envPrefix: [],
  publicDir: 'public',
  server: { host: '127.0.0.1', port: Number(process.env.PORT ?? 3000), strictPort: false },
  resolve: {
    dedupe: ['react', 'react-dom'],
    // `server-only` throws from its default entry; only Next's react-server
    // condition resolves it to an empty module, so the Workers SSR build would
    // crash at startup. Import specifiers stay in place as documentation, and
    // the real protection is the build-time client boundary check, which
    // rejects server modules from browser bundles outright.
    alias: [
      {
        find: /^server-only$/,
        replacement: fileURLToPath(new URL('./src/start/server-only-shim.mjs', import.meta.url)),
      },
    ],
  },
  // Never stringify process.env or expose server credentials through VITE_*.
  // Read only explicitly allowlisted, already-public variables supplied by CI.
  // The desktop cloud origin is deliberately empty here: the deployed web app
  // must never read it (the desktop runtime is the only consumer, and the
  // desktop build lane injects the approved value in vite.desktop.config.ts).
  define: {
    ...Object.fromEntries(
      PUBLIC_ENV_NAMES.map((key) => [
        `process.env.${key}`,
        JSON.stringify(process.env[key]) ?? 'undefined',
      ])
    ),
    __ADEA_DESKTOP_CLOUD_ORIGIN__: JSON.stringify(''),
  },
  css: { postcss: { plugins: [tailwindcss()] } },
  build: { assetsDir: 'start-assets', sourcemap: false },
  plugins: [
    // The plugin reads the deployment config so the manifest it generates and
    // the `.wrangler/deploy/config.json` redirect it writes both carry the
    // production Worker name, bindings, and asset settings. `main` is ignored
    // during dev; the plugin supplies the Start entry itself.
    cloudflare({
      configPath: fileURLToPath(new URL('./wrangler.jsonc', import.meta.url)),
      viteEnvironment: { name: 'ssr' },
      persistState: { path: fileURLToPath(new URL('./.wrangler/state', import.meta.url)) },
      remoteBindings: false,
    }),
    tanstackStart({ srcDirectory: './src/start' }),
    viteReact(),
    protectClientGraph(),
  ],
})
