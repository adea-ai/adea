# Cloudflare Workers deployment (TanStack Start)

`apps/web` deploys to Cloudflare Workers as a TanStack Start Worker built by
Vite and the [`@cloudflare/vite-plugin`](https://developers.cloudflare.com/workers/vite-plugin/).
Cloudflare Workers is the deployment target.

## Build and deploy commands

```sh
bun run build:cloudflare   # root: frozen install, workspace builds, vite build
wrangler deploy            # from apps/web; uses wrangler.jsonc
```

`build:cloudflare` (`scripts/build-cloudflare.mjs`) installs from the root
lockfile, builds the workspace packages the app depends on, syncs the scene
manifests, and runs `vite build`. The build emits the Worker entry at
`dist/server/index.js` and the browser assets under `dist/client/`; the Vite
plugin also writes an intermediate `dist/server/wrangler.json` that records the
generated paths. The production `wrangler.jsonc` points at those paths, so a
deploy never needs generated filenames hardcoded.

## One-time setup (Worker + GitHub Actions)

1. **Worker name.** `wrangler.jsonc` uses `adea-web` (renamed from
   `agent-hq-web`). Keep dashboard and config in agreement, otherwise CLI
   deploys miss the Git-connected Worker.
2. **GitHub Actions deployment.** The repository-owned
   `.github/workflows/cloudflare-preview.yml` and
   `.github/workflows/cloudflare-production.yml` call the shared Code Foundry
   Cloudflare workflow. Configure these repository secrets:
   - `CLOUDFLARE_API_TOKEN`: scoped to deploy the `adea-web` Worker
   - `CLOUDFLARE_ACCOUNT_ID`: `aa2dc82d7e02aff12b77800a8201df3f`
     The preview workflow uses `wrangler versions upload`; production uses
     `wrangler deploy`. After the first successful Actions deployment, disable
     the old Cloudflare Workers Builds GitHub integration so there is one deploy
     owner and no duplicate builds.
     Do NOT use the app's plain `bun run build` for a workflow trigger (it does
     not stage the workspace dependencies), and do NOT add a `build` block to
     `wrangler.jsonc` (`no_bundle` is set because Vite already produced a
     bundled entry).
3. **Hyperdrive (Neon pooling).** ✅ Done: `adea-db` (id in
   `wrangler.jsonc`) points at the standalone Neon project (`us-east-2`)
   via its **direct/unpooled** origin as `neondb_owner` — Hyperdrive pools
   itself, so never use the `-pooler` host here. There is no hosted-integration shortcut; if you
   ever need to recreate it:
   ```bash
   wrangler hyperdrive create adea-db \
     --connection-string="$DATABASE_URL_UNPOOLED"
   ```
   The app reads the binding captured by the Worker entry at runtime
   (`src/server/worker-bindings.ts`, resolved in
   `src/server/database-connection.ts`) and falls back to `DATABASE_URL`
   anywhere it is absent (local dev, tests). The existing `postgres.js` driver
   and all Drizzle transactions work unchanged.
4. **Secrets** (never in `wrangler.jsonc` or git):
   ```bash
   wrangler secret put DATABASE_URL_UNPOOLED
   wrangler secret put DATABASE_URL
   wrangler secret put NEON_AUTH_BASE_URL
   wrangler secret put NEON_AUTH_COOKIE_SECRET
   wrangler secret put CONTROL_PLANE_ORIGIN
   wrangler secret put CONTROL_PLANE_SERVICE_TOKEN
   wrangler secret put CONTROL_PLANE_SCOPE_WORKSPACE_ID
   ```
   Access is additionally gated by an account allowlist: set the
   `ADEA_ALLOWED_EMAILS` variable (Worker → Settings → Variables, a
   comma-separated list of email addresses) to restrict sign-in and workspace
   access to those accounts and disable guest sessions. Unset or empty keeps
   the default open behavior (any authenticated account plus guests).
   Source values: the Cloudflare Secret Store is the source of truth for hosted
   values (the `ADEA_*` records); `.env.local` (gitignored) keeps local
   Development copies for day-to-day dev. Drop every `POSTGRES_*`/`PG*` duplicate of the same Neon role.
5. **Local preview.** Copy `.dev.vars.example` to `.dev.vars` (gitignored),
   then `bun run preview`. Day-to-day dev is `bun run dev`, which runs the Vite
   dev server inside the Workers runtime (`wrangler.dev.jsonc`), so bindings
   behave like production.

## Request handling and caching

- **Root document** (`/`) is rendered per request behind the entry policy in
  `src/start/worker.ts`. Unsigned visitors on an allowlisted deployment get a
  307 to `/auth/sign-in`; denied accounts render the early-access notice.
- **API routes** under `/api/*` always execute the Worker
  (`assets.run_worker_first`), so authorization runs on every call.
- **Static assets** (`/start-assets/*`, `/assets/*`, `/icon.svg`) are served
  directly by Cloudflare's asset layer without invoking the Worker.
  `public/_headers` sets immutable caching for hashed build output and a
  day-long cache with stale-while-revalidate for scene manifests.
- Every dynamic response the Worker produces is `Cache-Control: private,
no-store` with `X-Robots-Tag: noindex, nofollow, noarchive`
  (`src/start/http-policy.mjs`).

## Scene manifests (no private pack here)

This repository ships manifests only. The spatial engine (models, textures,
audio) lives in the private `agent-sim` repo and is delivered through the
entitlement-gated engine remote; `adea` lanes never fetch the private
`adea-ai/assets` pack and need no asset credentials. `scripts/sync-assets.mjs`
stages the tracked protocol manifests (`packages/spatial-protocol/data`) into
the app's public assets directory, so plain checkouts build and test with zero
setup.

- **Local dev:** nothing to fetch. `bun run dev` syncs manifests automatically.
- **Cloudflare Builds:** no asset variables needed.
- **GitHub release lanes:** unchanged (`release-assets.yml` still serves the
  desktop shell; full engine payloads ship from `agent-sim` lanes).

## Release attribution (telemetry)

`scripts/build-cloudflare.mjs` stamps `DEPLOY_GIT_COMMIT_SHA` (plus the
`NEXT_PUBLIC_` twin the client bundle reads) from `git rev-parse HEAD`, so scene
telemetry keeps release labels without a hosting provider. An explicit
`DEPLOY_GIT_COMMIT_SHA` in the build environment always wins; Workers Builds
previews therefore report their own commit automatically. Navigation telemetry
subscribes to the router history in `src/start/router.tsx`.

## Database migrations

- **Cloudflare:** `.github/workflows/cloudflare-db-migrate.yml` runs
  `bun run db:verify` (same idempotent verifier) on pushes to `main` that
  touch `packages/db/drizzle/**`. It needs the `DATABASE_MIGRATION_URL`
  repository secret (unpooled migration role, `sslmode=require`).
- Keep migrations backward-compatible: the Worker deploys from the same
  push in parallel with the migrate job, so additive schema first, code
  that depends on it second.
- Migrations run ONLY as the migration role (owner first-runs poison object
  ownership and break later migrator runs on `ALTER`). New branches need
  `GRANT CREATE ON DATABASE` for their migration role.

## Deliberate gaps / follow-ups

- Cloudflare Access intentionally gates the worker (Zero Trust login is
  required before any app traffic). `AUTH_TRUSTED_ORIGINS` must therefore
  list every public origin: the `workers.dev` URL and the `adea.dev`
  custom domain.
- `src/start/routes/api/scene-editor.ts` is dev-only (404s outside
  `NODE_ENV=development`) and imports `node:fs` lazily so it never enters the
  Worker bundle for production requests.
- No `next/image` usage existed; the workspace uses plain `<img>` elements, so
  no Cloudflare Images loader configuration is needed.
- Preview Neon branches (`.github/workflows/neon_workflow.yml`) are unchanged
  and still gate PRs.
