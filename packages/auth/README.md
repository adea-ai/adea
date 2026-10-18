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
  and Google overrides.
- `createBetterAuthDriver()` adapts the server or client API to the provider-neutral `AuthDriver`.
  It never exposes a provider token; revocation resolves the normalized session ID to a token
  inside the driver, and refresh bypasses the signed session-data cookie cache.
- Verification and password-reset messages go through the injected, provider-neutral `AuthDelivery`.
  `createUnconfiguredDelivery()` fails closed; `createRecordingAuthDelivery()` is the synthetic
  test transport. The auth service never sends email itself.
- Better Auth response HTTP is `no-store`; auth/session/permission lookups are uncached.

The historical `createNeonServerAdapter` / `createNeonClientAdapter` / `handleNeonAuthRequest`
names are retained for the existing web and desktop call sites, with provider-neutral aliases
(`createAuthServerAdapter`, `createAuthClientAdapter`, `handleAuthRequest`). The legacy Neon-hosted
Auth environment is left in place and recoverable.

### Fresh-schema initialization

Better Auth owns its tables (`user`, `session`, `account`, `verification`) in `AUTH_DATABASE_URL`.
They must be created on the fresh PostgreSQL instance with Better Auth's supported schema tooling
(the Better Auth CLI) before first use; `@adea-ai/db` must not query or migrate them. Wiring that
command into a deploy step is remaining work.
