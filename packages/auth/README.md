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

### Worker auth transport

Production Workers use a separate `AUTH_HYPERDRIVE` binding backed by the auth-only
Railway role. Hyperdrive authenticates the origin certificate against the reviewed Railway
CA with `verify-full`, disables query caching, and limits origin connections to five.
The hosting adapter passes its connection string into each request-owned auth service;
the canonical `AUTH_DATABASE_URL` remains validated configuration. Hosted Workers fail
closed when the auth binding is missing. Direct connections remain available to Node/Bun
and disposable loopback Worker fixtures. Never substitute the application pool for auth.
The auth runtime role defaults to the `auth` schema; pools are closed with each request.

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
visibility, and that each response batch leaves no auth PostgreSQL backend within the 10-second
polling window. The fixture uses only loopback HTTPS and PostgreSQL; Worker-side delivery is not
tested, and no real email or production credentials are involved.

The web and desktop call sites use `createAuthServerAdapter`, `createAuthClientAdapter`, and `handleAuthRequest`.

### Fresh-schema initialization

Better Auth owns its tables (`user`, `session`, `account`, `verification`) in the auth schema.
`@adea-ai/db` must not query or migrate them. They are created by an explicit, operator-run
command that is separate from the runtime service:

```sh
bun run --cwd packages/auth schema-init            # plan only (default); changes nothing
bun run --cwd packages/auth schema-init -- --apply # runs Better Auth's migrations if needed
```

- Inputs come from the environment, never argv. `AUTH_MIGRATION_DATABASE_URL` is the only database
  the command reads and should carry the schema-owning migration role. `AUTH_DATABASE_URL` (the
  runtime role) is ignored. `AUTH_BASE_URL`, `AUTH_SECRET` and `AUTH_TRUSTED_ORIGINS` are validated
  with the runtime rules, so the tables come from the same Better Auth options.
- Ordering: (1) create the target schema and roles with the operator's own tooling; the search path
  must be a single unquoted schema name that exists (Better Auth inspects the first literal entry and
  unqualified DDL lands in the first existing one, so anything ambiguous is refused before any change); (2) plan; (3) apply with
  the migration role; (4) only then start the runtime service with `AUTH_DATABASE_URL` set to the
  runtime role. Re-applying an initialized schema is a no-op. Apply only adds tables and columns
  and never drops anything. Success is reported only when a fresh inspection shows nothing pending.
  Apply is all-or-nothing: the compiled statements (tables, columns and deferred indexes) run in one
  transaction on one connection, so a failure rolls the whole schema back and re-running apply
  completes it. Inspection does not compare indexes, so a schema some other tool left partly built
  is not detected; initialize only a fresh schema with this command.
- The runtime role has no `CREATE` on the auth schema, so it cannot create these tables even if
  misconfigured. It may plan (read-only) but apply is refused by the database.
- Upstream migration logging is disabled for this command, so the only error output is the single JSON
  line below. Errors print one JSON line with the failing stage (`config`, `connect`, `target`, `inspect`,
  `apply`, `cleanup`). Each message is passed through redaction of the connection string and its password.
  The pool is always released.

`scripts/fresh-postgres-acceptance` uses the same `applyAuthSchema()` for its disposable PostgreSQL
journey. Wiring the command into a hosted deploy step remains a separate, owner-approved change.
