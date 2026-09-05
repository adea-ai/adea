# Cloudflare Workers deployment (OpenNext)

`apps/web` deploys to Cloudflare Workers via
[`@opennextjs/cloudflare`](https://opennext.js.org/cloudflare) (Next 16 is
supported). Vercel still works during the transition; nothing here breaks it.

## One-time setup (dashboard + CLI)

1. **Worker name.** `wrangler.jsonc` uses `agent-hq-web`. Rename there or in
   the dashboard so they match, otherwise CLI deploys miss the Git-connected
   Worker.
2. **Dashboard build settings** (Worker → Settings → Build):
   - Build command: `bun run build:worker` (runs `next build`, then the
     OpenNext transform into `.open-next/`).
   - The repo is a Bun monorepo; the build must install from the repo root.
3. **Hyperdrive (Neon pooling).** ✅ Done: `agent-hq-db` (id in
   `wrangler.jsonc`) points at the standalone Neon project (`us-east-2`)
   via its **direct/unpooled** origin as `neondb_owner` — Hyperdrive pools
   itself, so never use the `-pooler` host here. No Vercel-style integration exists; if you
   ever need to recreate it:
   ```bash
   wrangler hyperdrive create agent-hq-db \
     --connection-string="$DATABASE_URL_UNPOOLED"
   ```
   The app reads `env.HYPERDRIVE.connectionString` at runtime
   (`src/server/database-connection.ts`) and falls back to `DATABASE_URL`
   anywhere the binding is absent (local dev, Vercel, tests). The existing
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
   Source values: `vercel env pull` (`.env.local`, gitignored). Drop
   `VERCEL_OIDC_TOKEN` (unused in code) and every `POSTGRES_*`/`PG*`
   duplicate once Hyperdrive is live — they were Vercel-integration copies
   of the same Neon role.
5. **Local preview.** Copy `.dev.vars.example` to `.dev.vars` (gitignored),
   then `bun run preview`. Day-to-day dev stays `bun run dev` (plain Node).

## Database migrations

- **Vercel:** unchanged (`vercel.json` → `scripts/deployment-migrate.mjs`,
  Vercel-only by design).
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
