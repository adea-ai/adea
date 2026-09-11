# TanStack Start web host

The canonical web host for the Adea browser workspace. Next.js and OpenNext
have been removed; this workspace builds and deploys a TanStack Start Worker
with Vite and the Cloudflare Vite plugin.

**Deploy paths:** `bun run build:cloudflare` (repository root) then
`wrangler deploy` from `apps/web`. See [CLOUDFLARE.md](../CLOUDFLARE.md) for
Worker setup, secrets, and caching.

## Architecture

- `src/start/worker.ts` is the Worker entry. It captures Cloudflare bindings
  (Hyperdrive), enforces the migration-era HTTP policy for dynamic responses,
  and runs the account entry policy before any workspace document is rendered.
- `src/start/routes/` holds the route tree: the root document, the auth
  documents, and every API route that previously lived in the Next app. API
  routes are ordinary `createFileRoute(...)` files with `server.handlers`
  (`GET`/`POST`/`PATCH`/`DELETE`/`OPTIONS`), so the URLs and HTTP contracts are
  unchanged: `/api/workspaces/bootstrap`, `/api/v1/workspaces/...`,
  `/api/auth/desktop/...`, and the Neon Auth proxy at `/api/auth/*`.
- `packages/auth` uses the framework-neutral `@neondatabase/auth/server`
  toolkit. `src/server/auth-request-context.ts` adapts TanStack Start's
  request storage to the toolkit's `RequestContext`, so the server-side
  session/cookie contract is the same one the Next adapter implemented.
- `src/server/` keeps the existing workspace principal, authorization,
  temporary-session, desktop, and marketplace code. `request-scope.ts`
  replaces Next's `after()`: per-request database connections register a
  cleanup callback and are closed once the response is produced.
- The workspace UI is browser-only and unchanged: the same Query/Zustand
  state, theme/audio providers, settings, plugins, conventional workspace,
  and optional spatial entry points. `src/components/lazy-component.tsx`
  replaces `next/dynamic` at the existing import sites.

## Entry policy

Root documents run the account allowlist in the Worker before rendering
(`src/server/workspace-entry-access.ts`):

- No configured allowlist: the workspace renders (guests allowed).
- Allowlist configured and no session: `307` to `/auth/sign-in`.
- Allowlist configured and a non-listed account: the early-access notice.

The decision travels to the document render on an internal header that is
stripped from inbound requests first, so a caller cannot forge it;
`/api/web-entry` also exposes the decision as JSON for tests and monitors.

## Validation

Use Node 24.18.0 and Bun 1.4.0. From the repository root:

```sh
bun install --frozen-lockfile
bunx turbo run build --filter=@adea-ai/web^...
bun run --cwd apps/web start:verify   # unit tests, build, typecheck, client guard
bun run build:cloudflare
bunx playwright install chromium
bun run --cwd apps/web start:test:local
```

`start:verify` builds first because the route tree is generated and ignored in
Git. `start:check-bundle` reads the compiled client output plus the build
plugin's module evidence and fails rather than reporting success without them.
The client graph disallows database, auth-server, and Worker-entry modules;
only four explicitly public environment variables are substituted (no blanket
`process.env` or `VITE_*` export).

`start:test:local` starts a disposable Docker Compose PostgreSQL project,
applies the reviewed migrations to it, runs the production-built Worker under
`wrangler dev` on loopback HTTPS, and runs the desktop/mobile browser suite
against it. It then enables the account allowlist and asserts the restricted
entry redirect, the restricted guest API status, and that the Worker serves a
real guest session and durable writes. Logs and evidence stay under ignored
`start/.checks/local-*`; production credentials are never inherited.

Local HTTPS is required because production-built sessions use `Secure`
cookies; do not strip that attribute to make HTTP tests pass.

`start:check-routes` boots the built Worker on its own and asserts the URL
surface against a real HTTP client: the root document (200) and its method
contract (405 for POST), both auth documents, the auth proxy mount (never
404), the entry-gate endpoint, unknown API/document paths (404), and the
immutable `Cache-Control` on hashed assets.

### Browser acceptance

The browser suite reuses `apps/web/e2e/workspace-guest.spec.ts` unchanged and
adds host-specific checks (`start/browser/`): the document is really served by
Start, unknown paths cannot become an unguarded workspace shell, a failed
workspace import produces a recoverable route error, view switching preserves
query state, and guest cookies/durable writes/tenant isolation hold.

### Hosted acceptance

Automated hosted checks run against a production-built Worker deployed under a
distinct name with secrets scoped to an isolated Neon branch — never the
production Worker, database, or DNS:

```sh
ADEA_ACCEPTANCE_URL=https://<isolated-worker>.workers.dev bun run --cwd apps/web start:accept:hosted
ADEA_ACCEPTANCE_URL=https://<isolated-worker>.workers.dev bun run --cwd apps/web start:accept:gates
```

`start:accept:allowlist create` makes the accounts for the allowlist phases;
enable `ADEA_ALLOWED_EMAILS` on that isolated Worker, then run
`start:accept:allowlist verify`. See [VALIDATION.md](VALIDATION.md) for results
and the hosted bug these checks caught.

### Performance

`start:compare` measures two built loopback hosts with fresh browser contexts
and real guest sessions:

```sh
bun run --cwd apps/web start:compare \
  --baseline-url https://127.0.0.1:3105 --candidate-url https://127.0.0.1:3104 --runs 5
```

It records browser-observed DOM readiness, loaded JavaScript bytes, resource
transfer, request counts, and automation-observed view switches, and fails on
browser exceptions or failed workspace API responses. It is an unthrottled
desktop lab measurement — not field INP or production LCP.

## Rollback

The migration changes no database schema and no stored data. Rolling back is a
code revert plus redeploying the previous Worker version; no data migration or
cleanup is required. Do not reset or delete user data.

## References

- [TanStack Start Next.js migration guide](https://tanstack.com/start/latest/docs/framework/react/migrate-from-next-js)
- [TanStack Start Cloudflare example](https://github.com/TanStack/router/tree/main/examples/react/start-basic-cloudflare)
- [Cloudflare Vite plugin](https://developers.cloudflare.com/workers/vite-plugin/)
- [nuqs adapter limitations](https://nuqs.dev/docs/adapters)
