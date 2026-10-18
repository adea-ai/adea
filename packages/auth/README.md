# Auth package

Provider-neutral authentication boundary for Adea. The root export contains normalized types
and adapters. `/auth/server` serves the self-hosted **Better Auth** service backed by a managed
PostgreSQL (Railway) instance; `/auth/client` is the browser client that talks to the same-origin
`/api/auth/*` proxy.

Authentication is optional for guest use. It proves a provider credential when a user chooses to
persist a temporary workspace, but it never grants workspace access by itself. See [the
authentication operations guide](../../docs/authentication.md) for temporary users, workspace
claiming, authorization, security, callbacks, observability, and provider-migration conventions.

## Self-hosted Better Auth

- `createBetterAuthServer()` (`/auth/server`) builds the Better Auth instance: email/password,
  optional Google OAuth, secure HTTP-only `SameSite=Lax` cookies, session expiry/update age, and
  Better Auth's own CSRF/origin checks. Configuration comes from `readBetterAuthConfig()`:
  `AUTH_BASE_URL` (the public app origin that serves `/api/auth/*`), `AUTH_SECRET` (≥32 chars),
  `AUTH_DATABASE_URL`, `AUTH_TRUSTED_ORIGINS`, plus optional session, verification, secure-cookie,
  and Google overrides. `AUTH_DATABASE_URL` must require TLS outside loopback; `AUTH_SECURE_COOKIES`
  may only be disabled for a loopback HTTP base URL; email verification is required by default and
  `profile.email` is withheld until the mailbox is verified.
- `createBetterAuthDriver()` adapts the server or client API to the provider-neutral `AuthDriver`.
  It never exposes a provider token; revocation resolves the normalized session ID to a token
  inside the driver, and refresh bypasses the signed session-data cookie cache.
- Verification and password-reset messages go through the injected, provider-neutral `AuthDelivery`.
  `createUnconfiguredDelivery()` fails closed; `createRecordingAuthDelivery()` is the synthetic
  test transport. The auth service never sends email itself.
- The service and its database connection are request-owned. `createBetterAuthService()` caches
  nothing at module scope and returns a `close()`; request-scoped callers pass
  `{ registerCleanup }` (the app's `registerRequestCleanup`) so the connection dies with the
  request. Every `Set-Cookie` Better Auth returns is persisted through the request context, and a
  credential call reads its own fresh cookie rather than the incoming one.
- Better Auth response HTTP is `no-store`; auth/session/permission lookups are uncached.

### PostgreSQL adapter

`createPostgresAuthDatabase()` supplies an auth-owned `pg.Pool` directly to Better Auth's built-in
Kysely PostgreSQL adapter. `pg` and its TypeScript definitions are pinned in this package because
Bun uses isolated workspace installs. TLS options stay in the validated connection URL so
node-postgres can apply the requested SSL mode. The PostgreSQL integration test uses
`AUTH_POSTGRES_TEST_URL` only when it points to a loopback database; it creates a temporary schema,
runs Better Auth's supported programmatic migration, and verifies signup, persisted session, and
revocation against the real adapter.

The retained local Worker acceptance (`bun run --cwd apps/web start:test:auth-worker`, also included
in `start:test:local`) runs the production-built Wrangler Worker against a separate auth schema in
its disposable PostgreSQL project. The Bun preparation phase runs a separate verification-enabled
signup through an in-memory recording delivery fixture. Worker requests use synthetic config with
verification disabled; they verify concurrent cookie and session isolation, logout/revocation
visibility, and that each auth request closes its PostgreSQL backend. The fixture uses only
loopback HTTPS and PostgreSQL; Worker-side delivery is not tested, and no real email or production
credentials are involved.

The historical `createNeonServerAdapter` / `createNeonClientAdapter` / `handleNeonAuthRequest`
names are retained for the existing web and desktop call sites, with provider-neutral aliases
(`createAuthServerAdapter`, `createAuthClientAdapter`, `handleAuthRequest`). The legacy Neon-hosted
Auth environment is left in place and recoverable.

### Fresh-schema initialization

Better Auth owns its tables (`user`, `session`, `account`, `verification`) in `AUTH_DATABASE_URL`.
They must be created on the fresh PostgreSQL instance with Better Auth's supported schema tooling
(the Better Auth CLI) before first use; `@adea-ai/db` must not query or migrate them. Wiring that
command into a deploy step is remaining work.
