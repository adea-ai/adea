# Railway cutover checklist

This checklist prepares one cutover: moving the self-hosted Better Auth service onto the
Railway-managed PostgreSQL at the current source, and the rollback that reverses it. It
records what must be true before that cutover may be attempted and what must be true
afterwards.

It authorizes nothing. It does not provision, deploy, cut over, change a credential,
delete anything in Neon, or mutate production. It does not replace the acceptance plan
in [Fresh PostgreSQL acceptance](fresh-postgres-acceptance.md); that plan's gates must
pass first, and a passing local receipt there does not switch traffic, retire Neon or
start the cost week.

The cost measurement that follows a verified cutover is planned in
[Railway cost week](railway-cost-week-plan.md).

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

Read at `3af8253666ac5f28d30b98333b56228e62907532` on 2026-10-19.

- **Two auth configurations coexist by design.** `readAuthConfig` in
  `packages/auth/src/config.ts` reads the legacy `NEON_AUTH_BASE_URL` and
  `NEON_AUTH_COOKIE_SECRET`. `readBetterAuthConfig` reads `AUTH_BASE_URL`,
  `AUTH_SECRET` and `AUTH_DATABASE_URL` for a fresh deployment on a managed PostgreSQL
  (Railway) instance. The two are kept separate "so the two environments can coexist
  while the old one stays recoverable".
- **The production Worker is still bound to the legacy Neon-hosted Auth pair.**
  `apps/web/wrangler.jsonc` and `apps/web/cloudflare.config.ts` bind
  `NEON_AUTH_BASE_URL` from `AGENT_HQ_NEON_PRODUCTION_AUTH_BASE_URL` and
  `NEON_AUTH_COOKIE_SECRET` from `AGENT_HQ_WORKER_AUTH_COOKIE_SECRET`, alongside
  `AUTH_TRUSTED_ORIGINS` from `AGENT_HQ_WORKER_AUTH_TRUSTED_ORIGINS` and `DATABASE_URL`
  from `AGENT_HQ_NEON_PRODUCTION_DATABASE_URL`.
- **`AUTH_BASE_URL`, `AUTH_SECRET` and `AUTH_DATABASE_URL` are bound nowhere in the
  deployed configuration.** The Railway-backed set exists in source and in the operator
  tooling, but no production or preview binding references it. Adding those bindings is
  the configuration change the cutover requires; it is a Cloudflare configuration
  change and needs its own review. This checklist does not make it.
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
  stays on Neon, and `packages/db/src/config.ts` classifies only Neon `-pooler` hosts as
  transaction-pooled (`isTransactionPooledHost`); every other host, including a direct
  Railway host, is classified as `preparedStatements: true`. The auth service does not
  use that path at all: it opens its own `pg.Pool` with `max: 1` from the validated
  connection string (`createPostgresAuthDatabase`). Record the auth pool's effective
  `prepare` behaviour on the Railway host, and do not carry the legacy endpoint's
  behaviour across.

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
      `AUTH_DATABASE_URL` is client-prefixed. `readDatabaseUrl` refuses any
      client-exposed database credential.
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

## Rollback checklist

Rollback is available only while the legacy Neon-hosted Auth environment is retained
and still able to serve. That retention is a precondition of the cutover, not a
consequence of it.

- [ ] The legacy `NEON_AUTH_BASE_URL` and `NEON_AUTH_COOKIE_SECRET` Secret Store
      records are still present and unmodified at rollback time. The cutover adds the
      new set; it does not remove the old one.
- [ ] The legacy Neon Auth endpoint was never deleted, and its provider tables were
      never migrated, altered or dropped by the cutover.
- [ ] Rollback restores the previous binding set and invalidates the sessions issued
      after the cutover. Rotating the cookie secret invalidates every Worker session;
      record that consequence before relying on it.
- [ ] Rollback re-points `AUTH_TRUSTED_ORIGINS` only if the cutover changed it, and
      restores the previous value exactly.
- [ ] The Railway target is left intact after a rollback, so a second attempt does not
      need to re-provision. Nothing in the rollback re-initializes the Railway schema.
- [ ] The rollback receipt records the head, the exact bindings changed, the sessions
      invalidated and the observation window after the rollback.

## Neon-recoverable preservation

These invariants hold for the whole cutover, and each one already has a source in this
repository.

| Invariant                                                                                                                   | Source                                     |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| The legacy Neon-hosted Auth environment is left in place and recoverable; nothing deletes or cuts it over.                  | `docs/authentication.md`                   |
| The legacy provider configuration is kept separate so the two environments can coexist while the old one stays recoverable. | `packages/auth/src/config.ts`              |
| The legacy Neon-hosted Auth environment is retained, unchanged, for recovery.                                               | `docs/authentication.md`                   |
| Existing Neon data stays recoverable throughout this work.                                                                  | `docs/guides/fresh-postgres-acceptance.md` |

- [ ] No Neon branch, database, role or table is deleted, dropped, truncated or
      migrated as part of the cutover.
- [ ] No provider table is copied into an Adea migration, and no provider subject is
      reinterpreted as a domain user ID.
- [ ] No dual write is introduced and no old record is reconciled or imported. The two
      environments may hold different accounts; the cutover does not merge them.
- [ ] The legacy environment's accessibility is re-checked after the cutover and
      again after the rollback, and the check is recorded. Retained is not the same as
      reachable.
- [ ] The application migration journal is unchanged by the cutover. The provider
      schema is owned by the provider's own tooling.

## What this checklist does not establish

- It does not qualify the Railway target, its TLS, its statement preparation, its
  pooling, or its cost. Those need their own evidence.
- It does not establish that the cutover has run. Nothing here has been provisioned,
  deployed, switched or rolled back.
- It does not start the cost week, and it does not retire Neon.
- It does not prove live Cloudflare request, CPU, subrequest or Hyperdrive
  attribution. See [Railway cost week](railway-cost-week-plan.md) for what is
  recorded, what is missing, and why the live read is blocked.
