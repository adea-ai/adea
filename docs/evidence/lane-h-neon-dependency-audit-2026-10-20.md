# Lane H — Neon dependency audit and live measurement

**Date:** 2026-10-20 · **Lane:** H — efficiency and no-Neon dependency audit
**Scope:** the whole repository (runtime, dependencies, generated configuration, tests, docs, CI,
scripts, environment requirements) plus a read-only measurement of the deployed Cloudflare Worker
and the reachable Railway project.

This page is the audit and its evidence. The measurements it cites are in
[the measurement file](lane-h-cloudflare-railway-measurement-2026-10-20.json). The source removals
this lane owns are in the same commit as this page.

## What this audit establishes

1. **Every remaining reference to the retired provider is classified.** Nothing in the repository is
   left unclassified, and each class has an owner and a next action.
2. **The application's runtime, deployment configuration and local environment no longer reference
   that provider.** The runtime has no provider-shaped branch left, and the deployment configuration
   binds only the managed database and the self-hosted auth service.
3. **The live production Worker still does.** That is a production fact, not a repository fact, and
   it is in [the production operations section](#production-operations-needing-root-approval) below
   with the exact steps.
4. **The remaining references are in other owners' lanes.** They are listed with the owner and the
   scoped action, so each owner can take its own change without this lane editing its files.
5. **The Cloudflare CPU, request, error and subrequest series is now readable.** The
   [Railway cost week plan](../guides/railway-cost-week-plan.md) recorded that the live read was
   blocked on the route that was tried. It is not blocked any more: the Cloudflare GraphQL
   Analytics API answers for this account through the already-authorized `cf` CLI credential.

## How the classes are defined

| Class                                | Meaning                                                                                                                                     | Rule                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Active integration**               | The repository's runtime, configuration, dependencies or local environment reach the provider, or a provider-shaped rule decides behaviour. | Removed, or routed to the single owner of that file.                                          |
| **Live production state**            | The deployed Worker, its bindings or its pooler still point at the provider.                                                                | Not a repository change. Reported for root, with the exact steps.                             |
| **Historical accountability record** | A record of what the deployment used to be, or of a decision already taken.                                                                 | Retained. It must not carry an active dependency.                                             |
| **Naming only**                      | A string in a test fixture, a deny rule, or a comment that names the provider without reaching it.                                          | Kept where removing it would weaken a gate or lose a regression's meaning; otherwise renamed. |

## 1. Active integrations removed by this lane

| Area              | File                                                       | What was removed                                                                                                         | What replaces it                                                                                                                                                   |
| ----------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime           | `packages/db/src/config.ts`                                | `isTransactionPooledHost` and the `-pooler.`/`.neon.tech` host heuristic that decided the statement mode.                | Every connection prepares statements. A host name is not a statement-capability contract.                                                                          |
| Runtime           | `packages/db/src/connection.ts`                            | The connection-role branch behind `prepare`.                                                                             | `prepare` defaults to true; only a declared transaction-pooled origin may turn it off.                                                                             |
| Scripts           | `scripts/database-config.mjs`                              | The pooled/unpooled endpoint rules and the "same environment" hostname normalisation.                                    | Runtime, migration and unpooled connections must reach one PostgreSQL host and one port. The provider's two-endpoint shape is refused without naming the provider. |
| Generated config  | `apps/web/wrangler.jsonc`, `apps/web/cloudflare.config.ts` | The `DATABASE_URL`/`NEON_AUTH_BASE_URL`/`NEON_AUTH_COOKIE_SECRET` bindings and the store name that carried the provider. | `DATABASE_URL`, `AUTH_BASE_URL`, `AUTH_SECRET`, `AUTH_DATABASE_URL` bound to the Railway-managed records.                                                          |
| Runtime           | `apps/web/src/server/event-cursor.ts`                      | The cursor's signing key read from `NEON_AUTH_COOKIE_SECRET`.                                                            | `AUTH_SECRET`, the one secret the deployment rotates.                                                                                                              |
| Browser boundary  | `apps/web/start/client-policy.mjs`                         | The provider's secret names in the private-environment list.                                                             | `AUTH_SECRET`, `AUTH_DATABASE_URL`, `AUTH_BASE_URL`. `AUTH_BASE_URL` is now server-only too, which the cutover checklist had flagged as unreviewed.                |
| App code          | `apps/web/src/**`, `apps/web/start/**`                     | The provider-named adapter calls and comments.                                                                           | The provider-neutral aliases `createAuthServerAdapter`, `handleAuthRequest` and `createAuthClientAdapter`, which `@adea-ai/auth` already exported.                 |
| Local environment | `apps/web/.env.example`, `apps/web/.dev.vars.example`      | The provider's local auth names and the instruction to read them from a provider CLI.                                    | The self-hosted auth service's own names.                                                                                                                          |

The provider's own client-bundle deny rules stay: `apps/web/start/client-policy.mjs` and
`apps/web/test/start-client-denylist.json` still refuse `@neondatabase/auth` in the browser graph,
and `scripts/auth-boundary.test.ts` still refuses it outside `@adea-ai/auth`. Those are gates, and
the dependency they guard is still installed. Removing them before the dependency goes would
weaken a gate.

## 2. Live production state (root-owned)

The deployed Worker is version 1343, uploaded 2026-10-20T06:35:30Z. Its bindings are read in the
measurement file. Three of them are provider-named, and the pooler in front of the database still
points at the provider:

| Live object                              | Current value                                                                                                                                          | Consequence                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Worker binding `DATABASE_URL`            | store record `AGENT_HQ_NEON_PRODUCTION_DATABASE_URL`                                                                                                   | The application fallback URL is the provider's.                                       |
| Worker binding `NEON_AUTH_BASE_URL`      | store record `AGENT_HQ_NEON_PRODUCTION_AUTH_BASE_URL`                                                                                                  | The legacy provider's auth endpoint.                                                  |
| Worker binding `NEON_AUTH_COOKIE_SECRET` | store record `AGENT_HQ_WORKER_AUTH_COOKIE_SECRET`                                                                                                      | The legacy provider's cookie secret.                                                  |
| Hyperdrive `adea-db`                     | origin `ep-aged-king-a52genig.us-east-2.aws.neon.tech:5432`, database `neondb`, user `neondb_owner`, origin connection limit 20, query caching enabled | Every Worker database connection still reaches the provider, through the edge pooler. |

**The production auth endpoint is failing.** `GET https://adea.dev/api/auth/get-session` answered
**HTTP 500** with `{"status":500,"unhandled":true,"message":"HTTPError"}` at 2026-10-20T07:21Z. The
root document answered 200. The cause is the binding set above: the deployed Worker binds the
legacy provider's auth names and does **not** bind `AUTH_BASE_URL`, `AUTH_SECRET` or
`AUTH_DATABASE_URL`, which the self-hosted auth service requires. `readBetterAuthConfig` throws
`AUTH_BASE_URL is required`, so the service cannot be constructed. The account path in
`apps/web/src/server/workspace-principal.ts` catches that failure and treats the visitor as a guest,
so the failure is silent on the signed-in path; the `/api/auth/*` route does not catch it and returns 500.

This is the state this lane's source change is designed to end, and it is a production operation to
end it. See [the operations list](#production-operations-needing-root-approval).

## 3. Active integrations owned by another lane

Each row is a scoped finding. The implementation belongs to that lane's owner; this lane does not
edit those files.

### 3a. Auth lane (B)

| File                                                                                       | Active coupling                                                                                                                                                                           | Scoped action                                                                                                    |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `packages/auth/src/config.ts`                                                              | `readAuthConfig` reads `NEON_AUTH_BASE_URL` and `NEON_AUTH_COOKIE_SECRET`. The function is exported and has no production caller.                                                         | Remove the legacy reader and the two names. The deployment no longer binds them.                                 |
| `packages/auth/src/neon-driver.ts`                                                         | The legacy provider driver, exported and unused at runtime.                                                                                                                               | Remove with the reader.                                                                                          |
| `packages/auth/src/session.ts`                                                             | `normalizeNeonSession` and the `'neon'` default provider label. The label is persisted in the `auth_identity` rows, so changing it is a data decision.                                    | Rename the helper. Changing the persisted label needs its own migration decision and is not this lane's to make. |
| `packages/auth/src/client.ts`, `packages/auth/src/server.ts`, `packages/auth/src/index.ts` | The provider-named exports (`createNeonClientAdapter`, `createNeonServerAdapter`, `handleNeonAuthRequest`). The provider-neutral aliases already exist and the application now uses them. | Drop the provider-named exports once no caller remains.                                                          |
| `packages/auth/src/vite-client-bundle.ts`                                                  | The `@neondatabase/auth` adapter deny pattern.                                                                                                                                            | Keep until the dependency goes; remove the dependency and the pattern together.                                  |
| `packages/auth/package.json`, `apps/web/package.json`                                      | The `@neondatabase/auth` dependency.                                                                                                                                                      | Remove the dependency, then the deny rules that guard it.                                                        |
| `packages/auth/tests/**`                                                                   | Unit and integration tests for the above.                                                                                                                                                 | Follow the source removal.                                                                                       |
| `package.json`, `scripts/integration-inventory.mjs`                                        | The root coverage command and the integration inventory name `packages/auth/tests/integration/neon-driver.test.ts`.                                                                       | Follow the test removal.                                                                                         |
| `apps/web/test/desktop-principal.test.ts`                                                  | A fixture whose provider label is `'neon'`.                                                                                                                                               | Follow the provider-label decision.                                                                              |

### 3b. CI and release lane (F)

| File                                                                                                                                     | Active coupling                                                                                                                                                                    | Scoped action                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/neon_workflow.yml`                                                                                                    | The whole workflow: it creates an isolated hosted branch, proves the key-discovery endpoint, migrates the branch and deletes it. It is the last active provider integration in CI. | Remove the workflow, or replace the branch proof with the disposable PostgreSQL proof the repository already carries.                              |
| `.github/workflows/cloudflare-db-migrate.yml`                                                                                            | The header names the provider and the production branch.                                                                                                                           | Reword the header. The workflow itself only needs `DATABASE_MIGRATION_URL`.                                                                        |
| `scripts/neon-branch-resolution.test.ts`, `scripts/neon-workflow-lifecycle.test.ts`, `scripts/neon-workflow-disposable-postgres.test.ts` | Test the shipped workflow's shape and its cleanup resolver.                                                                                                                        | Follow the workflow removal.                                                                                                                       |
| `scripts/test-target-guard.mjs`, `scripts/test-target-guard.test.ts`                                                                     | The CI-ephemeral host allow-list is keyed on the hosts that workflow emits, and `NEON_AUTH_BASE_URL` is the one remote value it admits.                                            | Remove the CI-host allow-list **after** the workflow is gone. Removing it earlier would widen what a test lane may reach, which weakens the guard. |
| `scripts/test-suite-boundary.test.ts`                                                                                                    | Asserts the workflow's job names and the `Migrate Neon Branch` gate.                                                                                                               | Follow the workflow removal.                                                                                                                       |
| `apps/web/start/acceptance-hosted.mjs`                                                                                                   | The hosted acceptance harness runs against that branch.                                                                                                                            | Repoint it at the Railway target or the disposable proof.                                                                                          |

### 3c. Other owners

| Owner                | File                                    | Active coupling                                                                                           | Scoped action                                                                                                                                    |
| -------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| E (caching and lock) | live Hyperdrive `adea-db` configuration | Query caching is enabled on the edge pooler, and the origin connection limit is 20.                       | The pooler is a live Cloudflare setting. Changing the cache or the limit is a production operation, not a repository change. It is listed below. |
| E                    | `packages/db/src/connection.ts`         | The Worker client is capped at five edge connections and the server client at ten; `idle_timeout` is 20s. | The efficiency measurement below is the input to any tuning decision.                                                                            |
| C (Pi runtime)       | —                                       | No provider coupling was found in the Pi runtime.                                                         | None.                                                                                                                                            |

## 4. Historical accountability records retained

These name the provider and are kept on purpose. Each is a record of what the deployment was, and
none of them is a path the runtime or the deployment configuration still takes.

| File                                          | What it records                                                                                                                                                                                                                                     |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/authentication.md`                      | The legacy hosted Auth environment is retained, unchanged, as an accountability record. It is not a recovery target: recovery for the Railway deployment is a Railway backup/restore or a forward fix.                                              |
| `docs/database-operations.md`                 | The old production principal name, the old plan's limitations, and the pull-request CI lane's provider. The page states that its provider-specific references describe the CI lane and the historical record, not this application's configuration. |
| `docs/guides/railway-cutover-checklist.md`    | The cutover plan and the retention invariants. Owned by the acceptance lane; its open pull request also touches it, so this lane did not edit it.                                                                                                   |
| `docs/guides/railway-cost-week-plan.md`       | The cost-measurement plan. Owned by the acceptance lane.                                                                                                                                                                                            |
| `PERF.md`                                     | A 2026-09-26 measurement taken against a remote branch.                                                                                                                                                                                             |
| `docs/decisions/0007-solid-tanstack-start.md` | A decision record.                                                                                                                                                                                                                                  |
| `CHANGELOG.md`                                | Release history.                                                                                                                                                                                                                                    |

## 5. Naming-only references kept

| File                                                                                                                    | Why it stays                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/db/tests/unit/config.test.ts`, `packages/db/tests/unit/connection.test.ts`                                    | The regression that proves the retired endpoint shape is no longer special-cased names that shape. Removing the name would remove the regression's meaning. |
| `scripts/identity-boundary.test.ts`                                                                                     | Refuses provider-shaped user-id fields. A gate.                                                                                                             |
| `scripts/desktop-auth-boundary.test.ts`, `apps/web/start/client-policy.mjs`, `apps/web/test/start-client-denylist.json` | Refuse the legacy SDK in the client graph. Gates that guard a dependency that still exists.                                                                 |
| `scripts/test-target-guard.test.ts`, `scripts/relay-retention-config.test.ts`, `packages/db/tests/integration/**`       | Fixture host names. They reach nothing.                                                                                                                     |

## 6. Measurement

The full series is in
[the measurement file](lane-h-cloudflare-railway-measurement-2026-10-20.json). The summary:

| UTC day                | Requests | Errors | `exceededResources` | Subrequests per request | CPU p50 of the bucket p50 (µs) |
| ---------------------- | -------- | ------ | ------------------- | ----------------------- | ------------------------------ |
| 2026-10-13             | 491      | 0      | 0                   | 6.02                    | 33,811                         |
| 2026-10-14             | 2,907    | 478    | 478                 | 6.76                    | 18,306                         |
| 2026-10-15             | 8,074    | 2,539  | 2,539               | 6.79                    | 12,947                         |
| 2026-10-16             | 8,972    | 4,879  | 4,879               | 6.94                    | 10,000                         |
| 2026-10-17             | 7,997    | 2,306  | 2,306               | 6.94                    | 16,591                         |
| 2026-10-18             | 729      | 0      | 0                   | 2.08                    | 23,612                         |
| 2026-10-19             | 1,635    | 0      | 0                   | 2.49                    | 20,019                         |
| 2026-10-20 (to 07:30Z) | 867      | 0      | 0                   | 3.61                    | 23,170                         |

Three readings, each with its limit:

- **The CPU overruns stopped.** Every `exceededResources` invocation in the series falls on
  2026-10-14 to 2026-10-17, and the three days since are free of them. The repository's
  [local CPU profiling evidence](worker-cpu-local-profiling-2026-10-18.json) recorded "307 rolling
  24h CPU overruns" as of 2026-10-18T15:20Z, provided by the coordinator and not independently read.
  The per-script GraphQL series does not reproduce that counter: it reports 2,306 overruns on
  2026-10-17 and none on 2026-10-18. The two figures measure different things, and the series here
  is the per-script read.
- **The request mix changed on 2026-10-18, not only its volume.** Subrequests per request fell
  from 6.0–6.9 to 2.1–3.6 on the same day. Daily requests also fell by roughly a factor of five.
  The overrun-free days are therefore also the low-traffic days, and this series does **not**
  establish that the fix holds at the 2026-10-15 to 2026-10-17 load.
- **The CPU figures are raw reservoir samples, not billed CPU.** Each bucket's quantiles are a
  sample over the invocations in that minute. Billed CPU was not established by this read.

Per-route CPU and subrequest attribution is **not** available from the route this lane could use.
The Workers Logs observability dataset exposes 22 keys, all `$metadata.*`, and returns zero matching
rows for `adea-web` over the read window. Hyperdrive query and cache counters are not readable
either: the account schema has no Hyperdrive group, and the account-level Workers analytics
dataset answers HTTP 500. Both negative results are recorded in the measurement file.

The Railway read reached one project, `control-plane`, which is the Control Plane service's own
infrastructure with its own runbooks. Its production Postgres service reports zero CPU and memory
over the last hour, and its API service reports zero requests over the last hour. **No Railway
service for the Adea auth database appears in that project**, and this credential reaches no other
Railway project or workspace. Whether the auth target exists elsewhere is not established by this
read.

## 7. Bounded efficiency changes

The measurement supports one change in the database layer, and this lane made it.

**The per-connection statement mode is no longer decided by a hostname.** The repository's local
profiling evidence named the local PostgreSQL SCRAM handshake and the per-connection type discovery
among the top CPU frames, and the deployed series shows a per-minute CPU p50 of 10–34 ms with a
bucket p99 above 350 ms. Those figures do not attribute CPU to any one route, so this lane did not
guess at a per-route fix and did not cache any authentication, session or permission decision: the
drizzle database still owns `$cache: undefined`, and the Worker still reads every authorization
decision fresh.

What changed is narrow and testable:

- The connection role is no longer sniffed from a provider hostname, so no deployment can be
  misclassified by a name it happens to carry.
- The deploy-time validator now refuses a configuration whose connections do not reach one
  PostgreSQL host, which is the provider's retired two-endpoint shape, and it refuses it without
  naming the provider.

Both are covered by regressions in `packages/db/tests/unit/config.test.ts`,
`packages/db/tests/unit/connection.test.ts` and `scripts/database-config.test.ts`.

Two further levers are available and are **not** taken here, because they are live settings or
another lane's:

- The edge pooler's origin connection limit (20) and its query-cache setting.
- The Worker client's edge-connection ceiling (5) and its idle timeout (20s).

## 8. Production operations needing root approval

Root owns every live action. This lane performs none of them, and each step below is separate and
needs its own approval. The order matters: the secrets must exist before the pull request merges,
because the merge is what deploys the Worker.

| #   | Action                                            | Detail                                                                                                                                                                                                                                                                                     | Why it is root's                                             |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| 1   | Create the Railway database and the auth database | One Railway-managed PostgreSQL with the `app` and `auth` schemas, the `_app` runtime roles and the `_migration` role, and the auth schema initialized by `bun run --cwd packages/auth schema-init -- --apply`.                                                                             | Provisioning, roles and schema creation are live operations. |
| 2   | Create the four Secrets Store records             | `ADEA_RAILWAY_PRODUCTION_DATABASE_URL`, `ADEA_RAILWAY_PRODUCTION_AUTH_BASE_URL`, `ADEA_RAILWAY_PRODUCTION_AUTH_SECRET`, `ADEA_RAILWAY_PRODUCTION_AUTH_DATABASE_URL`, in the account Secrets Store the Worker already reads.                                                                | A credential creation. The lane does not create credentials. |
| 3   | Decide `AUTH_BASE_URL`                            | It is the public app origin Better Auth scopes its cookies to. The Worker serves `adea.dev` and `adea-web.adea-ai.workers.dev`; one base URL means one of them is the cookie host. The record is in the store rather than in the repository so the value can be set without a code change. | A live value with a user-visible consequence.                |
| 4   | Repoint the edge pooler                           | Hyperdrive `adea-db` must front the Railway origin instead of `ep-aged-king-a52genig.us-east-2.aws.neon.tech`.                                                                                                                                                                             | A live Cloudflare setting on a production binding.           |
| 5   | Merge the pull request                            | The merge deploys the Worker with the new binding set. If step 2 has not happened, the deploy fails closed and the previous Worker keeps serving.                                                                                                                                          | A deployment.                                                |
| 6   | Observe                                           | Sign-in, refresh, logout and revocation outcomes; the verification deliveries; the Workers CPU-overrun counter; the request and subrequest counts.                                                                                                                                         | Live observation.                                            |
| 7   | Retire the legacy bindings                        | Delete `AGENT_HQ_NEON_PRODUCTION_DATABASE_URL`, `AGENT_HQ_NEON_PRODUCTION_AUTH_BASE_URL` and `AGENT_HQ_WORKER_AUTH_COOKIE_SECRET` from the store, once the observation window is clean.                                                                                                    | A credential deletion.                                       |

**Not required, and deliberately not done:** deleting, dropping, truncating or altering any provider
branch, database, role or table. The legacy environment is retained untouched as an accountability
record.

**Recovery for the Railway deployment is a Railway backup/restore or a forward fix.** There is no
provider fallback, no backward-compatibility path and no provider rollback. The proposed rollback
plan in the cutover checklist stays on the record as history; it is not an active dependency.

## 9. What this audit does not establish

- It does not establish that the provider is gone from the live deployment. The live Worker still
  binds it, and the table above says what ends that.
- It does not establish billed Cloudflare CPU, per-route attribution, or Hyperdrive query and cache
  counters. The routes for those were tried and are recorded as negative results.
- It does not establish that the CPU-overrun fix holds at the 2026-10-15 to 2026-10-17 traffic
  level. The overrun-free days are also the low-traffic days.
- It does not establish that a Railway service for the auth database exists. The reachable Railway
  project holds none, and the credential reaches no other project.
- It does not complete the wider database migration. It covers this repository's application
  database and its auth configuration. The Control Plane service carries its own Railway
  configuration and runbooks in its own repository.
- It does not measure cost. The seven-day cost interval is a measurement the user runs next week
  with the [cost week plan](../guides/railway-cost-week-plan.md) as its procedure; it is not a
  gate on this migration, and nothing here waits for it.
