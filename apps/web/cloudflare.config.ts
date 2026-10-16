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
const productionHyperdriveId = '5faad934a0a14a29bbb4780ca2f53fa6'
const ACCOUNT_ID = 'aa2dc82d7e02aff12b77800a8201df3f'
const controlPlaneStore = 'b3a1b4e8427a4d23ac7925cc18a7a2ac'

// A Preview build is evaluated with `ctx.isPreview` (cf-wrangler build --mode
// preview with CLOUDFLARE_PREVIEW_BUILD=true). Nothing below swaps bindings by
// itself, so this file does: a Preview Worker runs unreviewed pull-request code
// and must never carry the production Hyperdrive, the production database and
// auth secrets, the cookie secret, or the Control Plane signer. Without the
// explicit preview selection below there is nothing safe to deploy, so the
// build stops (see `previewEnv`): an assets-only Worker answers every API route
// with a 500, and a preview that cannot work must not be reported as one.
type EnvSource = Record<string, string | undefined>

const PREVIEW_SELECTION = {
  hyperdriveId: 'ADEA_PREVIEW_HYPERDRIVE_ID',
  storeId: 'ADEA_PREVIEW_SECRETS_STORE_ID',
  databaseUrl: 'ADEA_PREVIEW_DATABASE_URL_SECRET',
  authBaseUrl: 'ADEA_PREVIEW_AUTH_BASE_URL_SECRET',
  cookieSecret: 'ADEA_PREVIEW_AUTH_COOKIE_SECRET_NAME',
  trustedOrigins: 'ADEA_PREVIEW_AUTH_TRUSTED_ORIGINS_SECRET',
} as const

const productionSecretNames = [
  'AGENT_HQ_NEON_PRODUCTION_DATABASE_URL',
  'AGENT_HQ_NEON_PRODUCTION_AUTH_BASE_URL',
  'AGENT_HQ_WORKER_AUTH_COOKIE_SECRET',
  'AGENT_HQ_WORKER_AUTH_TRUSTED_ORIGINS',
  'ADEA_CONTROL_PLANE_SIGNING_KEY',
]

// A Preview Worker needs dedicated preview resources. The selection is all or
// nothing, and every value must be a preview resource, never a production one.
// With no selection the build fails closed: deploying the production bindings
// would hand pull-request code production data, and deploying assets only would
// publish a "preview" whose API answers 500. Blocking is the truthful result
// until isolated preview resources exist and are selected.
export function previewEnv(source: EnvSource = process.env) {
  const assets = { ASSETS: bindings.assets() }
  const selected = Object.fromEntries(
    Object.entries(PREVIEW_SELECTION).map(([key, name]) => [key, source[name]?.trim() || undefined])
  ) as Record<keyof typeof PREVIEW_SELECTION, string | undefined>
  const present = Object.values(selected).filter(Boolean).length
  if (present === 0) {
    throw new Error(
      'Preview deployment blocked: no isolated preview resources are configured. ' +
        `Select dedicated preview resources with ${Object.values(PREVIEW_SELECTION).join(', ')} ` +
        '(see apps/web/CLOUDFLARE.md); a preview never falls back to production bindings or to an assets-only Worker.'
    )
  }
  if (present !== Object.keys(PREVIEW_SELECTION).length) {
    throw new Error(
      `Preview data bindings are all or nothing: set every one of ${Object.values(PREVIEW_SELECTION).join(', ')} or none`
    )
  }
  const { hyperdriveId, storeId, databaseUrl, authBaseUrl, cookieSecret, trustedOrigins } =
    selected as Record<keyof typeof PREVIEW_SELECTION, string>
  if (hyperdriveId === productionHyperdriveId || storeId === controlPlaneStore) {
    throw new Error('Preview bindings must not use the production Hyperdrive or Secrets Store')
  }
  for (const name of [databaseUrl, authBaseUrl, cookieSecret, trustedOrigins]) {
    if (productionSecretNames.includes(name) || !/preview/i.test(name)) {
      throw new Error(`Preview secret "${name}" must be a dedicated preview secret`)
    }
  }
  const secret = (secretName: string) => bindings.secretsStoreSecret({ storeId, secretName })
  return {
    ...assets,
    HYPERDRIVE: bindings.hyperdrive({ id: hyperdriveId }),
    DATABASE_URL: secret(databaseUrl),
    NEON_AUTH_BASE_URL: secret(authBaseUrl),
    NEON_AUTH_COOKIE_SECRET: secret(cookieSecret),
    AUTH_TRUSTED_ORIGINS: secret(trustedOrigins),
  }
}

export function productionEnv() {
  return {
    ASSETS: bindings.assets(),
    HYPERDRIVE: bindings.hyperdrive({ id: productionHyperdriveId }),
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
  }
}

export default defineConfig(({ isPreview, mode }) => ({
  accountId: ACCOUNT_ID,
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
    env: isPreview || mode === 'preview' ? previewEnv() : productionEnv(),
  },
}))
