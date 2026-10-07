import { bindings, defineConfig } from 'cf/config'

// Deploy source of truth for `cf deploy --prebuilt`. The Vite plugin keeps
// reading wrangler.jsonc at build time (configPath); the emitted
// dist/server redirect is only used by the legacy wrangler path.
//
// Every hosted value the Worker reads from `process.env` MUST be declared
// here: this config replaces the whole binding set on each deploy, so a
// value that only exists as a dashboard secret silently disappears on the
// next `cf deploy`. That is how the 2026-10-01 migration lost the Control
// Plane proxy configuration and took the Plugins marketplace down with it.
// The Secrets Store (`control-plane-neon`) is the source of truth for
// secret values (see CLOUDFLARE.md); plain identifiers stay in `text`
// bindings because they are not secrets.
const controlPlaneStore = 'b3a1b4e8427a4d23ac7925cc18a7a2ac'

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
      // Marketplace proxy: production Control Plane (Railway).
      CONTROL_PLANE_ORIGIN: bindings.text(
        'https://control-planecontrol-api-production.up.railway.app'
      ),
      // Per-request signer (ADR 0013, docs/control-plane-credentials.md).
      // The issuer must equal the Control Plane's
      // CONTROL_PLANE_SERVICE_AUTH_ISSUER. Mirrored in wrangler.jsonc.
      CONTROL_PLANE_SIGNING_KEY: bindings.secretsStoreSecret({
        storeId: controlPlaneStore,
        secretName: 'ADEA_CONTROL_PLANE_SIGNING_KEY',
      }),
      CONTROL_PLANE_SIGNING_KEY_ID: bindings.text('adea-web-signer-2026-10'),
      CONTROL_PLANE_SIGNING_ISSUER: bindings.text('https://m9-certification.control-plane.invalid'),
      // Neon production branch, pooled owner role (Worker fallback for the
      // Hyperdrive connection) and the Neon Auth endpoint it pairs with.
      DATABASE_URL: bindings.secretsStoreSecret({
        storeId: controlPlaneStore,
        secretName: 'AGENT_HQ_NEON_PRODUCTION_DATABASE_URL',
      }),
      NEON_AUTH_BASE_URL: bindings.secretsStoreSecret({
        storeId: controlPlaneStore,
        secretName: 'AGENT_HQ_NEON_PRODUCTION_AUTH_BASE_URL',
      }),
      // Rotating the cookie secret invalidates every Worker session.
      NEON_AUTH_COOKIE_SECRET: bindings.secretsStoreSecret({
        storeId: controlPlaneStore,
        secretName: 'AGENT_HQ_WORKER_AUTH_COOKIE_SECRET',
      }),
      // Public origins allowed to talk to the auth endpoints.
      AUTH_TRUSTED_ORIGINS: bindings.secretsStoreSecret({
        storeId: controlPlaneStore,
        secretName: 'AGENT_HQ_WORKER_AUTH_TRUSTED_ORIGINS',
      }),
    },
  },
})
