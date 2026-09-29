import { bindings, defineConfig } from 'cf/config'

// Deploy source of truth for `cf deploy --prebuilt`. The Vite plugin keeps
// reading wrangler.jsonc at build time (configPath); the emitted
// dist/server redirect is only used by the legacy wrangler path.
export default defineConfig({
  accountId: 'aa2dc82d7e02aff12b77800a8201df3f',
  worker: {
    name: 'adea-web',
    compatibilityDate: '2026-08-01',
    compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
    entrypoint: 'dist/server/index.js',
    workersDev: true,
    observability: {
      enabled: true,
      headSamplingRate: 1,
    },
    assets: {
      notFoundHandling: 'none',
      runWorkerFirst: ['/api/*'],
    },
    env: {
      ASSETS: bindings.assets(),
      HYPERDRIVE: bindings.hyperdrive({ id: '5faad934a0a14a29bbb4780ca2f53fa6' }),
    },
  },
})
