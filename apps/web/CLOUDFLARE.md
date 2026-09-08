# Cloudflare Workers deployment (OpenNext)

`apps/web` deploys to Cloudflare Workers via
[`@opennextjs/cloudflare`](https://opennext.js.org/cloudflare) (Next 16 is
supported). Cloudflare Workers is the deployment target.

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
   not produce the Worker entry point), and do NOT add a `build` block to
   `wrangler.jsonc`.
3. **Hyperdrive (Neon pooling).** ✅ Done: `adea-db` (id in
   `wrangler.jsonc`) points at the standalone Neon project (`us-east-2`)
   via its **direct/unpooled** origin as `neondb_owner` — Hyperdrive pools
   itself, so never use the `-pooler` host here. There is no hosted-integration shortcut; if you
   ever need to recreate it:
   ```bash
   wrangler hyperdrive create adea-db \
     --connection-string="$DATABASE_URL_UNPOOLED"
   ```
   The app reads `env.HYPERDRIVE.connectionString` at runtime
   (`src/server/database-connection.ts`) and falls back to `DATABASE_URL`
   anywhere the binding is absent (local dev, tests). The existing
   `postgres.js` driver and all Drizzle transactions work unchanged.
4. **Secrets** (never in `wrangler.jsonc` or git):
   ```bash
   wrangler secret put DATABASE_URL_UNPOOLED
   wrangler secret put DATABASE_URL
   wrangler secret put NEON_AUTH_BASE_URL
   wrangler secret put NEON_AUTH_COOKIE_SECRET
   wrangler secret put VITE_NEON_AUTH_URL
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
   then `bun run preview`. Day-to-day dev stays `bun run dev` (plain Node).

## Scene manifests (no private pack here)

This repository ships manifests only. The spatial engine (models, textures,
audio) lives in the private `agent-sim` repo and is delivered through the
entitlement-gated engine remote; `adea` lanes never fetch the private
`adea-ai/assets` pack and need no asset credentials. `scripts/sync-assets.mjs`
stages the tracked protocol manifests (`packages/spatial-protocol/data`) into
the ignored Next public-assets directory, so plain checkouts build and test
with zero setup.

- **Local dev:** nothing to fetch. `bun run dev` syncs manifests automatically.
- **Cloudflare Builds:** no asset variables needed.
- **GitHub release lanes:** unchanged (`release-assets.yml` still serves the
  desktop shell; full engine payloads ship from `agent-sim` lanes).

## Release attribution (telemetry)

`scripts/build-cloudflare-worker.mjs` stamps `DEPLOY_GIT_COMMIT_SHA` (plus the
`NEXT_PUBLIC_` twin for the client bundle) from `git rev-parse HEAD`, so scene
telemetry keeps release labels without a hosting provider. An explicit
`DEPLOY_GIT_COMMIT_SHA` in the build environment always wins; Workers Builds
previews therefore report their own commit automatically.

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
- `src/app/api/scene-editor/route.ts` is dev-only (404s outside
  `NODE_ENV=development`) and now imports `node:fs` lazily so it never
  enters the Workers bundle.
- No `next/image` usage, so no Cloudflare Images loader config is needed.
- All API routes use `runtime = "nodejs"` (required); there is no
  `runtime = "edge"` anywhere.
- Preview Neon branches (`.github/workflows/neon_workflow.yml`) are unchanged
  and still gate PRs.
