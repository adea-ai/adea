# Railway cutover checklist

This checklist prepares one cutover: moving the self-hosted Better Auth service onto the
Railway-managed PostgreSQL at the current source, and the recovery that reverses it. It
records what must be true before that cutover may be attempted and what must be true
afterwards.

It authorizes nothing. It does not provision, deploy, cut over, change a credential,
delete anything, or mutate production. It does not replace the acceptance plan
in [Fresh PostgreSQL acceptance](fresh-postgres-acceptance.md); that plan's gates must
pass first, and a passing local receipt there does not switch traffic, retire the legacy
environment or start the cost measurement.

The cost measurement that follows a verified cutover is planned in
[Railway cost week](railway-cost-week-plan.md).

## Approval and authority

The live cutover was approved by the user in conversation. This document neither grants
nor revokes that approval, and it is not a substitute for it. Execution still depends on
the qualification in [Fresh PostgreSQL acceptance](fresh-postgres-acceptance.md) and on
each per-action gate below, and each of those gates is separate from the approval.
Nothing here authorizes a credential, security or production mutation.

## Source of record

Every fact below is read from this repository at the commit shown. Re-read them at the
cutover head; a test or inspection of an earlier candidate does not qualify a later
repair.

| Source                                     | Commit      | Date       | Fixes |
| ------------------------------------------ | ----------- | ---------- | ----- |
| `packages/auth/src/config.ts`              | `c32221e4a` | 2026-10-19 | #1466 |
| `packages/auth/src/server.ts`              | `c32221e4a` | 2026-10-19 | #1466 |
| `packages/auth/src/better-auth-server.ts`  | `c32221e4a` | 2026-10-19 | #1466 |
| `packages/auth/src/schema-init.ts`         | `4832507c2` | 2026-10-19 | #1477 |
| `packages/auth/README.md`                  | `4832507c2` | 2026-10-19 | #1477 |
| `docs/authentication.md`                   | `c32221e4a` | 2026-10-19 | #1466 |
| `apps/web/wrangler.jsonc`                  | `0a21100a8` | 2026-10-18 | #1464 |
| `apps/web/cloudflare.config.ts`            | `0a21100a8` | 2026-10-18 | #1464 |
| `docs/guides/fresh-postgres-acceptance.md` | `8ad6d276c` | 2026-10-18 | #1468 |

## Current-source state

Read at `3af8253666ac5f28d30b98333b56228e62907532` on 2026-10-19. This is the
configuration **in this repository at that commit**. It is not a live deployed inventory:
it does not prove which bindings the running Worker actually has, and it does not prove
that no Railway service exists outside this repository.

- **Two auth configurations coexist by design.** `readAuthConfig` in
  `packages/auth/src/config.ts` reads the legacy `NEON_AUTH_BASE_URL` and
  `NEON_AUTH_COOKIE_SECRET`. `readBetterAuthConfig` reads `AUTH_BASE_URL`,
  `AUTH_SECRET` and `AUTH_DATABASE_URL` for a fresh deployment on a managed PostgreSQL
  (Railway) instance. The two are kept separate "so the two environments can coexist
  while the old one stays recoverable".
- **The deployment configuration in this repository still binds the legacy Neon-hosted
  Auth pair.** `apps/web/wrangler.jsonc` and `apps/web/cloudflare.config.ts` bind
  `NEON_AUTH_BASE_URL` from `AGENT_HQ_NEON_PRODUCTION_AUTH_BASE_URL` and
  `NEON_AUTH_COOKIE_SECRET` from `AGENT_HQ_WORKER_AUTH_COOKIE_SECRET`, alongside
  `AUTH_TRUSTED_ORIGINS` from `AGENT_HQ_WORKER_AUTH_TRUSTED_ORIGINS` and `DATABASE_URL`
  from `AGENT_HQ_NEON_PRODUCTION_DATABASE_URL`. Whether the running Worker holds exactly
  these bindings is a live question this repository does not answer. These bindings are
  active Neon coupling: the Railway target is the only target, so they are to be removed
  rather than kept as a fallback. Their files belong to the auth lane, and this checklist
  records them as an open item instead of changing them.
- **`AUTH_BASE_URL`, `AUTH_SECRET` and `AUTH_DATABASE_URL` are bound nowhere in this
  repository's deployment configuration.** The Railway-backed set exists in source and in
  the operator tooling, but no production or preview binding in this repository
  references it. Adding those bindings is the configuration change the cutover requires;
  it is a Cloudflare configuration change and needs its own review. This checklist does
  not make it.
- **The current artifact cannot serve the legacy implementation.** `createNeonServerAdapter`
  and `handleNeonAuthRequest` both call `createBetterAuthService(environment)`
  unconditionally, and that reads `AUTH_BASE_URL` and throws when it is absent. The
  legacy reader `readAuthConfig` is exported from `packages/auth/src/server.ts` but has no
  production caller in this source. Restoring the legacy `NEON_AUTH_*` bindings on the
  current artifact therefore does not select the former implementation; it leaves the
  artifact without `AUTH_BASE_URL`, which fails closed. See the recovery section.
- **Provider schema initialization is not wired into a deploy step.**
  `docs/authentication.md` records this as remaining work, and
  `packages/auth/README.md` provides the operator-run command that replaces it:
  `bun run --cwd packages/auth schema-init` (plan only, default) and
  `bun run --cwd packages/auth schema-init -- --apply`.
- **Secret values live in the account Secrets Store, not in this repository.**
  `apps/web/CLOUDFLARE.md` names the Secrets Store as the source of truth. Plain
  identifiers stay in `vars` and text bindings. A secret value must never enter this
  repository, a commit, a log or a receipt.
- **The auth connection is not the application connection.** The application database
  has not moved yet, and `packages/db/src/config.ts` classifies only Neon `-pooler`
  hosts as transaction-pooled (`isTransactionPooledHost`); every other host, including
  a direct Railway host, is classified as `preparedStatements: true`. That Neon host
  classification is active Neon coupling, and it belongs to the application lane rather
  than to this checklist. The auth service does not
  use that path at all: it opens its own `pg.Pool` with `max: 1` from the validated
  connection string (`createPostgresAuthDatabase`). Record the auth pool's effective
  `prepare` behaviour on the Railway host, and do not carry the legacy endpoint's
  behaviour across.
- **This checklist covers the auth database only.** The wider database migration spans
  more than one database, and the Control Plane service carries its own Railway
  configuration and runbooks in its own repository. Completing the auth cutover does not
  complete the wider migration, and this checklist does not claim to.

## Cutover checklist

### A. Preconditions

- [ ] The acceptance gates in [Fresh PostgreSQL acceptance](fresh-postgres-acceptance.md)
      passed at the exact candidate head, and that receipt names the head it qualifies.
- [ ] #1466 and #1465 are merged and their resulting heads are recorded here.
- [ ] The Railway PostgreSQL target exists and is reachable from the deployment
      environment, and its host, region and plan are recorded.
- [ ] The exact source head to be cut over is recorded, and it is the same head that
      passed the acceptance gates.

### B. Database preparation on the Railway target

- [ ] The target schema and its roles were created with the operator's own tooling.
      The search path is a single unquoted schema name that already exists; an
      ambiguous or absent schema is refused before any change.
- [ ] `bun run --cwd packages/auth schema-init` was run in plan mode first and its
      output was read. The plan reads only `AUTH_MIGRATION_DATABASE_URL` and ignores
      `AUTH_DATABASE_URL`.
- [ ] `bun run --cwd packages/auth schema-init -- --apply` was run with the
      schema-owning migration role. Apply adds tables and columns and never drops
      anything. It is all-or-nothing: the statements run in one transaction on one
      connection, so a failure rolls back the whole apply.
- [ ] A second inspection after the apply reports nothing pending. Re-applying an
      initialized schema is a no-op.
- [ ] The runtime role was confirmed to have no `CREATE` on the auth schema, so it
      cannot create those tables even if misconfigured. The runtime service is started
      only with `AUTH_DATABASE_URL` set to the runtime role.
- [ ] The initialization was performed against a fresh schema. Inspection does not
      compare indexes, so a schema some other tool left partly built is not detected
      by the plan; initialize only a fresh schema with this command.

### C. Credentials and bindings

- [ ] `AUTH_BASE_URL`, `AUTH_SECRET` and `AUTH_DATABASE_URL` records exist in the
      account Secrets Store for the target environment, alongside the existing
      `AUTH_TRUSTED_ORIGINS` record. Each target keeps its own set; production and
      preview values are distinct and are never shared.
- [ ] `AUTH_DATABASE_URL` requires TLS on its non-loopback host (`sslmode=require`,
      `verify-ca` or `verify-full`); a bare hosted URL is rejected. The check asks the
      pinned `pg` client for the effective settings rather than re-parsing the string,
      and additionally rejects an empty TLS parameter and `sslmode=no-verify`. Record the
      effective mode that the driver resolves, not the parameter that was written.
- [ ] `AUTH_SECRET` is at least 32 characters, and neither `AUTH_SECRET` nor
      `AUTH_DATABASE_URL` is client-prefixed. This is a policy the checklist enforces by
      review, not by a runtime guard: the finite client-exposure list in
      `readDatabaseUrl` covers `ADEA_PUBLIC_*`, `NEXT_PUBLIC_*` and `VITE_*` database
      names only, and it does not mention `AUTH_SECRET` or `AUTH_DATABASE_URL`. Better
      Auth reads its own configuration through `readBetterAuthConfig`, which performs no
      client-exposure check. Confirm the absence of client-prefixed auth values by
      inspection of the deployment configuration and the build inputs, and record who
      checked it.
- [ ] `AUTH_TRUSTED_ORIGINS` lists exact origins and no wildcards. The production
      aliases are `adea.dev` and the `workers.dev` URL; a Preview Worker must list its
      exact URLs.
- [ ] `AUTH_BASE_URL` is the public app origin that serves the same-origin
      `/api/auth/*` proxy, so Better Auth scopes its cookies to the app host. It is
      HTTPS outside loopback.
- [ ] The deployment configuration binds the new set, and the preview isolation rules
      in `apps/web/cloudflare.config.ts` still hold: a preview secret may not name a
      production secret and must carry `preview` in its name, and a partial selection
      must fail the build.
- [ ] Google sign-in is enabled only if `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
      are both present, and the recorded state matches what the cutover intends.
- [ ] The session defaults are recorded as they will run: a 7-day session refreshed
      daily, verification **on**, secure cookies on for an HTTPS base URL.

### D. Verification before any traffic moves

- [ ] `bun run --cwd apps/web start:test:auth-worker` passed at the cutover head. It
      runs the production-built Worker against a separate auth schema with a synthetic
      secret, and it must not become a green skipped test.
- [ ] `bun run scripts/built-worker-desktop-auth-cli.ts` passed at the cutover head. It
      runs the production-built Worker against a disposable loopback PostgreSQL and
      proves the built desktop routes: the authorize route is registered, refuses a
      caller without a session, refuses a request that carries a parameter the desktop
      contract does not define, and issues an authorization code to a fresh account the
      Worker signs up itself; the exchange route turns that code into a desktop session
      and refuses a wrong PKCE verifier, an untrusted origin and a replayed code; and no
      response carries the auth secret, the session cookie, the authorization code or
      the desktop credential. The receipt carries every assertion by name, how many
      attempts each assertion made, how every attempt ended, the identity of the built
      artifact it proved, the verdict of the teardown, and the full auth lifecycle
      assertions. A run whose failure was published as a receipt is a failed run: an
      application failure is never retried into a pass, and a request whose outcome is
      unknown is never replayed. A receipt is published only after the Worker was
      stopped and its material removed. It must not become a green skipped run.
- [ ] The invalid, expired, revoked and wrong-origin cases, plus refresh, logout and
      delivery, passed. `docs/authentication.md` step 5 requires them before switching
      traffic.
- [ ] The identity-mapping tests passed: the provider subject stays an `AuthIdentity`
      input and is never an Adea `User.id`.
- [ ] Mailbox proof precedes email-based authority: `profile.email` is populated only
      for a verified address, so allowlists, invitations and desktop-session email
      matching fail closed for an unverified signup.
- [ ] A fresh connection to the Railway host was recorded with the effective TLS mode
      and the effective statement-preparation behaviour for that host.
- [ ] Each response batch leaves no auth PostgreSQL backend within the 10-second
      polling window, and the request-owned connection is closed or registered with the
      request scope's cleanup.

### E. Traffic switch and observation

- [ ] The switch itself is a separate approved change with its own receipt. This
      checklist does not authorize it.
- [ ] After the switch, the observation window records: sign-in, refresh, logout and
      revocation outcomes; verification deliveries; `account/summary` and other routes
      that failed on the legacy path; the Workers CPU-overrun counter; and the request
      and subrequest counts.
- [ ] The observation window reports sparse samples as sparse. Missing telemetry does
      not prove recovery, and the absence of an error is not evidence of a healthy
      path.

## Recovery checklist

Recovery is a forward-fix or a Railway backup/restore, and it is described in
[Railway PostgreSQL recovery](railway-postgres-recovery.md). It is not a
binding change, and it does not restore an earlier artifact.

The current artifact constructs Better Auth unconditionally.
`createNeonServerAdapter` and `handleNeonAuthRequest` both call
`createBetterAuthService(environment)`, which reads `AUTH_BASE_URL` and throws
when it is absent. The legacy reader `readAuthConfig` is exported but has no
production caller in this source, so the former implementation is not reachable
from the current artifact. Restoring the legacy `NEON_AUTH_BASE_URL` and
`NEON_AUTH_COOKIE_SECRET` on the current artifact does not select the former
implementation; it leaves the artifact without `AUTH_BASE_URL`, and the auth
path fails closed. There is therefore no legacy artifact to name, and a
recovery that named one would be a procedure that no artifact satisfies.

- [ ] The recovery method is recorded: `forward-fix` or `railway-backup-restore`.
      No other method is used.
- [ ] The exact artifact the recovery works from is recorded, and it is the
      artifact a proof receipt names, with the receipt's commit, source and
      clean-tree flag, as
      [Railway PostgreSQL recovery](railway-postgres-recovery.md) describes.
      "The previous deployment" is not a name, and a commit that was not proved
      is not an artifact.
- [ ] A forward-fix is proved on a disposable instance of the same PostgreSQL
      major version before it is applied to the target, and the plan output of
      the schema initializer was read before the apply.
- [ ] A backup/restore has a restored copy that was compared against the
      backup before the target was pointed at it.
- [ ] The scope of any session invalidation is recorded: which cookie and
      provider sessions are affected, which desktop grants are not, and which
      scoped revocation is planned instead. Rotating the auth cookie secret
      affects the cookie/provider sessions Better Auth signs with `AUTH_SECRET`,
      and it does **not** revoke desktop grants. A desktop grant is issued with
      a random credential whose SHA-256 digest is persisted, together with a
      session ID, and it is revoked or rotated by that digest and session ID
      (`createDesktopSessionService`, `revokeDesktopSessionRecord`,
      `rotateDesktopSessionRecord`). Any desktop-grant revocation is therefore a
      separate, scoped action against the persisted session ID and credential
      digest, planned on its own. This checklist authorizes no credential or
      security mutation, and it does not instruct one.
- [ ] The Railway target is left intact after a recovery, so a second attempt
      does not need to re-provision. Nothing in the recovery re-initializes the
      Railway schema.
- [ ] The recovery receipt records the artifact identity, the exact bindings
      changed, the sessions invalidated and the sessions deliberately left
      alone, and the observation window after the recovery.

### Superseded: the legacy rollback proposal

This entry is an accountability record, not a procedure. It is kept so the
history of the migration is complete, and it is deliberately not an active
dependency: no step below is authorized, and nothing in this checklist may be
executed from it.

On 2026-10-20, PR #1512 (reviewed head `7a3c42392`, merged as `333b948d4`)
proposed a rollback to a legacy-compatible artifact for the Railway auth
cutover, and named Adea main `5747673e5d31ff2da2dcc8dbdaa908ca94f8ace8` as a
**candidate** artifact. That commit was the squash of #1511, and it was
recorded at the time as _incompatible as a legacy rollback artifact_: it
constructs Better Auth unconditionally, so it cannot serve the legacy
`NEON_AUTH_*` path either.

That proposal is superseded. Recovery is a forward-fix or a Railway
backup/restore, described in [Railway PostgreSQL recovery](railway-postgres-recovery.md).
No legacy artifact is named, required or kept, and `5747673e5` is not treated
as compatible with anything: it is neither a legacy rollback artifact nor a
recovery artifact. The compatibility check recorded with the proposal stays on
the record, and the decision owner and the triggers it left unset were never
set.

## Legacy environment: evidence without an operating dependency

The legacy environment is not a target of this work and not a recovery path.
Nothing here requires one to exist, to stay running, or to be reachable, and
nothing here reads one. The repository keeps its historical records of that
environment as non-operational evidence, so the history of the migration stays
readable, and those records carry no dependency.

| Record                                     | What it is                                                          |
| ------------------------------------------ | ------------------------------------------------------------------- |
| `docs/authentication.md`                   | the documentation of the legacy provider configuration              |
| `packages/auth/src/config.ts`              | the separate legacy configuration reader, with no production caller |
| `docs/guides/fresh-postgres-acceptance.md` | the acceptance plan's description of the legacy boundary            |

- [ ] No provider table is copied into an Adea migration, and no provider subject
      is reinterpreted as a domain user ID.
- [ ] No dual write is introduced and no old record is reconciled or imported. The
      two environments may hold different accounts; the cutover does not merge
      them.
- [ ] The application migration journal is unchanged by the cutover. The provider
      schema is owned by the provider's own tooling.
- [ ] No legacy artifact, fallback provider or compatibility path is kept, required
      or named. Recovery is a forward-fix or a Railway backup/restore, and it is
      described in [Railway PostgreSQL recovery](railway-postgres-recovery.md).
- [ ] No gate in this checklist requires the legacy environment, its secrets or
      its endpoint to be present, reachable or unmodified.
- [ ] The lane's own sources carry no legacy provider coupling, and the gate
      that proves it is in the ordinary unit lane. It scans every source file
      of this lane, the acceptance sources and the named lane files outside
      them, and refuses a legacy provider environment variable, a legacy
      provider host and a legacy provider package.

## Evidence and the compatibility scope

An acceptance receipt carries the class of its own evidence, so a synthetic
result is never recorded as a CI result and a local result is never recorded as
a live one. The classes, and what each one does not prove, are listed in
[Railway PostgreSQL recovery](railway-postgres-recovery.md). The live class is
refused until a live acceptance is authorized and verified, and live acceptance
stays root-owned.

The compatibility scope of the Control Plane is confirmed and bounded in the
same document: the application, the authentication provider and the Control
Plane own separate migration boundaries, the Control Plane's own production
migration entry point, journal, object ownership and privileges stay open
dependencies, and an Adea receipt cannot stand in for them.

## What this checklist does not establish

- It does not qualify the Railway target, its TLS, its statement preparation, its
  pooling, or its cost. Those need their own evidence.
- It does not establish that the cutover has run. Nothing here has been provisioned,
  deployed, switched or recovered.
- It does not start the cost measurement. The user owns the next-week follow-up.
- It does not complete the wider database migration. It covers the auth database only.
- It does not prove live Cloudflare request, CPU, subrequest or Hyperdrive
  attribution. See [Railway cost week](railway-cost-week-plan.md) for what is
  recorded, what is missing, and the scope of the read blocker.
- It grants and revokes no approval. The live cutover was approved by the user in
  conversation; execution still depends on the qualification and on each per-action gate
  above.
