# Authentication boundary

`@adea-ai/auth` is the application-facing authentication provider boundary. It wraps a
self-hosted **Better Auth** service backed by a managed PostgreSQL instance (Railway) for fresh
initialization and new signups, but its public result contains only a provider name, provider
subject, non-authoritative profile hints, and session metadata. The provider subject is an
`AuthIdentity` input; it is never an Adea `User.id` and never grants workspace access.

The normalized identity uses the `better-auth` provider name. Recovery uses Railway backup/restore or a reviewed forward fix.

Authentication is optional for using Adea. A first web or desktop launch provisions a
temporary canonical `User`, owner membership, and default Home and Work workspaces transactionally. The browser
stores its opaque temporary credential in an HTTP-only cookie; the desktop app stores a distinct
credential in the shell's file-backed encrypted state directory. Temporary credentials expire after 30 days and are
stored in PostgreSQL only as SHA-256 digests.

Signing in or creating an account claims the temporary workspaces. A new account promotes the
temporary user in place; an existing account transfers memberships and ownership without exposing
provider IDs. Claim retries are idempotent for the same account and fail closed for another
account. Signing out affects only the account session and opens a new guest workspace; it does not
delete the saved workspaces or unpair a RuntimeNode.

## Environment topology

The fresh deployment runs one self-hosted Better Auth service against a managed PostgreSQL
database, served through the app's same-origin `/api/auth/*` proxy. `AUTH_BASE_URL` is the public
app origin that serves that proxy, so Better Auth scopes its cookies to the app host.

| Application target | Better Auth database | `AUTH_BASE_URL` (public app origin) |
| ------------------ | -------------------- | ----------------------------------- |
| Production         | Railway PostgreSQL   | Production `AUTH_BASE_URL`          |
| Disposable sandbox | Isolated PostgreSQL  | Synthetic `AUTH_BASE_URL`           |
| Development        | local PostgreSQL     | Loopback `AUTH_BASE_URL`            |

Each target keeps separate `AUTH_BASE_URL`, `AUTH_SECRET`, `AUTH_DATABASE_URL`, and
`AUTH_TRUSTED_ORIGINS` records in the Cloudflare Secret Store. `AUTH_SECRET` (Better Auth's cookie
signing secret, at least 32 characters) and `AUTH_DATABASE_URL` must never be client-prefixed.
Google sign-in is enabled only when both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are present.
Optional `AUTH_SESSION_EXPIRES_IN_SECONDS`, `AUTH_SESSION_UPDATE_AGE_SECONDS`,
`AUTH_EMAIL_VERIFICATION_REQUIRED`, and `AUTH_SECURE_COOKIES` overrides default to a 7-day session
refreshed daily, verification **on**, and secure cookies on whenever the base URL is HTTPS.
`AUTH_DATABASE_URL` must require TLS on any non-loopback host (`sslmode=require`, `verify-ca`, or
`verify-full`); a bare hosted URL is rejected. `AUTH_SECURE_COOKIES=false` is accepted only for a
loopback HTTP base URL. Mailbox proof is required by default: `profile.email` is populated only once
the provider reports the address verified, so an unverified fresh signup can sign in only when a
deployment deliberately turns verification off, and never carries email-based authority
(allowlists, invitations, desktop-session email) until it verifies.

The browser client calls the same-origin `/api/auth/*` proxy, which serves the Better Auth handler.
State-changing proxy requests require an exact `Origin` match, and Better Auth's own CSRF/origin
checks run as a second layer. Production uses only stable HTTPS aliases (`adea.dev` and the
`workers.dev` URL). Preview Worker deployments must list their exact URLs in `AUTH_TRUSTED_ORIGINS`.
Wildcards are prohibited. Loopback HTTP is accepted only for development, where secure cookies
downgrade automatically.

Better Auth accepts only HTTP(S) trusted origins, so the custom `adea://` callback is not passed to
it. Desktop OAuth therefore returns to the stable HTTPS web callback, which verifies state and
nonce before handing off to the allowlisted `adea://auth/callback` URI. The callback contract
requires that exact scheme; registration is still release-lane work. The desktop shell opens only
the fixed cloud authorization endpoint in the system browser, and rejects custom-scheme callbacks
containing tokens or session credentials. A provider must never redirect directly to an
unregistered custom scheme.

`createDesktopAuthorizationAttempt()` creates the five-minute state, nonce, and S256 PKCE binding in
the packaged client. `createDesktopAuthorizationCodeBroker()` stores only a digest of the one-time
code and requires its store to consume the record atomically. Exchange validates the exact redirect,
nonce, expiry, and PKCE verifier before issuing an opaque desktop user session. The custom callback
contains only `code`, `state`, and `nonce`; access, refresh, provider-session, and application-session
credentials are forbidden in URLs.

The web application exposes separate `authorize`, `exchange`, `refresh`, `logout`, and `revoke`
handlers under `/api/auth/desktop`. An unauthenticated authorization request is routed through
`/auth/sign-in` with an exact same-origin return target. Email registration creates the Better Auth
account, and the first authenticated authorization provisions one stable Adea user and identity
mapping before issuing the one-time desktop code. Exchange and lifecycle requests accept only the
shell's fixed loopback origin (`http://127.0.0.1:4789`) plus the fixed `http://127.0.0.1:1420`
local Vite origin, use no-store responses, and carry opaque user credentials in request headers or
bodies rather than URLs. Keeping that one loopback origin allowlisted lets a local desktop build
exercise the production cloud flow; arbitrary loopback ports and wildcard origins remain rejected.
PostgreSQL stores only SHA-256 digests for authorization codes and desktop credentials. Code
consumption and credential rotation are atomic.

Desktop releases package the spatial workspace and its Vite/Solid assets locally, served by the
shell on loopback. The shell injects its command bridge only into the served document and sends no
CORS headers, so remote web content receives no desktop command surface.
Server modules and Better Auth server entry points are excluded from the client dependency graph.

## Session security

- Better Auth owns credential verification, CSRF defenses, OAuth state, nonce, PKCE, session
  rotation, cookie serialization, and server-side revocation. Adea configures it; it does not
  reimplement those primitives.
- The server proxy sets secure HTTP-only cookies with `SameSite=Lax`, host-only scope, and a
  per-environment random signing secret. Refresh and revocation-sensitive lookups bypass Better
  Auth's signed session-data cookie cache so expiry and remote revocation fail closed.
- The service and its PostgreSQL connection are request-owned. Nothing is cached at module scope,
  and each request closes its connection (or registers `close` with the request scope's cleanup),
  so a Cloudflare Worker never reuses one request's socket in another.
- Every `Set-Cookie` Better Auth returns — signup, sign-in, renewal/refresh, account switch,
  revocation, logout — is persisted through the caller's request context. A credential call reads
  its session back through the cookie it just issued, never the request's incoming cookie, so a
  sign-in or account switch cannot resolve the pre-login account.
- Mailbox proof precedes email-based authority. `profile.email` is populated only for a verified
  address, so allowlists, invitations, and desktop-session email matching fail closed for a fresh
  unverified signup.
- Verification and password-reset links are delivered through an injected, provider-neutral
  transport (`AuthDelivery`). The default transport fails closed when no transport is configured;
  the transport never sends from the auth service itself.
- `createAuthorizationState()` supplies state, nonce, PKCE verifier/challenge, five-minute expiry,
  exact redirect binding, timing-safe comparisons, and one-time consumption for the desktop
  broker.
- Provider tokens, cookies, raw responses, and PII never appear in the normalized auth result.
  Provider SDK logging is disabled. `createAuthEvent()` emits only event name, outcome, reason, and
  request ID.
- Authentication and workspace authorization are separate. The desktop browser handoff may
  provision the first canonical user identity, but application services must still map the
  provider/subject pair to that identity and run membership and permission checks.

The retained `bun run --cwd apps/web start:test:auth-worker` acceptance runs the production-built Worker
with a synthetic Better Auth secret and a temporary PostgreSQL schema. During the Bun preparation
phase, a separate verification-enabled signup uses an in-memory recording delivery transport to
assert that a verification message is produced; this does not run inside the Worker. The native
Worker requests use verification-disabled synthetic configuration and test concurrent
signup/session cookie isolation, revocation and logout visibility through later requests, and that
no auth-owned PostgreSQL backend remains within the 10-second polling window after each response
batch. Both phases use loopback services and send no email; Worker-side delivery is not exercised.

## Adapter use

Server code imports `createAuthServerAdapter` from `@adea-ai/auth/server` (the historical alias
`createAuthServerAdapter` still exists). Client components import `createAuthClientAdapter` from
`@adea-ai/auth/client` (alias: `createAuthClientAdapter`). The implementation is the self-hosted
Better Auth service. All other application packages consume the provider-neutral types from
`@adea-ai/auth`; no other package may import `better-auth` server entry points or

Refresh bypasses Better Auth's signed session-data cache. Logout clears the current provider session.
Explicit revocation accepts the normalized session ID, resolves the provider token inside the
driver, and never exposes that token through the application interface.

The desktop session lifecycle is online-first for MVP. On restart, the platform session vault is
loaded and the broker refreshes the user session before cloud authorization proceeds. A network
failure is reported as an explicit offline state; invalid, expired, or revoked sessions are cleared.
Logout and user-session revocation clear only the user session vault. RuntimeNode device credentials
use a separate vault and lifecycle and are never reused as user credentials or implicitly unpaired.
The current Electrobun shell stores user sessions, pending authorization attempts,
and temporary workspace credentials as AES-GCM files under `desktop-state`. Its
`device.key` is a local file used by that transitional store, not an OS credential-store
entry. These values do not use the separate Dev Runtime vault. The current
`local_content_rotate_key` command removes this shared key file without re-encrypting
the saved values; source inspection does not establish a safe rotation contract.
See [desktop authentication](specs/desktop-auth.md) and
[local content](specs/local-content.md) for current implementation limits and target
requirements. Provider cookies and RuntimeNode device credentials are not copied
into the user-session store.

## Workspace authorization

Server routes call `authorizeWorkspaceAction()` with a shared named permission. Role names are
only permission bundles: owner, admin, and member policy is evaluated in one server-side boundary,
and non-user principals receive no user permissions implicitly. Missing membership and missing
objects return the same opaque workspace-unavailable contract. Denials and privileged decisions
are written to the authorization audit table.

To introduce a permission:

1. Add its stable identifier to `workspacePermissions` in `@adea-ai/types`.
2. Add it only to the reviewed role bundles in `@adea-ai/auth/authorization`.
3. Require it at each affected server route or service before repository access.
4. Add allow, deny, cross-workspace, non-user-principal, and audit tests.

Client visibility may reflect an authorization result for presentation, but it is never the policy
boundary. Changing a bundle takes effect through the existing named-permission path and does not
require a new role-name branch in a route.

## Workspace sharing

ADR 0012 (workspace memory, connections and sharing) adds invitations into a
workspace and per-project visibility. Both sit on top of the role bundles above.

**Invitations.** A principal holding `membership.manage` (owners and admins) invites an email
address with the `admin` or `member` role through `POST /api/v1/workspaces/:id/invitations`; the
list (`GET`) and revoke (`POST …/invitations/:invitationId/revoke`) routes need the same
permission.

- The token is 32 random bytes (base64url). Only its SHA-256 digest is stored, in
  `workspace_invitations.token_digest`; the plaintext is returned once in the create response and
  never again. Invitation lists carry no token.
- The create response includes `acceptPath`, `/invite#token=…`. The token rides in the URL
  fragment, which browsers do not send to the server, proxies or `Referer`; the `/invite` page reads
  it, clears it from the address bar, and posts it in a JSON body.
- No email is sent. The inviter copies the link from the Share dialog and delivers it themselves.
  Sending mail is out of scope until a mail provider is chosen.
- An invitation expires after 7 days. Re-inviting the same email replaces (revokes) the pending
  invitation, because the plaintext of the old link cannot be shown again. At most one invitation
  per (workspace, email) is pending, enforced by a partial unique index.
- `POST /api/workspace-invitations/preview { token }` lets the invitee see what they would join
  before accepting: the workspace name, its owner's display name, how many members it has now, the
  role they would hold, whether they are already a member, and the expiry. Accepting never changes
  an existing member's role, so for a member the role shown is the one they hold now, not the one
  on the invitation. It has the same gates as accepting and the same uniform `404`, reads only, and
  never settles the invitation. A used link previews only for the account that used it and only
  while that account is still a member; after removal it answers the same `404` as an unknown
  token, whatever has changed in the workspace since. Previewing requires sign-in: a guest gets
  `401` and no workspace details, and the page sends them through sign-in first. Where the
  workspace's work runs is not part of an invitation, so the page says the location is unknown.
- `POST /api/workspace-invitations/accept { token }` requires a signed-in account — temporary
  guests get `401` and the page sends them through sign-in — whose provider email matches the
  invitation (case-insensitive). The first acceptance creates the membership, appended to the end of
  the joiner's own workspace order, and settles the invitation; a replay by the same user returns
  the same workspace and changes nothing. Unknown, expired, revoked, already-used and wrong-email
  attempts all answer the same `404`, so a token cannot be probed. An existing member who accepts
  keeps their current role.

**Project visibility.** A project is `workspace` (every member, the default) or `members` (its
project members plus the workspace's owners and admins). Project members carry `viewer` or
`editor`.

- Owners and admins (`membership.manage`) change visibility (`PATCH …/projects/:id/visibility`) and
  the member list (`PUT`/`DELETE …/projects/:id/members/:userId`). Anyone who can see a project may
  read its member list (`GET …/projects/:id/members`), so the Share dialog renders read-only for
  them. Only workspace members can be listed on a project, and leaving the workspace drops the
  rows.
- Enforcement lives in the `@adea-ai/db` query layer (`project-access.ts`): every list, get and
  search function for projects, channels, messages, tasks, artifacts, content refs and their
  encrypted replicas, and read state resolves the caller's access scope and filters hidden projects
  in SQL. A hidden project answers exactly like a missing one. A task belongs to the project in its
  `project_id`; an artifact or content ref follows its task or its message's channel.
- Agents stay workspace-level: an agent assigned to a hidden project is still listed, with that
  project's id, to every member. The id names nothing they can open.
- In a `members` project a `viewer` reads but cannot write: message create, edit and delete and
  task and channel changes fail with `Project read-only` (`403 project_read_only`). Read state is
  personal, so viewers can still mark it. An `editor` may post, edit and delete messages in the
  project's channels even without the workspace-wide write role: the message routes accept
  `workspace.update` **or** editor membership of the channel's members-only project
  (`authorizeConversationWrite`). Other project writes keep their workspace-level permission.
- A project's member roles grant nothing while it is `workspace`-visible; the rows are kept so
  switching back to `members` restores the same list.
- The event stream filters per principal; see
  [workspace events](specs/workspace-events.md#per-principal-filtering).

| Field                                       | Classification     | Leaves the device       |
| ------------------------------------------- | ------------------ | ----------------------- |
| Invitation email and role                   | workspace metadata | yes                     |
| Invitation token                            | credential         | digest only, single use |
| Project visibility and project member roles | workspace metadata | yes                     |

## Provider migration

Better Auth stores its data (`user`, `session`, `account`, `verification`) in the database the auth
service is configured with. `@adea-ai/db` must not query or migrate that schema. The fresh
self-hosted deployment initializes those tables with Better Auth's own supported schema tooling
(the Better Auth CLI against the app's auth config) before first use; no Adea migration owns them.

The self-hosted move follows the same rules:

1. Initialize the provider-owned Better Auth tables on the fresh PostgreSQL instance using the
   provider's supported process. (Remaining work: the schema-init command is not yet wired into a
   deploy step. The service already uses Better Auth's built-in Kysely PostgreSQL adapter through
   the auth-owned `pg.Pool` from `createPostgresAuthDatabase()` — see `packages/auth/README.md`.)
2. `createBetterAuthDriver` implements `AuthDriver` and retains the provider/subject identity key
   under the `better-auth` provider name.
3. The `@adea-ai/auth/client` and `@adea-ai/auth/server` constructors are backed by Better Auth.
4. Rotate secrets, update exact trusted origins/callbacks, and invalidate old sessions.
5. Run invalid/expired/revoked/wrong-origin, refresh, logout, delivery, and identity-mapping tests
   before switching traffic.

Never copy provider tables into Adea migrations or reinterpret a provider subject as a domain
user ID during migration.

## Stable identity and principals

```text
Better Auth session
  -> @adea-ai/auth provider credential validation
  -> AuthIdentity(provider, subject)
  -> User(id)
  -> User PrincipalRef { kind: "user", userId }
  -> workspace membership and authorization

Device credential -> Runtime Node PrincipalRef
Service credential -> Service PrincipalRef
Agent delegation   -> Agent PrincipalRef
Worker execution   -> Worker PrincipalRef
```

`AuthIdentity` is the only bridge between a provider subject and an Adea `User`. The
provider/subject pair is unique and belongs to exactly one stable user. Creation writes both rows
in one transaction, so a concurrent duplicate cannot leave an orphan user. Revoked identities and
disabled users do not resolve. Unknown, non-user, or ambiguous mappings fail closed.

Provider subjects must never appear in workspace membership, control-plane foreign keys, API
principal fields, or model context. Those boundaries use `PrincipalRef`; user principals contain
only the stable Adea `userId`. Account linking is intentionally not automatic: adding another
provider identity to an existing user requires a future explicit, reauthenticated linking flow
that preserves the one-provider-subject-to-one-user invariant.
