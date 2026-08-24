# Authentication boundary

`@agent-hq/auth` is the only application-facing authentication provider boundary. It wraps Neon
Auth's managed Better Auth service today, but its public result contains only a provider name,
provider subject, non-authoritative profile hints, and session metadata. The provider subject is
an `AuthIdentity` input for M1.4; it is never an Agent HQ `User.id` and never grants workspace
access.

## Environment topology

| Application target | Neon branch  | Auth endpoint source                 |
| ------------------ | ------------ | ------------------------------------ |
| Production         | main         | Production `NEON_AUTH_BASE_URL`      |
| Preview            | staging      | Preview `NEON_AUTH_BASE_URL`         |
| Development        | development  | Development `NEON_AUTH_BASE_URL`     |
| Pull request CI    | preview/pr-* | Neon branch action `auth_url` output |

Vercel stores separate `NEON_AUTH_BASE_URL`, `NEON_AUTH_COOKIE_SECRET`, and
`AUTH_TRUSTED_ORIGINS` records for each target. `VITE_NEON_AUTH_URL` is public by design and is
also branch-specific for the later desktop shell. Never client-prefix the cookie secret.

The Next.js client calls the same-origin `/api/auth/*` proxy. State-changing proxy requests require
an exact `Origin` match. Production uses only stable HTTPS aliases. Preview deployments add their
exact `VERCEL_URL` and `VERCEL_BRANCH_URL` at runtime; the matching current deployment and branch
aliases must also exist in the staging branch's Neon Auth domain list. Wildcards are prohibited.
Development enables Neon's localhost setting.

Neon accepts only HTTP(S) trusted domains. Desktop OAuth therefore returns to the stable HTTPS web
callback, which verifies state and nonce before handing off to the allowlisted
`agent-hq://auth/callback` URI. M1.5 owns that broker and native protocol registration. A provider
must never redirect directly to an unregistered custom scheme.

## Session security

- Neon/Better Auth owns credential verification, CSRF defenses, OAuth state, nonce, PKCE, session
  rotation, cookie serialization, and provider-side revocation.
- The server proxy uses secure HTTP-only cookies with `SameSite=Lax`, a per-environment random HMAC
  secret, host-only cookie scope, and the SDK's minimum one-second session-data cache TTL. Refresh
  and revocation-sensitive lookups bypass that cache so expiry and remote revocation fail closed.
- `createAuthorizationState()` supplies state, nonce, PKCE verifier/challenge, five-minute expiry,
  exact redirect binding, timing-safe comparisons, and one-time consumption for the desktop
  broker.
- Provider tokens, cookies, raw responses, and PII never appear in the normalized auth result.
  Provider SDK logging is disabled. `createAuthEvent()` emits only event name, outcome, reason, and
  request ID.
- Authentication and workspace authorization are separate. Application services must map the
  provider/subject pair to a canonical identity, then run membership and permission checks.

## Adapter use

Server code imports `createNeonServerAdapter` from `@agent-hq/auth/server`. Client components import
`createNeonClientAdapter` from `@agent-hq/auth/client`. All other application packages consume the
provider-neutral types from `@agent-hq/auth`; no other package may import `@neondatabase/auth`.

Refresh bypasses Neon Auth's signed session-data cache. Logout clears the current provider session.
Explicit revocation accepts the normalized session ID, resolves the provider token inside the
driver, and never exposes that token through the application interface.

## Provider migration

Neon Auth stores Better Auth data in `neon_auth`; `@agent-hq/db` must not query or migrate that
schema. To move to another managed or self-hosted Better Auth deployment:

1. Export/migrate the provider-owned Better Auth tables using that provider's supported process.
2. Implement `AuthDriver` for the replacement SDK and retain the provider/subject identity key.
3. Replace only the `@agent-hq/auth/client` and `@agent-hq/auth/server` constructors.
4. Rotate cookie secrets, update exact trusted origins/callbacks, and invalidate old sessions.
5. Run invalid/expired/revoked/wrong-origin, refresh, logout, and identity-mapping tests before
   switching traffic.

Never copy provider tables into Agent HQ migrations or reinterpret a provider subject as a domain
user ID during migration.
