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
  Requests for the unsupported root scripts `/wp-login.php` and `/xmlrpc.php`
  receive a small private/no-store 404 before document rendering. API paths,
  invitation paths and auth return targets retain their existing handlers.
  Secret-store hydration still precedes this policy; the rejection avoids SSR,
  not all upstream Worker work. HEAD returns the same status/private headers
  with an empty body; GET and POST retain the small text response.
- `src/start/routes/` holds the route tree: the root document, the auth
  documents, and every API route that previously lived in the Next app. API
  routes are ordinary `createFileRoute(...)` files with `server.handlers`
  (`GET`/`POST`/`PATCH`/`DELETE`/`OPTIONS`), so the URLs and HTTP contracts are
  unchanged: `/api/workspaces/bootstrap`, `/api/v1/workspaces/...`,
  `/api/auth/desktop/...`, and the auth proxy at `/api/auth/*`.
- `packages/auth` wraps the framework-neutral Better Auth service.
  `src/server/auth-request-context.ts` adapts TanStack Start's
  request storage to the toolkit's `RequestContext`, so the server-side
  session/cookie contract is the same one the Next adapter implemented.
- `src/server/` keeps the existing workspace principal, authorization,
  temporary-session, desktop, and marketplace code. `request-scope.ts`
  replaces Next's `after()`: per-request database connections register a
  cleanup callback and are closed once the response is produced.
- The workspace UI is browser-only: the same shared state (TanStack Query's
  Solid bindings plus the Solid workspace store), theme/audio providers,
  settings, plugins, conventional workspace, and optional spatial entry
  points. `src/components/lazy-component.tsx` keeps those entries deferred.
- Web development startup checks named `lucide-solid` imports in reachable
  published shared-UI modules against `start/lucide-solid-dev-shim.jsx` and fails
  before serving modules if an export is missing. It follows static ESM imports
  and re-exports: a root-barrel import links every statically re-exported
  component even when the app selects one public name. Direct subpaths stay
  narrow. Literal lazy imports are inspected for missing icon exports without
  being loaded or executed. Tailwind source discovery still follows selected
  exports, so unused barrel components do not expand the production CSS source
  list.
- Solid compiles hydratable output only where a server-rendered page needs it
  (`start/solid-compile.ts`). The workspace route is `ssr: false` inside
  `ClientOnly`, so the browser build compiles `packages/dev-view` and the
  published shared-UI components the sign-in and invite pages do not import
  without the hydration helpers (about 11 KB raw in the Dev utility panes). The
  production build fails if one of those modules lands in the server bundle; a
  shared component that a server-rendered page starts using joins
  `SERVER_RENDERED_UI` in that file.

Tailwind source scanning for the published `@adea-ai/ui` package follows the
web client entry's runtime imports, including nested component imports and
literal dynamic imports. The Vite configs generate relative source directives
under `apps/web/node_modules/.cache/adea-ui-tailwind-sources.css`; unrelated
components added to the package barrel do not enter the consumer source list.
Both web and desktop builds compare that list with the rendered shared UI
modules recorded by the client build and fail if a rendered module is missing.
Type-only imports are ignored; unresolved shared UI imports and non-literal
runtime imports fail closed because their Tailwind sources cannot be proven.

The shared utility host, command helper and lazy status models use one
nonrecursive chunk group in `vite.config.ts`; shared UI primitives use another.
Other pane components and model dependencies retain their existing boundaries,
and model dependencies must not become Chat dependencies. Short internal names
for the navigation-icon and shared-primitive groups reduce repeated preload-path
bytes without changing those boundaries. At the #1385 repair,
consolidating the existing small shared chunks reduced the measured Dev utility
closure from 185,636 to 185,165 raw bytes and 16 to 12 files, within the unchanged
185,344-byte budget. Every route/startup closure remains checked by `start:verify`.
Runtime-contract grouping is nonrecursive so focused reply DTO dependencies keep
their existing lazy boundaries. The lean envelope, kind discriminators, Unicode
and CBOR length helpers stay together; complete event semantics remain a separate
module so history admission does not pull its validators into unrelated utilities.
Shared lazy badge and empty primitives co-locate with the existing lazy UI helpers,
using the same grouping qualified on the runtime queue integration.

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

Use Node 24.21.0 and Bun 1.4.4. From the repository root:

```sh
bun install --frozen-lockfile
bun run build:web-deps
bun run --cwd apps/web start:verify   # unit tests, build, typecheck, client guard
bun run build:cloudflare
bun run --cwd apps/web start:check-routes  # URL surface and hashed-asset caching gate
bunx playwright install chromium
bun run --cwd apps/web start:test:local
bun run --cwd apps/web start:test:auth-worker # Local auth Worker test without browser E2E
```

`start:verify` builds first because the tracked route tree is generated; rebuild
it after adding a route before running typecheck. `start:check-bundle` reads the compiled client output plus the build
plugin's module evidence and fails rather than reporting success without them.
Web and canonical desktop builds also run `start:check-ui-sources` (the desktop
build passes `--desktop`) to verify selective UI source coverage against the
rendered-module report.
The client graph disallows database, auth-server, and Worker-entry modules;
only four explicitly public environment variables are substituted (no blanket
`process.env` or `VITE_*` export).

`start:test:local` starts a disposable Docker Compose PostgreSQL project,
applies the reviewed application and Better Auth migrations to isolated
schemas, runs the production-built Worker under `wrangler dev` on loopback
HTTPS, and runs the desktop/mobile browser suite against it. Before starting the
Worker, the Bun preparation phase applies Better Auth's isolated schema migrations
and runs a separate verification-enabled signup with an in-memory recording
delivery transport. The Worker itself uses verification-disabled synthetic
configuration, so its auth requests do not exercise delivery. It creates two
accounts concurrently, proves their cookies resolve only their own sessions,
revokes one account's sessions, logs out the other, and verifies each request's
PostgreSQL backend closes within the 10-second polling window after each response
batch. No email or other external service is contacted. The harness then enables
the account allowlist and asserts the restricted entry redirect, the restricted
guest API status, and that the Worker serves a real guest session and durable
writes. Logs and evidence stay under ignored `start/.checks/local-*`; production
credentials are never inherited.
`start:test:auth-worker` runs the same isolated auth Worker and database checks without launching
the Playwright browser suite.

Local HTTPS is required because production-built sessions use `Secure`
cookies; do not strip that attribute to make HTTP tests pass. The checks keep
certificate verification on: each run mints an ephemeral loopback certificate
with `openssl` (`start/loopback-tls.mjs`), hands it to `wrangler dev`, and
trusts exactly that certificate for loopback requests. No other origin is
affected, so nothing needs `rejectUnauthorized: false`.

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

The root Playwright config gives its managed dev Worker the same validated
`DATABASE_URL` as the Node fixtures, using Hyperdrive's
`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` override. This keeps
an isolated worktree database from being mixed with `wrangler.jsonc`'s default
local port. With `PERF_BASE_URL`, the server is managed externally: set that
override to the same test database when starting it.

### Visual regression

`bun run test:e2e:visual` runs `apps/web/e2e/conventional-workspace.spec.ts`
with the committed `-darwin` pixel baselines on a workstation. The same spec
runs per pull request in the `Workspace visual lane` workflow against the
`-linux` baselines, inside the pinned Playwright container so the rendering
stays reproducible. A UI change that moves pixels refreshes both sets with
`--update-snapshots`; the spec mocks every API response and needs no database.

### Hosted acceptance

Automated hosted checks run against a production-built Worker with a distinct
name and secrets scoped to an isolated test database branch. They never use the
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
transfer, request counts, and automation-observed view switches. It fails on
browser exceptions or failed workspace API responses. This is an unthrottled
desktop lab measurement, not field INP or production LCP.

## Rollback

The migration changes no database schema and no stored data. Rolling back is a
code revert plus redeploying the previous Worker version; no data migration or
cleanup is required. Do not reset or delete user data.

## References

- [TanStack Start](https://tanstack.com/start/latest/docs/framework/solid/overview)
- [TanStack Solid Router search params](https://tanstack.com/router/latest/docs/framework/solid/guide/search-params)
- [Cloudflare Vite plugin](https://developers.cloudflare.com/workers/vite-plugin/)
- [Decision 0007: SolidJS on TanStack Start](../../../docs/decisions/0007-solid-tanstack-start.md)

## Stream disconnect qualification

Both `wrangler.jsonc` and the release deploy configuration in
`cloudflare.config.ts` opt in to Cloudflare's `enable_request_signal` flag so
an incoming disconnect can reach the event route's existing abort handler. That
handler stops the poll loop, releases its connection slot and lets the retained
request scope close its database client after in-flight work settles. The route's
authorization and cleanup ordering are unchanged.

Disconnect notification is write-driven in the native local fixture. An idle
connection can wait until the next 15-second heartbeat; this is not a promise of
immediate TCP-disconnect detection or a hosted timing bound. Wrangler's local
HTTP proxy added another heartbeat interval in the 2026-10-18 diagnostic.

After building, run `bun run --cwd apps/web start:test:disconnect`. It resolves
workerd from the locked Wrangler dependency and serves the current built Worker
directly on loopback HTTPS, with an isolated synthetic PostgreSQL database and
local Hyperdrive TCP binding. The no-flag control must continue polling after
socket closure; configured idle and active streams must abort, close the original
stream database connection once, and issue zero SQL in three settled ten-second
windows. The client closes its response, request and socket explicitly. The
fixture passes no production credentials, restricts Worker outbound traffic to
loopback, and removes only its own processes, database and compose volume.
`start:test:local` includes this regression after the existing browser checks.

The timestamped evidence is in
[`docs/evidence/worker-disconnect-2026-10-18.json`](../../../docs/evidence/worker-disconnect-2026-10-18.json).
The captured 12:09 UTC deployment used for diagnosis predates the later release
#1463 deployment. These local results do not establish current production CPU,
Hyperdrive usage, hosted-database cost reductions, or browser hidden/resume behavior.
