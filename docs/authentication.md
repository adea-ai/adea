# Authentication boundary

`@agent-hq/auth` is the only application-facing authentication provider boundary. It wraps Neon
Auth's managed Better Auth service today, but its public result contains only a provider name,
provider subject, non-authoritative profile hints, and session metadata. The provider subject is
an `AuthIdentity` input; it is never an Adea `User.id` and never grants workspace access.

Authentication is optional for using Adea. A first web or desktop launch provisions a
temporary canonical `User`, owner membership, and default Home and Work workspaces transactionally. The browser
stores its opaque temporary credential in an HTTP-only cookie; the desktop app stores a distinct
credential in the operating-system keychain. Temporary credentials expire after 30 days and are
stored in PostgreSQL only as SHA-256 digests.

Signing in or creating an account claims the temporary workspaces. A new account promotes the
temporary user in place; an existing account transfers memberships and ownership without exposing
provider IDs. Claim retries are idempotent for the same account and fail closed for another
account. Signing out affects only the account session and opens a new guest workspace; it does not
delete the saved workspaces or unpair a RuntimeNode.

## Environment topology

| Application target | Neon branch  | Auth endpoint source                 |
| ------------------ | ------------ | ------------------------------------ |
| Production         | main         | Production `NEON_AUTH_BASE_URL`      |
| Preview            | staging      | Preview `NEON_AUTH_BASE_URL`         |
| Development        | development  | Development `NEON_AUTH_BASE_URL`     |
| Pull request CI    | preview/pr-* | Neon branch action `auth_url` output |

Each target keeps separate `NEON_AUTH_BASE_URL`, `NEON_AUTH_COOKIE_SECRET`, and
`AUTH_TRUSTED_ORIGINS` records in the Cloudflare Secret Store. `VITE_NEON_AUTH_URL` is public by design and is
also branch-specific for the later desktop shell. Never client-prefix the cookie secret.

The browser client calls the same-origin `/api/auth/*` proxy. State-changing proxy requests require
an exact `Origin` match. Production uses only stable HTTPS aliases (`adea.dev` and the `workers.dev` URL).
Preview Worker deployments must list their exact URLs in `AUTH_TRUSTED_ORIGINS`;
those aliases must also exist in the Neon staging database branch's Auth domain list.
Wildcards are prohibited.
Development enables Neon's localhost setting.

Neon accepts only HTTP(S) trusted domains. Desktop OAuth therefore returns to the stable HTTPS web
callback, which verifies state and nonce before handing off to the allowlisted
`adea://auth/callback` URI. The desktop shell registers that exact scheme, opens only the fixed
cloud authorization endpoint in the system browser, and rejects custom-scheme callbacks containing
tokens or session credentials. A provider must never redirect directly to an unregistered custom
scheme.

`createDesktopAuthorizationAttempt()` creates the five-minute state, nonce, and S256 PKCE binding in
the packaged client. `createDesktopAuthorizationCodeBroker()` stores only a digest of the one-time
code and requires its store to consume the record atomically. Exchange validates the exact redirect,
nonce, expiry, and PKCE verifier before issuing an opaque desktop user session. The custom callback
contains only `code`, `state`, and `nonce`; access, refresh, provider-session, and application-session
credentials are forbidden in URLs.

The web application exposes separate `authorize`, `exchange`, `refresh`, `logout`, and `revoke`
handlers under `/api/auth/desktop`. An unauthenticated authorization request is routed through
`/auth/sign-in` with an exact same-origin return target. Email registration creates the Neon
account, and the first authenticated authorization provisions one stable Adea user and identity
mapping before issuing the one-time desktop code. Exchange and lifecycle requests accept only the
shell's fixed loopback origin (`http://127.0.0.1:4789`) plus the fixed `http://127.0.0.1:1420`
local Vite origin, use no-store responses, and carry opaque user credentials in request headers or
bodies rather than URLs. Keeping that one loopback origin allowlisted lets a local desktop build
exercise the production cloud flow; arbitrary loopback ports and wildcard origins remain rejected.
PostgreSQL stores only SHA-256 digests for authorization codes and desktop credentials. Code
consumption and credential rotation are atomic.

Desktop releases package the spatial workspace and its Vite/React assets locally, served by the
shell on loopback. The shell injects its command bridge only into the served document and sends no
CORS headers, so remote web content receives no desktop command surface.
Server modules and Neon Auth SDK code are excluded from the client dependency graph.

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
- Authentication and workspace authorization are separate. The desktop browser handoff may
  provision the first canonical user identity, but application services must still map the
  provider/subject pair to that identity and run membership and permission checks.

## Adapter use

Server code imports `createNeonServerAdapter` from `@agent-hq/auth/server`. Client components import
`createNeonClientAdapter` from `@agent-hq/auth/client`. All other application packages consume the
provider-neutral types from `@agent-hq/auth`; no other package may import `@neondatabase/auth`.

Refresh bypasses Neon Auth's signed session-data cache. Logout clears the current provider session.
Explicit revocation accepts the normalized session ID, resolves the provider token inside the
driver, and never exposes that token through the application interface.

The desktop session lifecycle is online-first for MVP. On restart, the platform session vault is
loaded and the broker refreshes the user session before cloud authorization proceeds. A network
failure is reported as an explicit offline state; invalid, expired, or revoked sessions are cleared.
Logout and user-session revocation clear only the user session vault. RuntimeNode device credentials
use a separate vault and lifecycle and are never reused as user credentials or implicitly unpaired.
The packaged shell implements the user-session vault with the operating system credential store;
provider cookies and RuntimeNode device credentials are never copied into it.

## Workspace authorization

Server routes call `authorizeWorkspaceAction()` with a shared named permission. Role names are
only permission bundles: owner, admin, and member policy is evaluated in one server-side boundary,
and non-user principals receive no user permissions implicitly. Missing membership and missing
objects return the same opaque workspace-unavailable contract. Denials and privileged decisions
are written to the authorization audit table.

To introduce a permission:

1. Add its stable identifier to `workspacePermissions` in `@agent-hq/types`.
2. Add it only to the reviewed role bundles in `@agent-hq/auth/authorization`.
3. Require it at each affected server route or service before repository access.
4. Add allow, deny, cross-workspace, non-user-principal, and audit tests.

Client visibility may reflect an authorization result for presentation, but it is never the policy
boundary. Changing a bundle takes effect through the existing named-permission path and does not
require a new role-name branch in a route.

## Provider migration

Neon Auth stores Better Auth data in `neon_auth`; `@agent-hq/db` must not query or migrate that
schema. To move to another managed or self-hosted Better Auth deployment:

1. Export/migrate the provider-owned Better Auth tables using that provider's supported process.
2. Implement `AuthDriver` for the replacement SDK and retain the provider/subject identity key.
3. Replace only the `@agent-hq/auth/client` and `@agent-hq/auth/server` constructors.
4. Rotate cookie secrets, update exact trusted origins/callbacks, and invalidate old sessions.
5. Run invalid/expired/revoked/wrong-origin, refresh, logout, and identity-mapping tests before
   switching traffic.

Never copy provider tables into Adea migrations or reinterpret a provider subject as a domain
user ID during migration.

## Stable identity and principals

```text
Neon Auth session
  -> @agent-hq/auth provider credential validation
  -> AuthIdentity(provider, subject)
  -> User(id)
  -> User PrincipalRef { kind: "user", userId }
  -> workspace membership and authorization

Device credential -> Runtime Node PrincipalRef
Service credential -> Service PrincipalRef
Agent delegation   -> Agent PrincipalRef
Worker execution   -> Worker PrincipalRef
```

`AuthIdentity` is the only bridge between a Neon provider subject and an Adea `User`. The
provider/subject pair is unique and belongs to exactly one stable user. Creation writes both rows
in one transaction, so a concurrent duplicate cannot leave an orphan user. Revoked identities and
disabled users do not resolve. Unknown, non-user, or ambiguous mappings fail closed.

Provider subjects must never appear in workspace membership, control-plane foreign keys, API
principal fields, or model context. Those boundaries use `PrincipalRef`; user principals contain
only the stable Adea `userId`. Account linking is intentionally not automatic: adding another
provider identity to an existing user requires a future explicit, reauthenticated linking flow
that preserves the one-provider-subject-to-one-user invariant.
