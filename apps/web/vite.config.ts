import { fileURLToPath } from 'node:url'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import { tanstackStart } from '@tanstack/solid-start/plugin/vite'
import viteSolid from 'vite-plugin-solid'
import tailwindcss from '@tailwindcss/postcss'
import { forbiddenClientModule, PUBLIC_ENV_NAMES } from './start/client-policy.mjs'

const root = fileURLToPath(new URL('.', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/')

/**
 * Dev-only alias for the bare `lucide-solid` specifier. The package's barrel
 * statically imports the whole icon catalogue, so the default resolution
 * (through the `solid` condition to the source tree) floods dev: ~2,100 icon
 * requests per fresh browser context (7-10s hydration minimum, 30-120s cold
 * server transforms) and a ~1,900-module SSR graph compiled on first render.
 * Pre-bundling is not an option: vite's optimizer cannot compile Solid JSX,
 * and a client-compiled artifact cannot be mixed with the SSR render anyway
 * (hydration then throws "Failed attempt to create new DOM elements during
 * hydration").
 *
 * `start/lucide-solid-dev-shim.jsx` re-exports exactly the icons the client
 * graph imports, as deep imports. Both dev environments go through it, so
 * they compile the same source modules (hydration matches) and only those
 * modules enter the graph. The `.jsx` extension is deliberate: it keeps the
 * shim outside vite's optimizable-entry set, so no optimizeDeps include or
 * discovery can pre-bundle it. The production build never sees the alias: it
 * keeps resolving the `solid` condition directly and tree-shakes the barrel
 * as before. The shim is held in lock-step with the sources by
 * scripts/lucide-dev-shim.test.ts.
 */
function lucideDevShimAlias() {
  return {
    find: /^lucide-solid$/,
    replacement: fileURLToPath(new URL('./start/lucide-solid-dev-shim.jsx', import.meta.url)),
  }
}

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

// better-auth pulls `z` in wholesale, and zod v4's barrel re-exports ~1.2MB of
// per-language error catalogues via `export * as locales` — dead weight the
// namespace import makes un-shakeable. Nothing configures a non-English
// locale, so the barrel serves only `en` and the other ~50 locale modules
// leave the module graph entirely.
function trimZodLocales(): Plugin {
  return {
    name: 'adea-trim-zod-locales',
    enforce: 'pre',
    load(id) {
      if (!id.replaceAll('\\', '/').endsWith('/zod/v4/locales/index.js')) return null
      return 'export { default as en } from "./en.js"'
    },
  }
}

export default defineConfig(({ command }) => ({
  root,
  // No automatic environment-variable prefixes: public values are enumerated below.
  envPrefix: [],
  publicDir: 'public',
  server: { host: '127.0.0.1', port: Number(process.env.PORT ?? 3000), strictPort: false },
  resolve: {
    dedupe: ['solid-js'],
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
      // Dev-only: route lucide-solid through the curated dev shim (see
      // lucideDevShimAlias above). The production build keeps the `solid`
      // condition so build output is unchanged.
      ...(command === 'serve' ? [lucideDevShimAlias()] : []),
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
    viteSolid({ ssr: true }),
    trimZodLocales(),
    protectClientGraph(),
  ],
}))
