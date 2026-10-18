import { fileURLToPath } from 'node:url'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import { tanstackStart } from '@tanstack/solid-start/plugin/vite'
import tailwindcss from '@tailwindcss/postcss'
import { forbiddenClientModule, PUBLIC_ENV_NAMES } from './start/client-policy.mjs'
import { selectiveUiSourcePlugin } from './start/ui-tailwind-sources'
import { publicFontAssetDirectories } from './start/public-font-assets'
import { solidPlugins } from './start/solid-compile'
import { authZodLite } from '@adea-ai/auth/vite-client-bundle'

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
 * `start/lucide-solid-dev-shim.jsx` re-exports the icon names required by the
 * statically linked app and shared-UI modules, as deep imports. Vite serves the
 * package as ESM, so a root-barrel import links all static re-exports even when
 * the app selects one public name. Literal dynamic imports are preflighted but
 * never loaded or executed by the check. Both dev environments use the same
 * shim, so they compile the same source modules (hydration matches). The `.jsx` extension keeps the shim outside vite's
 * optimizable-entry set, so no optimizeDeps include or discovery can pre-bundle
 * it. The production build never sees the alias: it keeps resolving the `solid`
 * condition directly and tree-shakes the barrel as before. The shim is held in
 * lock-step with the sources by `scripts/lucide-dev-shim.test.ts`.
 */
function lucideDevShimAlias() {
  return {
    find: /^lucide-solid$/,
    replacement: fileURLToPath(new URL('./start/lucide-solid-dev-shim.jsx', import.meta.url)),
  }
}

// Each exact-path cohort had the same static reachability from all original
// client/auth/workspace entry roots. Keep bootstrap separate from workspace
// data/state: a workspace-union comparison alone cannot establish that boundary.
// Dependencies are never included recursively; requalify individual entries
// and actual auth/guest requests when changing these pinned module cohorts.
const entryFoundationGroups = [
  {
    name: 'boot',
    modules: [
      /\/apps\/web\/src\/lib\/desktop-bridge\.ts$/,
      /\/apps\/web\/src\/start\/(?:client\.tsx|routeTree\.gen\.ts|router\.tsx|search-codec\.mjs)$/,
      /\/apps\/web\/src\/start\/routes\/(?:__root\.tsx|index\.tsx|invite\.tsx)$/,
      /\/apps\/web\/src\/start\/routes\/auth\/sign-in\.tsx$/,
      /\/apps\/web\/src\/start\/routes\/auth\/desktop\/complete\.tsx$/,
      /\/node_modules\/@adea-ai\/ui\/src\/components\/ui\/text-link\/text-link\.tsx$/,
      /\/node_modules\/@adea-ai\/ui\/src\/components\/ui\/typography\/typography\.tsx$/,
      /\/node_modules\/@solidjs\/meta\/dist\/index\.jsx$/,
      /\/node_modules\/@tanstack\/history\/dist\/esm\/index\.js$/,
      /\/node_modules\/@tanstack\/router-core\/dist\/esm\/(?:invariant\.js|link\.js|load-client\.js|new-process-route-tree\.js|not-found\.js|path\.js|qss\.js|redirect\.js|rewrite\.js|root\.js|route\.js|router\.js|scroll-restoration\.js|searchParams\.js|sieve-cache\.js|stores\.js|utils\.js)$/,
      /\/node_modules\/@tanstack\/router-core\/dist\/esm\/scroll-restoration-script\/client\.js$/,
      /\/node_modules\/@tanstack\/router-core\/dist\/esm\/ssr\/(?:bodyScripts\.js|ssr-match-id\.js)$/,
      /\/node_modules\/@tanstack\/router-core\/dist\/esm\/ssr\/serializer\/(?:RawStream\.js|RawStreamJSONPlugin\.js|RawStreamRPCPlugin\.js|ShallowErrorPlugin\.js|makeSerovalPlugin\.js|rawStreamCodec\.js|seroval-plugins\.js|transformer\.js)$/,
      /\/node_modules\/@tanstack\/solid-router\/dist\/source\/(?:Asset\.jsx|CatchBoundary\.jsx|ClientOnly\.jsx|Match\.jsx|Matches\.jsx|RouterProvider\.jsx|SafeFragment\.jsx|ScriptOnce\.jsx|Scripts\.jsx|Transitioner\.jsx|fileRoute\.js|lazyRouteComponent\.jsx|link\.jsx|matchContext\.jsx|not-found\.jsx|renderRouteNotFound\.jsx|route\.jsx|router\.js|routerContext\.jsx|routerStores\.js|scroll-restoration\.jsx|useLoaderData\.jsx|useLoaderDeps\.jsx|useMatch\.jsx|useNavigate\.jsx|useParams\.jsx|useRouteContext\.js|useRouter\.jsx|useSearch\.jsx|utils\.js)$/,
      /\/node_modules\/@tanstack\/solid-start-client\/dist\/esm\/(?:StartClient\.js|hydrateStart\.js)$/,
      /\/node_modules\/@tanstack\/start-client-core\/dist\/esm\/(?:constants\.js|empty-plugin-adapters\.js|getDefaultSerovalPlugins\.js|getStartOptions\.js)$/,
      /\/node_modules\/@tanstack\/start-client-core\/dist\/esm\/client\/(?:ServerFunctionSerializationAdapter\.js|hydrateStart\.js)$/,
      /\/node_modules\/@tanstack\/start-client-core\/dist\/esm\/client-rpc\/(?:createClientRpc\.js|frame-decoder\.js|serverFnFetcher\.js)$/,
      /\/node_modules\/seroval-plugins\/dist\/web-CDQeyEaf\.js$/,
      /\/node_modules\/seroval\/dist\/index\.js$/,
      /\/packages\/spatial\/dist\/(?:index\.js|manifests\.js|telemetry\.js)$/,
    ],
  },
  {
    name: 'tooltip',
    modules: [
      /\/node_modules\/@adea-ai\/ui\/src\/components\/ui\/tooltip\/tooltip\.tsx$/,
      /\/node_modules\/@adea-ai\/ui\/src\/lib\/(?:overlay\.ts|tooltip-focus-gate\.ts)$/,
      /\/node_modules\/@corvu\/utils\/dist\/chunk\/U42ECMND\.jsx$/,
      /\/node_modules\/@floating-ui\/core\/dist\/floating-ui\.core\.mjs$/,
      /\/node_modules\/@floating-ui\/dom\/dist\/floating-ui\.dom\.mjs$/,
      /\/node_modules\/@floating-ui\/utils\/dist\/(?:floating-ui\.utils\.dom\.mjs|floating-ui\.utils\.mjs)$/,
      /\/node_modules\/@internationalized\/number\/dist\/private\/NumberFormatter\.mjs$/,
      /\/node_modules\/@kobalte\/core\/dist\/chunk\/(?:3DLZMX4Z\.jsx|5WXHJDCZ\.jsx|AAA75RJW\.jsx|E53DB7BS\.jsx|FN6EICGO\.jsx|IARUYOQZ\.jsx|IGYOA2ZZ\.jsx|JNCCF6MP\.jsx|LP6E37CW\.jsx|OGE3DKII\.jsx|V3Y2TT5R\.jsx)$/,
      /\/node_modules\/@kobalte\/utils\/dist\/index\.js$/,
      /\/node_modules\/@solid-primitives\/props\/dist\/combineProps\.js$/,
      /\/node_modules\/solid-presence\/dist\/index\.jsx$/,
    ],
  },
  {
    name: 'theme',
    modules: [
      /\/node_modules\/@adea-ai\/themes\/dist\/(?:accents\.js|derive\.js|oklch\.js|policy\.js|schema\.js)$/,
      /\/node_modules\/@adea-ai\/themes\/dist\/adapters\/shadcn\.js$/,
      /\/node_modules\/@adea-ai\/ui\/src\/lib\/(?:accent-roles\.ts|theme-accents\.ts|theme-css\.ts|theme-defaults\.generated\.ts|theme-defaults\.ts|theme-records\.ts)$/,
    ],
  },
  {
    name: 'mount',
    modules: [
      /\/apps\/web\/src\/components\/workspace-entry\.tsx$/,
      /\/apps\/web\/src\/start\/(?:workspace-mount\.tsx|workspace-selection\.mjs)$/,
      /\/node_modules\/@adea-ai\/ui\/src\/components\/theme\/(?:theme-catalogue-source\.ts|theme-context\.ts|theme-document-core\.ts|theme-persistence\.ts|theme-provider-core\.tsx|theme-provider-lazy\.tsx|theme-provider-value\.ts|theme-state-core\.ts)$/,
      /\/node_modules\/@adea-ai\/ui\/src\/lib\/(?:accent-presets\.ts|appearance-font-settings\.ts|font-catalog\.ts|font-zoom\.ts|preference-store\.ts|theme-engine-light\.ts|theme-engine\.ts|theme-surface\.ts)$/,
      /\/node_modules\/lucide-solid\/dist\/source\/icons\/(?:music-2\.jsx|music\.jsx)$/,
      /\/packages\/app-core\/dist\/workspace-scene\.js$/,
      /\/packages\/audio\/src\/(?:config\.ts|controller\.ts|sound\.tsx)$/,
      /\/packages\/spatial\/dist\/scene-spawn\.js$/,
      /\/packages\/ui\/src\/components\/(?:appearance-codec\.ts|appearance-host\.tsx|custom-theme-library\.ts)$/,
      /\/packages\/workspace-ui\/src\/(?:rail-preferences\.ts|workspace-apps\.ts)$/,
    ],
  },
] as const

function protectClientGraph(): Plugin {
  return {
    name: 'adea-start-client-boundary',
    apply: 'build',
    configResolved() {
      rmSync(new URL('./dist/.checks/client-modules.json', import.meta.url), { force: true })
      rmSync(new URL('./dist/.checks/client-rendered-modules.json', import.meta.url), {
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
      mkdirSync(new URL('./dist/.checks/', import.meta.url), { recursive: true })
      writeFileSync(
        new URL('./dist/.checks/client-modules.json', import.meta.url),
        JSON.stringify([...modules].toSorted())
      )
      writeFileSync(
        new URL('./dist/.checks/client-rendered-modules.json', import.meta.url),
        JSON.stringify([...renderedModules].toSorted())
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
  environments: {
    ssr: {
      // Published Solid source must pass through viteSolid's SSR transform.
      // The dependency optimizer otherwise lowers JSX with React's runtime.
      optimizeDeps: { exclude: ['@adea-ai/ui'] },
    },
    client: {
      build: {
        rolldownOptions: {
          output: {
            codeSplitting: {
              // These small shared navigation glyphs otherwise each cost a
              // request. Leave feature components and their dependencies to
              // automatic splitting instead of grouping a whole icon catalogue.
              groups: [
                ...entryFoundationGroups.map(({ name, modules }) => ({
                  name,
                  priority: 100,
                  test: (id: string) =>
                    modules.some((pattern) => pattern.test(id.replaceAll('\\', '/'))),
                  includeDependenciesRecursively: false,
                })),
                {
                  name: 'lazy-ui',
                  test: /@adea-ai\/ui\/src\/components\/ui\/(label\/label|skeleton\/skeleton|status-chip\/status-chip|badge\/badge|empty\/empty)\.tsx$/,
                  includeDependenciesRecursively: false,
                  minShareCount: 2,
                },
                // Keep the lean browser envelope/CBOR helpers together. The public
                // wire facade also re-exports complete admission; leave that
                // facade outside this group so its cold dependencies stay lazy.
                {
                  name: 'dev-runtime-contract',
                  test: /packages\/types\/dist\/dev-runtime-(browser|cbor|envelope|event-kinds|follow-up-event|unicode|usage|cbor-length|validation-internal)\.js$/,
                  includeDependenciesRecursively: false,
                },
                // The contextual host and its lazy panes share this small command
                // helper and lazy status models. Co-locate their wrappers without hoisting
                // eager context or runtime decoder dependencies across boundaries.
                {
                  name: 'utility-host',
                  test: /packages\/dev-view\/src\/(?:utility-(?:host\.tsx|command\.ts)|agents\/harness-status-model\.ts|files\/status-cache\.ts)$/,
                  includeDependenciesRecursively: false,
                },
                // The shared appearance editor reaches Kobalte's radio internals
                // directly, which would otherwise split them from the radio
                // group into a second request for the same panel.
                {
                  name: 'radio-group',
                  test: /(@kobalte\/core\/dist\/chunk\/H7BK6JF7\.jsx|@adea-ai\/ui\/src\/components\/ui\/radio-group\/radio-group\.tsx)$/,
                  includeDependenciesRecursively: false,
                },
                // arrow-down, plus and sliders-horizontal are imported by the
                // startup entries and by terminal, App Library and Chat code;
                // left alone each is a request of a few hundred bytes. Folding
                // them into this startup-loaded group frees three files for the
                // lazy terminal addon chunks without moving any bytes out of
                // the measured graphs.
                {
                  name: 'nav',
                  test: /lucide-solid\/dist\/source\/icons\/(check|chevron-down|chevron-right|chevron-up|square|arrow-left|arrow-right|arrow-down|plus|sliders-horizontal)\.jsx$/,
                  minShareCount: 2,
                },
                {
                  name: 'shared-lazy-icons',
                  test: /lucide-solid\/dist\/source\/icons\/(archive|arrow-up|book-open|bot|download|external-link|file-text|message-square|lock-keyhole|mic|pencil|play|rotate-ccw|square-terminal|upload)\.jsx$/,
                  minShareCount: 2,
                },
                // Two single-glyph chunks that only lazy panes import
                // (Appearance, Plugins, Settings and Source control). Each is
                // otherwise its own request; grouped, neither reaches a route's
                // static graph or grows the Dev utility panes closure. Disjoint
                // from the startup group above.
                {
                  name: 'shared-pane-icons',
                  test: /lucide-solid\/dist\/source\/icons\/(eye-off|shield-check)\.jsx$/,
                  minShareCount: 2,
                },
              ],
            },
          },
        },
      },
    },
  },
  publicDir: 'public',
  server: {
    host: '127.0.0.1',
    port: Number(process.env.PORT ?? 3000),
    strictPort: false,
    // Linked dependency assets may live outside the workspace. Grant only the
    // four public font asset directories, never the package manager cache.
    fs: {
      strict: true,
      allow: [repositoryRoot, ...(command === 'serve' ? publicFontAssetDirectories() : [])],
    },
  },
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
    __ADEA_DESKTOP_COMPONENTS__: JSON.stringify(command === 'serve'),
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
    ...solidPlugins(),
    trimZodLocales(),
    authZodLite(),
    // The same reachable source graph checks the curated dev shim before the
    // web server starts, and again when source or shim files change.
    selectiveUiSourcePlugin(root, { checkLucideDevShim: true }),
    protectClientGraph(),
  ],
}))
